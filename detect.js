import { rewriteCommandOutput } from './lib/rewriters/index.js'

const LINE_NUM_RE = /^ *\d+[\t→]/

export function stripLineNumbers(str) {
  if (typeof str !== 'string') return str
  const lines = str.split('\n')
  if (lines.length < 2) return str
  // Check first 3 non-empty lines for line number pattern
  let matches = 0
  for (const line of lines.slice(0, 5)) {
    if (line.length === 0) continue
    if (LINE_NUM_RE.test(line)) matches++
  }
  if (matches < 2) return str
  return lines.map(l => l.replace(LINE_NUM_RE, '')).join('\n')
}

export function tryParseJSON(str) {
  if (typeof str !== 'string' || str.length === 0) return { ok: false }
  try {
    const value = JSON.parse(str)
    return { ok: true, value }
  } catch {
    return { ok: false }
  }
}

export function isTOON(str) {
  if (typeof str !== 'string') return false
  const firstLine = str.trimStart().split('\n')[0]
  return /^\[TOON\]/.test(firstLine) || /\w+\[\d+\]\{/.test(firstLine) || /\w+\[\d+\]:/.test(firstLine)
}

export function classifyContent(str) {
  if (typeof str !== 'string') return 'unknown'
  if (isTOON(str)) return 'toon'
  const { ok } = tryParseJSON(str)
  if (ok) return 'json'
  // Try stripping line numbers (e.g. Read tool output)
  const stripped = stripLineNumbers(str)
  if (stripped !== str && tryParseJSON(stripped).ok) return 'json-lined'
  if (str.length > 0) return 'text'
  return 'unknown'
}

// Thin wrapper around the rewriters module. Returns the rewriter name
// that would fire for this text, or null if no rewriter matches.
// Side-effect-free: discards the rewritten text and savedBytes.
export function detectCommandOutput(text) {
  const out = rewriteCommandOutput(text)
  return out.rewriter || null
}
