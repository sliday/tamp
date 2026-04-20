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

// --- Tokenizer ---
// Preserve identifiers with dots/underscores/dashes (e.g. `user.email`,
// `max_tokens`, `read-diff`) as single tokens. We collapse intra-word
// separators to underscore before splitting on non-word characters. Single
// character tokens are dropped (too noisy for BM25 on short queries).
const INTRA_WORD_RE = /([A-Za-z0-9])[._\-]+([A-Za-z0-9])/g
const SPLIT_RE = /[^A-Za-z0-9_]+/

export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  let normalized = text.toLowerCase()
  // Collapse intra-word separators. Run twice so chains like `a.b.c` fully
  // collapse (first pass joins a.b, second joins a_b.c -> a_b_c).
  normalized = normalized.replace(INTRA_WORD_RE, '$1_$2')
  normalized = normalized.replace(INTRA_WORD_RE, '$1_$2')
  const raw = normalized.split(SPLIT_RE)
  const out = []
  for (const tok of raw) {
    if (tok.length < 2) continue
    out.push(tok)
  }
  return out
}

// --- BM25 ---
// Standard Okapi BM25. Each document is a line; query is the user's last
// message. Returns Float64Array of scores aligned with the documents array.
export function bm25Scores(documents, query, { k1 = 1.5, b = 0.75 } = {}) {
  const N = documents.length
  const scores = new Float64Array(N)
  if (N === 0) return scores

  const qTokens = tokenize(query)
  if (qTokens.length === 0) return scores

  // Tokenize docs + build doc stats.
  const docTokens = new Array(N)
  const docLens = new Float64Array(N)
  let totalLen = 0
  for (let i = 0; i < N; i++) {
    const toks = tokenize(documents[i])
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

// --- Line trimmer ---
// Keep top-K highest-scoring lines until `targetTokens` is consumed. First
// and last line are always preserved. Returns null when text is already
// under budget, has fewer than `minLines` lines, or trimming didn't help.
//
// Output shape:
//   { text, keptLines, droppedLines, originalTokens, trimmedTokens, originalLines }
export function trimLinesByRelevance(text, query, { targetTokens = 4096, minLines = 10 } = {}) {
  if (typeof text !== 'string' || text.length === 0) return null

  const originalTokens = countTokens(text)
  if (originalTokens <= targetTokens) return null

  const lines = text.split('\n')
  const N = lines.length
  if (N < minLines) return null

  // Per-line token costs (includes the trailing newline for all but the last
  // line; we approximate by counting each line once and adding N-1 tokens).
  const lineTokens = new Array(N)
  for (let i = 0; i < N; i++) {
    lineTokens[i] = countTokens(lines[i])
  }
  const newlineCost = Math.max(0, N - 1)

  const scores = bm25Scores(lines, query)

  // Always-keep set: first + last as anchors.
  const keep = new Uint8Array(N)
  keep[0] = 1
  keep[N - 1] = 1
  let budgetUsed = lineTokens[0] + (N > 1 ? lineTokens[N - 1] : 0)
  // Rough marker cost reserved per collapsed gap; we'll reconcile below.
  const MARKER_RESERVE = 16

  // Sort remaining lines by score desc, then by position asc (stable earlier
  // context preferred on ties). We pick greedily until budget is hit.
  const candidates = []
  for (let i = 1; i < N - 1; i++) {
    candidates.push({ i, score: scores[i], len: lineTokens[i] })
  }
  candidates.sort((a, b) => (b.score - a.score) || (a.i - b.i))

  for (const c of candidates) {
    if (budgetUsed + c.len > targetTokens) continue
    keep[c.i] = 1
    budgetUsed += c.len
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
    out.push(`[... ${runLen} lines omitted, ${chars} chars ...]`)
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
