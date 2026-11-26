# Tamp Feature Atlas

Comprehensive map of all states, modes, entrypoints, stages, and surfaces in `@sliday/tamp` (`v0.9.1`).
Last updated: 2026-11-26 (Cycle 3).

---

## 1. CLI Entrypoint (`bin/tamp.js`)

| Subcommand / Mode | Flags & Inputs | States / Transitions |
|---|---|---|
| Default (`tamp`) | TTY vs non-TTY, `-y`, `--no-interactive`, `--force`, `--level N\|alias` | Non-TTY / `-y` → headless proxy; TTY → Ink TUI (`App.js`) |
| `init` | `CONFIG_PATH` (`~/.config/tamp/config`) | Creates template if missing; prints existing config if present |
| `settings` / `config` | `--help`, TTY required | Interactive Ink `LevelPicker` → writes `level=` or `TAMP_STAGES=` via `writeConfigField` |
| `status` | `loadConfig().port` | Queries `/health` via `fetchHealth`; prints version, active stages, requests, tokens saved, sidecar, `cacheHitRate`; exits `0` (running) / `1` (stopped) |
| `stop` | `loadConfig().port` | `reconcileStalePidFile` (with PID-reuse `isTampProcess` check) → `SIGTERM` → poll 2s → `SIGKILL` (guarded) → `clearPidFile` |
| `compress-config` | `--dry-run`, `--no-backup`, `<file...>` | Auto-detects strategy (`claude-rules`, `markdown`, `json`, `text`) → async `compressBlock` → `.bak` backup + overwrite |
| `install-service` / `uninstall-service` | macOS (`launchd`) / Linux (`systemd --user`) | Writes LaunchAgent plist or systemd user unit; fails cleanly on unsupported OS |
| `version` / `-v` / `--version` | — | Prints `Tamp v<VERSION>` |
| `help` / `-h` / `--help` | — | Prints CLI usage and config path |

### Config Precedence (`config.js`)
1. `TAMP_STAGES` (env or config file) — power-user explicit stage list
2. `--level` CLI flag (`1..9` or `conservative`, `balanced`, `aggressive`, `max`)
3. `TAMP_LEVEL` env
4. `TAMP_COMPRESSION_PRESET` (`conservative`, `balanced`, `aggressive`, `recommended`)
5. Config-file `level=`
6. `DEFAULT_LEVEL` (`5` / `balanced`)

---

## 2. Interactive TUI (`bin/ui/`)

| Component | States / Modes | Notes |
|---|---|---|
| `App.js` | Phases: `pick` → (`loading` if `llmlingua`) → `running` | Passes explicit `(overrides, loadOpts)` to `createProxy` (zero `process.env.TAMP_*` mutation); binds `proxyConfig.host` (`127.0.0.1` default); kills sidecar on bind errors; bounds `events` to `MAX_EVENTS = 200`; wires live `usage` via `onUsage`; installs shutdown hooks |
| `LevelPicker.js` | 1–9 slider (`←`/`→`/`h`/`l`/`1-9`), `A` → advanced `StagePicker`, `Enter` confirm, `Esc` cancel | Shows `LOSSLESS` (L1–L4) vs `LOSSY` (L5–L9) badge and cumulative stage chips |
| `StagePicker.js` | MultiSelect over all 20 stages (`DEFAULT_STAGES` + `EXTRA_STAGES`) | Enforces `>= 1` stage selected |
| `SidecarLoader.js` | `loading` → `success` (600ms) or `warning` (1200ms fallback without `llmlingua`) | Spawns `startSidecar()` |
| `Dashboard.js` | `Banner` (with `level`) + `StatsBar` (empty vs active + live `cache XX.X%`) + bounded `<Box>` tail (`MAX_VISIBLE_EVENTS = 20`) | Avoids Ink 5 `<Static>` stall past `MAX_EVENTS`; redacts query-string secrets in URLs via `redactUrl` |
| `Banner.js` | Compact `level` mode vs expanded `TAMP_STAGES` mode + `Available` opt-in hints + `Output mode` banner | Shows `ANTHROPIC_BASE_URL` and `OPENAI_API_BASE` setup lines |

---

## 3. HTTP Proxy Server (`index.js`)

| Route / Condition | Behavior & States |
|---|---|
| `Upgrade: websocket` | Immediate local `501` JSON (`not_implemented`) so Codex CLI drops to HTTP without retry delay |
| `GET`/`HEAD /health` | JSON: `status`, `version`, `stages`, `sidecar` (live-refreshed via bounded/debounced `probeSidecar` checking `model_loaded` when `llmlingua` active), `session`, `disclosure`, `replay`, `usage` (`cacheHitRate`), `redacted`, `staleImages`, `staleInputs` |
| `GET`/`HEAD /health?text` | Plain-text summary with savings, cache hit rate, redactions, and stale eviction counts |
| `GET`/`HEAD /caveman-help` | Output mode, env default, agent, live `CLASSIFIER_PATTERNS`, sample safe/dangerous rules |
| Unknown route (`!provider`) | Direct streaming `pipeRequest` to `config.upstream` |
| Body `> config.maxBody` | Mid-stream overflow switches cleanly to `pipeRequest` with buffered `prefixChunks` (`destroyOnReturn: false`) |
| Request `Content-Encoding` | `gzip`, `deflate`, `br`, `zstd` (streaming bomb-guarded `decompressZstd`), `identity`; limit `5× maxBody`; unknown/corrupt passes through raw |
| JSON parse vs compression errors | Separate `try/catch` blocks (`parse error` vs `compress error`), fail-open passthrough |
| Connection lifecycle | Per-proxy keep-alive `http.Agent` / `https.Agent` (destroyed on `server.close`), optional `TAMP_UPSTREAM_TIMEOUT`, `upstream.destroy()` on premature client `res.on('close')`, `502` JSON before headersSent or socket destroy mid-stream |
| Passive response telemetry (`lib/usage-tap.js`) | Non-blocking side tap over SSE/JSON (identity, gzip, br, deflate, raw deflate); bounded memory; extracts Anthropic, OpenAI Chat, OpenAI Responses, and Gemini usage + prompt-cache counters; invokes optional non-fatal `config.onUsage(usageTotals.snapshot(), u)` |

---

## 4. Providers & Auth Routing (`providers.js`)

| Provider | Routes Matched | Auth / Upstream Routing | Tool Result Extraction (`cacheSafe`) |
|---|---|---|---|
| `anthropic` | `POST /v1/messages*` | `TAMP_UPSTREAM` (`api.anthropic.com`) | Latest eligible `user` message (`tool_result` blocks, skipping `is_error`) |
| `openai` | `POST /v1/chat/completions*`, `/chat/completions*` | `TAMP_UPSTREAM_OPENAI`; JWT or `chatgpt-account-id` → `TAMP_UPSTREAM_CHATGPT/backend-api/codex` (unless `TAMP_DISABLE_CHATGPT_ROUTE`) | Latest contiguous `role: 'tool'` group (walks past trailing non-tool messages) |
| `openai-responses` | `POST /v1/responses*`, `/responses*` | Same OpenAI / ChatGPT Plus OAuth routing | Latest contiguous `function_call_output` / `custom_tool_call_output` group (string or `input_text[]`) |
| `gemini` | `POST *generateContent*` | `TAMP_UPSTREAM_GEMINI` (`generativelanguage.googleapis.com`) | Latest eligible `contents` entry with `functionResponse.response` (object JSON round-trip safe) |
| `kimi` | `POST /coding/v1/chat/completions*`, `/kimi/*` or `x-tamp-target: kimi` | `TAMP_UPSTREAM_KIMI` (`api.kimi.com`), skips `thinking`/`partial` blocks | Same as `openai` |
| `moonshot` | `POST /moonshot/*` or `x-tamp-target: moonshot` | `TAMP_UPSTREAM_MOONSHOT` (`api.moonshot.cn`) | Same as `openai` |

---

## 5. Compression Pipeline, Levels & Presets (`compress.js`, `metadata.js`, `lib/`)

### Pre-Stages (Always-On / Guardrails)
- **Phase 5 Rehydration (`lib/disclosure.js`)**: Expands model-quoted `<tamp-ref:v1:HASH:BYTES>` markers from `br-cache` (never scans untrusted `tool_result` bodies).
- **Caveman Output Hint (`lib/rules-generator.js`)**: Appends task-type-aware (`safe` / `dangerous` / `complex`) + per-agent (`codex`, etc.) rules to the latest user message when `TAMP_OUTPUT_MODE != off`.
- **Protected Tool Exemption**: `AskUserQuestion` marked `skip: 'user-decision'` across all attributed providers.
- **Replay Memo & History Stabilization (`lib/replay-memo.js`)**: Keys on `provider + conversationScope + path + toolId + sha256(raw)`. Replays older compressed turns byte-identically (validating referent hashes and `pxModels` allowlist); on miss, applies deterministic redaction only.
- **Secret Redaction (`lib/redact.js`)**: Runs BEFORE every stage and external call (`TAMP_REDACT=true`, `mask` or `remove` mode). Covers AWS, GitHub, Anthropic, OpenAI, OpenRouter, Google, Slack, Stripe, npm, PyPI, HuggingFace, Groq, xAI, JWT, PEM, and `UPPER_SNAKE` assignments; idempotent on masked markers.

### All 20 Compression Stages
- **Default 10 (`balanced` / L5):** `cmd-strip` (ANSI + 14 command rewriters), `minify` (unsafe-integer guarded), `toon`, `strip-lines`, `whitespace`, `llmlingua` (localhost sidecar, verbatim-critical guarded), `dedup`, `diff`, `read-diff` (multi-provider session LRU), `prune` (npm-internal metadata).
- **Opt-in 10:** `strip-comments`, `textpress` (Ollama localhost / OpenRouter, verbatim-critical guarded), `foundation-models` (macOS `apfel`, 64 KB guard, verbatim-critical guarded), `graph` (cross-request session dedup), `br-cache` (incremental-tracked Brotli disk store), `disclosure` (>32 KB 3-tier summary, dangerous-task bypass), `bm25-trim` (>64 KB code-block-aware BM25 ranker, dangerous-task bypass), `px-render` (`pxpipe-proxy` PNG image rendering + factsheet, model-gated, dangerous-task bypass), `stale-images` (age-scoped base64 eviction with `batchSize` epoching), `stale-inputs` (age-scoped `tool_use.input` payload pruning with `batchSize` epoching).

### Level Ladder (1–9, Prefix-Preserving) & Presets
- L1: `minify` → L2: +`whitespace,strip-lines` → L3: +`cmd-strip` → L4 (`conservative`): +`toon,dedup,diff` → L5 (`balanced`, default): +`llmlingua,read-diff,prune` → L6: +`strip-comments` → L7: +`textpress,br-cache` → L8 (`aggressive`): +`disclosure,bm25-trim` → L9 (`max`): +`graph,foundation-models`.
- Extra named preset: `recommended` (`aggressive` minus `llmlingua`, pair with `TAMP_MIN_SIZE=1024`).

---

## 6. Sidecar, Plugin Hooks & Website

- **Python Sidecar (`sidecar/server.py` + `bin/tamp.js` `startSidecar`)**: FastAPI `lifespan` model loader (`microsoft/llmlingua-2-xlm-roberta-large-meetingbank`), `GET /health` (`model_loaded`), sync threadpool `POST /compress` (503 while loading). `bin/tamp.js` honors configured `TAMP_LLMLINGUA_URL` (env > config file, loopback SSRF guarded) and passes `--with mlx` only on `darwin` + `arm64`.
- **Claude Code Plugin (`plugin/`)**: `SessionStart` hooks (`ensure-tamp.sh`, `ensure-claude-md.sh` reversible markers), `/tamp:status`, `/tamp:config`.
- **Website (`site/` → `https://tamp.dev`)**: Cloudflare Pages + `_worker.js` (Markdown-for-Agents content negotiation via `Accept: text/markdown`, RFC 8288 `Link` headers, `/.well-known/*` discovery cards, WebMCP tools incl. `recommended` preset), DAUB Solarized Light & Dark themes with WCAG AA-safe custom semantic tokens, and byte-identical `setup.sh` / `site/setup.sh` installer (`OPENAI_API_BASE=.../v1`, `@latest` upgrades).
