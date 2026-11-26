# Evidence Bundle: tui-state-and-telemetry

## Summary
- Overall status: PASS
- Last updated: 2026-11-26T21:06:00+00:00
- Branch: `fix/tui-state-and-telemetry`
- Changed files:
  - `bin/ui/App.js`
  - `bin/ui/Dashboard.js`
  - `index.js`
  - `test/proxy-usage.test.js`
  - `test/tui-state-telemetry.test.js`

## Acceptance criteria evidence

### AC1 — No `process.env` mutation & accurate proxy config in `bin/ui/App.js`
- Status: PASS
- Proof:
  - `bin/ui/App.js` exports `buildInteractiveProxyArgs(selection, { sidecarUrl, sidecarFailed, onCompress, onUsage })` and removes all `process.env.TAMP_STAGES`, `process.env.TAMP_LEVEL`, and `process.env.TAMP_LLMLINGUA_URL` mutations.
  - Level picks pass `loadOpts = { levelOverride: selection.level }` without `overrides.stages` (unless `sidecarFailed`, which filters out `llmlingua` into `overrides.stages`), keeping `config.level === level` and `config.levelSource === 'level-flag'`.
  - Custom stage picks pass `loadOpts = {}`, `overrides.stages = activeStages`, and `overrides.level = null`.
  - Sidecar URL sets `overrides.llmLinguaUrl` directly; `overrides` includes `log: false`, `onCompress`, and `onUsage`.
  - Verified by 6 tests in `test/tui-state-telemetry.test.js` (`AC1: App.js proxy arg building and zero process.env mutation`, 6/6 pass) and static check in `raw/lint.txt` (`process.env.TAMP_* assignments in bin/ui/App.js: 0`).
- Gaps:
  - None.

### AC2 — Sidecar cleanup on server bind error in `bin/ui/App.js`
- Status: PASS
- Proof:
  - `bin/ui/App.js` exports `handleServerError` and wires it into `server.on('error', ...)`, calling `try { getSidecarProc?.()?.kill() } catch {}` before `exit()` and `exitProcess(1)` for both `EADDRINUSE` and generic errors, with try/catch guards around `diagnose`, `kill`, and `exit`.
  - Preserves `server.listen(proxyConfig.port, proxyConfig.host, ...)`.
  - Verified by 3 tests in `test/tui-state-telemetry.test.js` (`AC2: Sidecar cleanup on server bind error`, 3/3 pass) and `test/cli-hardening.test.js` (`App.js host binding hardening`, 1/1 pass).
- Gaps:
  - None.

### AC3 — Bounded `events` state in `bin/ui/App.js` & Ink rendering compatibility in `bin/ui/Dashboard.js`
- Status: PASS
- Proof:
  - `bin/ui/App.js` exports `MAX_EVENTS = 200` and `appendBoundedEvent(events, event, max = MAX_EVENTS)`, used inside `onCompress` to cap `events` and drop oldest entries while preserving order.
  - `bin/ui/Dashboard.js` removes Ink 5 `<Static>` and renders `visibleEvents` (`events.slice(-MAX_VISIBLE_EVENTS)`, `MAX_VISIBLE_EVENTS = 20`) inside a regular `<Box flexDirection="column">`, eliminating the Ink 5 `<Static>` stall past `MAX_EVENTS` while preserving `redactUrl(meta.url)` in `LogEntry`.
  - Verified by 2 tests in `test/tui-state-telemetry.test.js` (`AC3: Bounded events array and Dashboard rendering past MAX_EVENTS`, 2/2 pass) and `test/cli-hardening.test.js` (`Dashboard.js URL redaction`, 2/2 pass).
- Gaps:
  - None.

### AC4 — Live usage telemetry callback in `index.js`
- Status: PASS
- Proof:
  - `index.js` invokes `try { config.onUsage?.(usageTotals.snapshot(), u) } catch {}` immediately after `usageTotals.record(u)` inside `createUsageTap`'s `onUsage` callback.
  - Verified end-to-end over live HTTP streaming in `test/proxy-usage.test.js` (`invokes config.onUsage with (snapshot, usage) on streamed responses` and `isolates throwing config.onUsage without disrupting response streaming or usage totals`, 5/5 pass).
- Gaps:
  - None.

### AC5 — `Banner` level propagation and live cache-hit display in `bin/ui/Dashboard.js` & `bin/ui/App.js`
- Status: PASS
- Proof:
  - `bin/ui/App.js` tracks `[usage, setUsage] = useState(null)`, updates it via `onUsage`, and passes `usage` to `Dashboard`.
  - `bin/ui/Dashboard.js` forwards `level: config.level` to `Banner` and exports `StatsBar`, rendering `cache ${(usage.cacheHitRate * 100).toFixed(1)}%` whenever `typeof usage?.cacheHitRate === 'number' && Number.isFinite(usage.cacheHitRate)` — both when `compressionCount > 0` and alongside `'Waiting for requests...'` when `compressionCount === 0`, and omitting it when `usage` or `cacheHitRate` is absent/non-finite.
  - Verified by 7 tests in `test/tui-state-telemetry.test.js` (`AC5: Dashboard Banner level propagation and StatsBar live cache hit rate`, 7/7 pass) and `test/banner.test.js` (13/13 pass).
- Gaps:
  - None.

### AC6 — Deterministic unit tests without a live TTY
- Status: PASS
- Proof:
  - Added deterministic, TTY-free unit tests in `test/tui-state-telemetry.test.js` (18 tests covering AC1, AC2, AC3, AC5) and 2 new integration tests in `test/proxy-usage.test.js` (covering AC4), with zero new external dependencies.
  - Full test suite `npm test` passes 931/931 tests across 211 suites + `bench/retrieval-eval.js` PASS; `node smoke.js` passes 6/6 checks.
- Gaps:
  - None.

## Commands run
- `node --check bin/ui/App.js bin/ui/Dashboard.js index.js test/tui-state-telemetry.test.js test/proxy-usage.test.js` → exit 0
- `node --test test/tui-state-telemetry.test.js test/cli-hardening.test.js test/banner.test.js` → 43/43 pass (exit 0)
- `node --test test/proxy-usage.test.js` → 5/5 pass (exit 0)
- `npm test` → 931/931 pass (211 suites, 0 fail) + `bench/retrieval-eval.js` PASS (exit 0)
- `node smoke.js` → 6/6 checks passed (exit 0)

## Raw artifacts
- `.agent/tasks/tui-state-and-telemetry/raw/build.txt`
- `.agent/tasks/tui-state-and-telemetry/raw/test-unit.txt`
- `.agent/tasks/tui-state-and-telemetry/raw/test-integration.txt`
- `.agent/tasks/tui-state-and-telemetry/raw/lint.txt`

## Known gaps
- None. Interactive TTY rendering is verified deterministically via React element-tree assertions (per AC6 and Non-goals: no `ink-testing-library` or `node-pty`).
