# Maintainer note: README promises openrouter/zen routing the code doesn't implement

Status: open docs-vs-code drift. Found during continuous-improvement review.
Breaks the documented **opencode** integration. No code changed.

## Problem

README (opencode section) tells users to set per-provider base URLs:

```json
"openrouter": { "options": { "baseURL": "http://localhost:7778/v1/openrouter" } },
"opencode":   { "options": { "baseURL": "http://localhost:7778/v1/zen" } }
```

and states: *"Tamp's adapter table routes each provider to the correct upstream."*

There is no such routing:

- `detectProvider('POST', '/v1/openrouter/chat/completions')` → `null` (no
  provider matches the `/v1/openrouter` or `/v1/zen` prefix; `openai.match`
  only matches `/v1/chat/completions` and `/chat/completions`).
- `config.js` reads `TAMP_UPSTREAM_{OPENAI,GEMINI,KIMI,MOONSHOT,CHATGPT}` but
  **no** `TAMP_UPSTREAM_OPENROUTER` / `TAMP_UPSTREAM_ZEN`.
- With no provider match, the request is a non-provider passthrough to the
  single default `config.upstream` (Anthropic by default).

Verified end-to-end: a request to `/v1/openrouter/chat/completions` is
forwarded verbatim to the default upstream — i.e. to
`api.anthropic.com/v1/openrouter/chat/completions` in production, which fails.

So an opencode user who follows the README has their OpenRouter and zen
traffic misrouted and broken.

## Options (pick one)

1. **Implement the routing** (feature). Add provider entries (or a
   gateway-prefix rule) that match `/v1/openrouter/*` and `/v1/zen/*`, strip the
   prefix, and forward to the right upstream (openrouter.ai; the zen/opencode
   endpoint), honoring new `TAMP_UPSTREAM_OPENROUTER` / `TAMP_UPSTREAM_ZEN`.
   Compression would treat them as openai-compatible chat bodies.
2. **Fix the docs** to match current behavior — remove the openrouter/zen base
   URL lines (and the "adapter table routes each provider" claim), or mark them
   as not-yet-supported.

Until one lands, the opencode openrouter/zen instructions should be treated as
non-functional.

## Scope guard

Anthropic/OpenAI/Gemini/Kimi/Moonshot/ChatGPT routing all work and are
unaffected. This gap is specific to the openrouter/zen base URLs added in the
v0.8.6 multi-provider docs.
