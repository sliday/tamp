# Tamp

**Token compression proxy for coding agents.** 32.0% fewer input tokens, zero code changes. Works with Claude Code, Aider, Cursor, Cline, Windsurf, and any OpenAI-compatible agent.

```
npx @sliday/tamp
```

Or install globally:

```bash
curl -fsSL https://tamp.dev/setup.sh | bash
```

## How It Works

Tamp auto-detects your agent's API format and compresses tool result blocks before forwarding upstream. Source code, error results, and non-JSON content pass through untouched.

```
Claude Code ──► Tamp (localhost:7778) ──► Anthropic API
Aider/Cursor ──►          │          ──► OpenAI API
Gemini CLI ────►          │          ──► Google AI API
                          │
                          ├─ JSON → minify whitespace
                          ├─ Arrays → TOON columnar encoding
                          ├─ Line-numbered → strip prefixes + minify
                          ├─ Source code → passthrough
                          └─ Errors → skip
```

### Supported API Formats

| Format | Endpoint | Agents |
|--------|----------|--------|
| Anthropic Messages | `POST /v1/messages` | Claude Code |
| OpenAI Chat Completions | `POST /v1/chat/completions` | Aider, Cursor, Cline, Windsurf, OpenCode |
| Google Gemini | `POST .../generateContent` | Gemini CLI |

> **Why not Codex?** Codex CLI uses OpenAI's Responses API (`POST /v1/responses`), which has a different request shape than Chat Completions — `input[]` with `function_call_output` items instead of `messages[]` with `role: tool`. We had early support but pulled it because the Responses API is still evolving and Codex sends zstd-compressed bodies that add another layer of complexity. We'll revisit once the format stabilizes.

### Compression Stages

| Stage | What it does | When it applies |
|-------|-------------|-----------------|
| `minify` | Strips JSON whitespace | Pretty-printed JSON objects/arrays |
| `toon` | Columnar [TOON encoding](https://github.com/nicholasgasior/toon-format) | Homogeneous arrays (file listings, routes, deps) |
| `strip-lines` | Removes line-number prefixes | Read tool output (`  1→...`) |
| `whitespace` | Collapses blank lines, trims trailing spaces | CLI output, source code |
| `llmlingua` | Neural text compression via [LLMLingua-2](https://github.com/microsoft/LLMLingua) | Natural language text (auto-starts sidecar) |

All 5 stages enabled by default. On first launch, an interactive prompt lets you toggle methods. Use `-y` to skip the prompt.

## Quick Start

### 1. Start the proxy

```bash
npx @sliday/tamp
```

```
  ┌─ Tamp ─────────────────────────────────┐
  │  Proxy: http://localhost:7778          │
  │  Status: ● Ready                       │
  │                                        │
  │  Claude Code:                          │
  │    ANTHROPIC_BASE_URL=http://localhost:7778
  │                                        │
  │  Aider / Cursor / Cline:              │
  │    OPENAI_BASE_URL=http://localhost:7778
  └────────────────────────────────────────┘
```

### 2. Point your agent at the proxy

**Claude Code:**
```bash
export ANTHROPIC_BASE_URL=http://localhost:7778
claude
```

**Aider:**
```bash
export OPENAI_API_BASE=http://localhost:7778
aider
```

**Cursor / Cline / Windsurf:**
Set the API base URL to `http://localhost:7778` in your editor's settings.

That's it. Use your agent as normal — Tamp compresses silently in the background.

## Configuration

All configuration via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `TAMP_PORT` | `7778` | Proxy listen port |
| `TAMP_UPSTREAM` | `https://api.anthropic.com` | Default upstream API URL |
| `TAMP_UPSTREAM_OPENAI` | `https://api.openai.com` | Upstream for OpenAI-format requests |
| `TAMP_UPSTREAM_GEMINI` | `https://generativelanguage.googleapis.com` | Upstream for Gemini-format requests |
| `TAMP_STAGES` | `minify,toon,strip-lines,whitespace,llmlingua` | Comma-separated compression stages |
| `TAMP_MIN_SIZE` | `200` | Minimum content size (chars) to attempt compression |
| `TAMP_LOG` | `true` | Enable request logging to stderr |
| `TAMP_LOG_FILE` | _(none)_ | Write logs to file |
| `TAMP_MAX_BODY` | `10485760` | Max request body size (bytes) before passthrough |
| `TAMP_LLMLINGUA_URL` | _(none)_ | LLMLingua sidecar URL for text compression |

### Recommended setup

```bash
# All stages enabled by default — just run:
npx @sliday/tamp

# Skip interactive prompt (CI/scripts):
npx @sliday/tamp -y

# Without LLMLingua (no Python needed):
TAMP_STAGES=minify,toon,strip-lines,whitespace npx @sliday/tamp -y
```

## Installation Methods

### npx (no install)

```bash
npx @sliday/tamp
```

### npm global

```bash
npm install -g @sliday/tamp
npx @sliday/tamp
```

### Git clone

```bash
git clone https://github.com/sliday/tamp.git
cd tamp && npm install
node bin/tamp.js
```

### One-line installer

```bash
curl -fsSL https://tamp.dev/setup.sh | bash
```

The installer clones to `~/.tamp`, adds `ANTHROPIC_BASE_URL` to your shell profile, and creates a `tamp` alias.

## What Gets Compressed

Tamp compresses `tool_result` blocks in **all messages** — not just the latest. Since each API call re-sends the full conversation history uncompressed, this compounds savings with every turn. An in-memory cache ensures identical content is only compressed once per session.

| Content Type | Action | Example |
|-------------|--------|---------|
| Pretty-printed JSON | Minify whitespace | `package.json`, config files |
| JSON with line numbers | Strip prefixes + minify | Read tool output (`  1→{...}`) |
| Homogeneous JSON arrays | TOON encode | File listings, route tables, dependencies |
| Already-minified JSON | Skip | Single-line JSON |
| Source code (text) | Strip line numbers + normalize whitespace | `.ts`, `.py`, `.rs` files |
| `is_error: true` results | Skip entirely | Error tool results |
| TOON-encoded content | Skip | Already compressed |

## Architecture

```
bin/tamp.js          CLI entry point
index.js             HTTP proxy server
providers.js         API format adapters (Anthropic, OpenAI, Gemini) + auto-detection
compress.js          Compression pipeline (compressRequest, compressText)
detect.js            Content classification (classifyContent, tryParseJSON, stripLineNumbers)
config.js            Environment-based configuration
stats.js             Session statistics and request logging
setup.sh             One-line installer script
```

### How the proxy works

1. `detectProvider()` auto-detects the API format from the request path
2. Unrecognized requests are piped through unmodified
3. Matched requests are buffered, parsed, and tool results are extracted via the provider adapter
4. Extracted blocks are classified and compressed
5. The modified body is forwarded to the correct upstream with updated `Content-Length`
6. The upstream response is streamed back to the client unmodified

Bodies exceeding `TAMP_MAX_BODY` are piped through without buffering.

## Benchmarking

The `bench/` directory contains a reproducible A/B benchmark that measures actual token savings via OpenRouter:

```bash
OPENROUTER_API_KEY=... node bench/runner.js   # 70 API calls, ~2 min
node bench/analyze.js                          # Statistical analysis
node bench/render.js                           # White paper (HTML + PDF)
```

Seven scenarios cover the full range: small/large JSON, tabular data, source code, multi-turn conversations, line-numbered output, and error results. Each runs 5 times for statistical confidence (95% CI via Student's t-distribution).

Results are written to `bench/results/` (gitignored).

## Development

```bash
# Run tests
npm test

# Smoke test (spins up proxy + echo server, validates compression)
node smoke.js

# Run specific test file
node --test test/compress.test.js
```

### Test files

```
test/compress.test.js    Compression pipeline tests (Anthropic + OpenAI formats)
test/providers.test.js   Provider adapter + auto-detection tests
test/detect.test.js      Content classification tests
test/config.test.js      Configuration loading tests
test/proxy.test.js       HTTP proxy integration tests
test/stats.test.js       Statistics and logging tests
test/fixtures/           Sample API payloads
```

## How Token Savings Work

Claude Code sends the full conversation history on every API call. As a session progresses, tool results accumulate — file contents, directory listings, command outputs — all re-sent as input tokens on each request.

At $3/million input tokens (Sonnet 4.6), a 200-request session consuming 3M input tokens costs $9. With 32% compression on 60% compressible traffic, that's ~63K tokens and $0.19 saved per session. For Opus 4.6 ($5/MTok), savings are $0.32/session.

### Claude Max subscribers

Max plans have fixed token budgets. With 32% fewer input tokens per request, you get **47% more requests** from the same budget:

| Plan | Without Tamp | With Tamp |
|------|-------------|-----------|
| Max 5× ($100/mo) | 5× Pro | **7.4×** Pro |
| Max 20× ($200/mo) | 20× Pro | **29.4×** Pro |

### API cost savings

| Model | Per dev/month | 10-person team/year |
|-------|-------------|-------------------|
| Sonnet 4.6 ($3/MTok) | $28 | $3,400 |
| Opus 4.6 ($5/MTok) | $48 | $5,760 |
| Opus 4.6 extended ($10/MTok) | $96 | $11,520 |

Based on 5 sessions/day, 200 requests/session, 60% compressible traffic.

## License

MIT

## Author

[Stas Kulesh](mailto:stas@sliday.com) — [sliday.com](https://sliday.com)
