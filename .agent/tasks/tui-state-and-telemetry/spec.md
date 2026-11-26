# Task Spec: tui-state-and-telemetry

## Metadata
- Task ID: tui-state-and-telemetry
- Created: 2026-11-26T20:33:31+00:00
- Frozen: 2026-11-26T20:35:00+00:00
- Repo root: /Users/stas/Playground/tamp
- Working directory at init: /Users/stas/Playground/tamp

## Guidance sources
- AGENTS.md
- CLAUDE.md

## Original task statement
Fix T-03 (RICE #1, score 12.6): Interactive TUI state hygiene, sidecar cleanup, and live cache-hit telemetry. 1) In bin/ui/App.js, stop mutating process.env.TAMP_STAGES and process.env.TAMP_LEVEL; instead pass explicit overrides and loadOpts (levelOverride when user picked a level, stages override when user picked custom stages or llmlingua fell back, and llmLinguaUrl when sidecar started) directly to createProxy(overrides, loadOpts) so config.level and config.levelSource stay accurate. 2) In bin/ui/App.js server.on('error'), kill getSidecarProc()?.kill() before exiting so bind failures never leak an orphan sidecar process. 3) Bound the events state array in bin/ui/App.js (e.g. MAX_EVENTS = 200) so long interactive sessions cannot leak unbounded memory. 4) In index.js, invoke optional config.onUsage?.(usageTotals.snapshot(), u) inside the usageTap onUsage handler so interactive callers receive live prompt-cache stats. 5) In bin/ui/Dashboard.js, pass level: config.level to Banner and render live cache hit rate in StatsBar when usage?.cacheHitRate != null (e.g., cache 91.4%), plus wire usage state from App.js. 6) Add deterministic unit tests covering all new behaviors without requiring a live TTY.

## Acceptance criteria

- **AC1 (No `process.env` mutation & accurate proxy config in `bin/ui/App.js`)**:
  - `bin/ui/App.js` does not write to `process.env.TAMP_STAGES`, `process.env.TAMP_LEVEL`, or `process.env.TAMP_LLMLINGUA_URL`.
  - When the user picks a level (`{ kind: 'level', level, stages }`), `App.js` calls `createProxy(overrides, loadOpts)` with `loadOpts = { levelOverride: level }`, omitting `overrides.stages` unless `llmlingua` fell back (in which case `overrides.stages` contains the filtered stage list without `llmlingua`), so `config.level === level` and `config.levelSource === 'level-flag'`.
  - When the user picks custom stages (`{ kind: 'stages', stages }`), `App.js` calls `createProxy(overrides, loadOpts)` with `loadOpts = {}`, `overrides.stages` set to the active stage list (filtered if `llmlingua` fell back), and `overrides.level = null` so `config.level` is `null` rather than inheriting a default or config-file level.
  - When the sidecar starts and returns a URL, `overrides.llmLinguaUrl` is set to that URL without mutating `process.env.TAMP_LLMLINGUA_URL`.
  - `overrides` continues to pass `onCompress`, `log: false`, and now also passes `onUsage`.

- **AC2 (Sidecar cleanup on server bind error in `bin/ui/App.js`)**:
  - In `bin/ui/App.js`, the `server.on('error', ...)` handler invokes `getSidecarProc?.()?.kill()` inside a `try { ... } catch {}` guard before calling `process.exit(1)` for both `EADDRINUSE` and non-`EADDRINUSE` errors.
  - Cleanup runs safely even when `getSidecarProc` is undefined, returns `null`/`undefined`, `.kill()` throws, or `diagnoseBindConflict` fails.

- **AC3 (Bounded `events` state in `bin/ui/App.js` & Ink rendering compatibility in `bin/ui/Dashboard.js`)**:
  - `bin/ui/App.js` bounds the `events` array to `MAX_EVENTS` (default `200`, exported constant) using a pure helper so appending past `MAX_EVENTS` drops the oldest entries and preserves order.
  - `bin/ui/Dashboard.js` renders bounded `events` cleanly without hitting the Ink 5 `<Static>` stall bug (see Constraints below): events appended after `events` reaches `MAX_EVENTS` still render in `Dashboard` without silently dropping new items or duplicating previously rendered items.

- **AC4 (Live usage telemetry callback in `index.js`)**:
  - Inside the `createUsageTap({ ..., onUsage })` callback in `index.js`, after `usageTotals.record(u)`, invoke optional `config.onUsage?.(usageTotals.snapshot(), u)` inside a non-fatal guard (`try { ... } catch {}`) so a throwing callback cannot disrupt logging or response streaming.
  - Both arguments match existing contracts: first argument is `usageTotals.snapshot()` (`{ requests, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, cacheHitRate }`), second argument is normalized per-request usage `u`.
  - Existing behavior when `config.onUsage` is omitted remains unchanged.

- **AC5 (`Banner` level propagation and live cache-hit display in `bin/ui/Dashboard.js` & `bin/ui/App.js`)**:
  - `bin/ui/App.js` stores live usage snapshot state (`usage`, initialized to `null`), updates it from `onUsage`, and passes `usage` to `Dashboard`.
  - `bin/ui/Dashboard.js` passes `level: config.level` to `Banner`.
  - `StatsBar` in `bin/ui/Dashboard.js` accepts `usage` and renders the formatted cache hit rate (e.g., `cache 91.4%`, computed as `(usage.cacheHitRate * 100).toFixed(1) + '%'`) whenever `typeof usage?.cacheHitRate === 'number' && Number.isFinite(usage.cacheHitRate)`.
  - When `usage` is missing or `usage.cacheHitRate == null`, no cache-hit segment is rendered.
  - When `compressionCount === 0` and `usage?.cacheHitRate == null`, `StatsBar` preserves `'Waiting for requests...'`; when `compressionCount === 0` and `usage?.cacheHitRate != null`, `StatsBar` still surfaces the live cache hit rate alongside the waiting/session indicator.

- **AC6 (Deterministic unit tests without a live TTY)**:
  - Automated unit/integration tests under `test/` cover AC1–AC5 deterministically without requiring a TTY or adding new npm dependencies:
    1. Pure proxy-arg builder / selection resolution for level pick, level pick with `llmlingua` fallback, custom stage pick, sidecar URL propagation, and verification via `createProxy` that `config.level`, `config.levelSource`, `config.stages`, and `config.llmLinguaUrl` are accurate with zero `process.env` mutation (plus source check on `bin/ui/App.js`).
    2. Bind error handler cleanup calling `getSidecarProc()?.kill()` on `EADDRINUSE` and generic errors, plus null/throwing safety.
    3. Bounded event appender capping at `MAX_EVENTS` (200) and `Dashboard` rendering events beyond `MAX_EVENTS`.
    4. `index.js` `config.onUsage` invocation with `(snapshot, u)` on streamed usage responses, plus non-fatal error isolation when `onUsage` throws.
    5. `Dashboard` forwarding `config.level` to `Banner` (both integer level and `null`) and `StatsBar` rendering/omitting `cache XX.X%` across `cacheHitRate` values and `compressionCount === 0` vs `> 0`.
  - Existing tests (`npm test`, `node smoke.js`) remain green.

## Constraints
- **Runtime & language**: Plain Node.js ESM JavaScript (no TypeScript, no new external npm dependencies).
- **Loopback host binding**: Preserve `server.listen(proxyConfig.port, proxyConfig.host, ...)` in `bin/ui/App.js` (verified by `test/cli-hardening.test.js`).
- **URL redaction**: Preserve `redactUrl(meta.url)` in `LogEntry` in `bin/ui/Dashboard.js` (verified by `test/cli-hardening.test.js`).
- **No `process.env` mutation**: `bin/ui/App.js` must not mutate `process.env.TAMP_STAGES`, `process.env.TAMP_LEVEL`, or `process.env.TAMP_LLMLINGUA_URL`.
- **Ink 5 `<Static>` behavior with bounded `events`**: In `ink@5.2.0` (`node_modules/ink/build/components/Static.js`), `<Static items={items}>` stores an internal `index` state updated via `useLayoutEffect(() => setIndex(items.length), [items.length])` and renders only `items.slice(index)`. Passing a sliding-window array capped at `MAX_EVENTS` directly to `<Static items={events}>` causes `items.length` to stay equal to `MAX_EVENTS` once full, making `items.slice(MAX_EVENTS)` permanently empty so every event after #200 is silently dropped. `Dashboard.js` must avoid this trap (e.g., render the bounded recent log entries inside a regular `<Box flexDirection="column">` rather than `<Static>`, keeping `Dashboard` a pure hook-free function component that can be tested directly like `Banner` and `LogEntry`).
- **Minimal diff**: Restrict edits to `bin/ui/App.js`, `bin/ui/Dashboard.js`, `index.js`, and test files under `test/`; avoid unrelated formatting or comment churn.
- **No secret leakage**: Preserve all redaction ordering and existing privacy guarantees.

## Non-goals
- Changing non-interactive CLI startup (`bin/tamp.js` already uses `resolveNonInteractiveConfig` without `process.env` mutation).
- Changing `config.js` precedence rules, `metadata.js` level ladder, or `lib/usage-tap.js` parsing logic.
- Adding new npm packages (e.g. `ink-testing-library`, `node-pty`) or requiring PTY-based interactive tests.
- Redesigning `Banner.js`, `LevelPicker.js`, `StagePicker.js`, or `SidecarLoader.js` layouts or keybindings.
- Persisting session event logs or usage metrics to disk.

## Assumptions & narrow ambiguity resolutions
1. **Exporting pure helpers for testability**: To satisfy AC6 without a TTY or React hook harness, `bin/ui/App.js` may export small pure helpers (e.g. `MAX_EVENTS`, `appendBoundedEvent`, `buildInteractiveProxyArgs`, `handleServerError`) and `bin/ui/Dashboard.js` may export `StatsBar`, following the existing pattern in `bin/ui/LevelPicker.js`, `bin/ui/Dashboard.js` (`LogEntry`), and `bin/tamp.js`.
2. **Custom stages and `config.level`**: When the user picks custom stages via the advanced picker (`payload.kind === 'stages'`), setting `overrides.level = null` is required so `createProxy` does not inherit `DEFAULT_LEVEL` (5) or a config-file `level` and cause `Banner` to hide the active stage list.
3. **Host-env `TAMP_STAGES` when picking a level interactively**: If `TAMP_STAGES` is unset (the standard interactive case), passing `loadOpts = { levelOverride: level }` lets `loadConfig` resolve `level`, `levelSource = 'level-flag'`, and `stages`. If `TAMP_STAGES` was pre-set in the host environment before launching interactive mode, `loadConfig` precedence intentionally keeps `TAMP_STAGES` authoritative unless explicitly overridden; we match `resolveNonInteractiveConfig` rather than mutating `process.env`.
4. **Visible log rows in `Dashboard.js`**: `App.js` bounds `events` state to `MAX_EVENTS = 200`. In `Dashboard.js`, rendering a bounded tail (e.g. `events.slice(-MAX_VISIBLE_EVENTS)` with a sensible constant such as `20` or rendering the bounded list directly in `<Box flexDirection="column">` without `<Static>`) avoids Ink's `<Static>` stall while keeping terminal repaint height bounded and `Dashboard` pure.
5. **Cache-hit formatting**: Format `usage.cacheHitRate` as `(usage.cacheHitRate * 100).toFixed(1) + '%'` (e.g. `cache 91.4%`), consistent with `formatStatusLines` in `bin/tamp.js`.

## Verification plan
- **Build**: N/A (plain Node.js ESM, no build step).
- **Unit tests**: Run `npm test` (`node --test test/*.test.js && node bench/retrieval-eval.js`), verifying all new and existing tests pass, including targeted runs of `node --test test/cli-hardening.test.js test/banner.test.js test/proxy-usage.test.js` and any new TUI telemetry/state test file.
- **Integration tests**: Run `node smoke.js` (and end-to-end proxy usage test in `test/proxy-usage.test.js` verifying `config.onUsage`).
- **Lint**: Syntax check modified JS files with `node --check bin/ui/App.js bin/ui/Dashboard.js index.js` and verify `git diff` stays minimal and strictly within scope.
- **Manual checks**: Confirm `bin/ui/App.js` has no `process.env.TAMP_*` assignments, retains `server.listen(proxyConfig.port, proxyConfig.host, ...)`, calls `getSidecarProc?.()?.kill()` in `server.on('error')`, and `bin/ui/Dashboard.js` retains `redactUrl` and does not pass a capped sliding-window array directly to Ink `<Static>`.
