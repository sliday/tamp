# Evidence Bundle: plugin-hook-hardening

## Summary
- Overall status: PASS
- Last updated: 2026-11-27T01:13:40Z
- Branch: `fix/plugin-hook-hardening`

## Acceptance criteria evidence

### AC1 (Port resolution & config parity)
- Status: PASS
- Proof:
  - `plugin/hooks/ensure-tamp.sh` implements `read_config_port()`, `validate_port()`, and precedence `TAMP_PORT` env > `$TAMP_CONFIG` (when set and non-empty) else `${HOME}/.config/tamp/config` > `7778`.
  - Mirrors `config.js` `loadConfigFile`: ignores blank/`#` lines, trims key/value whitespace and CRLF, matches exact key `TAMP_PORT`, strips one matching quote pair (`"..."` or `'...'`), uses last-definition-wins, ignores missing/unreadable files, normalizes leading zeros in base-10, and validates `1..65535` with fallback to `7778`.
  - Verified by 5 tests in `test/plugin-hooks.test.js` (`ensure-tamp.sh port resolution & config parity`, all PASS; see `.agent/tasks/plugin-hook-hardening/raw/test-unit.txt`).
- Gaps:
  - None.

### AC2 (Bounded single-fetch health check)
- Status: PASS
- Proof:
  - `plugin/hooks/ensure-tamp.sh` fetches `http://127.0.0.1:${PORT}/health` once via `HEALTH_BODY="$(curl -sf --max-time 2 "$HEALTH_URL" 2>/dev/null)"` and parses `"version"` from `$HEALTH_BODY` via `extract_version()` without issuing a second `curl` request.
  - Formats cleanly both with and without a `"version"` value (`Tamp v${VERSION} running on :${PORT}...` vs `Tamp running on :${PORT}...`).
  - Verified by 3 tests in `test/plugin-hooks.test.js` (`ensure-tamp.sh health check & JSON escaping`, asserting `hits === 1`, `--max-time 2`, valid SessionStart JSON, and missing/empty version handling; see `.agent/tasks/plugin-hook-hardening/raw/test-unit.txt`).
- Gaps:
  - None.

### AC3 (Listening-only port conflict check with `lsof` guard)
- Status: PASS
- Proof:
  - `plugin/hooks/ensure-tamp.sh` guards `lsof` with `command -v lsof >/dev/null 2>&1` and runs `lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1`.
  - Verified by 3 tests in `test/plugin-hooks.test.js` (`ensure-tamp.sh port-conflict & lsof handling`): live listening non-health TCP socket emits port-in-use JSON without spawning `tamp`; stubbed `lsof` verifies exact `-nP -iTCP:<PORT> -sTCP:LISTEN` flags and non-listening exit `1` does not block; missing `lsof` in `PATH` does not block startup (see `.agent/tasks/plugin-hook-hardening/raw/test-unit.txt`).
- Gaps:
  - None.

### AC4 (Always-valid JSON output)
- Status: PASS
- Proof:
  - `msg()` in `plugin/hooks/ensure-tamp.sh` escapes `\`, `"`, `\b`, `\f`, `\n`, `\r`, `\t`, and all ASCII control characters (`0x01..0x1f`) using POSIX `awk` (`ENVIRON["MSG"]`) with zero dependency on `jq`, `python3`, or `node`.
  - Verified by `grep -nE '\b(jq|python3|node)\b' plugin/hooks/ensure-tamp.sh` returning no matches (`.agent/tasks/plugin-hook-hardening/raw/lint.txt`) and `JSON.parse` assertions on every test path including backslashes, double quotes, tabs, and newlines in `/health` version (`.agent/tasks/plugin-hook-hardening/raw/test-unit.txt`).
- Gaps:
  - None.

### AC5 (Missing binary, auto-start & bounded polling)
- Status: PASS
- Proof:
  - Missing `tamp` emits valid SessionStart JSON advising `npm i -g @sliday/tamp@latest` and exits `0`.
  - Auto-start runs `nohup tamp -y </dev/null >/dev/null 2>&1 &` and polls `http://127.0.0.1:${PORT}/health` via `curl -sf --max-time 2` inside a `SECONDS=0; while [ "$SECONDS" -lt 8 ]` wall-clock loop; emits valid SessionStart JSON with `"auto-started"` on readiness or manual `tamp -y` guidance on timeout; all paths exit `0`.
  - Verified by 2 tests in `test/plugin-hooks.test.js` (`ensure-tamp.sh missing binary & auto-start path`: missing binary hint, live fake `tamp` shim auto-start returning promptly without stdio hang and without creating `nohup.out`, clean PID teardown).
- Gaps:
  - Timeout branch (`SECONDS >= 8`) is verified by code inspection rather than an 8-second wall-clock sleep test to keep the test suite fast.

### AC6 (Permissions & cross-platform shell portability)
- Status: PASS
- Proof:
  - `plugin/hooks/ensure-tamp.sh` retains mode `0755`, passes `bash -n` under GNU bash 3.2.57 (macOS BSD default), uses only POSIX/bash 3.2 constructs and standard tools (`bash`, `curl`, `awk`, `sleep`, `nohup`; optional `lsof`), and has zero `jq`/`python3`/`node` calls.
  - Verified in `.agent/tasks/plugin-hook-hardening/raw/build.txt` and `.agent/tasks/plugin-hook-hardening/raw/lint.txt`.
- Gaps:
  - None.

### AC7 (Deterministic subprocess test suite)
- Status: PASS
- Proof:
  - `test/plugin-hooks.test.js` runs under `node:test` using built-in Node.js modules only, with isolated `mkdtempSync` directories, custom `HOME`/`TAMP_CONFIG`/`PATH` shims, ephemeral `127.0.0.1:0` servers, and `afterEach` cleanup of servers, spawned PIDs, and temp dirs.
  - Covers all 6 required areas (config/env port precedence, single-fetch `/health` + JSON escaping + missing version, listening port conflict + `lsof` flags/missing guard, missing `tamp`, auto-start shim, and `ensure-claude-md.sh` create/idempotent/drift/`--uninstall`/`TAMP_RULES=off`).
  - `node --test test/plugin-hooks.test.js` passed `16/16` (`6` suites, `0` fail).
- Gaps:
  - None.

### AC8 (Full suite green & minimal diff)
- Status: PASS
- Proof:
  - `npm test` passed `993/993` tests (`227` suites, `0` fail) plus `bench/retrieval-eval.js` `PASS`.
  - `node smoke.js` passed all 6 proxy smoke checks.
  - `git status --short` confirms edits are strictly scoped to `plugin/hooks/ensure-tamp.sh`, `test/plugin-hooks.test.js`, and `.agent/tasks/plugin-hook-hardening/*`.
- Gaps:
  - None.

## Commands run
- `bash -n plugin/hooks/ensure-tamp.sh` (exit 0)
- `node --check test/plugin-hooks.test.js` (exit 0)
- `stat -f '%Lp %N' plugin/hooks/ensure-tamp.sh` (`755 plugin/hooks/ensure-tamp.sh`)
- `grep -nE '\b(jq|python3|node)\b' plugin/hooks/ensure-tamp.sh` (no matches)
- `node --test test/plugin-hooks.test.js` (exit 0, 16/16 pass)
- `npm test` (exit 0, 993/993 pass + `bench/retrieval-eval.js` PASS)
- `node smoke.js` (exit 0, all 6 checks pass)
- `git status --short` and `git diff --stat`

## Raw artifacts
- `.agent/tasks/plugin-hook-hardening/raw/build.txt`
- `.agent/tasks/plugin-hook-hardening/raw/lint.txt`
- `.agent/tasks/plugin-hook-hardening/raw/test-unit.txt`
- `.agent/tasks/plugin-hook-hardening/raw/test-integration.txt`

## Known gaps
- The 8-second auto-start failure timeout message path in `plugin/hooks/ensure-tamp.sh` is verified by inspection rather than an 8-second real-time wait in unit tests.
