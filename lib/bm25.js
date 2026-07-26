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

import { countTokens as rawCountTokens } from '@anthropic-ai/tokenizer'
import { detectBlocks, buildStructure, indentWidth } from './code-chunks.js'

// --- Safe token counting (C5) ---
//
// `countTokens` is NOT the fixed-cost call an earlier comment in this file
// claimed. It has a ~22ms floor on small inputs, but it is superlinear on
// large low-entropy input and it HARD CRASHES on some of it. Measured on
// whitespace-heavy bodies (400-char space runs):
//
//   80KB  ->  8.7s      200KB ->  22.4s      400KB -> 88.9s
//   1MB   ->  RuntimeError: unreachable   (tiktoken WASM trap)
//
// `bm25-trim` only runs on bodies over 64KB, so every attacker-controlled
// tool_result on this path paid it. A WASM trap is not catchable as a normal
// error in every runtime, so the primary defence is the size cap; the
// try/catch is only the backstop.
//
// The cap is 4KB, not 64KB, because the cost is driven by CONTENT, not size.
// Measured:
//
//   spaces:  1KB 22ms   4KB 31ms   8KB 58ms   16KB 167ms   32KB 609ms
//   prose:   8KB 22ms  32KB 24ms  64KB 27ms
//
// Prose is flat at the ~22ms floor whatever its length; pathological runs go
// quadratic. 4KB bounds the worst case to ~31ms. A 64KB cap still measured
// 44s on a megabyte of spaces, which is why the first attempt at this fix
// did not work.
const COUNT_CAP = 4 * 1024
const SAMPLES = 3

export function safeCountTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  try {
    if (text.length <= COUNT_CAP) return rawCountTokens(text)
    // Three windows spread across the body rather than one prefix — same cost,
    // better representativeness on a body whose head is not typical of its tail
    // (a log with a JSON blob at the end, a file with a licence header).
    const each = Math.floor(COUNT_CAP / SAMPLES)
    const stride = Math.floor((text.length - each) / (SAMPLES - 1))
    let sampled = 0
    let counted = 0
    for (let s = 0; s < SAMPLES; s++) {
      const start = Math.min(s * stride, text.length - each)
      const window = text.slice(start, start + each)
      counted += rawCountTokens(window)
      sampled += window.length
    }
    if (sampled === 0) return Math.max(1, Math.ceil(text.length / 4))
    return Math.max(1, Math.round(counted * (text.length / sampled)))
  } catch {
    // Tokenizer refused this input. Fall back to a coarse estimate rather than
    // aborting compression for the whole request.
    return Math.max(1, Math.ceil(text.length / 4))
  }
}

const countTokens = safeCountTokens

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
// No cap on parts per identifier. An earlier version capped at 4 and truncated
// from the TAIL, which reintroduced the exact bug this file exists to fix:
// `get_or_create_default_workspace_settings` emitted get/or/create/default and
// dropped `workspace` and `settings`, so a query for "workspace settings"
// scored the definition line at 0 and deleted it. The cap was motivated by an
// IDF-dilution worry that was never measured. If dilution is real,
// bench/retrieval-eval.js is where it should show up.

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

  // ONE pass over the documents (C7 + C8).
  //
  // C7: the old version kept `docTokens` — the full tokenization of every line
  // — alive for the whole call, though only query terms are ever read from it.
  // A 4.6MB body (60k lines) retained 47.4MB, roughly 10x amplification, on top
  // of the original string, the split lines array and the parsed request body.
  // The proxy serves concurrent requests with no per-request size cap on this
  // stage, so that was an OOM path, not just memory pressure.
  //
  // C8: document frequency was computed as `docTokens[i].includes(term)` for
  // every unique query term against every line — O(uniqQ x N x tokens/line) of
  // linear scans. Both dimensions are hostile: N is the attacker-controlled
  // line count, and the query is the user's last message, which routinely
  // contains a pasted stack trace. Measured at N=20000: 70ms for a 10-word
  // query, 163ms for 100 words, 676ms for 500.
  //
  // Now: tokenize each line once, keep only the per-line term frequencies for
  // terms that appear in the query (empty for the vast majority of lines), and
  // accumulate df in the same pass. Peak retention scales with the QUERY size,
  // not the body size.
  const qSet = new Set(qTokens)
  const docLens = new Float64Array(N)
  const docTf = new Array(N) // Map|null, only query terms, null when none present
  const df = new Map()
  let totalLen = 0

  for (let i = 0; i < N; i++) {
    const toks = tokenizer(documents[i])
    docLens[i] = toks.length
    totalLen += toks.length
    let tf = null
    for (const t of toks) {
      if (!qSet.has(t)) continue
      if (tf === null) tf = new Map()
      tf.set(t, (tf.get(t) || 0) + 1)
    }
    docTf[i] = tf
    if (tf !== null) for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1)
    // `toks` goes out of scope here and is collectable — nothing retains it.
  }

  const avgdl = N > 0 ? totalLen / N : 0
  if (avgdl === 0) return scores

  // Okapi BM25 IDF with +1 smoothing.
  const idf = new Map()
  for (const term of qSet) {
    const n = df.get(term) || 0
    idf.set(term, Math.log(1 + (N - n + 0.5) / (n + 0.5)))
  }

  for (let i = 0; i < N; i++) {
    const tf = docTf[i]
    if (tf === null) continue // no query term on this line — scores 0, skip
    const dl = docLens[i]
    if (dl === 0) continue
    let s = 0
    // Iterate the terms actually PRESENT (usually 0-3) rather than every
    // unique query term, so a long query costs nothing on unrelated lines.
    for (const [term, f] of tf) {
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
  // Clamped (C4). A single global ratio is gameable: token density spans ~200x
  // across content (400 spaces = 133 chars/token; emoji = 0.67), so a body
  // whose bulk is low-density padding and whose payload is dense text made
  // every payload line look ~20x cheaper than it is. Measured: a 762KB body
  // reported budgetUsed 4050 against targetTokens 4096 while emitting 31,869
  // real tokens — 7.8x over budget, with the only guard being "smaller than
  // the (attacker-sized) input".
  //
  // Real chars-per-token tops out near 4.6 on ordinary prose. Capping the
  // assumed ratio at 4 means a line can never be priced below len/4, so dense
  // content cannot be smuggled in under a padded average. Over-estimating is
  // safe here — it only makes the trim more conservative.
  const MAX_CHARS_PER_TOKEN = 4
  const rawRatio = originalTokens > 0 ? text.length / originalTokens : MAX_CHARS_PER_TOKEN
  const charsPerToken = Math.min(rawRatio, MAX_CHARS_PER_TOKEN)
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
  // `inPending` is a reusable membership mark, cleared via the `pending` list
  // at the top of each call (C6). The old version used `pending.includes(p)`,
  // O(depth) per probe, and never short-circuited on an already-kept ancestor
  // chain — so every REJECTED candidate refilled `pending` to full nesting
  // depth, giving O(candidates x depth^2). Depth is attacker-controlled and
  // costs no extra body bytes: at 20k lines, depth 200 measured 251ms total
  // while depth 800 measured 4512ms, of which 4443ms was this function.
  const pending = []
  const inPending = new Uint8Array(N)
  function closureFor(i) {
    for (const p of pending) inPending[p] = 0
    pending.length = 0
    if (!structure) return 0
    let cost = 0
    const mark = (line) => {
      if (line < 0 || line >= N || keep[line] || inPending[line]) return false
      inPending[line] = 1
      pending.push(line)
      cost += lineTokens[line]
      return true
    }
    // A line that OPENS a block must drag in its own closer, or a kept
    // signature is left hanging with no `}`. Ancestors alone do not cover
    // this: the header is not inside its own body.
    //
    // closer/headerOf are LISTS — one line can open or close several blocks
    // (`function f() { if (x) {`). Taking only the first would strand the
    // others, which is the defect these lists exist to fix.
    const ownClosers = structure.closer[i]
    if (ownClosers) for (const c of ownClosers) if (c !== i) mark(c)

    // Conversely, a closing line's own headers are not ancestors either — the
    // body sits between them — so seed the walk with them when the candidate
    // IS a closer. Continue from the outermost of them; the inner ones are its
    // descendants and get pulled in via their own closer lists.
    const ownHeaders = structure.headerOf[i]
    let p = structure.parent[i]
    if (ownHeaders && ownHeaders.length > 0) {
      let outermost = ownHeaders[0]
      for (const h of ownHeaders) {
        mark(h)
        if (h < outermost) outermost = h
      }
      p = structure.parent[outermost]
    }

    while (p >= 0) {
      // Short-circuit: if this ancestor is already kept, everything above it
      // was kept with it, so the rest of the chain is redundant. This is what
      // turns the rejected-candidate case from O(depth) into O(1).
      if (keep[p]) break
      if (!mark(p)) break // already pending — the rest of the chain is too
      const closers = structure.closer[p]
      // closer[] is a LIST since the C2 fix. Reading it as a scalar silently
      // worked for single-closer blocks (`[3]` coerces to "3") and silently
      // did nothing for multi-closer ones (`[2,3]` -> NaN).
      if (closers) for (const c of closers) if (c !== i) mark(c)
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
  // fragmented body. A blank RUN stranded between two dropped lines carries
  // nothing, so fold the whole run in.
  //
  // Must operate on runs, not single lines. An earlier version tested only
  // `keep[i-1]` and `keep[i+1]`, which never fires on `\n\n` — the most common
  // blank shape in source — because each blank sees the other as kept. Measured
  // 72 of 148 surviving lines blank before this fix. Snapshotting `keep` does
  // not help either; the run has to be considered as a unit.
  for (let i = 1; i < N - 1; i++) {
    if (!keep[i] || lines[i].trim() !== '') continue
    let j = i
    while (j < N - 1 && keep[j] && lines[j].trim() === '') j += 1
    if (!keep[i - 1] && j < N && !keep[j]) {
      for (let k = i; k < j; k += 1) keep[k] = 0
    }
    i = j - 1
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
