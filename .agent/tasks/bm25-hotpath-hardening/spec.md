# Task Spec: bm25-hotpath-hardening

## Metadata
- Task ID: bm25-hotpath-hardening
- Created: 2026-11-27T00:34:03+00:00
- Frozen: 2026-11-27
- Repo root: /Users/stas/Playground/tamp
- Working directory at init: /Users/stas/Playground/tamp

## Guidance sources
- `AGENTS.md`
- `CLAUDE.md`
- `docs/designs/bm25-hotpath-hardening.md`

## Original task statement
Fix T-06 (RICE #1, score 5.7): BM25 hot-path hardening remainder (`docs/designs/bm25-hotpath-hardening.md`).
1. In `lib/bm25.js`, thread optional `{ tokenizer = tokenize }` through `rerankScores(scores, lines, queryTokens, opts)` and pass `{ tokenizer }` from `trimLinesByRelevance()`; also expose `blockAware: Boolean(structure)` on `trimLinesByRelevance` output (and pass through `bm25-trim` stat entry in `compress.js`).
2. In `lib/tokens.js`, add `AsyncLocalStorage` request-scoped call-count instrumentation (`withTokenCountObserver` / `withTokenCountBudget`) with zero global state and zero overhead when unobserved, so concurrent requests stay isolated.
3. In `bench/retrieval-eval.js`, de-confound the before/after comparison by running both arms with `rerank: true` and passing `{ tokenizer }` into `rerankScores`, add an absolute mean NDCG@10 floor (`>= 0.90`), and add per-query regression gates (no fixture may drop below `before.ndcg` or below a per-fixture absolute NDCG floor of `0.50`).
4. Add deterministic tests in `test/bm25-trim.test.js` covering `rerankScores` injectable tokenizer, request-scoped tokenizer call-count budget on `compressRequest` with `bm25-trim` (proving zero redundant recounts and concurrent `AsyncLocalStorage` isolation), `blockAware` stat visibility, and 64KB superlinear-input CPU guards (via `test/helpers/timing.js`) for `detectBlocks`/`tokenize`/`bm25Scores`/`rerankScores`.

## Narrow ambiguity resolutions

1. **Empty-string / non-string fast path in `lib/tokens.js`:**
   - `safeCountTokens(text)` returns `0` immediately for `typeof text !== 'string' || text.length === 0` **before** reading `observerStore.getStore()` or invoking the observer.
   - Rationale: empty/non-string inputs never touch `@anthropic-ai/tokenizer` (O(1) zero-cost exit). Triggering the observer only after the fast-path guard ensures `observer(text)` always receives a non-empty `string` and `withTokenCountBudget` counts actual tokenizer boundary invocations (including calls that enter `rawCountTokens` and later fall back in `catch`).
2. **Nested `withTokenCountObserver` scopes and argument validation:**
   - If `typeof observer !== 'function'` or `typeof fn !== 'function'`, `withTokenCountObserver` throws a `TypeError`. (Likewise `withTokenCountBudget` throws a `TypeError` if `typeof fn !== 'function'`.)
   - Nested `withTokenCountObserver` calls compose parent and child observers so both are notified; each observer invocation is wrapped in `try { ... } catch {}` so a throwing observer never breaks `safeCountTokens` or sibling/parent observers.
3. **Sync vs async return contract for `withTokenCountObserver` and `withTokenCountBudget`:**
   - `withTokenCountObserver(observer, fn)` returns `fn()` directly (value for sync `fn`, Promise/thenable for async `fn`), preserving sync throws and async rejections.
   - `withTokenCountBudget(fn)` returns `{ result, calls }` synchronously when `fn()` is synchronous, and returns a `Promise` resolving to `{ result, calls }` when `fn()` returns a thenable (`out && typeof out.then === 'function'`), preserving sync throws and async rejections.
4. **De-confounded benchmark baseline verification:**
   - Verified offline against the current 15 fixtures in `bench/retrieval-eval.js`: running both arms with `rerank: true` and threading `{ tokenizer }` into `rerankScores` yields `before` mean NDCG@10 `0.441` and `after` mean NDCG@10 `0.931` (`>= 0.90`), zero per-query regressions (`after.ndcg + 1e-9 < before.ndcg` is false for all 15 fixtures), and minimum per-fixture `after.ndcg` of `0.651` (`definition-vs-callsite`, `>= 0.50`). No fixture edits are needed.
5. **Under-budget / no-trim call-count fixture in `test/bm25-trim.test.js`:**
   - `bm25TrimTargets` skips targets `<= 64 * 1024` UTF-8 bytes without calling `trimLinesByRelevance`. To exercise the 1-call under-budget / no-trim path through `compressRequest` with `stages: ['bm25-trim']`, use a `> 64 KB` target that exits early after `originalTokens = countTokens(text)` inside `trimLinesByRelevance` (for example, a `> 64 KB` payload with `< minLines` lines or low token density `<= 4096` tokens) and is not compressed by any other stage (`stages: ['bm25-trim']`), asserting `calls === 1`.
6. **64KB CPU guard shape:**
   - Exercise public entry points (`detectBlocks`, `tokenize`, `bm25Scores`, `rerankScores`) — do not export private regexes.
   - Each guard warms up the function once before asserting `assertCpuBudget(label, fn, 25)` from `test/helpers/timing.js` (`< 25ms` process CPU time, default wall-clock backstop).

## Acceptance criteria

- **AC1 (`lib/bm25.js` — injectable tokenizer in `rerankScores` and `trimLinesByRelevance`):**
  - `rerankScores(scores, lines, queryTokens, { tokenizer = tokenize } = {})` uses `tokenizer(def[1])` rather than module-level `tokenize(def[1])` when checking whether a definition name matches `queryTokens`.
  - Existing 3-argument calls `rerankScores(scores, lines, queryTokens)` remain fully backwards-compatible and default to `tokenize`.
  - `trimLinesByRelevance` passes `{ tokenizer }` into `rerankScores(raw, lines, tokenizer(query), { tokenizer })`.

- **AC2 (`lib/bm25.js` & `compress.js` — `blockAware` visibility):**
  - `trimLinesByRelevance` returns `blockAware: Boolean(structure)` on its result object (all existing return fields remain unchanged).
  - `bm25TrimTargets` in `compress.js` records `target.bm25BlockAware = Boolean(result.blockAware)` on trimmed targets.
  - The `method: 'bm25-trim'` stat entry pushed in `compress.js` includes `blockAware: Boolean(target.bm25BlockAware)` and continues to reuse `target.bm25OriginalTokens` and `target.bm25TrimmedTokens` without redundant `countTokens` recounts.

- **AC3 (`lib/tokens.js` — `AsyncLocalStorage` request-scoped instrumentation):**
  - Uses `AsyncLocalStorage` from `'node:async_hooks'` with zero module-level/global call counters and zero allocations/callback overhead when no observer is active.
  - Exports `withTokenCountObserver(observer, fn)` and `withTokenCountBudget(fn)` adhering to the contracts in "Narrow ambiguity resolutions" (items 1–3): non-empty string calls only, non-fatal throwing observers, nested scope composition, sync & async `fn` support, and full isolation across concurrent async executions.
  - Preserves `countTokens === safeCountTokens` identity (as verified by `test/compress-hardening.test.js`) and all existing `safeCountTokens` counting semantics (empty/non-string -> `0`, 4KB cap, 3-window sampling, try/catch fallback).

- **AC4 (`bench/retrieval-eval.js` — de-confounded arms & retrieval gates):**
  - Inside `evaluate(tokenizer, useRerank)`, `rerankScores` is called with `{ tokenizer }`: `rerankScores(scores, fx.lines, tokenizer(fx.query), { tokenizer })`.
  - Runs both arms with `rerank: true`: `before = evaluate(legacyTokenize, true)` and `after = evaluate(tokenize, true)`.
  - Preserves all existing gates (`noTrim.length === 0`, `defRecall === 1`, `mean(after.ndcg) > mean(before.ndcg)`, `mean(after.recall) >= mean(before.recall)`).
  - Adds absolute mean NDCG@10 floor gate: fails if `mean(after.ndcg) < 0.90`.
  - Adds per-query regression gates: fails if any fixture has `after[i].ndcg + 1e-9 < before[i].ndcg` OR `after[i].ndcg < 0.50`.
  - `node bench/retrieval-eval.js` exits `0` (`PASS`).

- **AC5 (`test/bm25-trim.test.js` — `rerankScores` injectable tokenizer unit tests):**
  - Verifies `rerankScores` honors a custom `{ tokenizer }` option (e.g., a non-splitting tokenizer suppresses the camelCase definition boost while the default splitting tokenizer applies it) and that 3-argument calls still default to `tokenize`.

- **AC6 (`test/bm25-trim.test.js` — request-scoped token-count budget & concurrency isolation tests):**
  - Unit tests `withTokenCountObserver` and `withTokenCountBudget` for sync & async `fn`, observer argument delivery, empty-string fast-path (`calls === 0`), non-fatal throwing observer, nested observers, and `countTokens === safeCountTokens`.
  - Integration tests `compressRequest` with `stages: ['bm25-trim']` verifying:
    - Exactly `2` `safeCountTokens` calls for 1 trimmed `> 64 KB` target (1 original + 1 trimmed, zero redundant recounts in `compress.js`).
    - Exactly `1` `safeCountTokens` call when a `> 64 KB` target exits without trimming inside `trimLinesByRelevance`.
    - Concurrent `Promise.all` isolation: interleaved async scopes using `withTokenCountBudget` report their exact independent call counts with zero cross-contamination.

- **AC7 (`test/bm25-trim.test.js` — `blockAware` stat visibility tests):**
  - Verifies `trimLinesByRelevance` sets `blockAware: true` on balanced JS code and `blockAware: false` on plain log text.
  - Verifies `compressRequest` with `stages: ['bm25-trim']` sets `stat.blockAware === true` on a `> 64 KB` balanced JS `tool_result` and `stat.blockAware === false` on a `> 64 KB` plain log `tool_result`.

- **AC8 (`test/bm25-trim.test.js` — 64KB superlinear-input CPU guards):**
  - Uses `assertCpuBudget` from `./helpers/timing.js` with `< 25ms` CPU budget (after warm-up) on `64 KB` (`64 * 1024`) pathological inputs exercising public functions `detectBlocks`, `tokenize`, `bm25Scores`, and `rerankScores` across:
    - escaped-quote runs (`'"' + 'a\\"'.repeat(...)`),
    - unterminated quotes,
    - long identifier runs (plain, camelCase, dotted),
    - deep indentation (Python-style indent blocks).

- **AC9 (Full test suite & diff hygiene):**
  - `npm test` (`node --test test/*.test.js && node bench/retrieval-eval.js`) passes cleanly with exit code `0`.
  - Diff is strictly limited to the 5 allowed implementation/test files (plus `.agent/tasks/bm25-hotpath-hardening/*` artifacts).

## Constraints
- Plain Node.js ESM JavaScript only — no TypeScript syntax or build step.
- Zero new external npm dependencies (`node:async_hooks` is built-in).
- Restrict source and test edits strictly to:
  - `lib/bm25.js`
  - `lib/tokens.js`
  - `compress.js`
  - `bench/retrieval-eval.js`
  - `test/bm25-trim.test.js`
- Keep diffs minimal and adhere to existing repo style (2-space indent, ESM imports, no unrelated reformatting or comment churn).
- Do not modify `metadata.js`, `lib/code-chunks.js`, `index.js`, `stats.js`, `package.json`, or `CHANGELOG.md`.
- Do not push to `main` or modify git history/branches as part of implementation.

## Non-goals
- Rewriting `lib/code-chunks.js` (already uses linear single-pass character scanning and indent stack).
- Adding per-request `countTokens` memo caching (deferred E4) or changing token estimation across other stages (`compressBlock`, `stats.js`, `bench/render.js`, `index.js`).
- Adding retrieval-quality gates for other lossy stages (`llmlingua`, `textpress`, `disclosure`, `prune`).
- Exporting private regex constants from `lib/bm25.js` or `lib/code-chunks.js`.
- Version bumps, `CHANGELOG.md` updates, or PR creation.

## Verification plan
- **Build:** N/A (plain Node.js ESM JavaScript; verify clean module loading via `node --test`).
- **Unit tests:** `node --test test/bm25-trim.test.js test/compress-hardening.test.js`
- **Retrieval benchmark / quality gates:** `node bench/retrieval-eval.js` (confirm `before` mean ~`0.441`, `after` mean `>= 0.90`, `defRecall === 100.0%`, zero per-query regressions, min per-fixture `after.ndcg >= 0.50`, exit code `0`).
- **Full regression suite:** `npm test` (runs `node --test test/*.test.js && node bench/retrieval-eval.js`, exit code `0`).
- **Lint / diff check:** `git diff --stat` and `git status --short` confirming only the 5 allowed files (and task artifacts) were modified, with zero new dependencies.
