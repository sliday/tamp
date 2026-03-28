#!/bin/bash
# Ensure Tamp proxy is running on session start.

PORT="${TAMP_PORT:-7778}"
HEALTH_URL="http://localhost:${PORT}/health"

msg() {
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"$1\"}}"
}

# Already running? Done.
if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
  VERSION=$(curl -sf "$HEALTH_URL" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
  msg "Tamp v${VERSION} running on :${PORT}. Token compression active."
  exit 0
fi

# Port taken by something else?
if lsof -i ":${PORT}" > /dev/null 2>&1; then
  msg "Port ${PORT} in use by another process. Run 'lsof -i :${PORT}' to check."
  exit 0
fi

# Tamp installed?
if ! command -v tamp > /dev/null 2>&1; then
  msg "Tamp not installed. Run: npm i -g @sliday/tamp"
  exit 0
fi

# Start tamp
nohup tamp -y > /dev/null 2>&1 &

# Wait for health (max 8 seconds)
for i in $(seq 1 80); do
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    VERSION=$(curl -sf "$HEALTH_URL" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
    msg "Tamp v${VERSION} auto-started on :${PORT}. Token compression active."
    exit 0
  fi
  sleep 0.1
done

msg "Tamp installed but failed to start within 8s. Run 'tamp -y' manually to diagnose."
exit 0
