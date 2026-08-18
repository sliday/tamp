# FTUE audit: wiring Tamp as the default proxy for three agents

Measured 2026-08-18 by actually doing it on a clean-ish machine: Claude Code,
Codex CLI, and Kimi Code, each pointed at `localhost:7778`. Six things went
wrong. Four are fixed, one is a documented limitation, one needs a product
decision.

## 1. LLMLingua corrupts tool output (fixed: guard)

`llmlingua` ships in `DEFAULT_STAGES`, so `tamp -y` turns it on. It is a prose
compressor. Fed ordinary command output at the default rate of 0.7 it returned:

| Before | After |
|--------|-------|
| `/Users/stas/Library/LaunchAgents/dev.tamp.proxy.plist` | `/Users/stas/Library/LaunchAgents.. proxy.` |
| `/Users/stas/.config/tamp/tamp.err.log` | `/Users/stas./tamp..` |
| `launchctl bootout gui/501/dev.tamp.proxy` | `launchctl bootout gui/501/dev..` |
| `"version":"0.8.17"` | `"version""0.. 17"` |
| `tail -f` | (dropped) |

Found by watching a live Claude Code session render garbage, then reproduced
offline against the sidecar. An agent handed that output cannot open the file,
cannot parse the JSON, and will invent the missing characters.

`compress.js` now routes text through `hasVerbatimCriticalContent()` first and
skips the sidecar for anything carrying paths, URLs, JSON separators, hex ids,
or semver. Guarded by `test/llmlingua-verbatim-guard.test.js`.

**Open decision.** That guard fires on **92% of text blocks >200 chars in
`bench/fixtures.js`** (22 of 24). On coding-agent traffic `llmlingua` therefore
buys almost nothing while carrying all of this risk. Making it opt-in would move
the advertised balanced-preset savings, so it is left in the default and flagged
here rather than changed unilaterally. `TODOS.md` already lists `llmlingua` as a
lossy stage with no quality gate; this is the evidence for that entry.

## 2. `TAMP_STAGES` in the config file did nothing (fixed)

`bin/tamp.js` read `TAMP_STAGES` from `process.env` only. On the `-y` path, when
the variable was unset, it overwrote it with `DEFAULT_STAGES` before `loadConfig`
ever looked at `~/.config/tamp/config`. So the documented file knob was inert on
the exact path every install script uses; only an env var worked. It now reads
the config file as a fallback.

## 3. No way to keep Tamp running on macOS (fixed)

`tamp install-service` was Linux-only. That is fine while Tamp is a thing you
start in a terminal, and wrong the moment you put `ANTHROPIC_BASE_URL` in
`~/.claude/settings.json`, because Claude Code then fails completely whenever
Tamp is down. `install-service` now writes a launchd agent
(`dev.tamp.proxy`, `RunAtLoad` + `KeepAlive`) on macOS.

## 4. Kimi Code cannot be proxied without re-login (documented)

Pointing `[providers."managed:kimi-code"].base_url` at Tamp broke a live session
immediately:

```
No token for "kimi-code-env-92f579c50dab5f50". Run /login to authenticate.
```

Kimi derives its credential key from the provider environment, and `base_url` is
part of it. Changing the URL orphans the stored OAuth token, and every running
agent, including background ones, fails at once. Restoring the URL restores the
token. Users must run `/login` after the edit, or leave Kimi unproxied.

Nothing in the README or on the site warned about this.

## 5. The published Kimi instructions were wrong (fixed)

The landing page told users to edit `~/.kimi/config.toml` (real path:
`~/.kimi-code/config.toml`), under `[providers.kimi-for-coding]` (real table:
`[providers."managed:kimi-code"]`), and to mount Moonshot at
`http://localhost:7778/v1/moonshot`, which returns **404**. Probed against a
running proxy:

| Path | Status |
|---|---|
| `/coding/v1/chat/completions` | 401 (routes) |
| `/kimi/coding/v1/chat/completions` | 401 (routes) |
| `/moonshot/v1/chat/completions` | 401 (routes) |
| `/v1/moonshot/chat/completions` | **404** |

401 is the expected answer for a deliberately invalid token; it proves the
request reached the upstream.

## 6. A stale global install shadowed every update

`npm config get prefix` pointed at `~/.hermes/node`, which is not on `PATH`.
`PATH` resolved `tamp` from an nvm bin instead, so `npm install -g` had been
updating a copy nobody ran: the command on `PATH` was **v0.8.0** while the repo
was at v0.8.16. Not a Tamp bug, but it is the kind of thing that makes a tool
look broken, so the README now shows how to check.

## Still open

- `/v1/models?client_version=…` returns `401 Invalid bearer token` through the
  proxy on the Codex subscription path. Cosmetic; sessions work.
- Codex 0.146 retries its WebSocket five times regardless of the status Tamp
  returns. `responses_websockets = false` does not suppress it.
