# Tamp

**Token compression proxy for coding agents.** 52.6% fewer input tokens, 60-70% combined with output compression. Zero code changes. Works with Claude Code, Codex CLI, Aider, Cursor, Cline, Windsurf, 🦞 [OpenClaw](https://openclaw.app), and any OpenAI-compatible agent.

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
export OPENAI_API_BASE=http://localhost:7778/v1   # Aider, Cursor, Cline
```

Use your agent as normal — Tamp compresses silently.

### Codex CLI

Codex CLI reads its upstream from `~/.codex/config.toml`, not `OPENAI_API_BASE`. Add a custom provider:

```toml
model_provider = "tamp"

[model_providers.tamp]
name = "Tamp Proxy"
base_url = "http://localhost:7778/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
```

Then `export OPENAI_API_KEY=sk-...` and run `codex` or `codex exec "..."` as usual. Tamp routes `/v1/responses` through the `openai-responses` adapter and compresses every `function_call_output` block.

## Configuration

Run `tamp init` to create `~/.config/tamp/config`. All variables work via env or config file.

### Compression Presets (New!)

Simplify configuration with three intensity levels:

| Preset | Savings | Description |
|--------|---------|-------------|
| `conservative` | 45-50% | Lossless only (no neural) |
| `balanced` (default) | 52-58% | Recommended, includes LLMLingua |
| `aggressive` | 60-68% | Maximum, lossy stages enabled |

```bash
# Use a preset
export TAMP_COMPRESSION_PRESET=balanced

# Or override specific stages
TAMP_COMPRESSION_PRESET=balanced
TAMP_STAGES=minify,toon  # Override preset
```

### Output Compression (New!)

Task-type-aware output compression via CLAUDE.md injection:

```bash
export TAMP_OUTPUT_MODE=balanced  # conservative | balanced | aggressive
export TAMP_AUTO_DETECT_TASK_TYPE=true  # Auto-detect safe vs dangerous tasks
```

**Mode behavior:**
- **Conservative**: Professional but concise (40-50% output savings)
- **Balanced**: Terse on safe tasks, full output on dangerous (65-75% on safe)
- **Aggressive**: Minimal caveman-style (75-85% on safe, partial on dangerous)

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
# Default (balanced preset)
npx @sliday/tamp

# Conservative (no Python, lossless only)
TAMP_COMPRESSION_PRESET=conservative npx @sliday/tamp -y

# Aggressive (maximum compression)
TAMP_COMPRESSION_PRESET=aggressive npx @sliday/tamp -y
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

## Development

```bash
npm test
node smoke.js
```

## License

MIT © [Stas Kulesh](https://sliday.com)
