#!/bin/bash
# Ensure Tamp proxy is running on session start.
# If ANTHROPIC_BASE_URL points to localhost:7778, start tamp if needed.

PORT="${TAMP_PORT:-7778}"
HEALTH_URL="http://localhost:${PORT}/health"

# Check if tamp is already healthy
if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
  VERSION=$(curl -sf "$HEALTH_URL" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"Tamp v${VERSION} is running on port ${PORT}. Token compression is active.\"}}"
  exit 0
fi

# Check if tamp command exists
if ! command -v tamp > /dev/null 2>&1 && ! command -v npx > /dev/null 2>&1; then
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"Tamp is not installed. Install with: npm i -g @sliday/tamp\"}}"
  exit 0
fi

# Start tamp in background
if command -v tamp > /dev/null 2>&1; then
  nohup tamp -y > /dev/null 2>&1 &
else
  nohup npx @sliday/tamp -y > /dev/null 2>&1 &
fi

# Wait for health (max 5 seconds)
for i in $(seq 1 50); do
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    VERSION=$(curl -sf "$HEALTH_URL" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
    echo "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"Tamp v${VERSION} auto-started on port ${PORT}. Token compression is active. Set ANTHROPIC_BASE_URL=http://localhost:${PORT} to use.\"}}"
    exit 0
  fi
  sleep 0.1
done

echo "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"Tamp failed to start within 5 seconds. Run 'tamp -y' manually to diagnose.\"}}"
exit 0
