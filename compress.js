import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { encode } from '@toon-format/toon'
import { safeCountTokens as countTokens } from './lib/tokens.js'
import { createPatch } from 'diff'
import { tryParseJSON, classifyContent, stripLineNumbers, jsonHasUnsafeInteger } from './detect.js'
import { rewriteCommandOutput } from './lib/rewriters/index.js'
import { redactText } from './lib/redact.js'
import { anthropic } from './providers.js'
import { graphDeduplicateTargets } from './session-graph.js'
import { detectTaskType, generateOutputRules, isDangerousTask } from './lib/rules-generator.js'
import { extractTargetPaths, extractTargetToolNames } from './lib/path-extract.js'
import { evictStaleImages } from './lib/stale-images.js'
import { pruneStaleInputs } from './lib/stale-inputs.js'
import { summarize, rehydrateReferences } from './lib/disclosure.js'
import { trimLinesByRelevance } from './lib/bm25.js'
import { pxRenderTargets, pxModelAllowed } from './lib/px-render.js'

const STALE_INPUTS_PROVIDERS = new Set(['anthropic', 'openai', 'openai-responses', 'kimi', 'moonshot'])

const cache = new Map()
const MAX_CACHE = 500

function cacheKey(text) {
  if (text.length < 128) return text
  return createHash('sha256').update(text).digest('base64')
}

export function clearCache() { cache.clear() }

function normalizeWhitespace(text) {
  // Right-trim each line by hand. The former `/[ \t]+$/gm` is quadratic: a long
  // run of spaces/tabs NOT at line end makes the greedy match restart at every
  // offset, so a padded/aligned tool_result (tables, ASCII art) stalled the
  // proxy event loop for seconds. This scan touches each char once.
  let out = ''
  for (let line of text.split('\n')) {
    let e = line.length
    while (e > 0 && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--
    out += (e === line.length ? line : line.slice(0, e)) + '\n'
  }
  return out.slice(0, -1).replace(/\n{3,}/g, '\n\n')
}

// --- Stage: dedup ---
function deduplicateTargets(targets) {
  const seen = new Map()
  for (const target of targets) {
    if (target.skip) continue
    const key = cacheKey(target.text)
    const prev = seen.get(key)
    if (prev && prev.text === target.text) {
      const ref = `[see tool_result in message ${prev.path[1]}, block ${prev.index} — identical content]`
      // Never expand: a tiny duplicate can be shorter than the reference itself.
      if (ref.length < target.text.length) {
        target.compressed = ref
        target.dedup = true
        target.refTarget = prev
      }
    } else {
      seen.set(key, target)
    }
  }
}

// --- Stage: diff ---
function diffTargets(targets) {
  const seen = []
  for (const target of targets) {
    if (target.skip || target.dedup || target.compressed) continue
    if (target.text.length < 200) { seen.push({ target, lineSet: null }); continue }

    const targetLen = target.text.length
    const targetSet = new Set(target.text.split('\n'))

    for (const prevEntry of seen) {
      const prev = prevEntry.target
      if (Math.abs(prev.text.length - targetLen) > Math.max(prev.text.length, targetLen) * 0.5) continue
      if (!prevEntry.lineSet) prevEntry.lineSet = new Set(prev.text.split('\n'))
      const sim = quickSimilarity(prevEntry.lineSet, targetSet)
      if (sim > 0.5 && sim < 1.0) {
        const patch = createPatch('file', prev.text, target.text, '', '', { context: 1 })
        // Strip the patch header (first 4 lines: ---, +++, index, etc.)
        const lines = patch.split('\n')
        const bodyStart = lines.findIndex(l => l.startsWith('@@'))
        if (bodyStart === -1) continue
        const diffBody = lines.slice(bodyStart).join('\n')
        if (diffBody.length < targetLen * 0.5) {
          target.compressed = `[diff from tool_result in message ${prev.path[1]}, block ${prev.index}]:\n${diffBody}`
          target.diffed = true
          target.refTarget = prev
          break
        }
      }
    }
    seen.push({ target, lineSet: targetSet })
  }
}

function quickSimilarity(setA, setB) {
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA]
  let intersection = 0
  for (const x of small) {
    if (large.has(x)) intersection += 1
  }
  const union = setA.size + setB.size - intersection
  return union > 0 ? intersection / union : 0
}

// --- Stage: read-diff ---
// Session-scoped unified diff for re-reads. For each target whose file path
// can be confidently attributed (via the preceding tool_use), compare against
// the last-seen body for the same (session, path) pair. If the patch is small
// enough, substitute it for the body. Always cache the fresh text afterwards.
// Tool results that must reach the model verbatim. Unlike a Read or a Bash
// run, re-invoking these cannot reproduce the content — it would re-prompt the
// human. Tool attribution is provider-aware (see lib/path-extract.js).
const PROTECTED_TOOLS = new Set(['AskUserQuestion'])

function exemptProtectedTools(targets, body, provider) {
  if (!provider || !targets.length) return 0
  const names = extractTargetToolNames(body, targets)
  let exempted = 0
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]
    if (!target || target.skip) continue
    if (!PROTECTED_TOOLS.has(names[i])) continue
    target.skip = 'user-decision'
    exempted += 1
  }
  return exempted
}

// --- Replay memo (see lib/replay-memo.js) ---
// Key = provider + conversation + position + tool id + hash of the RAW text.
// Position and conversation keep deterministic tool ids (`functions.read:0`)
// and identical bodies from sharing an entry; the hash catches a client that
// compacted or edited the body since.
function sha(text) {
  return createHash('sha256').update(text).digest('base64')
}

function conversationScope(body) {
  const turns = body?.messages || body?.input || body?.contents
  if (!Array.isArray(turns) || !turns.length) return ''
  // The first turn can be a system prompt every conversation shares (OpenAI
  // chat, Kimi), so the first user turn and top-level system are part of the identity too.
  const seed = [body?.system ?? null, turns[0], turns.find(t => t?.role === 'user') ?? null]
  // cache_control markers move between requests; they are not identity.
  try { return sha(JSON.stringify(seed, (k, v) => (k === 'cache_control' ? undefined : v))) } catch { return '' }
}

function replayKey(provider, scope, target) {
  return `${provider.name}\0${scope}\0${target.path.join('/')}\0${target.id || ''}\0${target.rawHash}`
}

// px-render values are block arrays; never share one object between the memo
// and a body that later stages (stale-images) may mutate.
function cloneReplayValue(value) {
  return Array.isArray(value) ? structuredClone(value) : value
}

function replayWrongModel(entry, body, config) {
  return Array.isArray(entry.value) && !pxModelAllowed(body?.model, config.pxModels)
}

// A memo entry is usable only if what it points at is still in this request:
// image blocks need a model that reads them, and a dedup/diff/read-diff marker
// needs its referent (a client can clear or drop the block it refers to).
function replayUsable(entry, body, config, hashByPath, hashes) {
  if (replayWrongModel(entry, body, config)) return false
  const ref = entry.meta.ref
  if (!ref) return true
  return ref.path ? hashByPath.get(ref.path) === ref.hash : hashes.has(ref.hash)
}

function applyReplay(body, provider, target, entry, replay) {
  // Through provider.apply so Gemini's wasObject JSON handling still runs.
  // A null entry means "went out unchanged": nothing to write, not a hit.
  if (entry.value === null) return
  provider.apply(body, [{ ...target, skip: undefined, compressed: cloneReplayValue(entry.value) }])
  replay.hits += 1
  replay.tokensHeld += (entry.meta.originalTokens || 0) - (entry.meta.compressedTokens || 0)
}

// Makes history byte-stable and keeps it redacted. Newest-group targets with a
// memo hit are replayed and skipped. Older turns (cacheSafe) are never
// compressed fresh: they get their memo entry, or failing that (restart,
// eviction, replay off) deterministic redaction only, so a masked secret
// cannot go out in clear one request later.
function stabilizeHistory(body, targets, config, provider, memo, replay) {
  // Collect older turns before touching the body: a replayed px-render array
  // would otherwise surface as new sub-text targets.
  let older = []
  if (config.cacheSafe !== false) {
    const latest = new Set(targets.filter(t => t.path).map(t => t.path.join('/')))
    older = provider.extract(body, { ...config, cacheSafe: false })
    exemptProtectedTools(older, body, provider)
    older = older.filter(t => !t.skip && typeof t.text === 'string' && !latest.has(t.path.join('/')))
  }
  if (!memo && (config.redact === false || !older.length)) return

  const scope = memo ? conversationScope(body) : ''
  const hashByPath = new Map()
  if (memo) {
    for (const t of [...older, ...targets]) {
      if (t.skip || typeof t.text !== 'string') continue
      t.rawHash = sha(t.text)
      hashByPath.set(t.path.join('/'), t.rawHash)
    }
  }
  const hashes = new Set(hashByPath.values())

  if (memo) {
    for (const target of targets) {
      if (!target.rawHash) continue
      target.replayKey = replayKey(provider, scope, target)
      const entry = memo.get(target.replayKey)
      if (!entry || !replayUsable(entry, body, config, hashByPath, hashes)) {
        // Another model's request must not overwrite images stored for this one.
        if (entry && replayWrongModel(entry, body, config)) target.replayKey = null
        replay.misses += 1
        continue
      }
      applyReplay(body, provider, target, entry, replay)
      target.skip = 'replayed'
    }
  }

  for (const target of older) {
    const key = memo && replayKey(provider, scope, target)
    const entry = memo?.get(key)
    if (entry && replayUsable(entry, body, config, hashByPath, hashes)) { applyReplay(body, provider, target, entry, replay); continue }
    if (memo) replay.misses += 1
    let value = null
    if (config.redact !== false) {
      const r = redactText(target.text, config.redactMode)
      if (r.count > 0) { value = r.text; provider.apply(body, [{ ...target, compressed: value }]) }
    }
    // Remembering the outcome (deterministic) spares the regex pass next time.
    if (memo && !(entry && replayWrongModel(entry, body, config))) memo.put(key, value, {})
  }
}

function readDiffTargets(targets, body, sessionKey, readCache, memo) {
  if (!readCache || !sessionKey) return
  const paths = extractTargetPaths(body, targets)
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]
    const path = paths[i]
    if (!path) continue
    if (target.skip || target.dedup || target.diffed || target.compressed) {
      // Even for already-compressed targets, refresh the cache with the
      // original text so the next request can diff against the latest copy.
      if (typeof target.text === 'string') {
        readCache.put(sessionKey, path, target.text)
        memo?.setAnchor?.(`${sessionKey}:${path}`, target.rawHash)
      }
      continue
    }
    if (typeof target.text !== 'string') continue

    const prior = readCache.get(sessionKey, path)
    if (prior && prior !== target.text) {
      const patch = createPatch(path, prior, target.text, '', '')
      if (patch.length < target.text.length * 0.5) {
        target.compressed = `[read-diff from prior read of ${path}]:\n${patch}`
        target.readDiffed = true
        target.refHash = memo?.getAnchor?.(`${sessionKey}:${path}`)
      }
    }
    readCache.put(sessionKey, path, target.text)
    memo?.setAnchor?.(`${sessionKey}:${path}`, target.rawHash)
  }
}

// --- Stage: disclosure (Phase 5) ---
// For tool_result bodies >= 32 KB that haven't been handled by earlier stages,
// store the full body in br-cache and replace it with a 3-tier summary block.
// Bypassed when the latest user message classifies as a dangerous task.
function discloseTargets(targets, body, provider, brCache) {
  if (!brCache || typeof brCache.put !== 'function') return 0
  if (!provider || typeof provider.getLastUserText !== 'function') return 0
  const userText = provider.getLastUserText(body) || ''
  if (isDangerousTask(userText)) return 0

  let disclosed = 0
  for (const target of targets) {
    if (target.skip || target.dedup || target.diffed || target.readDiffed || target.graphed || target.compressed) continue
    if (typeof target.text !== 'string') continue
    const byteLen = Buffer.byteLength(target.text, 'utf8')
    if (byteLen < 32 * 1024) continue

    const put = brCache.put(target.text)
    if (!put) continue
    const result = summarize(target.text, { hash: put.hash })
    if (!result) continue
    target.compressed = result.summary
    target.disclosed = true
    target.disclosedHash = result.hash
    target.disclosedOriginalBytes = result.originalBytes
    disclosed += 1
  }
  return disclosed
}

// --- Stage: bm25-trim (Phase 6) ---
// For tool_result bodies > 64 KB that survived earlier stages (including
// disclosure), rank lines by BM25 against the latest user message and drop
// low-relevance lines past a token budget. Bypassed when the latest user
// message classifies as a dangerous task — full fidelity is non-negotiable
// for security/debug/refactor/test flows.
function bm25TrimTargets(targets, body, provider) {
  if (!provider || typeof provider.getLastUserText !== 'function') return 0
  const userText = provider.getLastUserText(body) || ''
  if (!userText) return 0
  if (isDangerousTask(userText)) return 0

  // File paths let the trimmer pick a block detector by extension so dropped
  // lines respect code structure. Anthropic-only (see lib/path-extract.js);
  // elsewhere `path` is null and the trimmer sniffs the body instead.
  const paths = extractTargetPaths(body, targets)

  let trimmed = 0
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]
    if (target.skip || target.dedup || target.diffed || target.readDiffed || target.graphed || target.disclosed || target.compressed) continue
    if (typeof target.text !== 'string') continue
    const byteLen = Buffer.byteLength(target.text, 'utf8')
    if (byteLen <= 64 * 1024) continue

    const result = trimLinesByRelevance(target.text, userText, { path: paths[i] })
    if (!result) continue
    if (result.text.length >= target.text.length) continue
    target.compressed = result.text
    target.bm25Trimmed = true
    target.bm25KeptLines = result.keptLines
    target.bm25DroppedLines = result.droppedLines
    target.bm25OriginalTokens = result.originalTokens
    target.bm25TrimmedTokens = result.trimmedTokens
    trimmed += 1
  }
  return trimmed
}

// --- Stage: prune ---
// Unambiguously npm-internal keys — safe to drop regardless of value.
const PRUNE_KEYS = new Set(['_from', '_resolved', '_integrity', '_nodeVersion', '_npmVersion', '_phantomChildren', '_requiredBy'])
// `_id` / `integrity` / `shasum` are common field names; only drop them when the
// value is actually npm metadata, so a legitimately-named field (e.g.
// integrity:"high", or a MongoDB `_id` document key) in a non-npm tool_result is
// preserved. npm's `_id` is always `name@version` (optionally @scope/-prefixed).
const NPM_INTEGRITY = /^sha\d{1,3}-[A-Za-z0-9+/]+={0,2}$/
const NPM_SHASUM = /^[a-f0-9]{40}$/i
const NPM_PKG_ID = /^(@[\w.-]+\/)?[\w.-]+@\d[\w.\-+]*$/

function shouldPrune(key, val) {
  if (PRUNE_KEYS.has(key)) return true
  if (typeof val !== 'string') return false
  if (key === '_id' && NPM_PKG_ID.test(val)) return true
  if (key === 'resolved' && val.startsWith('https://registry.')) return true
  if (key === 'integrity' && NPM_INTEGRITY.test(val)) return true
  if (key === 'shasum' && NPM_SHASUM.test(val)) return true
  return false
}

function deepPrune(obj) {
  if (Array.isArray(obj)) return obj.map(deepPrune)
  if (obj === null || typeof obj !== 'object') return obj
  const result = {}
  for (const [key, val] of Object.entries(obj)) {
    if (shouldPrune(key, val)) continue
    result[key] = deepPrune(val)
  }
  return result
}

function pruneJSON(text) {
  const { ok, value } = tryParseJSON(text)
  if (!ok) return null
  const pruned = deepPrune(value)
  const minified = JSON.stringify(pruned)
  if (minified.length >= text.length * 0.95) return null
  return { value: pruned, minified }
}

// --- Stage: strip-comments (opt-in, not in defaults) ---
const HASH_DIRECTIVE_RE = /^#(?:!|include\b|define\b|pragma\b|if(?:n?def)?\b|elif\b|else\b|endif\b|region\b|endregion\b|\[)/
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}(?![0-9a-fA-F_])/

function stripLineComments(line) {
  let inSingle = false, inDouble = false, inTemplate = false, escaped = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inSingle || inDouble || inTemplate) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === "'" && inSingle) { inSingle = false; continue }
      if (ch === '"' && inDouble) { inDouble = false; continue }
      if (ch === '`' && inTemplate) { inTemplate = false; continue }
      continue
    }
    if (ch === "'") { inSingle = true; continue }
    if (ch === '"') { inDouble = true; continue }
    if (ch === '`') { inTemplate = true; continue }
    if (ch === '/' && line[i + 1] === '/') return line.slice(0, i).trimEnd()
    if (ch === '#') {
      const before = line.slice(0, i)
      const atLineStart = before.trim().length === 0
      const afterWs = i > 0 && (line[i - 1] === ' ' || line[i - 1] === '\t')
      if (!atLineStart && !afterWs) continue
      const rest = line.slice(i)
      if (atLineStart && HASH_DIRECTIVE_RE.test(rest)) continue
      if (HEX_COLOR_RE.test(rest)) continue
      return before.trimEnd()
    }
  }
  return line
}

// Remove line-level `/* ... */` block comments (opener at start of line after
// optional spaces/tabs) and `<!-- ... -->` HTML comments, in ONE linear pass.
// A regex can't do this without O(n^2): `/^[ \t]*\/\*[\s\S]*?\*\//gm` rescans to
// EOF at every unclosed opener, so a file full of `/*` line-starts stalled the
// event loop (256 KB took ~40s). An unterminated comment is left unchanged, to
// match the old lazy regex (which required a closing delimiter to match).
function stripBlockAndHtmlComments(text) {
  let out = ''
  let i = 0
  const n = text.length
  let lineStart = true
  while (i < n) {
    if (lineStart) {
      let j = i
      while (j < n && (text[j] === ' ' || text[j] === '\t')) j++
      if (text[j] === '/' && text[j + 1] === '*') {
        const close = text.indexOf('*/', j + 2)
        if (close === -1) { out += text.slice(i); break }
        i = close + 2
        lineStart = false
        continue
      }
    }
    if (text[i] === '<' && text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4)
      if (close === -1) { out += text.slice(i); break }
      i = close + 3
      lineStart = false
      continue
    }
    const c = text[i]
    out += c
    lineStart = c === '\n'
    i++
  }
  return out
}

function stripComments(text) {
  let result = stripBlockAndHtmlComments(text)
  result = result.split('\n').map(stripLineComments).join('\n')
  return result.replace(/\n\s*\n\s*\n/g, '\n\n')
}

// SSRF guard: only allow http/https loopback URLs (handles IPv6 [::1] and rejects 127.evil.com).
export function isLoopbackUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const hostname = parsed.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
    if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) {
      return hostname.split('.').every(octet => Number(octet) <= 255)
    }
    return false
  } catch {
    return false
  }
}

// --- Stage: textpress (opt-in, uses Ollama or OpenRouter free model) ---
const TEXTPRESS_PROMPT = 'You are an expert at making text more concise without changing its meaning. Don\'t reword, don\'t improve. Find ways to combine and shorten. Keep ALL names, versions, paths, function signatures, numbers. Return ONLY the shortened text. No explanations.'

async function textpressCompress(text, config) {
  if (text.length < 200) return null

  // Try Ollama first (local, free, no rate limits)
  const ollamaUrl = config.textpressOllamaUrl || 'http://localhost:11434'
  const ollamaModel = config.textpressOllamaModel || 'qwen3.5:0.8b'

  // SSRF protection: only allow loopback URLs
  let validatedUrl
  try {
    if (!isLoopbackUrl(ollamaUrl)) return null
    validatedUrl = new URL(ollamaUrl.replace(/\/+$/, '') + '/api/chat')
    if (!isLoopbackUrl(validatedUrl.href)) return null
  } catch {
    return null
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const res = await fetch(validatedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          messages: [{ role: 'system', content: TEXTPRESS_PROMPT }, { role: 'user', content: text }],
          stream: false,
          options: { temperature: 0, num_predict: Math.ceil(text.length * 0.7) },
          think: false,
        }),
        signal: controller.signal,
      })
      if (res.ok) {
        const data = await res.json()
        const output = (data.message?.content || '').trim()
        if (output.length > 0 && output.length < text.length * 0.9) return output
      }
    } finally { clearTimeout(timeout) }
  } catch { /* Ollama not available, try OpenRouter */ }

  // Fallback: OpenRouter free model
  const orKey = config.textpressApiKey || process.env.OPENROUTER_API_KEY
  if (!orKey) return null
  const orModel = config.textpressModel || 'google/gemini-3.1-flash-lite-preview'
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${orKey}` },
        body: JSON.stringify({
          model: orModel,
          messages: [{ role: 'system', content: TEXTPRESS_PROMPT }, { role: 'user', content: text }],
          max_tokens: Math.ceil(text.length * 0.5),
          temperature: 0,
        }),
        signal: controller.signal,
      })
      if (res.ok) {
        const data = await res.json()
        const output = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
        if (output.length > 0 && output.length < text.length * 0.9) return output
      }
    } finally { clearTimeout(timeout) }
  } catch { /* OpenRouter not available */ }

  return null
}

// Content an agent must be able to copy back out byte for byte. Neural
// compressors paraphrase, and a paraphrased path is a broken path.
const VERBATIM_CRITICAL = [
  /(?:^|[\s"'(=])\.{0,2}\/[\w.\-]+\/[\w.\-]+/, // /usr/local, ./src/app, ../a/b
  /[A-Za-z]:\\[\w.\-]+\\/,                      // C:\Users\x\
  /\bhttps?:\/\//,                              // urls
  /"\s*:\s*/,                                   // json key/value separators
  /[{[]\s*"/,                                   // json object/array openers
  /\b[0-9a-f]{7,}\b/,                           // sha/commit/hex ids
  /\bv?\d+\.\d+\.\d+\b/,                        // semver
]

export function hasVerbatimCriticalContent(text) {
  return VERBATIM_CRITICAL.some(re => re.test(text))
}

// --- Core compression ---
export function compressText(text, config) {
  if (text.length < config.minSize) { if (config.log !== false) process.stderr.write(`[tamp]   skip: too small (${text.length} < ${config.minSize})\n`); return null }
  const cls = classifyContent(text)
  if (cls === 'toon') { if (config.log !== false) process.stderr.write(`[tamp]   skip: classified as toon (first 80: ${text.slice(0, 80).replace(/\n/g, '\\n')})\n`); return null }

  if (cls === 'text') {
    let processed = text
    let cmdStripRewriter = null
    let cmdStripLen = text.length
    if (config.stages.includes('cmd-strip')) {
      const out = rewriteCommandOutput(processed)
      if (out.rewriter && out.text.length < processed.length) {
        processed = out.text
        cmdStripRewriter = out.rewriter
        cmdStripLen = processed.length
      }
    }
    if (config.stages.includes('strip-lines')) {
      const stripped = stripLineNumbers(processed)
      if (stripped !== processed) processed = stripped
    }
    if (config.stages.includes('whitespace')) {
      processed = normalizeWhitespace(processed)
    }
    if (config.stages.includes('strip-comments')) {
      processed = stripComments(processed)
    }
    if (processed.length < text.length * 0.9) {
      // If cmd-strip produced the savings and downstream stages didn't improve it further,
      // surface the rewriter identifier in the method name so stats are legible.
      const method = (cmdStripRewriter && processed.length === cmdStripLen)
        ? `cmd-strip:${cmdStripRewriter}`
        : 'normalize'
      return { text: processed, method, originalLen: text.length, compressedLen: processed.length, originalTokens: countTokens(text), compressedTokens: countTokens(processed) }
    }
    const hasNeuralStage = (config.stages.includes('llmlingua') && config.llmLinguaUrl)
      || (config.stages.includes('foundation-models') && config.foundationModelsPath)
      || config.stages.includes('textpress')

    if (hasNeuralStage) {
      // Neural/LLM compressors paraphrase. On tool output they drop or alter
      // characters inside tokens the agent has to reuse verbatim:
      //   /Users/x/.config/tamp/tamp.err.log -> /Users/x./tamp..
      //   "version":"0.8.17"                 -> "version""0.. 17"
      // A path the agent cannot cat is worse than a payload it cannot shrink,
      // so anything carrying paths, URLs, JSON or hashes skips ALL neural stages
      // (llmlingua, foundation-models, and textpress).
      if (hasVerbatimCriticalContent(processed)) {
        if (config.log !== false) process.stderr.write('[tamp]   skip: neural stages (verbatim-critical content: paths/JSON/urls/hashes)\n')
      } else {
        if (config.stages.includes('llmlingua') && config.llmLinguaUrl) {
          return { async: true, asyncMethod: 'llmlingua', text: processed, cls }
        }
        if (config.stages.includes('foundation-models') && config.foundationModelsPath) {
          return { async: true, asyncMethod: 'foundation-models', text: processed, cls }
        }
        if (config.stages.includes('textpress')) {
          return { async: true, asyncMethod: 'textpress', text: processed, cls }
        }
      }
    }
    if (config.log !== false) process.stderr.write(`[tamp]   skip: text not compressible (${config.stages.includes('llmlingua') && !config.llmLinguaUrl ? 'no llmlingua sidecar' : 'whitespace savings < 10%'})\n`)
    return null
  }

  if (cls !== 'json' && cls !== 'json-lined') return null

  let raw = cls === 'json-lined' ? stripLineNumbers(text) : text

  // Integers beyond 2^53 lose precision through JSON.parse/stringify, silently
  // corrupting numeric ids/amounts. We can't compress such JSON without changing
  // its meaning, so forward it untouched.
  if (jsonHasUnsafeInteger(raw)) return null

  // Prune low-value fields before minifying
  let parsedValue
  if (config.stages.includes('prune')) {
    const pruned = pruneJSON(raw)
    if (pruned) {
      parsedValue = pruned.value
      raw = pruned.minified
    }
  }

  if (!parsedValue) {
    const { ok, value } = tryParseJSON(raw)
    if (!ok) return null
    parsedValue = value
  }

  const minified = JSON.stringify(parsedValue)
  if (minified.length >= text.length) return null

  let best = { text: minified, method: 'minify' }

  if (config.stages.includes('toon')) {
    try {
      const tooned = encode(parsedValue)
      if (tooned.length < best.text.length) {
        best = { text: tooned, method: 'toon' }
      }
    } catch { /* fall back to minified */ }
  }

  return { text: best.text, method: best.method, originalLen: text.length, compressedLen: best.text.length, originalTokens: countTokens(text), compressedTokens: countTokens(best.text) }
}

async function compressWithLLMLingua(text, config) {
  try {
    // SSRF protection: only allow loopback URLs
    let url
    try {
      if (!isLoopbackUrl(config.llmLinguaUrl)) return null
      url = new URL(config.llmLinguaUrl.replace(/\/+$/, '') + '/compress')
      if (!isLoopbackUrl(url.href)) return null
    } catch {
      return null
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, rate: config.llmLinguaRate || 0.7 }),
        signal: controller.signal,
      })
      if (!res.ok) return null
      const data = await res.json()
      return { text: data.text, method: 'llmlingua', originalLen: text.length, compressedLen: data.text.length, originalTokens: countTokens(text), compressedTokens: countTokens(data.text) }
    } finally { clearTimeout(timeout) }
  } catch {
    return null
  }
}

async function compressWithFoundationModels(text, config) {
  if (!config.foundationModelsPath) return null
  if (Buffer.byteLength(text, 'utf8') > 65536) return null

  // Validate foundationModelsPath to prevent command injection
  const cmdPath = config.foundationModelsPath

  // Reject shell metacharacters and command injection attempts
  const dangerousChars = /[;&|`$()<>]/
  if (dangerousChars.test(cmdPath)) {
    return null
  }

  // Allow only simple command names (no path separators) or absolute paths
  if (cmdPath.includes('/') || cmdPath.includes('\\')) {
    // If it contains path separators, must be an absolute path
    if (!cmdPath.startsWith('/')) {
      return null
    }
    // Additional check: prevent path traversal in absolute paths
    const normalizedPath = cmdPath.replace(/\.\./g, '')
    if (normalizedPath !== cmdPath) {
      return null
    }
  }

  const SYSTEM_PROMPT = config.foundationModelsSystemPrompt ||
    'Compress this text to 50% length while preserving all key information and meaning. Return only the compressed text without explanation.'

  try {
    const args = [
      '-o', 'json',
      '-s', SYSTEM_PROMPT,
      '--max-tokens', String(Math.floor(text.length * 0.7)),
      '--quiet',
      text
    ]

    const proc = spawn(config.foundationModelsPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let responseData = ''
    proc.stdout.on('data', (chunk) => {
      responseData += chunk.toString()
    })

    const timeoutMs = config.foundationModelsTimeout || 10000
    const response = await new Promise((resolve, reject) => {
      // Bound the subprocess: a hung apfel must not hang the request forever.
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* already gone */ }
        reject(new Error(`apfel timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 5) {
          reject(new Error('FoundationModels not available (requires macOS 15+, Apple Silicon)'))
          return
        }
        if (code !== 0) {
          reject(new Error(`apfel exited with code ${code}`))
          return
        }
        try {
          const data = JSON.parse(responseData)
          resolve(data)
        } catch (err) {
          reject(new Error(`Failed to parse apfel JSON output: ${err.message}`))
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    const compressedText = response.content || response.compressedText
    if (!compressedText || compressedText.length >= text.length * 0.9) return null

    return {
      text: compressedText,
      method: 'foundation-models',
      originalLen: text.length,
      compressedLen: compressedText.length,
      originalTokens: countTokens(text),
      compressedTokens: countTokens(compressedText),
    }
  } catch {
    return null
  }
}

function configFingerprint(config) {
  const stages = Array.isArray(config?.stages) ? config.stages.join(',') : ''
  const minSize = config?.minSize ?? ''
  const ll = config?.llmLinguaUrl ? `${config.llmLinguaUrl}@${config.llmLinguaRate || 0.7}` : ''
  const tp = config?.stages?.includes('textpress')
    ? `${config.textpressOllamaUrl || ''}|${config.textpressOllamaModel || ''}|${config.textpressModel || ''}`
    : ''
  const fm = config?.foundationModelsPath || ''
  return `${stages}\0${minSize}\0${ll}\0${tp}\0${fm}`
}

export async function compressBlock(text, config) {
  const key = `${configFingerprint(config)}\0${cacheKey(text)}`
  if (cache.has(key)) return cache.get(key)

  const sync = compressText(text, config)
  let result
  if (sync && sync.async) {
    if (sync.asyncMethod === 'textpress') {
      const compressed = await textpressCompress(sync.text, config)
      result = compressed ? { text: compressed, method: 'textpress', originalLen: text.length, compressedLen: compressed.length, originalTokens: countTokens(text), compressedTokens: countTokens(compressed) } : null
    } else if (sync.asyncMethod === 'foundation-models') {
      result = await compressWithFoundationModels(sync.text, config)
    } else {
      result = await compressWithLLMLingua(sync.text, config)
    }
  } else {
    result = sync
  }

  if (result) {
    if (cache.size >= MAX_CACHE) {
      const firstKey = cache.keys().next().value
      cache.delete(firstKey)
    }
    cache.set(key, result)
  }
  return result
}

// Caveman-style output compression: append task-type-aware rules to the
// LATEST user message. Cache-safe — only the freshest message is touched,
// so the prefix (system prompt + earlier turns) stays cacheable.
function maybeInjectOutputHint(body, config, provider) {
  const mode = config.outputMode
  if (!mode || mode === 'off') return null
  if (typeof provider.injectOutputHint !== 'function') return null
  if (typeof provider.getLastUserText !== 'function') return null

  const userText = provider.getLastUserText(body)
  if (!userText) return null

  const taskType = config.autoDetectTaskType === false ? 'complex' : detectTaskType(userText)
  const rules = generateOutputRules(mode, taskType, config.agent)
  if (!rules) return null

  // Keep the injected hint compact and clearly marked so the model knows
  // it's a system-style instruction and not part of the user's prose.
  const wrapped = `[tamp output rules — ${mode} mode, ${taskType} task]\n${rules.trim()}`
  const ok = provider.injectOutputHint(body, wrapped)
  return ok ? { mode, taskType, bytes: wrapped.length } : null
}

export async function compressRequest(body, config, provider) {
  // Phase 5: before any stage runs, rehydrate <tamp-ref:v1:...> markers the
  // model quoted back from a prior turn. Must happen first so downstream
  // stages see the expanded body if relevant.
  let disclosureStats = null
  if (config.stages?.includes('disclosure') && config.brCache) {
    const rh = rehydrateReferences(body, provider, config.brCache)
    if (rh.rehydrated || rh.missed) disclosureStats = { rehydrated: rh.rehydrated, missed: rh.missed, disclosed: 0 }
  }

  const outputHint = maybeInjectOutputHint(body, config, provider)

  const targets = provider.extract(body, { ...config, cacheSafe: config.cacheSafe !== false })

  // Exempt recorded user decisions before any stage sees them. Re-running
  // AskUserQuestion would re-prompt the human, so its result is the one body
  // in a transcript that cannot be regenerated — the same reasoning that
  // already exempts errored results at extract time. These bodies are tiny,
  // so the forgone compression costs nothing.
  exemptProtectedTools(targets, body, provider)

  // Before redaction, so memo keys hash the raw text the client sent.
  const memo = config.replayMemo || null
  const replay = memo ? { hits: 0, misses: 0, tokensHeld: 0 } : null
  stabilizeHistory(body, targets, config, provider, memo, replay)

  // Redaction runs FIRST (security, not compression): mask secrets in every
  // target's text before any stage — dedup/diff/cache/llmlingua/textpress —
  // sees it, so secrets never enter a disk cache or get shipped to a third
  // party. We mutate target.text in place so the whole pipeline operates on
  // the redacted body; the non-compressible case is closed in the loop below.
  let redactedCount = 0
  if (config.redact !== false) {
    for (const target of targets) {
      // Replayed targets are already masked on the wire, but read-diff still
      // caches their text; a raw prior there would leak via a later patch.
      if ((target.skip && target.skip !== 'replayed') || typeof target.text !== 'string') continue
      const r = redactText(target.text, config.redactMode)
      if (r.count > 0) { target.text = r.text; target.redacted = true; redactedCount += r.count }
    }
  }

  // Read-diff: session-scoped unified diff for re-reads (lossless, opt-in)
  if (config.stages.includes('read-diff') && config.readCache && config.sessionKey) {
    readDiffTargets(targets, body, config.sessionKey, config.readCache, config.replayMemo)
  }

  // Dedup: replace identical blocks with reference markers
  if (config.stages.includes('dedup')) deduplicateTargets(targets)

  // Diff: replace similar blocks with unified diffs
  if (config.stages.includes('diff')) diffTargets(targets)

  // Graph: session-scoped dedup across requests (opt-in)
  if (config.stages.includes('graph') && config.sessionBucket) {
    graphDeduplicateTargets(targets, config.sessionBucket)
  }

  // Disclosure: progressive 3-tier summary for huge tool_results (opt-in, lossy)
  if (config.stages.includes('disclosure') && config.brCache && provider.name === 'anthropic') {
    const n = discloseTargets(targets, body, provider, config.brCache)
    if (n > 0) {
      disclosureStats = disclosureStats || { rehydrated: 0, missed: 0, disclosed: 0 }
      disclosureStats.disclosed += n
    }
  }

  // BM25-trim: query-aware line drop for huge tool_results (opt-in, lossy)
  if (config.stages.includes('bm25-trim')) {
    bm25TrimTargets(targets, body, provider)
  }

  // px-render: image large dense tool_results for legible models (opt-in, lossy).
  // Runs after bm25-trim so query-aware trimming keeps first claim on huge
  // blocks; px-render picks up dense blocks bm25 declined or can't see.
  if (config.stages.includes('px-render')) {
    await pxRenderTargets(targets, body, provider, {
      pxModels: config.pxModels,
      pxMinChars: config.pxMinChars,
      pxMaxImages: config.pxMaxImages,
      isDangerousTask,
    })
  }

  const stats = []
  for (const target of targets) {
    if (target.skip) { stats.push({ index: target.index, skipped: target.skip }); continue }

    // Dedup/diff/graph already set .compressed — record stats and skip compression
    if (target.dedup) {
      stats.push({ index: target.index, method: 'dedup', originalLen: target.text.length, compressedLen: target.compressed.length, originalTokens: countTokens(target.text), compressedTokens: countTokens(target.compressed) })
      continue
    }
    if (target.diffed) {
      stats.push({ index: target.index, method: 'diff', originalLen: target.text.length, compressedLen: target.compressed.length, originalTokens: countTokens(target.text), compressedTokens: countTokens(target.compressed) })
      continue
    }
    if (target.readDiffed) {
      stats.push({ index: target.index, method: 'read-diff', originalLen: target.text.length, compressedLen: target.compressed.length, originalTokens: countTokens(target.text), compressedTokens: countTokens(target.compressed) })
      continue
    }
    if (target.graphed) {
      stats.push({ index: target.index, method: 'graph', originalLen: target.text.length, compressedLen: target.compressed.length, originalTokens: countTokens(target.text), compressedTokens: countTokens(target.compressed) })
      continue
    }
    if (target.disclosed) {
      stats.push({ index: target.index, method: 'disclosure', originalLen: target.text.length, compressedLen: target.compressed.length, originalTokens: countTokens(target.text), compressedTokens: countTokens(target.compressed) })
      continue
    }
    if (target.bm25Trimmed) {
      stats.push({ index: target.index, method: 'bm25-trim', originalLen: target.text.length, compressedLen: target.compressed.length, originalTokens: target.bm25OriginalTokens ?? countTokens(target.text), compressedTokens: target.bm25TrimmedTokens ?? countTokens(target.compressed) })
      continue
    }
    if (target.pxRendered) {
      // compressed is a block array (images + factsheet); token counts were
      // computed at render time from pixel area, not text length.
      stats.push({ index: target.index, method: 'px-render', originalLen: target.text.length, compressedLen: JSON.stringify(target.compressed).length, originalTokens: target.pxOriginalTokens, compressedTokens: target.pxCompressedTokens, images: target.pxImageCount })
      continue
    }

    const result = await compressBlock(target.text, config)
    if (result) {
      target.compressed = result.text
      stats.push({ index: target.index, ...result })
    } else if (target.redacted) {
      // Not otherwise compressible, but it was redacted — apply() only writes
      // back when .compressed is set, so push the redacted text through.
      target.compressed = target.text
      stats.push({ index: target.index, method: 'redact', originalLen: target.text.length, compressedLen: target.text.length, originalTokens: countTokens(target.text), compressedTokens: countTokens(target.text) })
    } else {
      stats.push({ index: target.index, skipped: 'not-compressible' })
    }
  }
  provider.apply(body, targets)

  // Remember what went out. stats[i] belongs to targets[i]: the loop above
  // pushes exactly one entry per target.
  if (memo) {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]
      if (!target.replayKey || target.skip) continue
      // A marker is replayable only while its referent can be re-checked.
      // graph refs point into session state the memo cannot see: not stored.
      let ref
      if (target.graphed) continue
      if (target.dedup || target.diffed) ref = { path: target.refTarget.path.join('/'), hash: target.refTarget.rawHash }
      else if (target.readDiffed) { if (!target.refHash) continue; ref = { hash: target.refHash } }
      const value = target.compressed ? cloneReplayValue(target.compressed) : null
      memo.put(target.replayKey, value, { originalTokens: stats[i].originalTokens, compressedTokens: stats[i].compressedTokens, ref })
    }
  }

  // stale-images: drop base64 images from older turns (opt-in, lossy). Runs
  // after apply so the extractor never sees the notices it leaves behind.
  let staleImages = null
  if (config.stages.includes('stale-images') && provider.name === 'anthropic') {
    const r = evictStaleImages(body, { keepRecent: config.staleImageKeepRecent, batchSize: config.staleBatchSize })
    if (r.evicted > 0) staleImages = r
  }

  // stale-inputs: drop payloads from older tool calls (opt-in, lossy).
  let staleInputs = null
  if (config.stages.includes('stale-inputs') && STALE_INPUTS_PROVIDERS.has(provider.name)) {
    const r = pruneStaleInputs(body, { keepRecent: config.staleInputKeepRecent, batchSize: config.staleBatchSize })
    if (r.pruned > 0) staleInputs = r
  }

  return { body, stats, targetCount: targets.length, outputHint, disclosure: disclosureStats, redacted: redactedCount, staleImages, staleInputs, replay }
}

export async function compressMessages(body, config) {
  if (!body?.messages?.length) return { body, stats: [] }
  return compressRequest(body, config, anthropic)
}
