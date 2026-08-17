# Eval: Codex CLI on a ChatGPT subscription (v0.8.17)

Measured 2026-08-17 against `codex-cli 0.146.0`, ChatGPT Plus/Pro OAuth, macOS,
tamp on `localhost:7778`. Every number below comes from a live `codex exec` run
through the proxy, read off `GET /health`.

## What was broken

Before v0.8.17 the subscription path did not work at all, in two independent ways.

**1. Routing returned 404.** `resolveOpenAIUpstream` prefixed `/backend-api/codex`
onto the incoming path verbatim, so `/v1/responses` became
`/backend-api/codex/v1/responses`. The ChatGPT codex backend is unversioned and
answers that with `404 {"detail":"Not Found"}`. Codex retried, then died. The old
unit test asserted the broken path, so the suite stayed green.

**2. Extraction matched nothing.** With routing fixed, a 55 KB `cat data.json`
tool result produced `blocksCompressed: 0`. Codex 0.146 emits
`custom_tool_call_output` for freeform tools and carries `output` as an array of
`input_text` parts:

```json
{ "type": "custom_tool_call_output", "call_id": "…",
  "output": [ { "type": "input_text", "text": "Script completed…" },
              { "type": "input_text", "text": "{\"users\": […]}" } ] }
```

`extractOpenAIResponsesTargets` required `typeof item.output === 'string'` and
matched only `function_call_output`, so it returned zero targets on every Codex
turn. Tamp forwarded a byte-for-byte copy and reported success.

Captured by proxying Codex through a sniffer that zstd-decodes the request body.
Codex 0.146 sends `content-encoding: zstd`; tamp already handles that, so it was
not the cause.

## What it saves now

| Run | Requests | Blocks | Tokens saved | Chars saved / original |
|---|---|---|---|---|
| single `cat` of a 55 KB JSON file | 6 | 1 | 620 | 3,497 / 8,106 (43.1%) |
| `ls -la` + `cat … head -100` + `jq length` | 14 | 3 | 2,431 | 8,720 / 26,058 (33.5%) |

Answers were correct in both runs. Codex truncates large command output before it
reaches tamp, which caps the win on any single block.

## Transport caveat

Codex 0.146 opens `ws://<base>/responses` before falling back to HTTPS. Tamp
proxies HTTP only. Forwarding the upgrade upstream earned a Cloudflare 503 and
five retries; tamp now answers `501` locally, which removes the round trip.

Codex retries five times regardless of status, so the log noise stays. Setting
`responses_websockets = false` under `[features]` does not suppress it (tested).
Wall clock is unaffected: 43s with tamp, 43s native, on the same prompt.

## Regression guards

- `test/chatgpt-routing.test.js` — asserts `/v1/responses` maps to
  `/backend-api/codex/responses` and that non-`/v1` prefixes survive.
- `test/providers.test.js` — four cases covering `custom_tool_call_output`,
  content-array extraction, write-back into `output[j].text`, and the
  `cacheSafe` walk-back across both item types.

Both would have caught the shipped bugs. Neither existed before.

## Open

`/v1/models?client_version=…` returns `401 Invalid bearer token` through the
proxy. Cosmetic — it only fails Codex's model-list refresh, and sessions run
fine. Not yet compared against a native baseline.

See also [notes-toon-vs-tsv-pipe.md](notes-toon-vs-tsv-pipe.md) for the encoder
comparison measured in the same session.
