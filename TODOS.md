# TODOS

Deferred work with enough context to pick up cold. Each item carries a measurement and
an exit criterion — a TODO without one is prose, not work.

---

## P2 — Retrieval-quality gates for the remaining lossy stages

**What:** `bm25-trim` is the only lossy stage with a quality number. `llmlingua`,
`textpress`, `disclosure` and `prune` are unmeasured.

**Why:** Every one of them can silently degrade what the model sees. `bm25-trim` shipped
for months with a tokenizer that scored the queried definition line at exactly 0 and
dropped it; nobody noticed because nothing measured it. The other four are in the same
position today.

**Do not treat these as one problem.** They fail differently and need different harnesses:

| Stage | Kind | Right measurement |
|---|---|---|
| `prune` | structural removal | assert removed keys are provably npm-internal; no semantic eval needed |
| `disclosure` | reference substitution | round-trip: rehydrate and assert byte-identical |
| `llmlingua` | generative compressor | task-completion eval (`bench/semantic-eval.js` is the template) |
| `textpress` | generative compressor | same, plus a refusal/malformed-output path |

`bench/retrieval-eval.js` is the template only for the first two. The generative pair need
an LLM in the loop, which means an API key, which means they cannot join `npm test`.

**Exit criterion:** each of the four has a gate that fails on regression, and the two
offline ones run in `npm test`.

**Depends on:** T5 (fix the confounded arms and weak NDCG gate in `retrieval-eval.js`
first — do not clone a broken template four times).

**Effort:** human ~2d / CC ~1h.

---

## P3 — Per-request `countTokens` memo cache

**What:** Cache tokenizer results within a single request, keyed on the input string.

**Why:** `countTokens` costs a ~22 ms fixed floor per call plus a proportional term, and
`compress.js` counts the same target text at more than one stage.

**Measure before building.** The value depends entirely on the duplicate rate, which
nobody has measured:
- instrument `lib/tokens.js` (built in PR2) to log `(call count, distinct-input count)`
  per request
- run a real Claude Code session through the proxy
- **build only if duplicates exceed ~20% of calls**

**Cons to weigh:** the cache keys on full text, so a request carrying several large
`tool_result` bodies holds megabytes for the request's lifetime. Bound it by entry size or
count, not just by request scope.

**Exit criterion:** either a measured duplicate rate above the threshold and a bounded
cache shipped, or a recorded measurement below it and this item closed.

**Depends on:** PR2's `lib/tokens.js` wrapper — that is where the instrumentation lives.

**Effort:** human ~2h / CC ~8min.

---

## P3 — Fragment tolerance in block detection

**What:** `detectBlocks` returns `null` for any brace-unbalanced body, so partial files
(grep output, `sed -n` ranges, truncated reads) never get block-aware trimming.

**Why:** Verified — the same source gives 4 blocks complete and `null` with either the
first or last line removed. This may be a large share of real traffic or a trivial one.

**Measure first.** PR2 adds an attempt-level reason code to the `bm25-trim` stat
(`applied` / `unbalanced` / `unsupported` / `no-path` / `no-blocks`). Read the
`unbalanced` share off real traffic before building anything.

**Exit criterion:** `unbalanced` share known. Build tolerance only if it is material, and
only in a way that does not fabricate structure — the module's contract is that it refuses
to guess.

**Depends on:** PR2 reason-code stat (T10).

**Effort:** human ~4h / CC ~25min.

---

## P3 — Pair Tamp with semble in the docs

**What:** Note in the README that `semble` (code search for agents) is complementary.

**Why:** Semble stops the grep-and-read from happening; Tamp compresses what survives.
The largest token win is the read that never occurs. Zero code.

**Exit criterion:** a short README section exists.

**Effort:** human ~30min / CC ~5min.
