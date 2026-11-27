# Task Spec: test-timing-stability

## Metadata
- Task ID: test-timing-stability
- Status: FROZEN
- Created: 2026-11-27T00:04:33+00:00
- Frozen: 2026-11-27T00:06:00+00:00
- Repo root: /Users/stas/Playground/tamp
- Working directory at init: /Users/stas/Playground/tamp

## Guidance sources
- `AGENTS.md`
- `CLAUDE.md`
- `package.json`

## Original task statement
Fix T-08 (RICE #1, score 11.4): Stabilize parallel-load timing flakes in `npm test` without weakening DoS/ReDoS regression protection.
1. Add a tiny zero-dependency helper `test/helpers/timing.js` measuring process CPU time via `process.cpuUsage()` (immune to OS preemption under parallel `node --test`) alongside a generous wall-clock safety backstop, plus async CPU measurement support.
2. Update `test/compress-hardening.test.js` to warm up `safeCountTokens` before measuring and assert strict CPU budgets (`< 500ms` `safeCountTokens`, `< 1000ms` `compressRequest`) + generous wall-clock backstops so the 88s raw-tokenizer bug still fails fast while 16-way CPU contention never flakes.
3. Update `test/quality-gates.test.js` `assertFast` and ReDoS/complexity guards in `test/redact.test.js`, `test/compress.test.js`, `test/detect.test.js`, and `test/code-chunks.test.js` to measure process CPU time (keeping strict CPU budgets, e.g. `< 25ms` in `quality-gates`) + generous wall-clock backstops.
4. Eliminate async scheduling races in `test/proxy-usage.test.js` (await client `req.destroy()` before snapshotting upstream written bytes) and `test/usage-tap.test.js` (increase default `runAsync` fallback timeout for positive encoded-stream tests without slowing the normal path).
5. Add unit tests for `test/helpers/timing.js` and verify default-concurrency `npm test` passes reliably across multiple consecutive runs plus `node smoke.js`.

## Acceptance criteria

- **AC1 (Test-only scope, zero production diff, zero new dependencies):**
  All code edits are strictly under `test/` (no modifications to `lib/`, `compress.js`, `index.js`, `bin/`, `config.js`, `providers.js`, `metadata.js`, `detect.js`, `session-graph.js`, `stats.js`, `package.json`, or `package-lock.json`). All new/modified code is plain Node.js ESM JavaScript (`.js`) with zero new external npm dependencies.

- **AC2 (`test/helpers/timing.js` CPU + wall-clock helper API and semantics):**
  `test/helpers/timing.js` exists and exports:
  - `measureCpuMs(fn)` -> `{ result, cpuMs, wallMs }` where `cpuMs = (delta.user + delta.system) / 1000` via `process.cpuUsage(startCpu)` and `wallMs = Number(process.hrtime.bigint() - startWall) / 1e6`.
  - `measureCpuMsAsync(fn)` -> `Promise<{ result, cpuMs, wallMs }>` measuring the same CPU and wall deltas across an awaited invocation of `fn()`.
  - `assertCpuBudget(label, fn, maxCpuMs, opts = {})` -> runs `measureCpuMs(fn)`, asserts `cpuMs < maxCpuMs` AND `wallMs < maxWallMs` (where `maxWallMs = opts.maxWallMs ?? Math.max(maxCpuMs * 10, 2000)`), returns `{ result, cpuMs, wallMs }` on pass, and throws an `AssertionError` whose message includes `label`, measured `cpuMs`, `maxCpuMs`, measured `wallMs`, and `maxWallMs` on either breach.
  - `assertCpuBudgetAsync(label, fn, maxCpuMs, opts = {})` -> async equivalent of `assertCpuBudget` using `measureCpuMsAsync(fn)`, with identical budget checks, default `maxWallMs`, return shape, and `AssertionError` diagnostics.

- **AC3 (`test/compress-hardening.test.js` warmup + CPU/wall budgets):**
  In `test/compress-hardening.test.js` (`handles 512KB space-padded adversarial payload fast with no WASM crash`):
  - `safeCountTokens('warm')` is called before measuring the 512KB space-padded payload so one-time WASM/tokenizer initialization is excluded from the budget.
  - `safeCountTokens(payload)` is asserted via `assertCpuBudget` with strict CPU budget `< 500ms` and `maxWallMs: 5000`.
  - `compressRequest(body, { minSize: 50, stages: ['whitespace'], log: false }, anthropic)` is asserted via `assertCpuBudgetAsync` with strict CPU budget `< 1000ms` and `maxWallMs: 5000`.
  - All existing functional assertions (`tokens > 0`, `countTokens === safeCountTokens`, `bm25SafeCountTokens === safeCountTokens`, `stats[0].method === 'normalize'`) remain intact.

- **AC4 (`test/quality-gates.test.js` ReDoS guard uses CPU budget):**
  In `test/quality-gates.test.js` (`quality gate — adversarial ReDoS timing (< 25ms on 64KB inputs)`):
  - Existing JIT/regex warmups for `redactText`, `stripAnsi`, and `rewriteCommandOutput` remain in place.
  - `assertFast(label, fn)` measures process CPU time via `test/helpers/timing.js`, enforcing the strict `< 25ms` CPU budget and `maxWallMs: 1000` wall-clock backstop (retaining all 13 existing 64KB pathological cases unchanged).

- **AC5 (ReDoS/complexity guards in `test/redact.test.js`, `test/compress.test.js`, `test/detect.test.js`, `test/code-chunks.test.js`):**
  Each timing guard is migrated from raw wall-clock `process.hrtime.bigint()` checks to `assertCpuBudget` from `test/helpers/timing.js`, preserving its existing strict CPU threshold plus a generous wall-clock backstop (`opts.maxWallMs` or default `Math.max(maxCpuMs * 10, 2000)`):
  - `test/redact.test.js`: `redactText('A'.repeat(256_000))` -> `maxCpuMs: 250`.
  - `test/compress.test.js`: `normalizeWhitespace` (`' '.repeat(256_000) + 'x'`) -> `maxCpuMs: 300`; `stripComments` (`'/**\n'.repeat(64_000)`) -> `maxCpuMs: 400`.
  - `test/detect.test.js`: `isTOON('a'.repeat(256_000))` -> `maxCpuMs: 250`.
  - `test/code-chunks.test.js`: `buildStructure(lines, blocks)` on 8000 nested lines -> `maxCpuMs: 500` (keeping `assert.equal(parent.length, 8000)`).

- **AC6 (`test/proxy-usage.test.js` client disconnect race eliminated):**
  In `test/proxy-usage.test.js` (`stops reading the upstream once the client is gone`):
  - A `clientDestroyed` promise is awaited BEFORE entering the upstream write-settling wait window (`wait(300)` -> snapshot `written` -> `wait(300)` -> `assert.equal(written, settled, ...)`).
  - `clientDestroyed` resolves when `res.once('data', ...)` fires and calls `req.destroy()`, and rejects on a bounded timeout (e.g. 5000ms) with its timer cleared on resolution/cleanup so no hanging promises or open handles remain.

- **AC7 (`test/usage-tap.test.js` encoded-stream timeout hardened without slowing normal runs):**
  In `test/usage-tap.test.js`:
  - `runAsync` default `waitMs` is raised from `300` to `2000` so positive encoded-stream tests tolerate libuv/zlib contention while still resolving immediately (~20ms) as soon as `onUsage` fires.
  - Existing negative tests passing explicit shorter `waitMs` values (`50`, `100`, `200`) keep their explicit `waitMs` arguments untouched.

- **AC8 (Unit tests for `test/helpers/timing.js`):**
  `test/timing-helper.test.js` exists, is picked up by `node --test test/*.test.js`, and verifies:
  - `measureCpuMs` returns `{ result, cpuMs, wallMs }` with expected return value and non-negative numeric timings, and registers measurable `cpuMs` on synchronous CPU work.
  - `measureCpuMsAsync` returns `{ result, cpuMs, wallMs }` for async functions and shows `cpuMs` stays small while `wallMs` tracks async idle delay (e.g. `setTimeout`).
  - `assertCpuBudget` pass path (returns `{ result, cpuMs, wallMs }`), CPU budget breach path (throws `AssertionError` mentioning label, `cpuMs`, and `wallMs`), and wall-clock backstop breach path (throws `AssertionError` mentioning label, `cpuMs`, and `wallMs`).
  - `assertCpuBudgetAsync` pass path (including async sleep where `wallMs > maxCpuMs` yet `cpuMs < maxCpuMs` and `wallMs < maxWallMs`), default `maxWallMs` behavior, CPU budget breach path, and wall-clock backstop breach path.

- **AC9 (Multi-run stability & smoke verification):**
  Default-concurrency `npm test` (which runs `node --test test/*.test.js && node bench/retrieval-eval.js`) passes **3 consecutive times** with 0 failures, and `node smoke.js` exits 0 with 0 failures.

## Constraints
- **Plain Node.js ESM JavaScript only:** No TypeScript, no transpilation, no new dependencies in `package.json`.
- **Zero production changes:** Strictly modify/add files under `test/` (plus required workflow artifacts under `.agent/tasks/test-timing-stability/`).
- **Preserve DoS/ReDoS detection strength:** Do not relax any existing CPU budget thresholds (`25ms`, `250ms`, `300ms`, `400ms`, `500ms`, `1000ms`), and always keep a finite wall-clock backstop so infinite loops, blocking syscalls, or hung async operations still fail fast.
- **Minimal diffs:** Do not reformat unrelated tests or modify unrelated assertions in any touched file.
- **No timer/handle leaks:** Any bounded timeout introduced in `test/proxy-usage.test.js` or `test/timing-helper.test.js` must clear its timer once settled.

## Non-goals
- Changing production tokenizer, regex, proxy streaming, or usage-tap implementations.
- Changing `npm test` concurrency flags or disabling parallel test execution in `package.json`.
- Benchmarking or optimizing compression algorithms.
- Modifying `bench/retrieval-eval.js` or `smoke.js`.

## Narrow ambiguity resolutions
1. **Default `maxWallMs` formula in `test/helpers/timing.js`:**
   Locked to `opts.maxWallMs ?? Math.max(maxCpuMs * 10, 2000)`. That gives `2000ms` for tiny budgets (`<= 200ms`), `2500ms` for `250ms`, `3000ms` for `300ms`, `4000ms` for `400ms`, `5000ms` for `500ms`, and `10000ms` for `1000ms` unless overridden explicitly.
2. **Error format on budget failure:**
   `assertCpuBudget` and `assertCpuBudgetAsync` throw `AssertionError` (via `node:assert/strict`) whose message always includes the `label`, formatted `cpuMs` vs `maxCpuMs`, and formatted `wallMs` vs `maxWallMs` (for example: `${label} exceeded CPU budget: cpu=${cpuMs.toFixed(2)}ms (max ${maxCpuMs}ms), wall=${wallMs.toFixed(2)}ms (max ${maxWallMs}ms)` and the analogous wall-clock backstop message).
3. **`assertFast` GC-jitter handling in `test/quality-gates.test.js`:**
   `assertFast(label, fn)` uses `assertCpuBudget(label, fn, 25, { maxWallMs: 1000 })`; to prevent a single stray V8 major GC pause from flaking a `< 25ms` budget, it may run at most one retry when attempt 1 fails only on CPU budget (still asserting `< 25ms` CPU and `< 1000ms` wall on the retry). A deterministic ReDoS regression fails both attempts immediately; normal runs execute only once.
4. **Explicit `maxWallMs` overrides:**
   - `test/compress-hardening.test.js`: `maxWallMs: 5000` for both `safeCountTokens` (`maxCpuMs: 500`) and `compressRequest` (`maxCpuMs: 1000`).
   - `test/quality-gates.test.js`: `maxWallMs: 1000` for `assertFast` (`maxCpuMs: 25`).
   - `test/redact.test.js`, `test/compress.test.js`, `test/detect.test.js`, `test/code-chunks.test.js`: use the default `Math.max(maxCpuMs * 10, 2000)` backstop.
5. **Bounded timeout in `test/proxy-usage.test.js`:**
   Use a 5000ms bounded timeout on `clientDestroyed`, clearing the timeout when `req.destroy()` runs (and on error/cleanup in `finally`), so a broken proxy fails fast with a clear message instead of hanging until test runner timeout.

## Verification plan
- **Build:** N/A (plain Node.js ESM JavaScript, no build step).
- **Diff scope check:**
  - `git status --short` and `git diff --stat` confirm zero changes outside `test/` and `.agent/tasks/test-timing-stability/`.
- **Unit tests (targeted):**
  - `node --test test/timing-helper.test.js`
  - `node --test test/compress-hardening.test.js test/quality-gates.test.js test/redact.test.js test/compress.test.js test/detect.test.js test/code-chunks.test.js test/proxy-usage.test.js test/usage-tap.test.js`
- **Full suite stability (3 consecutive default-concurrency runs):**
  - Run `npm test` 3 consecutive times (no `--test-concurrency` throttling); all 3 runs must exit 0 with 0 failed tests.
- **Integration / smoke check:**
  - `node smoke.js` exits 0 with 0 failures.
- **Lint:** N/A (no lint script configured in `package.json`).
- **Manual checks:**
  - Inspect `test/helpers/timing.js` and updated tests to verify strict CPU thresholds (`25ms`, `250ms`, `300ms`, `400ms`, `500ms`, `1000ms`) and wall-clock backstops are preserved, `safeCountTokens('warm')` precedes measurement in `test/compress-hardening.test.js`, `clientDestroyed` is awaited before settle waits in `test/proxy-usage.test.js`, and `runAsync` default `waitMs` is `2000` while explicit negative-test timeouts remain unchanged in `test/usage-tap.test.js`.
