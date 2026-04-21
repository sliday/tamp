# Agent Compatibility Runbook

Explicit-config probe at `http://127.0.0.1:7877`. Start it with `npm run compat:probe` (or via `run.mjs`). Then run the agent steps below in another terminal.

Verdict rule: if `curl http://127.0.0.1:7877/_probe/log` returns `[]`, the agent bypassed the config (subscription hijack or ignored env). Any entry == intercepted.

BYOK fake key used everywhere: `sk-test-0000000000000000`.

---

## Claude Code

### BYOK
```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:7877 \
ANTHROPIC_API_KEY=sk-test-0000000000000000 \
claude 'reply OK'
```
Expect: probe log shows `POST /v1/messages`, `auth_type: "sk-*"`.

### Subscription (Pro/Max)
Not coverable by explicit config — Claude Code ignores `ANTHROPIC_BASE_URL` when OAuth session is active. Log out first (`claude /logout`), rerun BYOK block. Document bypass as "subscription path hits api.anthropic.com directly".

---

## Codex CLI

### BYOK
`~/.codex/config.toml`:
```toml
model = "gpt-4o-mini"
model_provider = "tamp"

[model_providers.tamp]
name = "tamp-probe"
base_url = "http://127.0.0.1:7877/v1"
wire_api = "responses"
```
Run:
```sh
OPENAI_API_KEY=sk-test-0000000000000000 codex exec 'reply OK'
```
Expect: `POST /v1/responses`, `auth_type: "sk-*"`.

### ChatGPT OAuth (Plus/Pro)
Keep config above, unset key:
```sh
unset OPENAI_API_KEY
codex login   # complete browser OAuth
codex exec 'reply OK'
```
Expect: `auth_type: "jwt"` and `chatgpt_account_id` header set. If log empty, Codex bypassed `base_url` for ChatGPT tier.

---

## Cursor

### BYOK (custom OpenAI base)
Settings (Cmd+,): search "OpenAI Base URL", set to `http://127.0.0.1:7877/v1`. API key: `sk-test-0000000000000000`. Override model name to something non-cursor like `gpt-4o-mini`.
Trigger a chat message. Expect `POST /v1/chat/completions`.

### Cursor Pro subscription models
Pick model `auto`, `cursor-small`, or `sonnet` (bundled). Send a chat message.
Expect: probe log **empty** — Cursor routes via `api2.cursor.sh` regardless of custom base URL. This is the documented bypass case.

---

## Cline (VS Code)

### BYOK
In Cline settings: Provider = "OpenAI Compatible". Base URL = `http://127.0.0.1:7877/v1`. API Key = `sk-test-0000000000000000`. Model ID = `gpt-4o-mini`.
Send a chat message. Expect `POST /v1/chat/completions`.

---

## opencode

### BYOK (per-provider baseURL — NOT env var)
`~/.config/opencode/opencode.json`:
```json
{
  "provider": {
    "openai": {
      "options": { "baseURL": "http://127.0.0.1:7877/v1", "apiKey": "sk-test-0000000000000000" }
    }
  }
}
```
Run:
```sh
opencode run 'reply OK'
```
Expect `POST /v1/chat/completions`.

### Zen / Anthropic-subscription
```json
{
  "provider": {
    "opencode": {
      "options": { "baseURL": "http://127.0.0.1:7877/v1" }
    }
  }
}
```
Run after `opencode auth login`. If opencode respects the per-provider baseURL, probe sees the OAuth-bearer request; if not, log empty.

---

## Kimi CLI

### Kimi Code (Moonshot-hosted)
Edit `~/.kimi/config.toml`:
```toml
[provider]
name = "moonshot"
base_url = "http://127.0.0.1:7877/v1"
api_key = "sk-test-0000000000000000"
```
Run:
```sh
kimi 'reply OK'
```
Expect `POST /v1/chat/completions`.

### Moonshot key branch
Same config block, set `api_key` to a Moonshot-style key. Behavior should match BYOK.

---

## Aider

### BYOK
```sh
aider --openai-api-base http://127.0.0.1:7877/v1 \
      --openai-api-key sk-test-0000000000000000 \
      --model gpt-4o-mini \
      --message 'reply OK' --yes --no-git
```
Expect `POST /v1/chat/completions`.

---

## Probe inspection cheatsheet

```sh
curl -s http://127.0.0.1:7877/_probe/log | jq .
curl -sX POST http://127.0.0.1:7877/_probe/reset
```

## Verdict file

`run.mjs --agent X --mode Y` writes `test/compat/results/X-Y.json`:
```json
{ "intercepted": true, "entryCount": 1, "firstEntry": {...}, "verdict": "intercepted", "notes": "..." }
```
