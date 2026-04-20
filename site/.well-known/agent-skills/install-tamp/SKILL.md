---
name: install-tamp
description: Install and run Tamp, a local token-compression proxy for coding agents (Claude Code, Codex CLI, Cursor, Cline, Aider). Cuts input+output tokens ~50% with zero code changes.
type: skill
version: 1
---

# Install Tamp

Tamp is a local HTTPS proxy that sits between your coding agent and the upstream LLM API, compressing request and response payloads. It works with any agent that honors `ANTHROPIC_BASE_URL` or a custom API base.

## One-line install

```bash
curl -fsSL https://tamp.dev/setup.sh | bash
```

The installer:
1. Installs the `tamp` npm binary.
2. Starts the proxy on `http://localhost:7778`.
3. Prints the environment variables to export.

## Point your agent at Tamp

```bash
export ANTHROPIC_BASE_URL="http://localhost:7778"
```

For other agents (Codex CLI, Cursor, Cline, Continue, Aider), see per-agent instructions: https://github.com/sliday/tamp#wire-it-up-in-30-seconds

## Verify it works

```bash
tamp --version
curl -s http://localhost:7778/health
```

## Tune the compression preset

```bash
export TAMP_COMPRESSION_PRESET=balanced   # conservative | balanced | aggressive
```

## References

- Source: https://github.com/sliday/tamp
- Whitepaper: https://tamp.dev/whitepaper-latest
- Benchmark: https://github.com/sliday/tamp/tree/main/bench
