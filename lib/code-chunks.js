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

// --- Brace detector ---
//
// One left-to-right character scan carrying string AND comment state (F2).
//
// The previous version detected `/*` on the RAW line before stripping strings,
// so any `/*` substring — a URL path, a glob, prose about comment syntax —
// flipped the scanner into block-comment state and swallowed every following
// line's braces until an unrelated `*/`. It fired on this repo's own
// compress.js:258 and config.js:220, silently disabling block-aware trimming
// for 2 of 6 source files. Injecting one line into a 214KB body flipped 465
// detected blocks to 0 and produced 72 unclosed braces in the output.
//
// It also missed a complete `/* } */` on one line, because it declined to
// enter comment state when `*/` followed on the same line, and the regex-based
// stripper never handled `/* */` at all.
//
// Scanning once, left to right, makes both cases fall out for free: a `/*`
// inside a string is never seen as a comment opener because we are in string
// state when we reach it.
//
// Returns null when braces do not balance, or when comment state is still open
// at end of input — the honest signal that the scan mis-parsed something
// (regex literals and JSX are still not modelled).

function detectBraceBlocks(lines) {
  const blocks = []
  const open = []
  let inBlockComment = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (typeof line !== 'string') return null

    let quote = null // "'", '"' or '`' while inside a string literal
    let escaped = false

    for (let c = 0; c < line.length; c++) {
      const ch = line[c]

      if (inBlockComment) {
        if (ch === '*' && line[c + 1] === '/') { inBlockComment = false; c += 1 }
        continue
      }
      if (quote !== null) {
        if (escaped) { escaped = false; continue }
        if (ch === '\\') { escaped = true; continue }
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
      if (ch === '/' && line[c + 1] === '*') { inBlockComment = true; c += 1; continue }
      if (ch === '/' && line[c + 1] === '/') break // line comment: rest of line is noise
      if (ch === '#') break // ditto for shell/python-style comments

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
    // Single-quoted and double-quoted strings do not span lines in any language
    // this detector claims; reset so one stray quote cannot swallow the file.
    // Backtick state deliberately carries over (template literals are multiline).
    if (quote === '"' || quote === "'") quote = null
  }
  if (open.length > 0 || inBlockComment) return null
  return blocks
}

// --- Indent detector ---
//
// A block opens on a line ending in `:` and runs while indentation exceeds the
// header's. Blank lines belong to the block; they do not close it.
//
// Built in ONE pass with an indent stack (C3). The previous version scanned
// forward from every header to find its end, and because blank lines were
// skipped with `continue` rather than terminating the scan, every enclosing
// header re-walked the same blank field: O(headers x blank_lines), unbounded by
// body bytes since a blank line costs one byte but is visited once per open
// block. Measured 2000 headers over 200k blank lines (2.2MB) at 10783ms.

function detectIndentBlocks(lines) {
  const blocks = []
  const stack = [] // { headerLine, indent }, outermost first
  let lastContentLine = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (typeof line !== 'string') return null
    if (isBlank(line)) continue // blanks belong to whatever block is open

    const indent = indentWidth(line)
    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      const done = stack.pop()
      if (lastContentLine > done.headerLine) {
        blocks.push({
          headerLine: done.headerLine,
          startLine: done.headerLine + 1,
          endLine: lastContentLine,
          closeLine: null,
        })
      }
    }
    if (PY_BLOCK_RE.test(line)) stack.push({ headerLine: i, indent })
    lastContentLine = i
  }
  while (stack.length > 0) {
    const done = stack.pop()
    if (lastContentLine > done.headerLine) {
      blocks.push({
        headerLine: done.headerLine,
        startLine: done.headerLine + 1,
        endLine: lastContentLine,
        closeLine: null,
      })
    }
  }
  return blocks
}

// Non-allocating blank check. `line.trim() === ''` allocated a string per line,
// which the old per-header rescan paid once per open block per blank line.
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') return false
  }
  return true
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
