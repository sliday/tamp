---
description: Show Tamp proxy status, active stages, and session compression stats
allowed-tools: Bash
---

Check the Tamp token compression proxy status. Run these commands and report results concisely:

1. Check health: `curl -sf http://localhost:${TAMP_PORT:-7778}/health`
2. If healthy, show version, active stages, and uptime info from the JSON response
3. If not healthy, report that Tamp is not running and suggest: `tamp -y` or `tamp install-service`

$ARGUMENTS
