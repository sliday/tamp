# Evidence Bundle: bm25-hotpath-hardening

## Summary
- Overall status: PASS
- Last updated: 2026-11-27T00:42:00+00:00

## Acceptance criteria evidence

### AC1 (`lib/bm25.js` — injectable tokenizer in `rerankScores` and `trimLinesByRelevance`)
- Status: PASS
- Proof:
  - `lib/bm25.js`: `rerankScores(scores, lines, queryTokens, { tokenizer = tokenize } = {})` uses `tokenizer(def[1])` instead of module-level `tokenize(def[1])`, keeping 3-arg calls backwards-compatible.
  - `lib/bm25.js`: `trimLinesByRelevance` passes `{ tokenizer }` into `rerankScores(raw, lines, tokenizer(query), { tokenizer })`.
  - Verified by `test/bm25-trim.test.js` (`bm25 — rerank > honors an injectable tokenizer and defaults 3-arg calls to tokenize`) and `bench/retrieval-eval.js`.
  - Raw logs: `.agent/tasks/bm25-hotpath-hardening/raw/test-unit.txt`, `.agent/tasks/bm25-hotpath-hardening/raw/build.txt`.
- Gaps:
  - None.

### AC2 (`lib/bm25.js` & `compress.js` — `blockAware` visibility)
- Status: PASS
- Proof:
  - `lib/bm25.js`: `trimLinesByRelevance` returns `blockAware: Boolean(structure)` on its result object without removing or altering existing fields.
  - `compress.js`: `bm25TrimTargets` records `target.bm25BlockAware = Boolean(result.blockAware)`.
  - `compress.js`: `method: 'bm25-trim'` stat entry includes `blockAware: Boolean(target.bm25BlockAware)` and continues to reuse `target.bm25OriginalTokens` / `target.bm25TrimmedTokens`.
  - Verified by `test/bm25-trim.test.js` (`bm25 — blockAware visibility`) and `test/compress-hardening.test.js` (`bm25-trim precomputed token reuse`).
  - Raw logs: `.agent/tasks/bm25-hotpath-hardening/raw/test-unit.txt`.
- Gaps:
  - None.

### AC3 (`lib/tokens.js` — `AsyncLocalStorage` request-scoped instrumentation)
- Status: PASS
- Proof:
  - `lib/tokens.js`: uses `AsyncLocalStorage` from `'node:async_hooks'` (`observerStore`) with zero global counters and zero allocation/callback overhead when unobserved.
  - `lib/tokens.js`: exports `withTokenCountObserver(observer, fn)` and `withTokenCountBudget(fn)` with `TypeError` argument validation, empty/non-string fast-path before reading `observerStore`, nested observer composition, non-fatal `try/catch` around observers, and sync/async return + throw/rejection preservation.
  - Preserves `countTokens === safeCountTokens` identity and all existing `safeCountTokens` counting semantics (4KB cap, 3-window sampling, fallback).
  - Verified by `test/bm25-trim.test.js` (`tokens — request-scoped observer & budget (AsyncLocalStorage)`) and `test/compress-hardening.test.js` (`safe tokenizer (lib/tokens.js)`).
  - Raw logs: `.agent/tasks/bm25-hotpath-hardening/raw/test-unit.txt`.
- Gaps:
  - None.

### AC4 (`bench/retrieval-eval.js` — de-confounded arms & retrieval gates)
- Status: PASS
- Proof:
  - `bench/retrieval-eval.js`: calls `rerankScores(scores, fx.lines, tokenizer(fx.query), { tokenizer })` inside `evaluate`.
  - `bench/retrieval-eval.js`: runs both arms with `rerank: true` (`before = evaluate(legacyTokenize, true)`, `after = evaluate(tokenize, true)`).
  - Preserves existing gates (`noTrim`, `defRecall`, mean NDCG improvement, mean recall non-regression) and adds `MEAN_NDCG_FLOOR = 0.90`, per-fixture regression check (`after[i].ndcg + 1e-9 < before[i].ndcg`), and `PER_FIXTURE_NDCG_FLOOR = 0.50`.
  - `node bench/retrieval-eval.js` exited `0` (`PASS`): `before` mean NDCG@10 `0.441` / recall `46.7%`, `after` mean NDCG@10 `0.931` (`>= 0.90`) / recall `100.0%`, definition survival `100.0%`, `0` per-fixture regressions, min per-fixture `after` NDCG@10 `0.651` (`>= 0.50`).
  - Raw logs: `.agent/tasks/bm25-hotpath-hardening/raw/test-integration.txt`.
- Gaps:
  - None.

### AC5 (`test/bm25-trim.test.js` — `rerankScores` injectable tokenizer unit tests)
- Status: PASS
- Proof:
  - Added test `honors an injectable tokenizer and defaults 3-arg calls to tokenize` under `describe('bm25 — rerank')` proving default 3-arg camelCase boost, non-splitting custom tokenizer suppression, and synthetic custom tokenizer activation.
  - Passed in `node --test test/bm25-trim.test.js test/compress-hardening.test.js test/code-chunks.test.js` and `npm test`.
  - Raw logs: `.agent/tasks/bm25-hotpath-hardening/raw/test-unit.txt`.
- Gaps:
  - None.

### AC6 (`test/bm25-trim.test.js` — request-scoped token-count budget & concurrency isolation tests)
- Status: PASS
- Proof:
  - Added suite `describe('tokens — request-scoped observer & budget (AsyncLocalStorage)')` covering `countTokens === safeCountTokens`, `TypeError` validation, sync/async return & error propagation, empty/non-string fast-path (`calls === 0`), non-fatal throwing observers, nested scope composition, `compressRequest` with `stages: ['bm25-trim']` (`calls === 2` trimmed, `calls === 1` early no-trim exit), and concurrent `Promise.all` isolation (`calls === 1, 2, 5`).
  - All 5 tests in the suite passed in targeted runs and `npm test`.
  - Raw logs: `.agent/tasks/bm25-hotpath-hardening/raw/test-unit.txt`.
- Gaps:
  - None.

### AC7 (`test/bm25-trim.test.js` — `blockAware` stat visibility tests)
- Status: PASS
- Proof:
  - Added suite `describe('bm25 — blockAware visibility')` verifying `trimLinesByRelevance` (`blockAware: true` on balanced JS, `false` on plain log) and `compressRequest` with `stages: ['bm25-trim']` (`stat.blockAware === true` on `> 64 KB` balanced JS, `false` on `> 64 KB` plain log).
  - Both tests passed in targeted runs and `npm test`.
  - Raw logs: `.agent/tasks/bm25-hotpath-hardening/raw/test-unit.txt`.
- Gaps:
  - None.

### AC8 (`test/bm25-trim.test.js` — 64KB superlinear-input CPU guards)
- Status: PASS
- Proof:
  - Added suite `describe('bm25 — 64KB superlinear-input CPU guards')` using `assertCpuBudget(..., 25)` after warm-up across public functions `detectBlocks`, `tokenize`, `bm25Scores`, and `rerankScores` on 64KB escaped-quote runs, unterminated quotes, long identifiers (plain, camelCase, dotted), and deep Python-style indentation.
  - All 4 CPU guard tests passed in targeted runs and `npm test`.
  - Raw logs: `.agent/tasks/bm25-hotpath-hardening/raw/test-unit.txt`.
- Gaps:
  - None.

### AC9 (Full test suite & diff hygiene)
- Status: PASS
- Proof:
  - `npm test` exited `0`: `977` passed, `0` failed (`221` suites) + `bench/retrieval-eval.js` `PASS`.
  - `node smoke.js` exited `0`: `All checks passed!`.
  - `git status --short` and `git diff --name-only` confirm strictly the 5 allowed implementation/test files were modified (`bench/retrieval-eval.js`, `compress.js`, `lib/bm25.js`, `lib/tokens.js`, `test/bm25-trim.test.js`) with zero new external dependencies.
  - Raw logs: `.agent/tasks/bm25-hotpath-hardening/raw/test-unit.txt`, `.agent/tasks/bm25-hotpath-hardening/raw/test-integration.txt`, `.agent/tasks/bm25-hotpath-hardening/raw/lint.txt`.
- Gaps:
  - None.

## Commands run
- `node -v` -> `v22.17.0`
- `node --check lib/bm25.js lib/tokens.js compress.js bench/retrieval-eval.js test/bm25-trim.test.js` -> exit `0`
- `node --test test/bm25-trim.test.js test/compress-hardening.test.js test/code-chunks.test.js` -> exit `0` (`58` pass, `0` fail)
- `node bench/retrieval-eval.js` -> exit `0` (`PASS`; before `0.441`, after `0.931`, defRecall `100.0%`)
- `npm test` -> exit `0` (`977` pass, `0` fail + `bench/retrieval-eval.js` `PASS`)
- `node smoke.js` -> exit `0` (`All checks passed!`)
- `git status --short` / `git diff --stat` / `git diff --name-only` -> exit `0` (only 5 allowed files modified)

## Raw artifacts
- `.agent/tasks/bm25-hotpath-hardening/raw/build.txt`
- `.agent/tasks/bm25-hotpath-hardening/raw/lint.txt`
- `.agent/tasks/bm25-hotpath-hardening/raw/test-unit.txt`
- `.agent/tasks/bm25-hotpath-hardening/raw/test-integration.txt`

## Known gaps
- None.
