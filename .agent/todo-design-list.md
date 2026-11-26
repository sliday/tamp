# Todo Design List & RICE Backlog

Maintained by the autonomous `/repo-task-proof-loop` 30m cycle.
Scoring formula: `RICE = (Reach × Impact × Confidence) / Effort`
- **Reach:** 1–10 (breadth of users/sessions affected)
- **Impact:** 0.25 (minimal) | 0.5 (low) | 1.0 (medium) | 2.0 (high) | 3.0 (massive)
- **Confidence:** 0.5–1.0
- **Effort:** relative agent-hours (0.25–4.0)

---

## Global Issues Decomposed into Local Problems (RICE-Ranked)

| Rank | ID | Status | Global Issue → Local Problem | Reach | Impact | Conf | Effort | RICE | Target Files |
|---:|---|---|---|---|---:|---:|---:|---:|---:|---|
| 1 | `T-07` | `OPEN` | **Repo Root Hygiene:** Remove ~10MB of stray root screenshots (`tamp-*.png`) and `sliday-tamp-0.8.18.tgz` and ensure `.gitignore` covers them. | 4 | 0.5 | 1.00 | 0.25 | **8.0** | `.gitignore`, root artifacts |
| 2 | `T-04` | `OPEN` | **Multi-Provider `stale-inputs` Pruning:** Extend `lib/stale-inputs.js` to prune bulky old tool-call inputs in OpenAI Responses (`function_call` / `custom_tool_call` like Codex `apply_patch`) and OpenAI Chat (`assistant.tool_calls`). | 7 | 2.0 | 0.85 | 1.5 | **7.9** | `lib/stale-inputs.js`, `compress.js`, `test/stale-inputs.test.js` |
| 3 | `T-06` | `OPEN` | **BM25 Hot-Path Hardening Remainder (`docs/designs/bm25-hotpath-hardening.md`):** Thread injectable `tokenizer` through `rerankScores`, add request-scoped `lib/tokens.js` call-count budget test, and fix confounded `bench/retrieval-eval.js` arm + per-query regression floor. | 5 | 2.0 | 0.85 | 1.5 | **5.7** | `lib/bm25.js`, `lib/tokens.js`, `bench/retrieval-eval.js`, `test/bm25-trim.test.js` |
| 4 | `T-09` | `OPEN` | **Interactive `--level <alias>` Seed Parity:** `tamp --level aggressive` passes `'aggressive'` to `LevelPicker`, where `initialLevel()` rejects strings and resets to 5; resolve alias strings via `LEVEL_ALIASES` before seeding `LevelPicker`. | 3 | 0.5 | 0.95 | 0.25 | **5.7** | `bin/ui/App.js`, `bin/ui/LevelPicker.js`, `test/level-picker.test.js` |
| 5 | `T-08` | `OPEN` | **Parallel-Load Timing Flake in `test/compress-hardening.test.js`:** Stabilize the 512KB space-padded adversarial payload latency assertion (`< 1000ms` occasionally spikes to ~1265ms under 211-suite parallel CPU contention) without weakening DoS regression protection against the 88s raw-tokenizer bug. | 3 | 0.5 | 0.90 | 0.25 | **5.4** | `test/compress-hardening.test.js` |

---

## Completed Cycles

- **Cycle 1 (`T-01`, RICE 21.4, `sidecar-platform-health`) — PASS (PR #36):** Platform-gated `--with mlx` (`darwin` + `arm64` only) in `bin/tamp.js` and `index.js`, honored configured `TAMP_LLMLINGUA_URL` (env > config file, loopback-guarded) in `startSidecar()`, and added bounded/debounced live `/health` sidecar refresh checking `model_loaded` with concurrent probe coalescing. Proof: `.agent/tasks/sidecar-platform-health/verdict.json`.
- **Cycle 2 (`T-02`, RICE 19.0, `onboarding-discovery-sync`) — PASS (PR #37):** Synced `setup.sh` and `site/setup.sh` byte-identically (`OPENAI_API_BASE=.../v1`, `npm install -g @sliday/tamp@latest`, accurate Claude Code plugin routing note), fixed `site/index.md` (`tamp` instead of nonexistent `tamp start` + `/v1` `OPENAI_API_BASE`), added `recommended` preset card and WebMCP enum in `site/index.html`, and added regression tests in `test/docs.test.js`. Proof: `.agent/tasks/onboarding-discovery-sync/verdict.json`.
- **Cycle 3 (`T-03`, RICE 12.6, `tui-state-and-telemetry`) — PASS (PR #38):** Removed `process.env.TAMP_*` mutations in `bin/ui/App.js` (`buildInteractiveProxyArgs` passing explicit `(overrides, loadOpts)`), added safe sidecar cleanup on server bind errors (`handleServerError`), bounded `events` (`MAX_EVENTS = 200`, `appendBoundedEvent`) and replaced Ink 5 `<Static>` in `bin/ui/Dashboard.js` with a bounded `<Box>` tail (`MAX_VISIBLE_EVENTS = 20`), added live non-fatal `config.onUsage(snapshot, u)` hook in `index.js`, wired `level` to `Banner` and live `cache XX.X%` to `StatsBar`, and added 20 deterministic TTY-free tests (`test/tui-state-telemetry.test.js` + `test/proxy-usage.test.js`). Proof: `.agent/tasks/tui-state-and-telemetry/verdict.json`.
- **Cycle 4 (`T-05`, RICE 8.1, `cli-preset-flag`) — PASS:** Added `--preset NAME` / `--preset=NAME` CLI flag (`conservative`, `balanced`, `aggressive`, `recommended`) with pure exported parsers (`parsePresetArgv`, `parseCliFlags`), exit-code-2 validation and `--level`/`--preset` conflict checks, 7-tier `loadConfig` `options.presetOverride` precedence (`levelSource: 'preset-flag'`) with `Object.hasOwn` prototype-chain guards across `config.js`, `metadata.js`, `bin/tamp.js`, and `bin/ui/App.js` (`resolveInteractiveSeed`), updated `tamp help`, and added deterministic unit + subprocess CLI tests (`943/943` pass). Proof: `.agent/tasks/cli-preset-flag/verdict.json`.
