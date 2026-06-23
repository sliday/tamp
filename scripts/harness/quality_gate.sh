#!/usr/bin/env bash
# Stop hook — quality gate. Blocks agent from completing if code is broken.
# Why: https://harn.app/kb/safety.html — "Quality checks in the loop"
# Pattern: https://harn.app/kb/evals.html — "Infrastructure noise moves benchmarks"
set -euo pipefail

# Check dependencies
command -v jq &>/dev/null || { echo "Harn: jq not found, quality gate skipped" >&2; exit 0; }

PAYLOAD=$(cat /dev/stdin)
IS_ACTIVE=$(echo "$PAYLOAD" | jq -r '.stop_hook_active // false' 2>/dev/null || echo "false")

# CRITICAL: Break infinite loops
if [ "$IS_ACTIVE" = "true" ]; then
  exit 0
fi

# Session-aware temp file (prevents race conditions)
LOG_FILE="${TMPDIR:-/tmp}/harn_gate_${PPID}_$$.log"

echo "Harn: Running quality gate..." >&2

# Detect stack and run checker (fail-closed: block if checker missing)
if [ -f "tsconfig.json" ]; then
  command -v npx &>/dev/null || {
    echo "QUALITY GATE BLOCKED: TypeScript detected but 'npx' not found." >&2
    echo "Install Node.js or remove tsconfig.json to skip." >&2
    exit 2
  }
  npx tsc --noEmit > "$LOG_FILE" 2>&1 || {
    echo "QUALITY GATE FAILED — TypeScript errors:" >&2
    cat "$LOG_FILE" >&2
    exit 2
  }
elif [ -f "package.json" ] && jq -e '.scripts.test' package.json &>/dev/null; then
  command -v npm &>/dev/null || {
    echo "QUALITY GATE BLOCKED: package.json test script found but 'npm' not found." >&2
    exit 2
  }
  npm test > "$LOG_FILE" 2>&1 || {
    echo "QUALITY GATE FAILED — test suite errors:" >&2
    cat "$LOG_FILE" >&2
    exit 2
  }
elif [ -f "Cargo.toml" ]; then
  command -v cargo &>/dev/null || {
    echo "QUALITY GATE BLOCKED: Rust detected but 'cargo' not found." >&2
    exit 2
  }
  cargo check > "$LOG_FILE" 2>&1 || {
    echo "QUALITY GATE FAILED — Rust errors:" >&2
    cat "$LOG_FILE" >&2
    exit 2
  }
elif [ -f "go.mod" ]; then
  command -v go &>/dev/null || {
    echo "QUALITY GATE BLOCKED: Go detected but 'go' not found." >&2
    exit 2
  }
  go vet ./... > "$LOG_FILE" 2>&1 || {
    echo "QUALITY GATE FAILED — Go errors:" >&2
    cat "$LOG_FILE" >&2
    exit 2
  }
elif [ -f "pyproject.toml" ] && command -v mypy &>/dev/null; then
  mypy . > "$LOG_FILE" 2>&1 || {
    echo "QUALITY GATE FAILED — Python type errors:" >&2
    cat "$LOG_FILE" >&2
    exit 2
  }
fi

# Clean up temp file
rm -f "$LOG_FILE"

echo "Harn: Quality gate passed." >&2
exit 0
