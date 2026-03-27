# Tamp + OpenClaw: Token Compression Setup

Save 3-50% on input tokens by routing API requests through [Tamp](https://github.com/sliday/tamp) — a local HTTP proxy that compresses tool_result blocks before they reach Anthropic.

## Prerequisites

- **Node.js 18+**
- **Anthropic API key** — Tamp proxies requests to Anthropic. Your `ANTHROPIC_API_KEY` must be set in your OpenClaw config. Tamp itself does not store or read this key — it forwards the `x-api-key` header from incoming requests unchanged.

## 1. Install & Run

```bash
# Install globally
npm i -g @sliday/tamp

# Or run without installing
npx @sliday/tamp -y
```

Start with default stages:

```bash
TAMP_STAGES=minify,toon,strip-lines,whitespace,dedup,diff,prune tamp -y
```

Verify:

```bash
curl http://localhost:7778/health
# {"status":"ok","version":"<package version>","stages":["minify","toon",...]}
```

By default, Tamp keeps `TAMP_CACHE_SAFE=true`, so it only compresses the newest eligible tool result in each request to preserve prompt-cache stability. If you want full-history compression instead, start it with `TAMP_CACHE_SAFE=false`.

> **Note:** Tamp is [open source (MIT)](https://github.com/sliday/tamp). You can audit the source, build from git, or run from a local clone instead of npm: `git clone https://github.com/sliday/tamp && cd tamp && npm install && node bin/tamp.js -y`

## 2. Run as systemd service

```bash
tamp init                  # create config file (~/.config/tamp/config)
tamp install-service       # install + start systemd user service
```

Check status:

```bash
tamp status
journalctl --user -u tamp -f  # live compression logs
```

Remove:

```bash
tamp uninstall-service
```

The service reads config from `~/.config/tamp/config`. Edit it to change stages, port, upstream, etc.

## 3. Configure OpenClaw

Add a provider in your OpenClaw config:

```json5
{
  models: {
    providers: {
      "anthropic-tamp": {
        baseUrl: "http://localhost:7778",
        apiKey: "${ANTHROPIC_API_KEY}",  // Your Anthropic key — forwarded to upstream, not stored by Tamp
        api: "anthropic-messages",
        models: [
          { id: "claude-opus-4-6", name: "Claude Opus 4.6 (compressed)" },
          { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (compressed)" }
        ]
      }
    }
  }
}
```

Set as primary model:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic-tamp/claude-opus-4-6"
      }
    }
  }
}
```

Restart the gateway. All requests now flow through Tamp.

## How it works

```
OpenClaw → POST /v1/messages → Tamp (localhost:7778) → compresses JSON body → Anthropic API
                                                     ← streams response back unchanged
```

Tamp intercepts the request body, finds `tool_result` blocks in `messages[]`, and compresses their content. Headers (including `x-api-key`) are forwarded unchanged. The response streams back untouched.

## 7 Compression Stages

| Stage | What it does | Lossy? |
|-------|-------------|--------|
| minify | Strip JSON whitespace | No |
| toon | Columnar encoding for arrays (file listings, deps, routes) | No |
| strip-lines | Remove line-number prefixes from Read tool output | No |
| whitespace | Collapse blank lines, trim trailing spaces | No |
| dedup | Deduplicate identical tool_results across turns | No |
| diff | Delta-encode similar re-reads as unified diffs | No |
| prune | Strip lockfile hashes, registry URLs, npm metadata | Metadata only* |

\* The `prune` stage removes fields like `integrity`, `resolved`, `shasum`, `_id`, `_from`, `_nodeVersion` from JSON. These are npm registry metadata not needed by the LLM. If you need full provenance in tool outputs, disable prune: remove it from `TAMP_STAGES`.

## What to expect

| Scenario | Savings | Notes |
|----------|---------|-------|
| Telegram chat (short turns) | 3-5% | Mostly text, few tool calls |
| Coding sessions (file reads, JSON) | 30-50% | Heavy tool_result compression |
| Lockfiles | up to 81% | Prune strips hashes and URLs |
| Subagent tasks | 20-40% | Depends on file exploration |

## Security Notes

- **API key handling:** Tamp forwards the `x-api-key` / `Authorization` header from the incoming request to upstream. It does not store, log, or read API keys.
- **Local only:** Tamp binds to `localhost` by default. It does not accept external connections unless you change the bind address.
- **No telemetry:** Tamp does not phone home, collect analytics, or make any outbound connections except to the configured upstream API.
- **Fallback:** Add Anthropic direct as a fallback model in OpenClaw. If Tamp is down, requests bypass it automatically.

## Resources

- **RAM:** ~70MB
- **Latency:** <5ms per request
- **No Python needed** — all 7 stages run in Node.js
- **Source:** https://github.com/sliday/tamp (MIT license)
- **Site:** https://tamp.dev
- **White paper:** https://tamp.dev/whitepaper.pdf
