// Query-aware line ranker for huge tool_result bodies (Phase 6).
//
// Pure-JS BM25 scorer, zero deps. Given a query (last user message) and a
// large body, score each line against the query using Okapi BM25 and keep
// the highest-scoring lines until a token budget is satisfied. First and
// last lines are always preserved as context anchors, and collapsed ranges
// are replaced by a "[... N lines omitted, N chars ...]" marker so the
// model can reason about the elision.
//
// This primitive is reusable: any future stage that wants "keep the most
// relevant N lines" can import tokenize/bm25Scores directly.

import { countTokens } from '@anthropic-ai/tokenizer'
import { detectBlocks, buildStructure, indentWidth } from './code-chunks.js'

// --- Tokenizer ---
// Preserve identifiers with dots/underscores/dashes (e.g. `user.email`,
// `max_tokens`, `read-diff`) as single tokens. We collapse intra-word
// separators to underscore before splitting on non-word characters. Single
// character tokens are dropped (too noisy for BM25 on short queries).
//
// Emitting ONLY the collapsed form silently destroys recall on the queries
// agents actually ask. `parse config` tokenizes to ['parse','config'], while
// `function parseConfig(` yields ['parseconfig'] and `def parse_config(`
// yields ['parse_config'] — no shared term, so BM25 scores the definition
// line the user asked about at exactly 0 and `bm25-trim` drops it. So we also
// emit the identifier's parts, splitting on camelCase, PascalCase, acronym
// runs, and underscores. Case must survive until the split, hence the
// lowercase happens per-token at the end rather than up front.
const INTRA_WORD_RE = /([A-Za-z0-9])[._\-]+([A-Za-z0-9])/g
const SPLIT_RE = /[^A-Za-z0-9_]+/
// `HTTPServer` -> `HTTP Server`. Runs before CAMEL_LOWER_UPPER so that
// `parseHTTPResponse` splits three ways rather than swallowing the acronym.
const CAMEL_ACRONYM = /([A-Z]+)([A-Z][a-z])/g
const CAMEL_LOWER_UPPER = /([a-z0-9])([A-Z])/g
// Cap parts per identifier. Deeply-joined names (`a_b_c_d_e_f`) would
// otherwise flood the term space and dilute IDF for everything else.
const MAX_PARTS = 4

// Split one raw token into its component words. Returns [] when the token has
// no internal structure, so an already-atomic `config` is not emitted twice
// (which would inflate its term frequency and skew BM25).
function subTokens(rawTok) {
  const spaced = rawTok
    .replace(CAMEL_ACRONYM, '$1 $2')
    .replace(CAMEL_LOWER_UPPER, '$1 $2')
    .replace(/_+/g, ' ')
  const parts = spaced.split(' ')
  if (parts.length < 2) return []
  const out = []
  for (const part of parts) {
    if (part.length < 2) continue
    out.push(part.toLowerCase())
    if (out.length >= MAX_PARTS) break
  }
  return out
}

export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  // Collapse intra-word separators. Run twice so chains like `a.b.c` fully
  // collapse (first pass joins a.b, second joins a_b.c -> a_b_c).
  let normalized = text.replace(INTRA_WORD_RE, '$1_$2')
  normalized = normalized.replace(INTRA_WORD_RE, '$1_$2')
  const raw = normalized.split(SPLIT_RE)
  const out = []
  for (const tok of raw) {
    if (tok.length === 0) continue
    if (tok.length >= 2) out.push(tok.toLowerCase())
    for (const part of subTokens(tok)) out.push(part)
  }
  return out
}

// --- BM25 ---
// Standard Okapi BM25. Each document is a line; query is the user's last
// message. Returns Float64Array of scores aligned with the documents array.
// `tokenizer` is injectable so bench/retrieval-eval.js can score the same
// corpus with the pre-subtoken tokenizer and report a real before/after.
export function bm25Scores(documents, query, { k1 = 1.5, b = 0.75, tokenizer = tokenize } = {}) {
  const N = documents.length
  const scores = new Float64Array(N)
  if (N === 0) return scores

  const qTokens = tokenizer(query)
  if (qTokens.length === 0) return scores

  // Tokenize docs + build doc stats.
  const docTokens = new Array(N)
  const docLens = new Float64Array(N)
  let totalLen = 0
  for (let i = 0; i < N; i++) {
    const toks = tokenizer(documents[i])
    docTokens[i] = toks
    docLens[i] = toks.length
    totalLen += toks.length
  }
  const avgdl = N > 0 ? totalLen / N : 0
  if (avgdl === 0) return scores

  // Document-frequency per unique query term.
  const uniqQ = Array.from(new Set(qTokens))
  const df = new Map()
  for (const term of uniqQ) {
    let count = 0
    for (let i = 0; i < N; i++) {
      if (docTokens[i].includes(term)) count += 1
    }
    df.set(term, count)
  }

  // Precompute IDF per term (Okapi BM25 variant with +1 smoothing).
  const idf = new Map()
  for (const term of uniqQ) {
    const n = df.get(term) || 0
    const v = Math.log(1 + (N - n + 0.5) / (n + 0.5))
    idf.set(term, v)
  }

  for (let i = 0; i < N; i++) {
    const dl = docLens[i]
    if (dl === 0) continue
    // Term-frequency table for this doc (only for query terms we care about).
    const tf = new Map()
    const toks = docTokens[i]
    for (const t of toks) {
      if (!idf.has(t)) continue
      tf.set(t, (tf.get(t) || 0) + 1)
    }
    let s = 0
    for (const term of uniqQ) {
      const f = tf.get(term) || 0
      if (f === 0) continue
      const num = f * (k1 + 1)
      const den = f + k1 * (1 - b + b * (dl / avgdl))
      s += idf.get(term) * (num / den)
    }
    scores[i] = s
  }
  return scores
}

// --- Rerank ---
// Raw BM25 treats every line as an equal bag of words. Two code-aware signals
// and one structural one fix its most visible failures.
//
// Note on scope: a path-based penalty (test files, .d.ts stubs) would be a
// no-op here. `bm25-trim` ranks lines WITHIN one tool_result, so a multiplier
// constant across the whole body cannot change any relative ordering. Path is
// used for language detection only.

// A line that DEFINES a query term beats a line that merely mentions it.
const DEF_RE = /\b(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|def|const|let|var|type|interface|enum|struct|impl|trait|fn|func|module|namespace)\s+([A-Za-z_$][\w$]*)/
const COMMENT_RE = /^\s*(?:\/\/|#|\*|\/\*|--|<!--|;)/
const DEF_BOOST = 1.6
const COMMENT_PENALTY = 0.6
// A kept line lends a quarter of its score to each immediate neighbour, so the
// survivors read as contiguous code rather than confetti. Applied off the
// pre-coherence scores so boosts do not cascade down the file.
const COHERENCE = 0.25

export function rerankScores(scores, lines, queryTokens) {
  const n = lines.length
  const out = new Float64Array(n)
  const qSet = new Set(queryTokens)

  for (let i = 0; i < n; i++) {
    let s = scores[i]
    const line = lines[i]
    if (typeof line !== 'string' || s === 0) { out[i] = s; continue }

    const def = DEF_RE.exec(line)
    if (def) {
      for (const tok of tokenize(def[1])) {
        if (qSet.has(tok)) { s *= DEF_BOOST; break }
      }
    }
    if (COMMENT_RE.test(line)) s *= COMMENT_PENALTY
    out[i] = s
  }

  if (n < 3) return out
  const cohered = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const left = i > 0 ? out[i - 1] : 0
    const right = i < n - 1 ? out[i + 1] : 0
    cohered[i] = out[i] + COHERENCE * Math.max(left, right)
  }
  return cohered
}

// --- Line trimmer ---
// Keep top-K highest-scoring lines until `targetTokens` is consumed. First
// and last line are always preserved. Returns null when text is already
// under budget, has fewer than `minLines` lines, or trimming didn't help.
//
// Output shape:
//   { text, keptLines, droppedLines, originalTokens, trimmedTokens, originalLines }
// `tokenizer` and `rerank` exist for bench/retrieval-eval.js, which replays the
// same fixtures through the pre-subtoken tokenizer to produce a real
// before/after. Production callers should leave both at their defaults.
export function trimLinesByRelevance(text, query, {
  targetTokens = 4096,
  minLines = 10,
  path = null,
  tokenizer = tokenize,
  rerank = true,
} = {}) {
  if (typeof text !== 'string' || text.length === 0) return null

  const originalTokens = countTokens(text)
  if (originalTokens <= targetTokens) return null

  const lines = text.split('\n')
  const N = lines.length
  if (N < minLines) return null

  // Per-line token costs. `countTokens` carries a fixed ~21ms cost per call
  // regardless of input length, so counting each line separately turns a
  // 1000-line tool_result into a ~20-second stall on the proxy hot path — for
  // a budget that is approximate by nature. Instead calibrate a chars-per-token
  // ratio from the whole-body count already taken above, and estimate per line.
  // Two tokenizer calls total instead of N + 2. The reported
  // original/trimmed token counts stay exact.
  const charsPerToken = originalTokens > 0 ? text.length / originalTokens : 4
  const lineTokens = new Array(N)
  for (let i = 0; i < N; i++) {
    lineTokens[i] = Math.max(1, Math.ceil((lines[i].length + 1) / charsPerToken))
  }
  const newlineCost = Math.max(0, N - 1)

  const raw = bm25Scores(lines, query, { tokenizer })
  const scores = rerank ? rerankScores(raw, lines, tokenizer(query)) : raw

  // Block structure, when the body parses as code. Keeping a line without its
  // enclosing signature and closing brace emits syntactically broken output;
  // `structure` lets selection pull those ancestors in as part of the line's
  // cost. Null (prose, logs, JSON, unbalanced source) falls back to plain
  // per-line selection, exactly as before.
  const blocks = detectBlocks(lines, { path })
  const structure = blocks ? buildStructure(lines, blocks) : null

  // Always-keep set: first + last as anchors.
  const keep = new Uint8Array(N)
  keep[0] = 1
  keep[N - 1] = 1
  // Anchor the last NON-EMPTY line too. Tool output almost always ends with
  // '\n', so lines[N-1] is '' — pinning only that empty terminator would let
  // the real final line (often a trailing error or stack trace, exactly the
  // "context anchor" this claims to preserve) be dropped as a candidate.
  let lastReal = N - 1
  while (lastReal > 0 && lines[lastReal] === '') lastReal--
  keep[lastReal] = 1
  let budgetUsed = 0
  for (const idx of new Set([0, N - 1, lastReal])) budgetUsed += lineTokens[idx]
  // Rough marker cost reserved per collapsed gap; we'll reconcile below.
  const MARKER_RESERVE = 16

  // Sort remaining lines by score desc, then by position asc (stable earlier
  // context preferred on ties). We pick greedily until budget is hit.
  const candidates = []
  for (let i = 1; i < N - 1; i++) {
    if (keep[i]) continue // skip already-anchored lines (e.g. lastReal)
    candidates.push({ i, score: scores[i], len: lineTokens[i] })
  }
  candidates.sort((a, b) => (b.score - a.score) || (a.i - b.i))

  // Ancestors a line drags in with it: every enclosing block header not yet
  // kept, plus that block's closing line. Charged as part of the candidate's
  // cost so the budget stays honest instead of overflowing at assembly time.
  const pending = []
  function closureFor(i) {
    pending.length = 0
    if (!structure) return 0
    let cost = 0
    // A line that OPENS a block must drag in its own closer, or a kept
    // signature is left hanging with no `}`. Ancestors alone do not cover
    // this: the header is not inside its own body.
    const ownCloser = structure.closer[i]
    if (ownCloser >= 0 && ownCloser < N && !keep[ownCloser]) {
      pending.push(ownCloser)
      cost += lineTokens[ownCloser]
    }
    // Conversely, a closing line's own header is not an ancestor either — the
    // body sits between them — so start the walk there when the candidate IS
    // a closer.
    const own = structure.headerOf[i]
    let p = own >= 0 ? own : structure.parent[i]
    let guard = 0
    while (p >= 0 && guard++ < 1000) {
      if (!keep[p] && !pending.includes(p)) {
        pending.push(p)
        cost += lineTokens[p]
        const c = structure.closer[p]
        if (c >= 0 && c < N && c !== i && !keep[c] && !pending.includes(c)) {
          pending.push(c)
          cost += lineTokens[c]
        }
      }
      p = structure.parent[p]
    }
    return cost
  }

  for (const c of candidates) {
    if (keep[c.i]) continue // already pulled in as an ancestor
    const closureCost = closureFor(c.i)
    if (budgetUsed + c.len + closureCost > targetTokens) continue
    for (const a of pending) keep[a] = 1
    keep[c.i] = 1
    budgetUsed += c.len + closureCost
  }

  // Blank lines cost zero tokens, so greedy selection always keeps them. Left
  // alone they punch holes through dropped runs, and every hole costs another
  // ~12-token marker — enough to overshoot the budget several times over on a
  // fragmented body. A blank line stranded between two dropped lines carries
  // nothing, so fold it into the run.
  for (let i = 1; i < N - 1; i++) {
    if (!keep[i] || lines[i].trim() !== '') continue
    if (!keep[i - 1] && !keep[i + 1]) keep[i] = 0
  }

  // If even the anchors + marker exceed budget, still proceed — we need to
  // produce SOME trim. But if nothing was dropped at all, bail.
  let keptLines = 0
  for (let i = 0; i < N; i++) keptLines += keep[i]
  const droppedLines = N - keptLines
  if (droppedLines === 0) return null

  // Assemble output, collapsing contiguous dropped runs into drop markers.
  const out = []
  let i = 0
  while (i < N) {
    if (keep[i]) {
      out.push(lines[i])
      i += 1
      continue
    }
    let j = i
    let chars = 0
    while (j < N && !keep[j]) { chars += lines[j].length + 1; j += 1 }
    const runLen = j - i
    // Indent the marker to the dropped body's own depth, so a collapsed
    // function body reads as part of the block it replaced.
    const pad = lines[i].slice(0, indentWidth(lines[i]))
    out.push(`${pad}[... ${runLen} lines omitted, ${chars} chars ...]`)
    i = j
  }

  const trimmedText = out.join('\n')
  const trimmedTokens = countTokens(trimmedText)
  // Defensive: if trimming somehow grew the text, don't return a trim.
  if (trimmedTokens >= originalTokens) return null

  return {
    text: trimmedText,
    keptLines,
    droppedLines,
    originalTokens,
    trimmedTokens,
    originalLines: N,
    budgetUsed,
    newlineCost,
    markerReserve: MARKER_RESERVE,
  }
}
