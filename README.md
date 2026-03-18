# Tamp

**Token compression proxy for coding agents.** 33.9% fewer input tokens, zero code changes. Works with Claude Code, Aider, Cursor, Cline, Windsurf, and any OpenAI-compatible agent.

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

### Compression Stages

| Stage | What it does | When it applies |
|-------|-------------|-----------------|
| `minify` | Strips JSON whitespace | Pretty-printed JSON objects/arrays |
| `toon` | Columnar [TOON encoding](https://github.com/nicholasgasior/toon-format) | Homogeneous arrays (file listings, routes, deps) |
| `llmlingua` | Neural text compression via [LLMLingua](https://github.com/microsoft/LLMLingua) sidecar | Natural language text (requires sidecar) |

Only `minify` is enabled by default. Enable more with `TOONA_STAGES=minify,toon`.

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
| `TOONA_PORT` | `7778` | Proxy listen port |
| `TOONA_UPSTREAM` | `https://api.anthropic.com` | Default upstream API URL |
| `TOONA_UPSTREAM_OPENAI` | `https://api.openai.com` | Upstream for OpenAI-format requests |
| `TOONA_UPSTREAM_GEMINI` | `https://generativelanguage.googleapis.com` | Upstream for Gemini-format requests |
| `TOONA_STAGES` | `minify` | Comma-separated compression stages |
| `TOONA_MIN_SIZE` | `200` | Minimum content size (chars) to attempt compression |
| `TOONA_LOG` | `true` | Enable request logging to stderr |
| `TOONA_LOG_FILE` | _(none)_ | Write logs to file |
| `TOONA_MAX_BODY` | `10485760` | Max request body size (bytes) before passthrough |
| `TOONA_LLMLINGUA_URL` | _(none)_ | LLMLingua sidecar URL for text compression |

### Recommended setup

```bash
# Maximum compression
TOONA_STAGES=minify,toon npx @sliday/tamp
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

Tamp only compresses the **last user message** in each request (the most recent `tool_result` blocks). Historical messages are left untouched to avoid redundant recompression.

| Content Type | Action | Example |
|-------------|--------|---------|
| Pretty-printed JSON | Minify whitespace | `package.json`, config files |
| JSON with line numbers | Strip prefixes + minify | Read tool output (`  1→{...}`) |
| Homogeneous JSON arrays | TOON encode | File listings, route tables, dependencies |
| Already-minified JSON | Skip | Single-line JSON |
| Source code (text) | Passthrough | `.ts`, `.py`, `.rs` files |
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

Bodies exceeding `TOONA_MAX_BODY` are piped through without buffering.

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

At $3/million input tokens (Sonnet 4), a 200-request session consuming 3M input tokens costs $9. If 60% of tool results are compressible JSON, and compression removes 30-50% of those tokens, that's $1.60-2.70 saved per session.

For teams with 5 developers doing 2 sessions/day, that's $500-800/month in savings.

## License

MIT

## Author

[Stas Kulesh](mailto:stas@sliday.com) — [sliday.com](https://sliday.com)
