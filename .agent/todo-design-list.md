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
| 1 | `T-03` | `OPEN` | **Interactive TUI State & Telemetry Parity:** `App.js` clobbers `TAMP_LEVEL` by writing `process.env.TAMP_STAGES`, omits `level` prop to `Banner`, leaks `sidecarProc` on server error, keeps unbounded `events[]`, and `Dashboard.js` hides live `usage.cacheHitRate`. | 7 | 2.0 | 0.90 | 1.0 | **12.6** | `bin/ui/App.js`, `bin/ui/Dashboard.js`, `bin/ui/Banner.js`, `index.js`, `test/cli-hardening.test.js` |
| 2 | `T-05` | `OPEN` | **CLI Ergonomics for Autoresearch Winner (`recommended`):** Expose `--preset` flag and/or `recommended` in CLI help & level selection so users can opt into the autoresearch-winning preset without manual env vars. | 6 | 1.5 | 0.90 | 1.0 | **8.1** | `bin/tamp.js`, `config.js`, `test/config.test.js`, `test/cli-hardening.test.js` |
| 3 | `T-07` | `OPEN` | **Repo Root Hygiene:** Remove ~10MB of stray root screenshots (`tamp-*.png`) and `sliday-tamp-0.8.18.tgz` and ensure `.gitignore` covers them. | 4 | 0.5 | 1.00 | 0.25 | **8.0** | `.gitignore`, root artifacts |
| 4 | `T-04` | `OPEN` | **Multi-Provider `stale-inputs` Pruning:** Extend `lib/stale-inputs.js` to prune bulky old tool-call inputs in OpenAI Responses (`function_call` / `custom_tool_call` like Codex `apply_patch`) and OpenAI Chat (`assistant.tool_calls`). | 7 | 2.0 | 0.85 | 1.5 | **7.9** | `lib/stale-inputs.js`, `compress.js`, `test/stale-inputs.test.js` |
| 5 | `T-06` | `OPEN` | **BM25 Hot-Path Hardening Remainder (`docs/designs/bm25-hotpath-hardening.md`):** Thread injectable `tokenizer` through `rerankScores`, add request-scoped `lib/tokens.js` call-count budget test, and fix confounded `bench/retrieval-eval.js` arm + per-query regression floor. | 5 | 2.0 | 0.85 | 1.5 | **5.7** | `lib/bm25.js`, `lib/tokens.js`, `bench/retrieval-eval.js`, `test/bm25-trim.test.js` |

---

## Completed Cycles

- **Cycle 1 (`T-01`, RICE 21.4, `sidecar-platform-health`) — PASS (PR #36):** Platform-gated `--with mlx` (`darwin` + `arm64` only) in `bin/tamp.js` and `index.js`, honored configured `TAMP_LLMLINGUA_URL` (env > config file, loopback-guarded) in `startSidecar()`, and added bounded/debounced live `/health` sidecar refresh checking `model_loaded` with concurrent probe coalescing. Proof: `.agent/tasks/sidecar-platform-health/verdict.json`.
- **Cycle 2 (`T-02`, RICE 19.0, `onboarding-discovery-sync`) — PASS:** Synced `setup.sh` and `site/setup.sh` byte-identically (`OPENAI_API_BASE=.../v1`, `npm install -g @sliday/tamp@latest`, accurate Claude Code plugin routing note), fixed `site/index.md` (`tamp` instead of nonexistent `tamp start` + `/v1` `OPENAI_API_BASE`), added `recommended` preset card and WebMCP enum in `site/index.html`, and added regression tests in `test/docs.test.js`. Proof: `.agent/tasks/onboarding-discovery-sync/verdict.json`.
