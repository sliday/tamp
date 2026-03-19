#!/bin/bash
# Live tests for tamp proxy with real Claude Code.
# Usage: ANTHROPIC_BASE_URL=http://localhost:7778 ./test-live.sh
#
# Start proxy first:
#   TOONA_STAGES=minify,toon,llmlingua TOONA_LLMLINGUA_URL=http://127.0.0.1:7779 node index.js
#
# Watch proxy stderr for compression stats.

set -e
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-http://localhost:7778}"

GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
RESET='\033[0m'
N=0

run() {
  N=$((N + 1))
  local label="$1"; shift
  echo -e "\n${CYAN}[$N] $label${RESET}"
  echo -e "${YELLOW}Prompt: $1${RESET}"
  local out
  out=$(claude -p "$1" 2>&1)
  echo -e "${GREEN}Response:${RESET} $(echo "$out" | head -5)"
  echo "---"
}

echo "=== tamp live test suite ==="
echo "Proxy: $ANTHROPIC_BASE_URL"
echo ""

# --- JSON file reads (should trigger json-lined -> minify/toon) ---
run "Read JSON file (package.json)" \
  "Use the Read tool to read /Users/stas/Playground/tamp/package.json and tell me the project name and version."

run "Read JSON file (sample fixtures)" \
  "Use the Read tool to read /Users/stas/Playground/tamp/test/fixtures/sample-messages.json and count how many test scenarios it contains. Just the number."

# --- Code file reads (should trigger text -> llmlingua if enabled) ---
run "Read JS source (compress.js)" \
  "Use the Read tool to read /Users/stas/Playground/tamp/compress.js and list all exported functions."

run "Read Python source (sidecar)" \
  "Use the Read tool to read /Users/stas/Playground/tamp/sidecar/server.py and tell me what model it loads."

# --- Bash output (text content) ---
run "Bash ls output" \
  "Run ls -la /Users/stas/Playground/tamp/ and tell me how many files and directories are at the top level."

run "Bash multi-line output" \
  "Run cat /Users/stas/Playground/tamp/config.js and tell me what the default port is."

# --- Multi-tool turn (Read + follow-up) ---
run "Multi-tool chain" \
  "Read /Users/stas/Playground/tamp/detect.js, then run node -e \"console.log('hello')\" and tell me if both succeeded."

# --- Large-ish output (grep results) ---
run "Grep-like output" \
  "Run grep -n 'function' /Users/stas/Playground/tamp/compress.js and count how many functions are defined."

# --- Edge: tiny file ---
run "Tiny file" \
  "Read /Users/stas/Playground/tamp/.gitignore and tell me what it ignores."

# --- Edge: non-existent file ---
run "Error handling" \
  "Try to read /Users/stas/Playground/tamp/does-not-exist.js and tell me what error you get."

echo ""
echo "=== Done: $N tests ==="
echo "Check proxy terminal for compression stats."
