// Block structure detection for code bodies (Phase 7).
//
// `bm25-trim` drops individual lines. On code that produces syntactically
// broken output: a kept line from inside a function body, with its signature
// and closing brace gone, tells the model almost nothing. This module finds
// block ranges so the trimmer can enforce a simple invariant — keep a line,
// keep the headers and closers of every block enclosing it.
//
// Deliberately not tree-sitter. That is a native dependency, and Tamp ships a
// pure-JS package with a tight `files:` list. Two cheap detectors cover the
// languages coding agents actually read, and both refuse to guess: when the
// structure does not check out, `detectBlocks` returns null and the caller
// falls back to plain line trimming.

// --- Language selection ---

const BRACE_EXT = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
  'java', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'go', 'rs',
  'swift', 'kt', 'kts', 'scala', 'php', 'dart', 'zig',
])
const INDENT_EXT = new Set(['py', 'pyi', 'yaml', 'yml'])

export function languageForPath(path) {
  if (typeof path !== 'string' || path.length === 0) return null
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  const ext = path.slice(dot + 1).toLowerCase()
  if (BRACE_EXT.has(ext)) return 'brace'
  if (INDENT_EXT.has(ext)) return 'indent'
  return null
}

// Path-based detection only works on Anthropic requests (see
// lib/path-extract.js). Everywhere else we sniff the body itself.
const PY_BLOCK_RE = /^\s*(?:async\s+)?(?:def|class|if|for|while|with|try|elif|else|except|finally)\b.*:\s*$/

export function sniffLanguage(lines) {
  if (!Array.isArray(lines) || lines.length < 10) return null
  let braceOpens = 0
  let pyBlocks = 0
  const sample = Math.min(lines.length, 400)
  for (let i = 0; i < sample; i++) {
    const line = lines[i]
    if (typeof line !== 'string') continue
    if (/\{\s*$/.test(line)) braceOpens += 1
    if (PY_BLOCK_RE.test(line)) pyBlocks += 1
  }
  // A low bar is safe: the brace detector independently returns null unless
  // the whole body balances, so a wrong guess on a log file self-corrects.
  if (braceOpens >= 3 && braceOpens > pyBlocks) return 'brace'
  if (pyBlocks >= 3) return 'indent'
  return null
}

// --- Shared helpers ---

export function indentWidth(line) {
  if (typeof line !== 'string') return 0
  let n = 0
  while (n < line.length && (line[n] === ' ' || line[n] === '\t')) n += 1
  return n
}

// Strip string literals and trailing line comments so brace counting is not
// thrown off by `"}"` or `// }`. Block comments are handled by the caller,
// which tracks `/* */` state across lines.
const STRINGS_RE = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g
const LINE_COMMENT_RE = /(\/\/|#).*$/

function stripNoise(line) {
  return line.replace(STRINGS_RE, '""').replace(LINE_COMMENT_RE, '')
}

// --- Brace detector ---
//
// Returns null when braces do not balance, which is the honest signal that
// stripNoise mis-parsed something (regex literals, template nesting, JSX).

function detectBraceBlocks(lines) {
  const blocks = []
  const open = []
  let inBlockComment = false

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    if (typeof line !== 'string') return null

    if (inBlockComment) {
      const end = line.indexOf('*/')
      if (end < 0) continue
      line = line.slice(end + 2)
      inBlockComment = false
    }
    const start = line.indexOf('/*')
    if (start >= 0 && line.indexOf('*/', start) < 0) {
      inBlockComment = true
      line = line.slice(0, start)
    }

    const code = stripNoise(line)
    for (let c = 0; c < code.length; c++) {
      const ch = code[c]
      if (ch === '{') {
        // The header is the line the brace opens on. A brace that opens and
        // closes on the same line yields a zero-length body and is dropped
        // below, so object literals inline in an argument list cost nothing.
        open.push(i)
      } else if (ch === '}') {
        const headerLine = open.pop()
        if (headerLine === undefined) return null // unbalanced — give up
        if (i > headerLine + 1) {
          blocks.push({ headerLine, startLine: headerLine + 1, endLine: i - 1, closeLine: i })
        }
      }
    }
  }
  if (open.length > 0) return null
  return blocks
}

// --- Indent detector ---
//
// A block opens on a line ending in `:` and runs while indentation exceeds
// the header's. Blank lines belong to the block; they do not close it.

function detectIndentBlocks(lines) {
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (typeof line !== 'string') return null
    if (!PY_BLOCK_RE.test(line)) continue
    const headerIndent = indentWidth(line)

    let end = i
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]
      if (typeof next !== 'string') return null
      if (next.trim() === '') continue
      if (indentWidth(next) <= headerIndent) break
      end = j
    }
    if (end > i) {
      blocks.push({ headerLine: i, startLine: i + 1, endLine: end, closeLine: null })
    }
  }
  return blocks
}

// --- Public entry ---
//
// `detectBlocks(lines, { path })` -> array of blocks, or null when no detector
// applies or the structure did not check out. Blocks are unordered with
// respect to nesting; use `buildStructure` to get the lookup maps.

export function detectBlocks(lines, { path = null } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return null
  const language = languageForPath(path) || sniffLanguage(lines)
  if (language === 'brace') return detectBraceBlocks(lines)
  if (language === 'indent') return detectIndentBlocks(lines)
  return null
}

// Flatten blocks into per-line lookups the trimmer needs:
//   parent[i]    innermost block header enclosing line i, or -1
//   closer[h]    ARRAY of closing lines for blocks whose header is line h
//   headerOf[c]  ARRAY of header lines for blocks closing on line c
//
// `headerOf` is the inverse of `closer`: a bare `}` sits outside its own
// block's body, so without it a closing line looks parentless and can be kept
// on its own, stranding a `}` with no signature.
//
// Both are LISTS, not scalars (C2). One physical line can open or close more
// than one block — `function f() { if (x) {` opens two, `} }` closes two.
// Scalar maps keyed by line number silently kept only the LAST write, so the
// outer closer was lost and the trimmer emitted a signature with no matching
// brace. Verified before the fix: closer[0] === 2 (the inner `}`) not 3.
//
// `parent` is filled by one stack sweep rather than by painting each block's
// span (C1). Painting costs O(sum of block spans) = O(N x nesting depth),
// quadratic on deeply nested input: a body of N/2 `{` then N/2 `}` measured
// 200ms at 80KB, 1188ms at 200KB, 4741ms at 400KB. The sweep is O(N + blocks).
export function buildStructure(lines, blocks) {
  const n = lines.length
  const parent = new Int32Array(n).fill(-1)
  const closer = new Array(n)
  const headerOf = new Array(n)
  if (!Array.isArray(blocks) || blocks.length === 0) return { parent, closer, headerOf }

  for (const block of blocks) {
    const h = block.headerLine
    const c = block.closeLine
    if (h < 0 || h >= n || c === null || c < 0 || c >= n) continue
    ;(closer[h] || (closer[h] = [])).push(c)
    ;(headerOf[c] || (headerOf[c] = [])).push(h)
  }

  // Outer-first among blocks starting on the same line, so the narrower one
  // lands on top of the stack and wins `parent` for the lines both cover.
  const byStart = blocks
    .slice()
    .sort((a, b) => (a.startLine - b.startLine) || (b.endLine - a.endLine))
  const stack = []
  let bi = 0
  for (let i = 0; i < n; i++) {
    while (stack.length > 0 && stack[stack.length - 1].endLine < i) stack.pop()
    while (bi < byStart.length && byStart[bi].startLine <= i) {
      const b = byStart[bi]
      bi += 1
      if (b.endLine >= i) stack.push(b)
    }
    // A block never covers its own header (startLine is headerLine + 1), so
    // parent[headerLine] keeps pointing at the enclosing block.
    parent[i] = stack.length > 0 ? stack[stack.length - 1].headerLine : -1
  }
  return { parent, closer, headerOf }
}
