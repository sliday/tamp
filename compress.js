import { encode } from '@toon-format/toon'
import { countTokens } from '@anthropic-ai/tokenizer'
import { createPatch } from 'diff'
import { tryParseJSON, classifyContent, stripLineNumbers } from './detect.js'
import { anthropic } from './providers.js'

const cache = new Map()
const MAX_CACHE = 500

function cacheKey(text) {
  if (text.length < 128) return text
  return `${text.length}:${text.slice(0, 64)}:${text.slice(-64)}`
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
  const result = JSON.stringify(pruned, null, 2)
  if (result.length >= text.length * 0.95) return null
  return result
}

// --- Stage: strip-comments (opt-in, not in defaults) ---
function stripComments(text) {
  return text
    .replace(/\/\*\*[\s\S]*?\*\//g, '')  // JSDoc /** ... */
    .replace(/\/\*[\s\S]*?\*\//g, '')     // block /* ... */
    .replace(/\/\/.*$/gm, '')             // line // ...
    .replace(/^\s*#(?!!).*$/gm, '')       // Python/shell # (not #!)
    .replace(/<!--[\s\S]*?-->/g, '')      // HTML <!-- ... -->
    .replace(/\n\s*\n\s*\n/g, '\n\n')    // collapse resulting blank lines
}

// --- Core compression ---
export function compressText(text, config) {
  if (text.length < config.minSize) return null
  const cls = classifyContent(text)
  if (cls === 'toon') return null

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
      return { async: true, text: processed, cls }
    }
    return null
  }

  if (cls !== 'json' && cls !== 'json-lined') return null

  let raw = cls === 'json-lined' ? stripLineNumbers(text) : text

  // Prune low-value fields before minifying
  if (config.stages.includes('prune')) {
    const pruned = pruneJSON(raw)
    if (pruned) raw = pruned
  }

  const { ok, value } = tryParseJSON(raw)
  if (!ok) return null

  const minified = JSON.stringify(value)
  if (minified.length >= text.length) return null

  let best = { text: minified, method: 'minify' }

  if (config.stages.includes('toon')) {
    try {
      const tooned = encode(value)
      if (tooned.length < best.text.length) {
        best = { text: tooned, method: 'toon' }
      }
    } catch { /* fall back to minified */ }
  }

  return { text: best.text, method: best.method, originalLen: text.length, compressedLen: best.text.length, originalTokens: countTokens(text), compressedTokens: countTokens(best.text) }
}

async function compressWithLLMLingua(text, config) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(config.llmLinguaUrl + '/compress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, rate: 0.5 }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) return null
    const data = await res.json()
    return { text: data.text, method: 'llmlingua', originalLen: text.length, compressedLen: data.text.length, originalTokens: countTokens(text), compressedTokens: countTokens(data.text) }
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
    result = await compressWithLLMLingua(sync.text, config)
  } else {
    result = sync
  }

  if (cache.size >= MAX_CACHE) {
    const firstKey = cache.keys().next().value
    cache.delete(firstKey)
  }
  cache.set(key, result)
  return result
}

export async function compressRequest(body, config, provider) {
  const targets = provider.extract(body)

  // Dedup: replace identical blocks with reference markers
  if (config.stages.includes('dedup')) deduplicateTargets(targets)

  // Diff: replace similar blocks with unified diffs
  if (config.stages.includes('diff')) diffTargets(targets)

  const stats = []
  for (const target of targets) {
    if (target.skip) { stats.push({ index: target.index, skipped: target.skip }); continue }

    // Dedup/diff already set .compressed — record stats and skip compression
    if (target.dedup) {
      stats.push({ index: target.index, method: 'dedup', originalLen: target.text.length, compressedLen: target.compressed.length, originalTokens: countTokens(target.text), compressedTokens: countTokens(target.compressed) })
      continue
    }
    if (target.diffed) {
      stats.push({ index: target.index, method: 'diff', originalLen: target.text.length, compressedLen: target.compressed.length, originalTokens: countTokens(target.text), compressedTokens: countTokens(target.compressed) })
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
