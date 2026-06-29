import { rewriteCommandOutput } from './lib/rewriters/index.js'

const LINE_NUM_RE = /^ *\d+[\t→]/
// Genuine line-numbered output (cat -n, the Read tool) is right-aligned, so the
// number carries leading padding. Requiring padding distinguishes it from
// unpadded numeric first columns in TSV/CSV tool output.
const PADDED_LINE_NUM_RE = /^ +\d+[\t→]/

export function stripLineNumbers(str) {
  if (typeof str !== 'string') return str
  const lines = str.split('\n')
  if (lines.length < 2) return str
  // Collect the leading numbers from the first few non-empty lines. Only treat
  // them as line numbers when they are padded AND strictly consecutive — the
  // invariants of real line numbering. This avoids silently dropping the first
  // column of numeric tabular data (e.g. "1\tAlice\t30").
  const nums = []
  for (const line of lines.slice(0, 5)) {
    if (line.length === 0) continue
    if (!PADDED_LINE_NUM_RE.test(line)) continue
    nums.push(parseInt(line, 10))
  }
  if (nums.length < 2) return str
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== nums[i - 1] + 1) return str
  }
  return lines.map(l => l.replace(LINE_NUM_RE, '')).join('\n')
}

// True if the JSON text contains an integer literal outside the JS safe-integer
// range (|n| > 2^53-1). Such values lose precision through JSON.parse, so the
// minify/toon stages would silently alter a numeric id/amount — a semantic
// corruption. Scans number tokens outside string literals; floats are left
// alone (they are inherently approximate). Conservative on the safe side: when
// in doubt it returns true so the caller skips compression.
export function jsonHasUnsafeInteger(str) {
  if (typeof str !== 'string') return false
  let inString = false
  let escaped = false
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch !== '-' && (ch < '0' || ch > '9')) continue
    // Start of a number token. Consume the integer-part digit run.
    let j = ch === '-' ? i + 1 : i
    const digitStart = j
    while (j < str.length && str[j] >= '0' && str[j] <= '9') j++
    const intDigits = j - digitStart
    // Consume any fraction + exponent so their digits aren't re-scanned as a
    // separate integer. Floats are left alone (inherently approximate).
    let isFloat = false
    if (str[j] === '.') { isFloat = true; j++; while (j < str.length && str[j] >= '0' && str[j] <= '9') j++ }
    if (str[j] === 'e' || str[j] === 'E') {
      isFloat = true; j++
      if (str[j] === '+' || str[j] === '-') j++
      while (j < str.length && str[j] >= '0' && str[j] <= '9') j++
    }
    if (!isFloat && intDigits >= 16 && !Number.isSafeInteger(Number(str.slice(i, j)))) {
      return true
    }
    i = j - 1
  }
  return false
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
