# Task Spec: sidecar-platform-health

## Metadata
- Task ID: sidecar-platform-health
- Created: 2026-11-26T16:01:53+00:00
- Frozen: 2026-11-26T16:05:00+00:00
- Repo root: /Users/stas/Playground/tamp
- Working directory at init: /Users/stas/Playground/tamp

## Guidance sources
- `AGENTS.md`
- `CLAUDE.md`
- `LEARNED.md`

## Original task statement
Fix T-01 (RICE #1): Sidecar startup reliability across OSes and live /health status refresh. 1) Only include --with mlx in uv sidecar spawn on macOS Apple Silicon (darwin + arm64), so Linux and Intel Mac users can auto-start the llmlingua sidecar without mlx install failure (and update the manual hint in index.js similarly). 2) In bin/tamp.js startSidecar(), honor an already-configured TAMP_LLMLINGUA_URL (from env or config file) instead of always checking/spawning on hardcoded port 8788. 3) In index.js, make /health and /health?text accurately reflect sidecar readiness when llmlingua is enabled by refreshing sidecarState via probeSidecar when stale (bounded/debounced) and checking model_loaded from the sidecar /health JSON if present, rather than staying permanently stale from a single startup probe.

## Acceptance criteria
- **AC1 (Platform-gated `--with mlx` in `bin/tamp.js` `uv` spawn):**
  - The `uv` argument list used by `bin/tamp.js` to spawn the LLMLingua sidecar includes `'--with', 'mlx'` **only** when `platform === 'darwin' && arch === 'arm64'` (defaulting to `process.platform` and `process.arch`).
  - On all other platform/arch combinations (e.g., `darwin` + `x64`, `linux` + `x64`, `linux` + `arm64`, `win32` + `x64`), `'--with', 'mlx'` is omitted while preserving `'run', '--with', 'fastapi', '--with', 'uvicorn', '--with', 'llmlingua', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', String(port)`.
  - Exposed via a pure exported helper (or injectable `platform`/`arch` parameter) so unit tests verify Apple Silicon vs Intel Mac vs Linux deterministically without spawning `uv`.

- **AC2 (Platform-gated `--with mlx` in `index.js` manual start hint):**
  - The manual sidecar start command logged by `index.js` when the sidecar is not reachable includes `--with mlx` **only** when `platform === 'darwin' && arch === 'arm64'` (defaulting to `process.platform` and `process.arch`).
  - The hint continues to bind `--host 127.0.0.1` (never `--host 0.0.0.0`), remaining compliant with `test/docs.test.js`.

- **AC3 (`startSidecar()` honors configured `TAMP_LLMLINGUA_URL` from env or config file):**
  - When `TAMP_LLMLINGUA_URL` is configured via environment variable or config file (`TAMP_CONFIG` / `~/.config/tamp/config`, resolved with env taking precedence over config file as in `config.js`), `startSidecar()` returns that URL (normalized without trailing slashes) instead of probing or spawning on hardcoded port `8788`.
  - Loopback SSRF enforcement: any configured `TAMP_LLMLINGUA_URL` is validated with `isLoopbackUrl` (from `compress.js`). If malformed or non-loopback, `startSidecar()` returns `null` without contacting the remote host and without falling back to port `8788`.
  - When `TAMP_LLMLINGUA_URL` is unset/empty, `startSidecar()` preserves existing default behavior (check existing sidecar on port `8788`, else spawn `uv` or `.venv` on `127.0.0.1:8788`).
  - Non-interactive mode (`resolveNonInteractiveConfig` and its `onSidecarReady` log output in `bin/tamp.js`) passes through and displays the resolved sidecar URL/port rather than hardcoding `:8788`, and interactive mode (`SidecarLoader` calling `startSidecar()` with no args) also honors configured `TAMP_LLMLINGUA_URL`.

- **AC4 (`probeSidecar` checks `model_loaded` if present, enforces loopback, and is awaitable/bounded):**
  - `probeSidecar` in `index.js` returns a `Promise<boolean>` resolving to the updated `sidecarState.available` and never rejects.
  - Rejects non-loopback target URLs via `isLoopbackUrl`, setting `sidecarState.available = false` without issuing a network request.
  - On HTTP `200`, reads a bounded response body (e.g., max 64 KB) and parses JSON if valid:
    - If parsed JSON is an object with own boolean property `model_loaded`, sets `sidecarState.available = parsed.model_loaded === true` (`{"status":"ok","model_loaded":false}` -> `false`; `{"status":"ok","model_loaded":true}` -> `true`).
    - If HTTP `200` with empty/non-JSON body or JSON without `model_loaded`, sets `sidecarState.available = true` for backwards compatibility.
  - On non-200 status, connection error, or bounded request timeout (default `<= 2000ms`), sets `sidecarState.available = false`.
  - Preserves standalone auto-discovery: if `sidecarState.available` becomes `true` and `!config.llmLinguaUrl`, sets `config.llmLinguaUrl = SIDECAR_URL`.

- **AC5 (Live, bounded/debounced sidecar refresh on `/health` and `/health?text`):**
  - When `llmlingua` is included in `config.stages` and a sidecar target is active (`config.llmLinguaUrl` is configured, or standalone `isMain` auto-probe is enabled), `GET`/`HEAD` requests to `/health` and `/health?text` refresh `sidecarState` via `probeSidecar` if the last check is stale (`Date.now() - checkedAt >= ttlMs`) or a probe is already in flight.
  - Refreshing is debounced and deduplicated per proxy instance:
    - Requests within the freshness TTL (default `5000ms`, overridable via `createProxy` options for deterministic testing) return the cached `sidecarState.available` without issuing another HTTP probe.
    - Concurrent `/health` requests while a probe is already in flight await the single shared in-flight probe promise rather than firing duplicate probes.
    - Probes are timeout-bounded (default `<= 2000ms`, overridable for tests) so `/health` always responds promptly.
  - Live state transitions work in both directions once stale:
    - Unreachable or `model_loaded: false` -> `model_loaded: true` updates `/health` JSON `sidecar` from `false` to `true` and `/health?text` from `sidecar: not running` to `sidecar: ok`.
    - `model_loaded: true` -> `model_loaded: false` or stopped updates `/health` JSON `sidecar` from `true` to `false` and `/health?text` from `sidecar: ok` to `sidecar: not running`.
  - When `llmlingua` is not in `config.stages`, `/health` performs no sidecar probe and `/health?text` reports `sidecar: n/a`.
  - Per-proxy `sidecarState` isolation is preserved, and existing `test/proxy-hardening.test.js` behavior (calling `createProxy({ log: false, stages: ['minify', 'llmlingua'] })` without `llmLinguaUrl` and asserting manually mutated `sidecarState.available`) remains intact.

- **AC6 (Regression-free test coverage):**
  - `npm test` (all `test/*.test.js`, including `test/docs.test.js`, `test/cli-hardening.test.js`, `test/proxy-hardening.test.js`, plus `bench/retrieval-eval.js`) and `node smoke.js` pass.
  - Automated tests specifically cover AC1, AC2, AC3, AC4, and AC5 using local stub HTTP servers and pure helper assertions (no dependency on external network, live `uv`, or live Python ML models).

## Constraints
- **Stack & language (`AGENTS.md`):** Node.js ESM plain JavaScript only — no TypeScript, no new external dependencies.
- **Minimal diffs (`AGENTS.md`):** Keep changes tightly scoped to the affected files (`bin/tamp.js`, `index.js`, and tests) with no unrelated reformatting or comment churn.
- **Branching (`AGENTS.md` / `LEARNED.md`):** Never push directly to `main`.
- **Sidecar binding & security (`test/docs.test.js` & `compress.js`):**
  - Sidecar spawn commands and manual hints must bind to `127.0.0.1` / `localhost` only; never emit `--host 0.0.0.0` or `'0.0.0.0'`.
  - Reuse `isLoopbackUrl` from `compress.js` (SSRF guard) whenever validating or probing `TAMP_LLMLINGUA_URL` / sidecar URLs.
- **CLI env hygiene (`LEARNED.md` / `test/cli-hardening.test.js`):** Do not mutate `process.env.TAMP_STAGES` or `process.env.TAMP_LLMLINGUA_URL` in non-interactive resolution paths (`resolveNonInteractiveConfig`).
- **Stage pipeline (`AGENTS.md`):** Do not alter compression stage ordering or the 1–9 level ladder in `metadata.js`.
- **Health payload compatibility (`bin/tamp.js` `formatStatusLines`):** `/health` JSON must continue returning boolean `sidecar` and `/health?text` must preserve the `sidecar: ok | not running | n/a` format.

## Resolved ambiguities & assumptions
1. **Behavior when `TAMP_LLMLINGUA_URL` is configured but the external sidecar is still booting:**
   - Resolved: When `TAMP_LLMLINGUA_URL` is explicitly configured (via env or config file) and passes `isLoopbackUrl`, `startSidecar()` returns the normalized configured URL directly without spawning a local uvicorn process and without failing startup if the external sidecar is still loading its model.
   - Rationale: Matches `README.md` (`Set to http://localhost:8788 to skip the auto-probe (avoids startup race if sidecar is still loading the model)`), avoids stripping `llmlingua` during startup races, and pairs directly with AC5 where `/health` dynamically reports `false`/`not running` until the sidecar finishes loading and then flips to `true`/`ok`.
2. **Invalid or non-loopback `TAMP_LLMLINGUA_URL`:**
   - Resolved: Fails closed by returning `null` from `startSidecar()` (and `available = false` in `probeSidecar`) rather than contacting a non-loopback host or silently falling back to port `8788`.
3. **Probing when `llmLinguaUrl` is unset in programmatic `createProxy()`:**
   - Resolved: `createProxy({ stages: ['minify', 'llmlingua'] })` with `llmLinguaUrl: null` does not probe `localhost:8788` on `/health` unless standalone `isMain` enabled default-URL auto-probing. This keeps `test/proxy-hardening.test.js` deterministic regardless of whether a sidecar happens to be running on port `8788` on the host machine, and matches existing `index.js:78` (`if (config.stages?.includes('llmlingua') && config.llmLinguaUrl)`).
4. **Sidecar `/health` response without `model_loaded`:**
   - Resolved: If HTTP `200` is returned and the JSON body omits `model_loaded` (or is non-JSON), treat the sidecar as available (`true`) per "checking `model_loaded` from the sidecar `/health` JSON if present". Only when `model_loaded` is present as a boolean is readiness gated on `model_loaded === true`.
5. **Debounce TTL and timeout defaults:**
   - Resolved: Default probe freshness TTL = `5000` ms, default probe HTTP timeout = `2000` ms (matching existing `timeout: 2000`), and default max `/health` response body read = `65536` bytes; TTL and timeout are injectable via `createProxy` options (e.g. `sidecarProbeTtlMs`, `sidecarProbeTimeoutMs`) so tests run fast without long sleeps.

## Non-goals
- Changing `sidecar/server.py` (it already returns `{"status": "ok", "model_loaded": compressor is not None}` and `503` on `/compress` while loading).
- Adding remote (non-loopback) sidecar support or relaxing SSRF protection in `compress.js`.
- Supporting Windows-specific `which`/`.venv/Scripts/python.exe` spawning beyond omitting `--with mlx` from the `uv` args on non-`darwin+arm64` platforms.
- Redesigning `/health` JSON schema, `tamp status` formatting, or interactive TUI screens beyond passing through the resolved sidecar URL.
- Modifying compression stages, levels, presets, or redaction logic.

## Verification plan
- **Build:** Not applicable (plain Node.js ESM, no build step).
- **Unit tests:** `node --test test/cli-hardening.test.js test/proxy-hardening.test.js test/docs.test.js` (plus any new focused test file if added) covering:
  - `uv` sidecar args and manual start hint across `(darwin, arm64)`, `(darwin, x64)`, `(linux, x64)`, `(linux, arm64)`.
  - `startSidecar()` honoring `TAMP_LLMLINGUA_URL` from `env`, from a temporary `TAMP_CONFIG` file, env-over-file precedence, trailing-slash normalization, and rejecting non-loopback URLs without network I/O.
  - `probeSidecar()` against local ephemeral `http.createServer` stubs returning `200 {"status":"ok","model_loaded":false}`, `200 {"status":"ok","model_loaded":true}`, `200 {"status":"ok"}` (no `model_loaded`), `503`, connection refused, and timeout.
  - `/health` and `/health?text` live refresh across state transitions (`false` -> `true` -> `false`), TTL debouncing (counting stub hits), concurrent in-flight probe coalescing, non-`llmlingua` no-probe (`sidecar: n/a`), and per-proxy state isolation.
- **Integration tests:** `npm test` (`node --test test/*.test.js && node bench/retrieval-eval.js`) and `node smoke.js`.
- **Lint:** Not configured in `package.json`; verify syntax/runtime via `node --check bin/tamp.js index.js` and `npm test`.
- **Manual checks:** Confirm `git diff` is minimal and touches only intended files; verify no `--host 0.0.0.0` appears anywhere in touched files.
