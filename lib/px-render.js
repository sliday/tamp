// px-render stage: render large DENSE tool_results as PNG image blocks.
//
// Borrowed from teamchong/pxpipe (MIT): image input tokens are priced by pixel
// area (⌈w/28⌉×⌈h/28⌉ patches on Anthropic), not text volume, so content that tokenizes
// badly as text (paths, hashes, hex, grep output at ~1-2 chars/token) packs
// ~3x more chars per token as a rendered image. Prose tokenizes fine (~3.5+
// chars/token) and LOSES money imaged — the density gate below excludes it.
//
// Model-gated: vision legibility varies wildly per model (pxpipe FINDINGS:
// fable-5 reads dense hex 13/15, opus-tier 2/15), so the allowlist defaults to
// the models measured legible, not the expensive ones per se. Reading images
// is lossy-in-fidelity: a factsheet of precision-critical tokens rides beside
// the images as plain text so exact identifiers never depend on glyph reading.

import { countTokens } from '@anthropic-ai/tokenizer'

// Anthropic vision pricing: one token per 28×28-px patch, ⌈w/28⌉×⌈h/28⌉ per
// image (pxpipe 0.16 src/core/vision-cost.ts patchTokens; pixels/750 was the
// older continuous approximation). Fallback when the exported estimator is absent.
const PATCH_PX = 28
// Post-render profitability margin: images + factsheet must beat text by 20%.
const PROFIT_MARGIN = 0.8
// Density pre-gate: chars-per-text-token at or above this reads as clean
// prose — the content class with the worst measured image-legibility risk and
// the least token upside. This gate is a cheap CPU skip only; the exact
// profitability decision is the post-render check below (pixel area is known
// then). Grep/code/log content sits at ~2.5-3.5 chars/token and must pass.
const MAX_DENSITY = 4.0

let pxpipeModule // memoized dynamic import; null = tried and missing
async function loadPxpipe() {
  if (pxpipeModule !== undefined) return pxpipeModule
  try {
    pxpipeModule = await import('pxpipe-proxy')
  } catch {
    pxpipeModule = null
  }
  return pxpipeModule
}

// Bracketed variant tags ([1m] etc.) stripped so base and variant gate identically.
export function pxModelAllowed(model, allowCsv) {
  if (typeof model !== 'string' || !allowCsv) return false
  const base = model.replace(/\[[^\]]*\]/g, '')
  return allowCsv.split(',').map(s => s.trim()).filter(Boolean)
    .some(b => base === b || base.startsWith(`${b}-`))
}

// --- Lean factsheet (adapted from pxpipe src/core/factsheet.ts, MIT) ---
// Extracts precision-critical tokens (paths, SHAs, versions, flags, numbers,
// CONST_IDS) so they ride next to the images as verbatim text. Deterministic
// by construction (fixed pattern order, total sort, no Date/random) so the
// emitted line is byte-stable and never busts the prompt cache.
// Synced with pxpipe 0.16 (LABEL=value, field=value, email, IBAN, currency,
// dir path, CLI flag, decimal, camelCase, ticket codes). Every pattern must
// stay linear-time on a whole 200k-char string, not just a 512-char chunk:
// the email and path patterns start only at the head of a run (lookbehind)
// instead of retrying at every offset, and the ticket pattern checks its digit
// after matching instead of with upstream's 120-char lookahead.
const FS_TICKET = /\b[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+\b/g
export const FS_PATTERNS = [
  /\b[A-Z][A-Z0-9_]{2,}=[^\s)"'<>]+/g,
  /\b[A-Za-z][A-Za-z0-9_]{2,}=[A-Za-z0-9_.:/+-]{1,64}/g,
  /\bhttps?:\/\/[^\s)"'<>]+/g,
  /(?<![\w.!#$%&'*+/=?^`{|}~-])[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g,
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  /\b[A-Z]{2}\d{2}[A-Z0-9]{8,30}\b/g,
  /(?:[$€£¥]|USD|EUR|GBP|CAD|AUD|CHF|JPY)\d(?:[\d,_]*\d)?(?:\.\d{2})?\b/g,
  /(?<![\w@~+./-])[\w@~+.-]*(?:\/[\w.@+-]+)+\.[A-Za-z]\w{0,8}\b/g,
  /\/[\w.@+-]+(?:\/[\w.@+-]+)+\/?/g,
  /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g,
  /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?\b/g,
  /(?:^|[^\w-])(--?[A-Za-z][\w-]+)/g,
  /\b\d[\d,_]{3,}\b/g,
  /\b\d+\.\d+\b/g,
  /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b/g,
  /\b(?:[a-z]+|[A-Z][a-z0-9]+)(?:[A-Z][a-z0-9]*)+\b/g,
  FS_TICKET,
]
const FS_MAX_TOKENS = 96
const FS_MAX_URLS = 8
const FS_MAX_SCAN = 262_144
const FS_URL = /^https?:\/\//
// Short opaque identifiers (SHAs, UUIDs, numbers, CONST_IDS) outrank long URLs:
// length is anti-correlated with OCR-risk × consequence.
const FS_TIER0 = /^(?:(?=[0-9a-f]*\d)[0-9a-f]{7,40}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+|\d[\d,_]*|\d+\.\d+)$/
// pxpipe 0.16 tier-0 additions. Lowercase field=value stays tier 1: log lines
// carry one per row and would flood the top tier.
const FS_TIER0_SHAPES = [
  /^[A-Z][A-Z0-9_]{2,}=\S+$/,
  /^[^@\s]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/,
  /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/,
  /^(?:[$€£¥]|USD|EUR|GBP|CAD|AUD|CHF|JPY)\d(?:[\d,_]*\d)?(?:\.\d{2})?$/,
  /^--?[A-Za-z][\w-]+$/,
]
const FS_TICKET_SHAPE = /^[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+$/
const FS_CAMEL = /^(?:[a-z]+|[A-Z][a-z0-9]+)(?:[A-Z][a-z0-9]*)+$/

function fsTier(tok) {
  if (FS_TIER0.test(tok)) return 0
  if (FS_TIER0_SHAPES.some(re => re.test(tok))) return 0
  if (FS_TICKET_SHAPE.test(tok) && /\d/.test(tok)) return 0
  if (tok.length >= 8 && FS_CAMEL.test(tok)) return 0
  if (FS_URL.test(tok)) return 2
  return 1
}

export function extractFactsheetTokens(text) {
  const scan = text.length > FS_MAX_SCAN ? text.slice(0, FS_MAX_SCAN) : text
  const seen = new Set()
  for (const chunk of scan.split(/\s+/)) {
    if (chunk.length < 3 || chunk.length > 512) continue
    for (const re of FS_PATTERNS) {
      for (const m of chunk.matchAll(re)) {
        const tok = (m[1] ?? m[0]).trim().replace(/(?<![.,;:!?])[.,;:!?]+$/, '')
        if (re === FS_TICKET && !/\d/.test(tok)) continue
        if (tok.length >= 3 && tok.length <= 120) seen.add(tok)
      }
    }
    if (seen.size >= 2048) break
  }
  // Substring collapse (length-desc, then lexical — total order) so partial
  // forms fold into the most specific token.
  const ordered = [...seen].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
  const specific = []
  for (const t of ordered) {
    if (!specific.some(k => k.includes(t))) specific.push(t)
  }
  const ranked = specific
    .map(t => ({ t, tier: fsTier(t) }))
    .sort((a, b) => a.tier - b.tier || b.t.length - a.t.length || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
  const kept = []
  let urls = 0
  for (const { t, tier } of ranked) {
    if (kept.length >= FS_MAX_TOKENS) break
    if (tier === 2 && urls++ >= FS_MAX_URLS) continue
    kept.push(t)
  }
  return kept
}

export function factsheetText(text) {
  const tokens = extractFactsheetTokens(text)
  if (!tokens.length) return ''
  return '[Exact identifiers from the rendered image above (paths, ids, versions, numbers) — quote these verbatim instead of transcribing them from the image: '
    + tokens.join(' · ') + ']'
}

// --- The stage ---
// Claims eligible targets by setting target.compressed to a tool_result
// content ARRAY (image blocks + factsheet text). applyTargets writes it
// verbatim, and the Anthropic API accepts block arrays at tool_result.content.
// Only string-content tool_result targets are eligible (path depth 5 ending in
// 'content'): sub-text targets point at a `text` field where an array would be
// structurally invalid.
export async function pxRenderTargets(targets, body, provider, config) {
  if (!provider || provider.name !== 'anthropic') return 0
  if (!pxModelAllowed(body?.model, config.pxModels)) return 0
  const userText = typeof provider.getLastUserText === 'function' ? (provider.getLastUserText(body) || '') : ''
  if (userText && config.isDangerousTask?.(userText)) return 0

  const px = await loadPxpipe()
  if (!px?.renderTextToImages) return 0

  // pxpipe 0.16 resolves a Claude id to its render profile (claude-model-profiles.ts):
  // the original Fable 5 keeps bare 5×8 rows, Fable 5.1+ and other Claude ids get
  // +2px row spacing. Only Claude ids are passed: anything else would resolve to a
  // GPT/Gemini geometry, so it keeps the Anthropic defaults.
  const base = body.model.replace(/\[[^\]]*\]/g, '')
  const pxModel = /claude|anthropic/i.test(base) ? base : undefined
  const imageTokensOf = pages => pages.reduce((sum, p) => sum + (pxModel && typeof px.openAIVisionTokens === 'function'
    ? px.openAIVisionTokens(pxModel, p.width, p.height)
    : Math.ceil(p.width / PATCH_PX) * Math.ceil(p.height / PATCH_PX)), 0)

  let rendered = 0
  for (const target of targets) {
    if (target.skip || target.dedup || target.diffed || target.readDiffed || target.graphed || target.disclosed || target.bm25Trimmed || target.compressed) continue
    if (typeof target.text !== 'string') continue
    if (!Array.isArray(target.path) || target.path.length !== 5 || target.path[target.path.length - 1] !== 'content') continue
    if (target.text.length < config.pxMinChars) continue

    const textTokens = countTokens(target.text)
    if (textTokens === 0 || target.text.length / textTokens >= MAX_DENSITY) continue

    let result
    try {
      result = await px.renderTextToImages(target.text, pxModel ? { reflow: true, model: pxModel } : { reflow: true })
    } catch {
      continue
    }
    if (!result?.pages?.length || result.pages.length > config.pxMaxImages) continue
    // Atlas gaps render as blank cells — silent loss, don't ship it.
    if (result.droppedChars > 0) continue

    const sheet = factsheetText(target.text)
    // Priced from the real rendered page sizes (Σ w×h = result.pixels), so a
    // spaced profile's taller pages are charged in full.
    const imageTokens = imageTokensOf(result.pages)
    const sheetTokens = sheet ? countTokens(sheet) : 0
    if (imageTokens + sheetTokens >= textTokens * PROFIT_MARGIN) continue

    const blocks = result.pages.map(p => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: Buffer.from(p.png).toString('base64') },
    }))
    if (sheet) blocks.push({ type: 'text', text: sheet })

    target.compressed = blocks
    target.pxRendered = true
    target.pxOriginalTokens = textTokens
    target.pxCompressedTokens = imageTokens + sheetTokens
    target.pxImageCount = result.pages.length
    rendered += 1
  }
  return rendered
}
