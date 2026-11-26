# Evidence Bundle: sidecar-platform-health

- **Task ID:** `sidecar-platform-health`
- **Overall Status:** `PASS`
- **Changed files:**
  - `bin/tamp.js`
  - `index.js`
  - `test/sidecar-platform-health.test.js`

## Acceptance Criteria Evaluation

| AC | Status | Proof |
|---|---|---|
| **AC1** | `PASS` | `bin/tamp.js` exports `buildSidecarUvArgs(port, { platform, arch })` gating `--with mlx` strictly to `darwin` + `arm64` and preserving `--host 127.0.0.1`. Verified by `test/sidecar-platform-health.test.js` (49/49 pass, exit 0) in `.agent/tasks/sidecar-platform-health/raw/test-unit.txt`. |
| **AC2** | `PASS` | `index.js` exports `formatSidecarStartHint({ platform, arch, port })` emitting `--with mlx` only on `darwin` + `arm64` and binding `--host 127.0.0.1`. Verified by `test/sidecar-platform-health.test.js` + `test/docs.test.js` (exit 0) in `.agent/tasks/sidecar-platform-health/raw/test-unit.txt` and `raw/lint.txt` (zero `0.0.0.0` matches). |
| **AC3** | `PASS` | `bin/tamp.js` `startSidecar({ env, configPath })` resolves `TAMP_LLMLINGUA_URL` (env > config file), enforces `isLoopbackUrl` fail-closed (`null`, no network I/O, no fallback to `:8788`), normalizes trailing slashes, and threads the resolved URL through `resolveNonInteractiveConfig` and `onSidecarReady`. Verified by `test/sidecar-platform-health.test.js` + `test/cli-hardening.test.js` (exit 0) in `raw/test-unit.txt`. |
| **AC4** | `PASS` | `index.js` `probeSidecar(config, sidecarState, opts)` returns a non-rejecting `Promise<boolean>`, enforces `isLoopbackUrl`, bounds HTTP timeout (`<= 2000ms`) and body size (`65536` bytes), checks boolean `model_loaded` when present (backwards-compatible when absent), and preserves standalone `config.llmLinguaUrl` auto-discovery. Verified by local stub tests in `test/sidecar-platform-health.test.js` (exit 0, `raw/test-unit.txt`). |
| **AC5** | `PASS` | `index.js` `/health` and `/health?text` invoke `refreshSidecarState` when `llmlingua` is active (`config.llmLinguaUrl` or `autoProbe`), debouncing within TTL (`sidecarProbeTtlMs`, default `5000ms`), coalescing concurrent in-flight probes, transitioning `false -> true -> false`, skipping probes when `llmlingua` is inactive (`sidecar: n/a`), and keeping per-proxy isolation intact (`test/proxy-hardening.test.js` + `test/sidecar-platform-health.test.js`, exit 0, `raw/test-unit.txt`). |
| **AC6** | `PASS` | Full suite `npm test` (908/908 tests pass, 207 suites, 0 failures + `bench/retrieval-eval.js` PASS, NDCG@10 0.931, 100% definition survival) and `node smoke.js` (6/6 checks pass) exited `0` in `.agent/tasks/sidecar-platform-health/raw/test-integration.txt`. Syntax checks exited `0` in `raw/build.txt` and `raw/lint.txt`. |

## Raw Artifacts
- `.agent/tasks/sidecar-platform-health/raw/build.txt` — `node --check bin/tamp.js index.js test/sidecar-platform-health.test.js` (`EXIT_CODE=0`)
- `.agent/tasks/sidecar-platform-health/raw/lint.txt` — syntax check + `grep -n "0\.0\.0\.0" bin/tamp.js index.js` (0 matches) + `git diff --stat`
- `.agent/tasks/sidecar-platform-health/raw/test-unit.txt` — `node --test test/cli-hardening.test.js test/proxy-hardening.test.js test/docs.test.js test/sidecar-platform-health.test.js` (`49/49 pass`, exit `0`)
- `.agent/tasks/sidecar-platform-health/raw/test-integration.txt` — `npm test` (`908/908 pass` + `bench/retrieval-eval.js PASS`) + `node smoke.js` (`All checks passed!`, exit `0`)

## Commands for Fresh Verifier
1. `node --check bin/tamp.js index.js test/sidecar-platform-health.test.js`
2. `node --test test/cli-hardening.test.js test/proxy-hardening.test.js test/docs.test.js test/sidecar-platform-health.test.js`
3. `npm test`
4. `node smoke.js`
