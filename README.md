# Tamp

**Token compression proxy for coding agents.** 52.6% fewer tokens, zero code changes. Works with Claude Code, Aider, Cursor, Cline, Windsurf, 🦞 [OpenClaw](https://openclaw.app), and any OpenAI-compatible agent.

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

Opt-in lossy stages: `strip-comments`, `textpress` (LLM semantic compression)

## Quick Start

```bash
# Option A: One-line installer
curl -fsSL https://tamp.dev/setup.sh | bash

# Option B: Manual
npx @sliday/tamp
export ANTHROPIC_BASE_URL=http://localhost:7778
```

Use your agent as normal — Tamp compresses silently.

## Configuration

Run `tamp init` to create `~/.config/tamp/config`. All variables work via env or config file.

| Variable | Default | Description |
|----------|---------|-------------|
| `TAMP_PORT` | `7778` | Listen port |
| `TAMP_UPSTREAM` | `https://api.anthropic.com` | Default upstream |
| `TAMP_STAGES` | *(all default)* | Comma-separated stages |
| `TAMP_MIN_SIZE` | `200` | Min content size (chars) |
| `TAMP_LOG` | `true` | Enable logging |
| `TAMP_CACHE_SAFE` | `true` | Compress newest only (prompt-cache safe) |
| `TAMP_LLMLINGUA_URL` | *(none)* | LLMLingua sidecar URL |

**Recommended setups:**

```bash
# Default (all stages)
npx @sliday/tamp

# No Python (skip LLMLingua)
TAMP_STAGES=minify,toon,strip-lines,whitespace,dedup,diff,prune npx @sliday/tamp -y

# Re-compress history too
TAMP_CACHE_SAFE=false npx @sliday/tamp
```

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

**With 52.6% average compression:** Save $0.19–$0.32 per 200-request session (Sonnet/Opus 4.6). Max subscribers get 47% more requests from fixed budgets. See [whitepaper PDF](site/whitepaper.pdf) for full benchmarks.

**Output savings:** Tamp injects token-efficient rules into your `CLAUDE.md`, reducing output tokens by 66.2%. Inspired by [drona23/claude-token-efficient](https://github.com/drona23/claude-token-efficient).

**Caveman Mode evaluation:** Tested extreme compression (40-70% additional savings) but found unsafe for production. Recommended: task-type-aware compression (78% savings on safe tasks like env vars/typos/docs). Full evaluation: [`bench/caveman-mode-evaluation.md`](bench/caveman-mode-evaluation.md).

## Development

```bash
npm test
node smoke.js
```

## License

MIT © [Stas Kulesh](https://sliday.com)
