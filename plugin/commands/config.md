---
description: Show or edit Tamp configuration file (~/.config/tamp/config)
argument-hint: [show|edit|init]
allowed-tools: Bash, Read, Edit
---

Manage the Tamp config file at `~/.config/tamp/config`.

Actions:
- `show` (default): Read and display the current config file
- `edit`: Open the config for modification based on user's request
- `init`: Run `tamp init` to create the config file if it doesn't exist

Available config variables:
- `TAMP_PORT` (default: 7778) — proxy listen port
- `TAMP_UPSTREAM` (default: https://api.anthropic.com) — upstream API
- `TAMP_UPSTREAM_OPENAI` — upstream for OpenAI-format requests
- `TAMP_UPSTREAM_GEMINI` — upstream for Gemini-format requests
- `TAMP_STAGES` — comma-separated compression stages
- `TAMP_MIN_SIZE` (default: 200) — minimum content size for compression
- `TAMP_LOG` (default: true) — enable request logging
- `TAMP_LOG_FILE` — append logs to file
- `TAMP_MAX_BODY` (default: 10485760) — max body size before passthrough
- `TAMP_CACHE_SAFE` (default: true) — only compress newest block for cache stability

$ARGUMENTS
