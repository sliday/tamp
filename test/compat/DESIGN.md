# Agent Compatibility Harness — Design

> **Simplified implementation** (2026-04-20): superseded the DNS-shim / CA-trust plan below with an **explicit-config-only** approach. The probe listens plain HTTP on `127.0.0.1:7877` and each agent is pointed at it via its own config/env knob. If the agent honors the knob, we log the request; if it silently bypasses (e.g. Cursor's `cursor-*` hijack, Claude Code OAuth session), the log stays empty. Binary outcome, no root, no certs, no hosts edits. See **`runbook.md`** for per-agent steps and **`run.mjs`** for the driver.

Goal: prove, per agent, whether tamp actually sits in the request path under both BYOK and subscription modes. Four outcomes: `intercepted`, `bypassed`, `failed`, `unknown`.

Directory layout (all new, zero new deps):

```
test/compat/
  DESIGN.md                 # this file
  probe-proxy.js            # ~70 LOC — standalone logger
  hosts-shim.sh             # ~40 LOC — /etc/hosts mutator (sudo)
  run.sh                    # ~80 LOC — orchestrator
  verdict.js                # ~60 LOC — reads probe log, emits JSON
  agents/
    codex.sh                # ~30 LOC each
    cursor.sh
    kimi.sh
    opencode.sh
    claude-code.sh
    cline.sh
    aider.sh
  fixtures/
    prompt.txt              # single-turn "reply OK" prompt
    fake-key.env            # sk-test-0000000000000000
  results/
    <agent>-<mode>.json
```

## 1. Probe proxy (`probe-proxy.js`, ~70 LOC)

Node `http`/`https` server on `127.0.0.1:7779` (configurable `PROBE_PORT`).

- Accepts both HTTP CONNECT (forward-proxy mode) and plain HTTP (reverse-proxy mode via hosts override + self-signed TLS terminator).
- For every request records one JSON line to `test/compat/results/probe.log`:
  `{ ts, method, path, hostHeader, authHeaderPresent, authPrefix, contentLength, sni, via }`
  - `via: "proxy"` if received through `HTTPS_PROXY`, `via: "dns"` if received through hosts override, `via: "tamp"` if `x-tamp-forward: 1` header set (tamp forwards with this header when chained).
- Returns a canned `200 {"choices":[{"message":{"content":"OK"}}]}` so agents don't hang.
- Exposes `GET /probe-log` on the plain-HTTP port returning ndjson tail.
- No compression, no body inspection — just headers. Self-signed cert generated once into `test/compat/.cert/`.

Tamp itself is patched (1-line) to add `x-tamp-forward: 1` when it proxies out, so the probe can attribute requests as "came through tamp" vs "came direct". If adding a header is undesirable, fall back to port-distinguishing (tamp → probe on 7779, direct → probe on 443 via hosts override).

## 2. Traffic-redirect side-channel

Three options; harness supports all, picks per-agent:

| Method | Pros | Cons | Use when |
|---|---|---|---|
| `HTTPS_PROXY=http://127.0.0.1:7779` | No root, per-process, clean teardown | Agents that use Node's `undici` or Rust `reqwest` may ignore env var; some pin TLS | BYOK testing, first attempt |
| `/etc/hosts` override `api.openai.com 127.0.0.1` + probe on 443 | Catches agents that ignore proxy env | Needs `sudo`, needs self-signed CA trust, global side-effect | Subscription mode where the client hardcodes upstream |
| Local DNS shim (dnsmasq in a Linux netns / `scutil` on macOS) | Scoped, no global hosts edit | Setup heavy, macOS needs root + `dscacheutil -flushcache` | CI on Linux |

Default harness picks **HTTPS_PROXY first**, falls back to **hosts override** if the first run produces zero probe entries AND the agent exited 0 (suggests bypass). `hosts-shim.sh` backs up `/etc/hosts`, appends, restores via trap.

Additional lever: point tamp's upstream (`TAMP_UPSTREAM`) at the probe, so any tamp-proxied request still reaches the probe with `x-tamp-forward: 1`. That lets us distinguish "tamp saw it and forwarded" from "agent bypassed tamp".

## 3. Per-agent runbook

All use `sk-test-0000000000000000` as BYOK key. Each `agents/<name>.sh` exports env, writes config, runs agent with `fixtures/prompt.txt`, 20 s timeout, exits with agent's code.

| Agent | BYOK knob | Subscription knob | Notes |
|---|---|---|---|
| Codex CLI | `OPENAI_API_KEY` + `OPENAI_BASE_URL=http://127.0.0.1:7778` | `codex login` (ChatGPT) — **human-only**, skip in CI | Rust `reqwest` respects `HTTPS_PROXY` |
| Cursor | Settings JSON: `cursor.general.customOpenAIBaseUrl` | Pro-bundled models (auto/sonnet) — **human-only**; Cursor routes via `api2.cursor.sh` | Headless Cursor not supported; drive via `cursor --cli` if available, else mark `requires-human` |
| Kimi (Moonshot) | `MOONSHOT_API_KEY`, `MOONSHOT_BASE_URL` | n/a (BYOK only) | Easy case |
| opencode | `~/.opencode/config.json` `providers.openai.baseURL` | Anthropic-subscription via `opencode auth login` — **human-only** | BYOK fully scriptable |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:7778`, `ANTHROPIC_API_KEY` | `claude /login` (Pro/Max) — **human-only** | Subscription path uses OAuth-bearer to `api.anthropic.com`; probe must terminate TLS |
| Cline (VS Code) | `cline.apiProvider=openai-compatible`, `cline.openAiBaseUrl` | n/a | Needs `code --extensionTestsPath` runner or manual |
| Aider | `--openai-api-base http://127.0.0.1:7778` `--openai-api-key sk-test-...` | n/a | Cleanest case |

## 4. Verdict rules (`verdict.js`)

Inputs: `probe.log`, tamp access log (`~/.tamp/access.log`), agent exit code.

```
if probe saw >=1 request with via=tamp           -> intercepted
elif probe saw >=1 request with via=dns|proxy    -> bypassed        (host = hostHeader)
elif agent exit != 0 AND probe empty AND tamp empty -> failed       (notes = last stderr line)
else                                              -> unknown
```

Emits `results/<agent>-<mode>.json`:
`{ intercepted, upstreamHost, bytesRequested, exitCode, notes, via, probeEntries }`.

## 5. CI caveat

GitHub Actions can run BYOK for: Kimi, Aider, opencode, Claude Code (BYOK), Codex (BYOK). Hosts override works inside Linux runners (root available). Matrix: `{agent} x {byok}`.

**Cannot run in CI** (require real logged-in session, marked `requires-human: true` and skipped): Cursor Pro, Codex ChatGPT Plus, Claude Code Max, opencode Anthropic-login. These get a manual checklist in `test/compat/HUMAN.md` (follow-up) and a local-only `run.sh --human` mode that prompts before each step.

## Open questions for review

1. ~~OK to patch tamp to emit `x-tamp-forward: 1`? Alternative: port-distinguish.~~ **Resolved by explicit-config approach — no tamp patching needed; the probe is the terminus.**
2. ~~`/etc/hosts` path needs `sudo` — acceptable for a local test harness, or prefer a user-space DNS shim only?~~ **Resolved — not needed. Explicit config avoids DNS entirely.**
3. ~~Self-signed CA trust: install into system keychain per-run, or require user to pre-trust `test/compat/.cert/ca.pem`?~~ **Resolved — not needed. Probe speaks plain HTTP on loopback; every tested agent accepts an `http://` base URL for its own config.**
