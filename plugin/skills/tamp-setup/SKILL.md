---
name: tamp-setup
description: Use when the user asks to "set up tamp", "configure tamp proxy", "install tamp", "start tamp", "tamp not working", or troubleshoot tamp token compression proxy issues.
---

# Tamp Setup & Troubleshooting

Tamp is a token compression proxy that sits between coding agents and the API. It compresses tool_result blocks to reduce input tokens by ~52%.

## Quick Setup

```bash
# Install
npm i -g @sliday/tamp

# Create config file
tamp init

# Start (interactive)
tamp

# Start (non-interactive, for scripts/services)
tamp -y
```

## Point Your Agent at Tamp

```bash
# Claude Code
export ANTHROPIC_BASE_URL=http://localhost:7778

# Aider/Cursor/Cline
export OPENAI_API_BASE=http://localhost:7778
```

Add the export to your shell profile (`~/.zshrc`, `~/.bashrc`) for persistence.

## Run as Service (Linux)

```bash
tamp init              # create config
tamp install-service   # systemd user service
tamp status            # verify
```

## Config File

Location: `~/.config/tamp/config`

Format: KEY=VALUE (same as env vars). Env vars override config file.

Key settings:
- `TAMP_UPSTREAM` — set this for Claude Max or custom API endpoints
- `TAMP_STAGES` — comma-separated list of compression stages
- `TAMP_CACHE_SAFE=true` — only compress newest block (preserves prompt cache)

## Common Issues

### "Model not found" with Claude Max
Set `TAMP_UPSTREAM` to your Claude Max API endpoint in config file or env var.

### LLMLingua not available
Install `uv`: `curl -LsSf https://astral.sh/uv/install.sh | sh`
Or skip it: set `TAMP_STAGES=minify,toon,strip-lines,whitespace,dedup,diff,prune`

### Tamp not compressing
Check health: `curl http://localhost:7778/health`
Verify `ANTHROPIC_BASE_URL=http://localhost:7778` is set.

## CLI Commands

| Command | Description |
|---------|-------------|
| `tamp` | Start with interactive stage picker |
| `tamp -y` | Start non-interactive (use defaults/config) |
| `tamp init` | Create config file |
| `tamp status` | Check if running |
| `tamp install-service` | Install systemd service (Linux) |
| `tamp uninstall-service` | Remove service |
| `tamp help` | Show help |
