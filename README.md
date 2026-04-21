# Tamp

**Token compression proxy for coding agents.** 52.6% fewer input tokens, 60-70% combined with output compression. Zero code changes. Works with Claude Code, Codex CLI, opencode, Aider, Cursor, Cline, Windsurf, 🦞 [OpenClaw](https://openclaw.app), and any OpenAI-compatible agent.

```
npx @sliday/tamp
```

### Claude Code plugin

Auto-start on every session:

```bash
claude plugin marketplace add sliday/claude-plugins
claude plugin install tamp@sliday
```

Adds `/tamp:status` and `/tamp:config` commands.

### 🦞 OpenClaw

```bash
TAMP_STAGES=minify,toon,strip-lines,whitespace,dedup,diff,prune tamp -y
```

Set provider to `http://localhost:7778` → done. Full guide: [docs/openclaw-setup.md](docs/openclaw-setup.md)

## How It Works

```
Claude Code ──► Tamp (localhost:7778) ──► Anthropic API
Aider/Cursor ──►          │          ──► OpenAI API
Gemini CLI ────►          │          ──► Google AI API
```

Auto-detects API format, compresses tool output, forwards upstream. Error results skipped. JSON minified, arrays encoded columnarly, text/code normalized or semantically compressed.

**Compression Stages** (all enabled by default):

| Stage | What |
|-------|------|
| `cmd-strip` | Strip progress bars and spinners from command output (lossless) |
| `minify` | Strip JSON whitespace |
| `toon` | Columnar array encoding |
| `strip-lines` | Remove line-number prefixes |
| `whitespace` | Collapse blank lines |
| `llmlingua` | Neural text compression |
| `dedup` | Replace duplicates with refs |
| `diff` | Replace similar re-reads with diffs |
| `prune` | Remove low-value metadata |

Opt-in stages: `strip-comments`, `textpress` (LLM semantic compression), `graph` (session-scoped dedup — works on any coding agent: Codex, Claude Code, Aider — anywhere the same file is read twice, up to -99% per repeat block)

## Quick Start

```bash
# Option A: One-line installer
curl -fsSL https://tamp.dev/setup.sh | bash

# Option B: Manual
npx @sliday/tamp
export ANTHROPIC_BASE_URL=http://localhost:7778   # Claude Code
export OPENAI_API_BASE=http://localhost:7778/v1   # Aider, Cline
```

Use your agent as normal — Tamp compresses silently.

### Codex CLI

Codex CLI reads its upstream from `~/.codex/config.toml`, not an env var. Add a custom provider:

```toml
model_provider = "tamp"

[model_providers.tamp]
name = "Tamp Proxy"
base_url = "http://localhost:7778/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
```

Then `export OPENAI_API_KEY=sk-...` and run `codex` or `codex exec "..."` as usual. Tamp routes `/v1/responses` through the `openai-responses` adapter and compresses every `function_call_output` block.

**ChatGPT Plus / Pro subscription.** If you sign in with `codex login` instead of using an API key, add this line to `~/.codex/config.toml`:

```toml
openai_base_url = "http://localhost:7778/v1"
```

Tamp detects OAuth bearer tokens and routes them to `chatgpt.com/backend-api/codex` automatically, so your ChatGPT Plus/Pro subscription keeps paying for inference while Tamp compresses every tool result in flight.

### Cursor

1. Start Tamp: `npx @sliday/tamp -y`
2. Open Cursor → **Settings** (`⌘,`) → **Models**
3. Scroll to **OpenAI API Key**, paste your `sk-...` key
4. Click **"Override OpenAI Base URL"**, paste `http://localhost:7778/v1`
5. Click **Verify**, then enable any OpenAI-family model (`gpt-4o`, `gpt-5-codex`, etc.)
6. Use Cursor as normal — Tamp compresses every tool call

> **Cursor Pro subscription caveat.** Cursor's bundled `cursor-*`, `composer-*`, `claude-*`, and `gpt-*` models are routed through Cursor's own servers (`api2.cursor.sh`) regardless of the "Override OpenAI Base URL" setting — Tamp cannot intercept them. Compression only applies when you (a) bring your own OpenAI key and (b) select a model Cursor treats as external (e.g. an unbundled `gpt-4o` with BYOK, or a custom model name via a public tunnel).

### opencode

opencode **silently ignores** `OPENAI_API_BASE` / `OPENAI_BASE_URL`. Configure base URLs per provider in `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "anthropic":  { "options": { "baseURL": "http://localhost:7778" } },
    "openai":     { "options": { "baseURL": "http://localhost:7778/v1" } },
    "openrouter": { "options": { "baseURL": "http://localhost:7778/v1/openrouter" } },
    "opencode":   { "options": { "baseURL": "http://localhost:7778/v1/zen" } }
  }
}
```

Restart opencode. Tamp's adapter table routes each provider to the correct upstream.

### VS Code

#### Cline (recommended)

1. Install [Cline](https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev) from the VS Code marketplace
2. Start Tamp: `npx @sliday/tamp -y`
3. Click the Cline icon in the activity bar → **Settings** (⚙️)
4. **API Provider**: `OpenAI Compatible`
5. **Base URL**: `http://localhost:7778/v1`
6. **API Key**: your `sk-...`
7. **Model ID**: `gpt-4o`, `claude-sonnet-4-5`, or any model your key supports

Cline talks directly to the configured base URL for every request — works seamlessly through Tamp.

#### Continue

1. Install [Continue](https://marketplace.visualstudio.com/items?itemName=Continue.continue)
2. Start Tamp: `npx @sliday/tamp -y`
3. Open `~/.continue/config.json` and add:

```json
{
  "models": [
    {
      "title": "GPT-4o (via Tamp)",
      "provider": "openai",
      "model": "gpt-4o",
      "apiKey": "sk-...",
      "apiBase": "http://localhost:7778/v1"
    }
  ]
}
```

#### GitHub Copilot

Copilot does not expose a base URL setting and routes everything through GitHub's servers. Tamp **cannot** intercept Copilot traffic. Use Cline or Continue instead if you want compression in VS Code.

## Configuration

Run `tamp init` to create `~/.config/tamp/config`. All variables work via env or config file.

### Compression levels

One knob, nine stops. The 1–9 ladder is prefix-preserving (each level adds stages on top of the previous), so you can dial compression up or down without reasoning about individual stages.

| Level | Stages (cumulative) | Lossy | Expected savings | Preset alias |
|---|---|---|---|---|
| 1 | minify | — | ~15% | — |
| 2 | + whitespace, strip-lines | — | ~25% | — |
| 3 | + cmd-strip | — | ~35% | — |
| 4 | + toon, dedup, diff | — | ~45% | `conservative` |
| 5 | + llmlingua, read-diff, prune | yes | ~53% | **`balanced` (default)** |
| 6 | + strip-comments | yes | ~58% | — |
| 7 | + textpress, br-cache | yes | ~62% | — |
| 8 | + disclosure, bm25-trim | yes | ~67% | `aggressive` |
| 9 | + graph, foundation-models | yes | ~72% | `max` |

Three interchangeable ways to pick a level:

```bash
tamp --level 7              # CLI flag
TAMP_LEVEL=7 tamp           # Environment variable
tamp settings               # Interactive slider (+ advanced stage picker)
```

Precedence: `--level` > `TAMP_LEVEL` > config file > preset alias > default (`balanced` / L5). Setting `TAMP_STAGES` explicitly still wins over any level — the banner will show the full stage list instead of the Level line.

### Compression Presets

The named presets are aliases of levels and still work unchanged:

| Preset | Level | Savings | Description |
|--------|-------|---------|-------------|
| `conservative` | L4 | 45-50% | Lossless only (no neural) |
| `balanced` (default) | L5 | 52-58% | Recommended, includes LLMLingua |
| `aggressive` | L8 | 60-68% | Maximum, lossy stages enabled |

```bash
# Use a preset
export TAMP_COMPRESSION_PRESET=balanced

# Or override specific stages
TAMP_COMPRESSION_PRESET=balanced
TAMP_STAGES=minify,toon  # Override preset
```

### Output Compression — Caveman Mode

Task-type-aware output compression. Tamp classifies each request as `safe` (typo fixes, env var changes, doc updates) or `dangerous` (security, debug, refactor) and injects matching rules into the last user message before forwarding. Cache-safe — the prefix stays untouched so prompt caching keeps working.

**Opt in** (default is `off` — zero behavior change unless you flip the switch):

```bash
export TAMP_OUTPUT_MODE=balanced  # off | conservative | balanced | aggressive
export TAMP_AUTO_DETECT_TASK_TYPE=true  # default; set to false to force 'complex'
```

**Mode behavior:**
- **off** *(default)*: No injection. Pass-through.
- **conservative**: Professional but concise for all tasks (40-50% output savings).
- **balanced**: Terse on safe tasks, full output on dangerous (65-75% on safe).
- **aggressive**: Minimal caveman-style (75-85% on safe, partial on dangerous).

Supported on all providers: Anthropic, OpenAI Chat, OpenAI Responses (Codex), Gemini.

### Other Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `TAMP_PORT` | `7778` | Listen port |
| `TAMP_UPSTREAM` | `https://api.anthropic.com` | Default upstream |
| `TAMP_MIN_SIZE` | `200` | Min content size (chars) |
| `TAMP_LOG` | `true` | Enable logging |
| `TAMP_CACHE_SAFE` | `true` | Compress newest only (prompt-cache safe) |
| `TAMP_LLMLINGUA_URL` | *(none)* | LLMLingua sidecar URL |

**Recommended setups:**

```bash
# Default (balanced preset = L5)
npx @sliday/tamp

# Conservative (no Python, lossless only)
TAMP_LEVEL=4 npx @sliday/tamp -y

# Aggressive (maximum compression)
TAMP_LEVEL=8 npx @sliday/tamp -y
```

## CLI Tools

### compress-config (New!)

Compress CLAUDE.md and config files by 40-45%:

```bash
# Dry run (preview savings)
tamp compress-config --dry-run ~/.claude/CLAUDE.md

# Compress with backup
tamp compress-config ~/.claude/CLAUDE.md

# Compress multiple files
tamp compress-config ~/.config/tamp/config ~/.claude/CLAUDE.md
```

Inspired by [JuliusBrussee/caveman-compress](https://github.com/JuliusBrussee/caveman).

## Lifecycle

Tamp writes a PID file at `~/.config/tamp/tamp-${port}.pid` on start and cleans it up on graceful shutdown (SIGINT, SIGTERM, SIGHUP). If a terminal dies and leaves the port bound, `tamp -y` will now detect it and print a friendly error instead of a cryptic EADDRINUSE:

```
[tamp] Tamp v0.5.4 already running on :7778 (pid 12345, started 3m ago).
  Run 'tamp stop' to replace it, or set TAMP_PORT=7779 to run alongside it.
```

- `tamp stop` — graceful SIGTERM to the running proxy, falls back to SIGKILL after 2s
- `tamp -y --force` — replace any existing Tamp on the same port in one step (for scripts)

## Installation

```bash
# npx (no install)
npx @sliday/tamp

# npm global
npm install -g @sliday/tamp
tamp

# systemd service (Linux)
tamp install-service
tamp status
```

## Token Savings

Claude Code sends full conversation history on every API call. Tool results accumulate — files, listings, outputs — all re-sent as input tokens.

**With 52.6% average input compression:** Save $0.19–$0.32 per 200-request session (Sonnet/Opus 4.6). Max subscribers get 47% more requests from fixed budgets. See [whitepaper PDF](site/whitepaper.pdf) for full benchmarks.

**Output compression (new):** Task-type-aware rules reduce output tokens by 65-75% on safe tasks (env vars, typos, docs) while preserving full output for dangerous tasks (security, debugging). Inspired by [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman).

**Combined impact:** With new Caveman-integrated features, Tamp achieves 60-70% total token savings (input + output) in balanced mode.

### Did v0.8 headline % improve over v0.5?

Short answer: **not much on the micro-benchmark, a lot on real sessions.**

On the short single-request fixtures in `bench/`, the headline percentage barely moves — v0.5 baseline lands at 45.1%, L5 (balanced) at 45.3%, L9 (max) at 45.4%. The fixtures are too small to exercise the new stages: they don't contain re-reads, don't cross the disclosure threshold (>32 KB tool_result bodies), don't include the noisy CLI streams `cmd-strip` targets, and fit entirely inside a single request so cross-request session dedup (`graph`) is a no-op.

Where v0.8 actually pays off is **session-scoped work**, which is what coding agents do all day:

- `read-diff` (L5) and `graph` (L9) eliminate the cost of re-reading the same file — a dominant pattern in multi-turn debugging sessions.
- `disclosure` (L8) keeps `tool_result` payloads over 32 KB from burning input tokens a second time when the agent references them later.
- `cmd-strip` (L3) removes per-command stdout noise (spinners, progress bars from `npm`, `pip`, `cargo`, `docker`) that the synthetic fixtures don't contain.
- `br-cache` (L7) and `bm25-trim` (L8) shave long-tail content the fixtures don't exercise.

The real win in v0.8 is **the level knob itself** — a zip-like 1–9 dial that lets you trade compression aggressiveness for risk without memorizing stage names. To reproduce the numbers above, run `node bench/runner.js --sweep` (set `OPENROUTER_API_KEY` for the live A/B pass).

## Development

```bash
npm test
node smoke.js
```

## License

MIT © [Stas Kulesh](https://sliday.com)
