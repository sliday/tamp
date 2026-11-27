# Task Spec: plugin-hook-hardening

## Metadata
- Task ID: plugin-hook-hardening
- Created: 2026-11-27T01:03:59+00:00
- Repo root: /Users/stas/Playground/tamp
- Working directory at init: /Users/stas/Playground/tamp
- Status: Frozen

## Guidance sources
- `AGENTS.md`
- `CLAUDE.md`
- `LEARNED.md`
- `plugin/hooks/ensure-tamp.sh`
- `plugin/hooks/ensure-claude-md.sh`
- `plugin/hooks/hooks.json`
- `config.js` (lines 78–105, 244–251)

## Original task statement
Fix T-11 (RICE #1, score 10.8): Harden Claude Code SessionStart hook plugin/hooks/ensure-tamp.sh and add deterministic tests. 1) Resolve PORT with proper precedence: TAMP_PORT env > TAMP_PORT= in config file (TAMP_CONFIG or ~/.config/tamp/config, handling comments/quotes/whitespace) > 7778, validating integer 1..65535 with fallback to 7778. 2) Use bounded single-fetch curl (--max-time 2) against http://127.0.0.1:${PORT}/health (parsing version from the captured response without double-fetching). 3) Fix false port-conflict detection by checking only listening TCP sockets (lsof -nP -iTCP:${PORT} -sTCP:LISTEN, guarded with command -v lsof) so TIME_WAIT/client sockets and missing lsof never break startup. 4) Escape any special characters or ensure valid JSON output in msg() so SessionStart hookSpecificOutput is always valid JSON. 5) Add deterministic subprocess tests in test/plugin-hooks.test.js covering config-file TAMP_PORT precedence, env > config precedence, already-running health detection with valid JSON output, port-in-use listening check, missing tamp binary fallback, and ensure-claude-md.sh idempotency + --uninstall.

## Acceptance criteria
- **AC1 (Port resolution & config parity)**: `plugin/hooks/ensure-tamp.sh` resolves `PORT` with precedence `TAMP_PORT` env > `TAMP_PORT=` in config file (`$TAMP_CONFIG` if set and non-empty, else `${HOME}/.config/tamp/config`) > `7778`. Config parsing mirrors `config.js` (`loadConfigFile`): skips blank lines and `#` comment lines, trims whitespace around key and value, matches exact key `TAMP_PORT`, strips one matching pair of enclosing single or double quotes, uses last-definition-wins when `TAMP_PORT` appears multiple times, and silently ignores missing/unreadable config files. Resolved port is validated as a base-10 integer in `1..65535`; empty or invalid values fall back to `7778`.
- **AC2 (Bounded single-fetch health check)**: `plugin/hooks/ensure-tamp.sh` queries `http://127.0.0.1:${PORT}/health` using `curl -sf --max-time 2` and captures the response body in a variable once (never issuing a second `curl` request to parse `version`). It parses `"version"` from the captured body; if `"version"` is missing or empty on a successful `/health` response, it still reports Tamp as running without broken formatting or invalid JSON. On an already-running proxy, exactly 1 HTTP request is made to `/health`, valid SessionStart JSON is printed, and the hook exits `0`.
- **AC3 (Listening-only port conflict check with `lsof` guard)**: Before attempting auto-start, `plugin/hooks/ensure-tamp.sh` checks `command -v lsof >/dev/null 2>&1` and only when `lsof` is present runs `lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1`. If a listening socket occupies `${PORT}`, the hook prints a valid SessionStart JSON port-in-use message, does not spawn `tamp`, and exits `0`. Missing `lsof` or non-listening sockets (`TIME_WAIT`, client connections) never falsely block startup.
- **AC4 (Always-valid JSON output)**: `msg()` in `plugin/hooks/ensure-tamp.sh` escapes JSON special characters (`\`, `"`, newline, carriage return, tab) using only standard POSIX/bash utilities (no `jq`, `python3`, or `node` required at runtime) so every exit path outputs a single `JSON.parse`-valid object with `hookSpecificOutput.hookEventName === "SessionStart"` and string `hookSpecificOutput.additionalContext`—even if parsed health fields contain backslashes, quotes, or control characters.
- **AC5 (Missing binary, auto-start & bounded polling)**: When `tamp` is absent from `PATH`, `plugin/hooks/ensure-tamp.sh` emits valid SessionStart JSON recommending `npm i -g @sliday/tamp@latest` and exits `0`. When `tamp` is present, it starts `nohup tamp -y </dev/null >/dev/null 2>&1 &` (closing inherited stdio so subprocess callers do not hang) and polls `http://127.0.0.1:${PORT}/health` with the single-fetch `--max-time 2` check within a bounded ~8s wall-clock window (fitting cleanly inside `hooks.json`'s 12s timeout). On readiness it emits valid SessionStart JSON containing `"auto-started"` and exits `0`; on timeout it emits valid SessionStart JSON advising manual `tamp -y` and exits `0`. Every exit path of the script exits `0`.
- **AC6 (Permissions & cross-platform shell portability)**: `plugin/hooks/ensure-tamp.sh` retains executable mode `0755`, passes `bash -n`, works under macOS BSD bash 3.2+ and Linux GNU bash, and requires only standard shell tools (`bash`, `curl`, `awk`/`sed`/`grep`, `sleep`, `nohup`; optional `lsof`). No `jq`, `python3`, `node`, or bash 4+-only syntax is required at runtime.
- **AC7 (Deterministic subprocess test suite)**: `test/plugin-hooks.test.js` runs under `node:test` with full isolation (temp dirs via `mkdtempSync`, isolated `HOME`/`TAMP_CONFIG`/`PATH` shims, ephemeral `127.0.0.1:0` servers, no dependency on the host's real `~/.config/tamp/config` or real port `7778`, and deterministic teardown leaving zero orphan processes) and verifies:
  1. Config-file `TAMP_PORT` resolution (both `TAMP_CONFIG` and `${HOME}/.config/tamp/config`, `#` comments, blank lines, whitespace, single/double quotes, last-value-wins, invalid-port fallback to `7778` verified via stubbed `curl` so host port `7778` state never causes flakiness) and `TAMP_PORT` env overriding config file.
  2. Already-running `/health` on a custom config port: verifies exactly 1 HTTP request hit, valid `JSON.parse` output, `SessionStart` event name, version & port in `additionalContext`, exit `0`, plus JSON-escaping safety when version contains special characters (e.g. `\`) and graceful handling when `version` is absent.
  3. Listening port conflict: bound non-health listener on the resolved port (and/or `-sTCP:LISTEN` `lsof` check) emits port-in-use JSON, exits `0`, and does not invoke `tamp`; missing `lsof` in `PATH` and non-listening `lsof` exit-1 do not falsely block startup.
  4. Missing `tamp` binary in `PATH` emits valid JSON with `@sliday/tamp` install hint and exits `0`.
  5. Auto-start path with a fake `tamp` shim bringing up a temporary `/health` server emits valid JSON containing `"auto-started"`, version, and port, exits `0`, and cleans up the spawned shim server without orphan processes.
  6. `plugin/hooks/ensure-claude-md.sh` create, idempotent re-run, drift refresh (preserving user content outside markers), `--uninstall`, and `TAMP_RULES=off` removal (including deleting `CLAUDE.local.md` when empty after removal), asserting valid SessionStart JSON and exit `0` on every path.
- **AC8 (Full suite green & minimal diff)**: `npm test` passes completely with zero regressions, and code changes are strictly scoped to `plugin/hooks/ensure-tamp.sh` and `test/plugin-hooks.test.js`.

## Constraints
- Follow `AGENTS.md`: never push to `main` (work on a `feat/` or `fix/` branch if committing), keep diffs minimal, no unrelated reformatting or comment churn.
- Restrict code edits strictly to `plugin/hooks/ensure-tamp.sh` and `test/plugin-hooks.test.js`.
- Plain Node.js ESM JavaScript in `test/plugin-hooks.test.js` using built-in modules (`node:test`, `node:assert/strict`, `node:child_process`, `node:fs`, `node:http`, `node:net`, `node:os`, `node:path`) — no new npm dependencies.
- Keep `plugin/hooks/ensure-tamp.sh` POSIX/macOS BSD bash 3.2+ and Linux GNU bash compatible (`0755` executable mode, no `jq`/`python3`/`node` runtime dependency).
- Tests must never read or mutate the user's real `~/.config/tamp/config`, never assume port `7778` is free or running on the host, and must terminate all spawned test servers/processes in cleanup hooks.

## Non-goals
- Do NOT edit `plugin/commands/status.md`, `plugin/hooks/ensure-claude-md.sh`, `plugin/hooks/hooks.json`, `config.js`, `index.js`, or `bin/tamp.js`.
- Do NOT change compression stages, proxy endpoints, CLI flags, or `package.json` scripts/dependencies.
- Do NOT add external linting/shellcheck dependencies to the repo.

## Assumptions & narrow ambiguity resolutions
- **Empty vs invalid `TAMP_PORT` env**: If `TAMP_PORT` env is unset or empty (`""`), read from config file; if `TAMP_PORT` env is non-empty, it takes precedence over the config file (and if invalid, falls back directly to `7778` rather than reading the config file, matching `config.js` precedence).
- **Duplicate keys in config file**: Last active `TAMP_PORT=` line wins, matching `config.js` `loadConfigFile()` which iterates lines top-to-bottom and assigns `vars[key] = val`.
- **Leading zeros / numeric parsing**: Accept base-10 integer strings matching `^[0-9]+$` whose base-10 value is between `1` and `65535` inclusive (normalizing via base-10 arithmetic, avoiding bash octal interpretation errors on values like `08000`); reject `0`, negative numbers, non-digits, and values `> 65535` by falling back to `7778`.
- **Missing `"version"` in `/health` body**: If `/health` succeeds (HTTP 200) without a `"version"` field (or with an empty version), still report Tamp as running / auto-started cleanly (e.g. `Tamp running on :${PORT}. Token compression active.` instead of `Tamp v running on :${PORT}...`).
- **Auto-start polling bound**: Use bash's built-in `SECONDS` (or equivalent bounded wall-clock loop) capped at 8 seconds so slow `curl --max-time 2` calls cannot stretch polling past `hooks.json`'s 12s timeout.
- **No-hang background spawn**: Redirect stdin as well as stdout/stderr (`nohup tamp -y </dev/null >/dev/null 2>&1 &`) so the backgrounded `tamp` process does not inherit open pipes from callers like Claude Code or Node's `spawnSync`/`execFile`.
- **Test portability for `PATH` shims**: Tests that construct a restricted `PATH` without `tamp` or `lsof` must still expose standard utilities needed by the script (`bash`, `curl`, `awk`, `sed`, `grep`, `sleep`, `nohup`, etc., e.g. by symlinking required system tools into a temp `bin` dir or shadowing specific commands) so tests work identically on macOS and Linux.

## Verification plan
- **Syntax & permissions**:
  - `bash -n plugin/hooks/ensure-tamp.sh`
  - `test -x plugin/hooks/ensure-tamp.sh` (verify mode `0755`)
- **Targeted unit/subprocess tests**:
  - `node --test test/plugin-hooks.test.js`
- **Full test & quality gate**:
  - `npm test` (`node --test test/*.test.js && node bench/retrieval-eval.js`)
- **Scope & diff check**:
  - `git status --short` and `git diff --stat` confirming only `plugin/hooks/ensure-tamp.sh`, `test/plugin-hooks.test.js`, and `.agent/tasks/plugin-hook-hardening/*` artifacts are modified/added.
