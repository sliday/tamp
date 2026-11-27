# Evidence Bundle: test-timing-stability

## Summary
- Overall status: PASS
- Last updated: 2026-11-27T00:11:00+00:00

## Acceptance criteria evidence

### AC1 (Test-only scope, zero production diff, zero new dependencies)
- Status: PASS
- Proof:
  - `git status --short` and `git diff --stat` in `.agent/tasks/test-timing-stability/raw/lint.txt` show strictly 8 modified files and 2 new files under `test/` (plus workflow artifacts under `.agent/tasks/test-timing-stability/`), with zero edits to production files or `package.json`/`package-lock.json`.
  - All 10 new/modified files are plain Node.js ESM `.js` files passing `node --check` (`.agent/tasks/test-timing-stability/raw/build.txt`).
- Gaps:
  - None.

### AC2 (`test/helpers/timing.js` CPU + wall-clock helper API and semantics)
- Status: PASS
- Proof:
  - `test/helpers/timing.js` exports `measureCpuMs`, `measureCpuMsAsync`, `assertCpuBudget`, and `assertCpuBudgetAsync`.
  - Uses `process.cpuUsage(startCpu)` (`(delta.user + delta.system) / 1000`) and `Number(process.hrtime.bigint() - startWall) / 1e6`.
  - `checkBudget` computes `maxWallMs = opts.maxWallMs ?? Math.max(maxCpuMs * 10, 2000)`, asserts `cpuMs < maxCpuMs` and `wallMs < maxWallMs` via `node:assert/strict`, returns `{ result, cpuMs, wallMs }` on pass, and throws `AssertionError` including `label`, measured `cpuMs`, `maxCpuMs`, measured `wallMs`, and `maxWallMs` on either breach.
  - Verified by `test/timing-helper.test.js` (8/8 pass in `.agent/tasks/test-timing-stability/raw/test-unit.txt`).
- Gaps:
  - None.

### AC3 (`test/compress-hardening.test.js` warmup + CPU/wall budgets)
- Status: PASS
- Proof:
  - `test/compress-hardening.test.js` calls `safeCountTokens('warm')` before measuring the 512KB space-padded payload.
  - Asserts `safeCountTokens(payload)` via `assertCpuBudget(..., 500, { maxWallMs: 5000 })` and `compressRequest(...)` via `assertCpuBudgetAsync(..., 1000, { maxWallMs: 5000 })`.
  - Preserves all functional assertions (`tokens > 0`, `countTokens === safeCountTokens`, `bm25SafeCountTokens === safeCountTokens`, `stats[0].method === 'normalize'`).
  - Passes in all 3 consecutive default-concurrency `npm test` runs (`.agent/tasks/test-timing-stability/raw/test-unit.txt`).
- Gaps:
  - None.

### AC4 (`test/quality-gates.test.js` ReDoS guard uses CPU budget)
- Status: PASS
- Proof:
  - `test/quality-gates.test.js` preserves warmups for `redactText`, `stripAnsi`, and `rewriteCommandOutput` plus all 13 64KB pathological cases.
  - `assertFast(label, fn)` uses `assertCpuBudget(label, fn, 25, { maxWallMs: 1000 })` with at most one CPU-budget-only retry to absorb a stray V8 major GC pause while still enforcing `< 25ms` CPU and `< 1000ms` wall.
  - Passes in all 3 consecutive default-concurrency `npm test` runs (`.agent/tasks/test-timing-stability/raw/test-unit.txt`).
- Gaps:
  - None.

### AC5 (ReDoS/complexity guards in `test/redact.test.js`, `test/compress.test.js`, `test/detect.test.js`, `test/code-chunks.test.js`)
- Status: PASS
- Proof:
  - `test/redact.test.js`: migrated `redactText('A'.repeat(256_000))` to `assertCpuBudget(..., 250)`.
  - `test/compress.test.js`: migrated `normalizeWhitespace` (`' '.repeat(256_000) + 'x'`) to `assertCpuBudget(..., 300)` and `stripComments` (`'/**\n'.repeat(64_000)`) to `assertCpuBudget(..., 400)`.
  - `test/detect.test.js`: migrated `isTOON('a'.repeat(256_000))` to `assertCpuBudget(..., 250)`.
  - `test/code-chunks.test.js`: migrated `buildStructure(lines, blocks)` on 8000 nested lines to `assertCpuBudget(..., 500)` while preserving `assert.equal(parent.length, 8000)`.
  - All 4 files pass across 3 consecutive default-concurrency `npm test` runs (`.agent/tasks/test-timing-stability/raw/test-unit.txt`).
- Gaps:
  - None.

### AC6 (`test/proxy-usage.test.js` client disconnect race eliminated)
- Status: PASS
- Proof:
  - `test/proxy-usage.test.js` (`stops reading the upstream once the client is gone`) awaits `clientDestroyed` before `wait(300)` -> `settled = written` -> `wait(300)` -> `assert.equal(written, settled, ...)`.
  - `clientDestroyed` resolves in `res.once('data', ...)` after calling `req.destroy()` and clearing the 5000ms bounded timer; `finally` also clears the timer so no handles leak.
  - Passes in `node --test test/proxy-usage.test.js` (5/5 pass in `.agent/tasks/test-timing-stability/raw/test-integration.txt`) and all 3 `npm test` runs.
- Gaps:
  - None.

### AC7 (`test/usage-tap.test.js` encoded-stream timeout hardened without slowing normal runs)
- Status: PASS
- Proof:
  - `test/usage-tap.test.js` raises `runAsync` default `waitMs` from `300` to `2000`; `done()` clears the timer immediately on `onUsage` (~20ms normal completion).
  - Explicit negative-test `waitMs` arguments (`50`, `100`, `200`) remain untouched.
  - Passes in all 3 `npm test` runs (`.agent/tasks/test-timing-stability/raw/test-unit.txt`).
- Gaps:
  - None.

### AC8 (Unit tests for `test/helpers/timing.js`)
- Status: PASS
- Proof:
  - `test/timing-helper.test.js` is discovered by `node --test test/*.test.js` and passes 8/8 tests covering `measureCpuMs`, `measureCpuMsAsync`, `assertCpuBudget` (pass, CPU breach, wall breach), and `assertCpuBudgetAsync` (async idle pass where `wallMs > maxCpuMs`, default `maxWallMs` formula, CPU breach, wall breach).
  - Recorded in `.agent/tasks/test-timing-stability/raw/test-unit.txt`.
- Gaps:
  - None.

### AC9 (Multi-run stability & smoke verification)
- Status: PASS
- Proof:
  - Default-concurrency `npm test` passed 3 consecutive times with 0 failures:
    - Run 1: `tests 965, suites 218, pass 965, fail 0, duration_ms 4711.29` + `bench/retrieval-eval.js` `PASS`.
    - Run 2: `tests 965, suites 218, pass 965, fail 0, duration_ms 3880.39` + `bench/retrieval-eval.js` `PASS`.
    - Run 3: `tests 965, suites 218, pass 965, fail 0, duration_ms 3110.16` + `bench/retrieval-eval.js` `PASS`.
  - `node smoke.js` exited `0` with all 6 checks passing (`.agent/tasks/test-timing-stability/raw/test-integration.txt`).
- Gaps:
  - None.

## Commands run
- `node --version` -> `v22.17.0`
- `node --check test/helpers/timing.js ...` (all 10 new/modified test files) -> exit `0`
- `git status --short && git diff --stat` -> exit `0` (strictly `test/` changes)
- `node --test test/timing-helper.test.js` -> exit `0` (8/8 pass)
- `node --test test/proxy-usage.test.js` -> exit `0` (5/5 pass)
- `npm test` (3 consecutive runs, default concurrency) -> exit `0` (965/965 pass + retrieval-eval PASS on all 3 runs)
- `node smoke.js` -> exit `0` (6/6 checks passed)

## Raw artifacts
- `.agent/tasks/test-timing-stability/raw/build.txt`
- `.agent/tasks/test-timing-stability/raw/lint.txt`
- `.agent/tasks/test-timing-stability/raw/test-unit.txt`
- `.agent/tasks/test-timing-stability/raw/test-integration.txt`

## Known gaps
- None.
