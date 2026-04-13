import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { encode } from '@toon-format/toon'
import { countTokens } from '@anthropic-ai/tokenizer'
import { createPatch } from 'diff'
import { tryParseJSON, classifyContent, stripLineNumbers } from './detect.js'
import { anthropic } from './providers.js'
import { graphDeduplicateTargets } from './session-graph.js'

const cache = new Map()
const MAX_CACHE = 500

function cacheKey(text) {
  if (text.length < 128) return text
  return createHash('sha256').update(text).digest('base64')
}

export function clearCache() { cache.clear() }

function normalizeWhitespace(text) {
  return text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
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
      target.compressed = ref
      target.dedup = true
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
    if (target.text.length < 200) { seen.push(target); continue }

    for (const prev of seen) {
      const sim = quickSimilarity(prev.text, target.text)
      if (sim > 0.5 && sim < 1.0) {
        const patch = createPatch('file', prev.text, target.text, '', '', { context: 1 })
        // Strip the patch header (first 4 lines: ---, +++, index, etc.)
        const lines = patch.split('\n')
        const bodyStart = lines.findIndex(l => l.startsWith('@@'))
        if (bodyStart === -1) continue
        const diffBody = lines.slice(bodyStart).join('\n')
        if (diffBody.length < target.text.length * 0.5) {
          target.compressed = `[diff from tool_result in message ${prev.path[1]}, block ${prev.index}]:\n${diffBody}`
          target.diffed = true
          break
        }
      }
    }
    seen.push(target)
  }
}

function quickSimilarity(a, b) {
  if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.5) return 0
  const setA = new Set(a.split('\n'))
  const setB = new Set(b.split('\n'))
  const intersection = [...setA].filter(x => setB.has(x)).length
  const union = new Set([...setA, ...setB]).size
  return union > 0 ? intersection / union : 0
}

// --- Stage: prune ---
const PRUNE_KEYS = new Set(['integrity', 'shasum', '_id', '_from', '_resolved', '_integrity', '_nodeVersion', '_npmVersion', '_phantomChildren', '_requiredBy'])

function shouldPrune(key, val) {
  if (PRUNE_KEYS.has(key)) return true
  if (key === 'resolved' && typeof val === 'string' && val.startsWith('https://registry.')) return true
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
function stripLineComments(line) {
  let inSingle = false, inDouble = false, inTemplate = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    const prev = i > 0 ? line[i - 1] : ''
    if (prev === '\\') continue
    if (ch === "'" && !inDouble && !inTemplate) { inSingle = !inSingle; continue }
    if (ch === '"' && !inSingle && !inTemplate) { inDouble = !inDouble; continue }
    if (ch === '`' && !inSingle && !inDouble) { inTemplate = !inTemplate; continue }
    if (inSingle || inDouble || inTemplate) continue
    if (ch === '/' && line[i + 1] === '/') return line.slice(0, i).trimEnd()
    if (ch === '#' && !line.startsWith('#!')) return line.slice(0, i).trimEnd()
  }
  return line
}

function stripComments(text) {
  // Block comments: only strip if they start at line-level (not inside strings)
  let result = text
    .replace(/^[ \t]*\/\*\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  result = result.split('\n').map(stripLineComments).join('\n')
  return result.replace(/\n\s*\n\s*\n/g, '\n\n')
}

// --- Stage: textpress (opt-in, uses Ollama or OpenRouter free model) ---
const TEXTPRESS_PROMPT = 'You are an expert at making text more concise without changing its meaning. Don\'t reword, don\'t improve. Find ways to combine and shorten. Keep ALL names, versions, paths, function signatures, numbers. Return ONLY the shortened text. No explanations.'

async function textpressCompress(text, config) {
  if (text.length < 200) return null

  // Try Ollama first (local, free, no rate limits)
  const ollamaUrl = config.textpressOllamaUrl || 'http://localhost:11434'
  const ollamaModel = config.textpressOllamaModel || 'qwen3.5:0.8b'

  // SSRF protection: only allow localhost URLs
  let validatedUrl
  try {
    const parsed = new URL(ollamaUrl)
    const hostname = parsed.hostname.toLowerCase()
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1' && !hostname.startsWith('127.')) {
      return null
    }
    validatedUrl = parsed
  } catch {
    return null
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const res = await fetch(`${validatedUrl}/api/chat`, {
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

// --- Core compression ---
export function compressText(text, config) {
  if (text.length < config.minSize) { if (config.log !== false) process.stderr.write(`[tamp]   skip: too small (${text.length} < ${config.minSize})\n`); return null }
  const cls = classifyContent(text)
  if (cls === 'toon') { if (config.log !== false) process.stderr.write(`[tamp]   skip: classified as toon (first 80: ${text.slice(0, 80).replace(/\n/g, '\\n')})\n`); return null }

  if (cls === 'text') {
    let processed = text
    if (config.stages.includes('strip-lines')) {
      const stripped = stripLineNumbers(text)
      if (stripped !== text) processed = stripped
    }
    if (config.stages.includes('whitespace')) {
      processed = normalizeWhitespace(processed)
    }
    if (config.stages.includes('strip-comments')) {
      processed = stripComments(processed)
    }
    if (processed.length < text.length * 0.9) {
      return { text: processed, method: 'normalize', originalLen: text.length, compressedLen: processed.length, originalTokens: countTokens(text), compressedTokens: countTokens(processed) }
    }
    if (config.stages.includes('llmlingua') && config.llmLinguaUrl) {
      return { async: true, asyncMethod: 'llmlingua', text: processed, cls }
    }
    if (config.stages.includes('foundation-models') && config.foundationModelsPath) {
      return { async: true, asyncMethod: 'foundation-models', text: processed, cls }
    }
    if (config.stages.includes('textpress')) {
      return { async: true, asyncMethod: 'textpress', text: processed, cls }
    }
    if (config.log !== false) process.stderr.write(`[tamp]   skip: text not compressible (${config.stages.includes('llmlingua') && !config.llmLinguaUrl ? 'no llmlingua sidecar' : 'whitespace savings < 10%'})\n`)
    return null
  }

  if (cls !== 'json' && cls !== 'json-lined') return null

  let raw = cls === 'json-lined' ? stripLineNumbers(text) : text

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
    // SSRF protection: only allow localhost URLs
    let url
    try {
      url = new URL(config.llmLinguaUrl + '/compress')
      const hostname = url.hostname.toLowerCase()
      if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1' && !hostname.startsWith('127.')) {
        return null
      }
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

    const response = await new Promise((resolve, reject) => {
      proc.on('close', (code) => {
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

async function compressBlock(text, config) {
  const key = cacheKey(text)
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

export async function compressRequest(body, config, provider) {
  const targets = provider.extract(body, { ...config, cacheSafe: config.cacheSafe !== false })

  // Dedup: replace identical blocks with reference markers
  if (config.stages.includes('dedup')) deduplicateTargets(targets)

  // Diff: replace similar blocks with unified diffs
  if (config.stages.includes('diff')) diffTargets(targets)

  // Graph: session-scoped dedup across requests (opt-in)
  if (config.stages.includes('graph') && config.sessionBucket) {
    graphDeduplicateTargets(targets, config.sessionBucket)
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
    if (target.graphed) {
      stats.push({ index: target.index, method: 'graph', originalLen: target.text.length, compressedLen: target.compressed.length, originalTokens: countTokens(target.text), compressedTokens: countTokens(target.compressed) })
      continue
    }

    const result = await compressBlock(target.text, config)
    if (result) {
      target.compressed = result.text
      stats.push({ index: target.index, ...result })
    } else {
      stats.push({ index: target.index, skipped: 'not-compressible' })
    }
  }
  provider.apply(body, targets)
  return { body, stats, targetCount: targets.length }
}

export async function compressMessages(body, config) {
  if (!body?.messages?.length) return { body, stats: [] }
  return compressRequest(body, config, anthropic)
}
