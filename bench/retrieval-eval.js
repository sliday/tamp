#!/usr/bin/env node
// Retrieval quality evaluation for the `bm25-trim` stage.
//
// `bm25-trim` is lossy: it decides which lines of a huge tool_result the model
// never gets to see. Until now nothing measured whether it kept the RIGHT
// lines. This harness does, and unlike bench/quality-eval.js and
// bench/semantic-eval.js it needs no API key — retrieval is measurable offline.
//
// Two metrics per fixture:
//   NDCG@10        ranking quality — are the gold lines at the top?
//   Recall@budget  survival — did the gold lines actually make it through the
//                  trim at a realistic token budget?
//
// Both are reported for the legacy tokenizer (collapsed identifiers only) and
// the current one (collapsed form plus its parts), so the delta is visible.
//
// Usage: node bench/retrieval-eval.js

import { bm25Scores, rerankScores, tokenize, trimLinesByRelevance } from '../lib/bm25.js'

// The tokenizer as it shipped before subtoken expansion. Kept here rather than
// in lib/ so the comparison stays reproducible after lib/bm25.js moves on.
const LEGACY_INTRA_WORD = /([A-Za-z0-9])[._\-]+([A-Za-z0-9])/g
const LEGACY_SPLIT = /[^A-Za-z0-9_]+/
function legacyTokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  let normalized = text.toLowerCase()
  normalized = normalized.replace(LEGACY_INTRA_WORD, '$1_$2')
  normalized = normalized.replace(LEGACY_INTRA_WORD, '$1_$2')
  return normalized.split(LEGACY_SPLIT).filter(t => t.length >= 2)
}

// --- Fixture construction ---
//
// Each fixture is a synthetic source file: a lot of plausible filler plus a
// handful of gold lines that answer the query. Filler deliberately shares
// vocabulary with the query where a real file would, so the metrics are not
// trivially saturated.

function filler(n, kind) {
  const out = []
  for (let i = 0; i < n; i++) {
    if (kind === 'py') {
      out.push(`def helper_${i}(value):`)
      out.push(`    total = value + ${i}  # routine accumulation step`)
      out.push(`    return total`)
      out.push('')
    } else {
      out.push(`export function helper${i}(value) {`)
      out.push(`  const total = value + ${i} // routine accumulation step`)
      out.push('  return total')
      out.push('}')
      out.push('')
    }
  }
  return out
}

// `gold` marks the lines a correct retrieval must surface. `definition` marks
// the subset that must survive the trim outright — losing a signature is the
// failure mode that makes the whole stage untrustworthy.
// 280 filler units puts every fixture past ~5k tokens, so the default
// 4096-token budget actually bites. A fixture that fits under budget trims
// nothing, and its recall number would be a meaningless 100%.
function fixture({ id, path, query, body, kind = 'js', fillerCount = 280 }) {
  // Weighted to the front on purpose. Once the high-scoring lines are taken,
  // greedy selection spends the rest of the budget in file order, so gold
  // sitting in the first half survives whether or not it was ranked. Burying
  // it at ~85% depth means only a real relevance score can save it.
  const head = filler(Math.round(fillerCount * 0.85), kind)
  const tail = filler(fillerCount - Math.round(fillerCount * 0.85), kind)
  const lines = [...head]
  const gold = []
  const definitions = []
  for (const entry of body) {
    const text = typeof entry === 'string' ? entry : entry.text
    if (typeof entry !== 'string' && entry.gold) {
      gold.push(lines.length)
      if (entry.definition) definitions.push(lines.length)
    }
    lines.push(text)
  }
  lines.push(...tail)
  return { id, path, query, lines, gold, definitions }
}

const FIXTURES = [
  fixture({
    id: 'camel-definition',
    path: 'src/config.js',
    query: 'where is parse config implemented',
    body: [
      { text: 'export function parseConfig(opts) {', gold: true, definition: true },
      { text: '  const merged = Object.assign({}, DEFAULTS, opts)', gold: true },
      '  return merged',
      '}',
    ],
  }),
  fixture({
    id: 'snake-definition',
    path: 'src/config.py',
    kind: 'py',
    query: 'where is parse config implemented',
    body: [
      { text: 'def parse_config(opts):', gold: true, definition: true },
      { text: '    merged = dict(DEFAULTS, **opts)', gold: true },
      '    return merged',
    ],
  }),
  fixture({
    id: 'pascal-class',
    path: 'src/store.ts',
    query: 'find the config store class',
    body: [
      { text: 'export class ConfigStore {', gold: true, definition: true },
      { text: '  private map = new Map<string, string>()', gold: true },
      '  read(key) {',
      '    return this.map.get(key)',
      '  }',
      '}',
    ],
  }),
  fixture({
    id: 'acronym-method',
    path: 'src/net.ts',
    query: 'parse http response handling',
    body: [
      { text: 'export function parseHTTPResponse(raw) {', gold: true, definition: true },
      { text: '  const [head, body] = raw.split("\\r\\n\\r\\n")', gold: true },
      '  return { head, body }',
      '}',
    ],
  }),
  fixture({
    id: 'interface-type',
    path: 'src/types.ts',
    query: 'retry policy type definition',
    body: [
      { text: 'export interface RetryPolicy {', gold: true, definition: true },
      { text: '  maxAttempts: number', gold: true },
      '  backoffMs: number',
      '}',
    ],
  }),
  fixture({
    id: 'go-func',
    path: 'internal/server.go',
    query: 'handle upload request',
    body: [
      { text: 'func handleUploadRequest(w http.ResponseWriter, r *http.Request) {', gold: true, definition: true },
      { text: '\tfile, header, err := r.FormFile("upload")', gold: true },
      '\tdefer file.Close()',
      '}',
    ],
  }),
  fixture({
    id: 'rust-fn',
    path: 'src/lib.rs',
    query: 'decode frame header',
    body: [
      { text: 'pub fn decode_frame_header(buf: &[u8]) -> Result<Header> {', gold: true, definition: true },
      { text: '    let len = u32::from_be_bytes(buf[0..4].try_into()?);', gold: true },
      '    Ok(Header { len })',
      '}',
    ],
  }),
  fixture({
    id: 'nested-method',
    path: 'src/cache.js',
    query: 'evict least recently used entry',
    body: [
      'export class Cache {',
      { text: '  evictLeastRecentlyUsed() {', gold: true, definition: true },
      { text: '    const oldest = this.order.shift()', gold: true },
      '    this.map.delete(oldest)',
      '  }',
      '}',
    ],
  }),
  fixture({
    id: 'const-arrow',
    path: 'src/auth.js',
    query: 'verify session token',
    body: [
      { text: 'export const verifySessionToken = async (token) => {', gold: true, definition: true },
      { text: '  const claims = await jwt.verify(token, SECRET)', gold: true },
      '  return claims',
      '}',
    ],
  }),
  fixture({
    id: 'error-string',
    path: 'src/upload.js',
    query: 'connection timed out during upload',
    body: [
      { text: '    throw new UploadError("connection timed out during upload")', gold: true },
      { text: '  } catch (err) {', gold: false },
    ],
  }),
  fixture({
    id: 'config-key',
    path: 'src/settings.js',
    query: 'max retry attempts setting',
    body: [
      { text: 'const DEFAULTS = { maxRetryAttempts: 3, backoffMs: 250 }', gold: true },
      '// tuning knobs live above',
    ],
  }),
  fixture({
    id: 'comment-vs-code',
    path: 'src/queue.js',
    query: 'drain pending jobs',
    body: [
      '// TODO: drainPendingJobs should also flush metrics',
      { text: 'export function drainPendingJobs(queue) {', gold: true, definition: true },
      { text: '  while (queue.length) queue.shift().run()', gold: true },
      '}',
    ],
  }),
  fixture({
    id: 'definition-vs-callsite',
    path: 'src/index.js',
    query: 'build session key',
    body: [
      '  const key = buildSessionKey(req)',
      '  log.debug("using", buildSessionKey(req))',
      { text: 'export function buildSessionKey(req) {', gold: true, definition: true },
      { text: '  return `${req.ip}:${req.headers["x-session"]}`', gold: true },
      '}',
    ],
  }),
  fixture({
    id: 'multi-term',
    path: 'src/stream.js',
    query: 'abort controller signal cleanup on stream close',
    body: [
      { text: 'export function attachAbortCleanup(stream, controller) {', gold: true, definition: true },
      { text: "  stream.on('close', () => controller.abort())", gold: true },
      '}',
    ],
  }),
  fixture({
    id: 'dotted-path',
    path: 'src/user.js',
    query: 'user.email validation',
    body: [
      { text: 'export function validateUserEmail(user) {', gold: true, definition: true },
      { text: '  return EMAIL_RE.test(user.email)', gold: true },
      '}',
    ],
  }),
]

// --- Metrics ---

function ndcgAt(scores, goldSet, k = 10) {
  const order = Array.from({ length: scores.length }, (_, i) => i)
    .sort((a, b) => (scores[b] - scores[a]) || (a - b))
  let dcg = 0
  for (let rank = 0; rank < Math.min(k, order.length); rank++) {
    if (goldSet.has(order[rank])) dcg += 1 / Math.log2(rank + 2)
  }
  let idcg = 0
  for (let rank = 0; rank < Math.min(k, goldSet.size); rank++) idcg += 1 / Math.log2(rank + 2)
  return idcg === 0 ? 0 : dcg / idcg
}

function recallAfterTrim(fx, tokenizer, rerank) {
  const text = fx.lines.join('\n')
  const result = trimLinesByRelevance(text, fx.query, {
    targetTokens: 4096,
    path: fx.path,
    tokenizer,
    rerank,
  })
  // C9. When trimLinesByRelevance returns null (body under budget, under
  // minLines, or the trim grew the text) there IS no trimmed output, so
  // scoring the gold lines against `text` measured nothing and returned a
  // perfect 100% recall and 100% definition survival. The definition-survival
  // gate below therefore could not fail for any fixture that stopped trimming
  // — one fillerCount edit away from silently green forever.
  //
  // A fixture that does not trim is a broken fixture, not a passing one.
  if (!result) {
    return { recall: 0, defRecall: 0, tokens: null, originalTokens: null, noTrim: true }
  }
  const kept = result.text
  const survived = fx.gold.filter(i => kept.includes(fx.lines[i].trim())).length
  const defsSurvived = fx.definitions.filter(i => kept.includes(fx.lines[i].trim())).length
  return {
    recall: fx.gold.length === 0 ? 1 : survived / fx.gold.length,
    defRecall: fx.definitions.length === 0 ? 1 : defsSurvived / fx.definitions.length,
    tokens: result.trimmedTokens,
    originalTokens: result.originalTokens,
    noTrim: false,
  }
}

function evaluate(tokenizer, useRerank) {
  const rows = []
  for (const fx of FIXTURES) {
    const goldSet = new Set(fx.gold)
    let scores = bm25Scores(fx.lines, fx.query, { tokenizer })
    if (useRerank) scores = rerankScores(scores, fx.lines, tokenizer(fx.query))
    const trim = recallAfterTrim(fx, tokenizer, useRerank)
    rows.push({ id: fx.id, ndcg: ndcgAt(scores, goldSet), ...trim })
  }
  return rows
}

const mean = xs => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
const pct = x => `${(x * 100).toFixed(1)}%`

const before = evaluate(legacyTokenize, false)
const after = evaluate(tokenize, true)

console.log('\nbm25-trim retrieval quality  (15 fixtures, offline)\n')
console.log('fixture                    NDCG@10 before   after      Recall before   after')
console.log('-'.repeat(80))
for (let i = 0; i < FIXTURES.length; i++) {
  const b = before[i]
  const a = after[i]
  const flag = a.ndcg + 1e-9 < b.ndcg ? '  <-- regression' : ''
  console.log(
    `${b.id.padEnd(26)} ${b.ndcg.toFixed(3).padStart(7)} ${a.ndcg.toFixed(3).padStart(10)}` +
    `   ${pct(b.recall).padStart(12)} ${pct(a.recall).padStart(8)}${flag}`,
  )
}
console.log('-'.repeat(80))
console.log(
  `${'MEAN'.padEnd(26)} ${mean(before.map(r => r.ndcg)).toFixed(3).padStart(7)}` +
  ` ${mean(after.map(r => r.ndcg)).toFixed(3).padStart(10)}` +
  `   ${pct(mean(before.map(r => r.recall))).padStart(12)} ${pct(mean(after.map(r => r.recall))).padStart(8)}`,
)

// --- Gates ---

const failures = []

// A fixture that never trims proves nothing — surface it loudly rather than
// letting it count as a perfect score (C9).
const noTrim = after.filter(r => r.noTrim).map(r => r.id)
if (noTrim.length > 0) {
  failures.push(`${noTrim.length} fixture(s) produced no trim, so they measure nothing: ${noTrim.join(', ')}`)
}

const defRecall = mean(after.map(r => r.defRecall))
if (defRecall < 1) {
  const lost = after.filter(r => r.defRecall < 1).map(r => r.id)
  failures.push(`definition survival ${pct(defRecall)} (< 100%): ${lost.join(', ')}`)
}
if (mean(after.map(r => r.ndcg)) <= mean(before.map(r => r.ndcg))) {
  failures.push('mean NDCG@10 did not improve over the legacy tokenizer')
}
if (mean(after.map(r => r.recall)) < mean(before.map(r => r.recall))) {
  failures.push('mean recall regressed against the legacy tokenizer')
}

console.log(`\ndefinition survival at 4096-token budget: ${pct(defRecall)}`)
if (failures.length > 0) {
  console.error('\nFAIL')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('PASS\n')
