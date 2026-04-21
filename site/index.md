# Tamp — Cut your AI coding costs in half

Tamp saves **52.6% of tokens** for coding agents like Claude Code, Codex CLI, opencode, Cursor, and Aider. A/B tested, open source, zero code changes. One command.

- Homepage: <https://tamp.dev/>
- Source: <https://github.com/sliday/tamp>
- Whitepaper (HTML): <https://tamp.dev/whitepaper-latest>
- Whitepaper (PDF): <https://tamp.dev/whitepaper.pdf>
- License: MIT

## What it is

Tamp is a local HTTPS proxy that sits between your coding agent and the upstream LLM API. It compresses request and response payloads using a configurable stage pipeline (cmd-strip, minify, toon, prune, dedup, diff, read-diff, strip-lines, whitespace, llmlingua, plus opt-in strip-comments, textpress, graph, br-cache, disclosure, bm25-trim) and streams back results without the agent noticing.

- No code changes — point `ANTHROPIC_BASE_URL` (or the equivalent for your agent) at `http://localhost:7778`.
- Provider-agnostic — works with Anthropic, OpenAI Responses API, Gemini, and more.
- Caveman-integrated presets deliver ~60-70% combined input+output savings (aggressive preset: 65-72%).

## Install

```sh
curl -fsSL https://tamp.dev/setup.sh | bash
```

Or via npm:

```sh
npm install -g @sliday/tamp
tamp start
```

## Wire it up in 30 seconds

Set one environment variable. Your agent never knows there's a proxy in the way.

```sh
export ANTHROPIC_BASE_URL="http://localhost:7778"
```

Per-agent instructions (Claude Code, Codex CLI, Cursor, Cline, Continue, Aider): <https://github.com/sliday/tamp#wire-it-up-in-30-seconds>

Diagnostic endpoint: `curl http://localhost:7778/caveman-help` returns the current output mode and classifier rules.

## Compression presets

```sh
# conservative | balanced | aggressive
export TAMP_COMPRESSION_PRESET=balanced
```

Explicit override:

```sh
export TAMP_STAGES=cmd-strip,minify,toon,prune,dedup,diff,read-diff,strip-lines,whitespace,llmlingua
```

## Output compression + Caveman mode

Tamp also compresses **model outputs** on the way back to the agent, integrating Caveman-style short-token rewriting for an additional ~15-20% reduction on long agent responses. See the whitepaper for A/B benchmark methodology and results.

## How it works — pipeline

1. Agent sends a request to `http://localhost:7778`.
2. Tamp decodes the payload, runs the configured stages on each message/part.
3. Request is forwarded upstream (Anthropic/OpenAI/Gemini) over HTTPS.
4. Response is compressed on the way back (when output mode is enabled).
5. Agent receives normal-looking SSE/JSON.

## Agent-discovery metadata

- `robots.txt`: <https://tamp.dev/robots.txt>
- `sitemap.xml`: <https://tamp.dev/sitemap.xml>
- API catalog: <https://tamp.dev/.well-known/api-catalog>
- Agent skills index: <https://tamp.dev/.well-known/agent-skills/index.json>
- MCP server card (CLI-based, not a hosted MCP server): <https://tamp.dev/.well-known/mcp/server-card.json>

## Author

Stas Kulesh — <https://sliday.com> — <https://x.com/staskulesh>
