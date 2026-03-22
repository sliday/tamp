import { encode } from '@toon-format/toon'
import { countTokens } from '@anthropic-ai/tokenizer'
import { tryParseJSON, classifyContent, stripLineNumbers } from './detect.js'
import { anthropic } from './providers.js'

export function compressText(text, config) {
  if (text.length < config.minSize) return null
  const cls = classifyContent(text)
  if (cls === 'toon') return null
  if (cls === 'text') {
    if (config.stages.includes('llmlingua') && config.llmLinguaUrl) {
      return { async: true, text, cls }
    }
    return null
  }
  if (cls !== 'json' && cls !== 'json-lined') return null

  const raw = cls === 'json-lined' ? stripLineNumbers(text) : text
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
  const sync = compressText(text, config)
  if (sync && sync.async) {
    return compressWithLLMLingua(text, config)
  }
  return sync
}

export async function compressRequest(body, config, provider) {
  const targets = provider.extract(body)
  const stats = []
  for (const target of targets) {
    if (target.skip) { stats.push({ index: target.index, skipped: target.skip }); continue }
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
