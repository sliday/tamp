#!/usr/bin/env bash
# PostToolUse hook — logs tool calls to JSONL for debugging and analytics.
set -euo pipefail

TRACE_FILE=".claude/agent-trace.jsonl"
MAX_LINES=5000
KEEP_LINES=2500

# Ensure directory exists
mkdir -p "$(dirname "$TRACE_FILE")"

# Read payload from stdin
PAYLOAD=$(cat /dev/stdin 2>/dev/null || echo "{}")

# Extract tool_name and exit_code
TOOL_NAME=$(echo "$PAYLOAD" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")
EXIT_CODE=$(echo "$PAYLOAD" | jq -r '.exit_code // 0' 2>/dev/null || echo "0")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Append trace entry
echo "{\"ts\":\"$TIMESTAMP\",\"tool\":\"$TOOL_NAME\",\"exit\":$EXIT_CODE}" >> "$TRACE_FILE"

# Log rotation: keep last KEEP_LINES when exceeding MAX_LINES
if [ -f "$TRACE_FILE" ]; then
  LINE_COUNT=$(wc -l < "$TRACE_FILE" | tr -d ' ')
  if [ "$LINE_COUNT" -gt "$MAX_LINES" ]; then
    tail -n "$KEEP_LINES" "$TRACE_FILE" > "${TRACE_FILE}.tmp" && mv "${TRACE_FILE}.tmp" "$TRACE_FILE"
  fi
fi

exit 0
