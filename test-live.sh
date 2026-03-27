#!/bin/bash
# Live tests for tamp proxy with real Claude Code.
# Usage: ANTHROPIC_BASE_URL=http://localhost:7778 ./test-live.sh
#
# Start proxy first:
#   TAMP_STAGES=minify,toon,llmlingua TAMP_LLMLINGUA_URL=http://127.0.0.1:7779 node ./bin/tamp.js -y
#
# Watch proxy stderr for compression stats.

set -euo pipefail
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-http://localhost:7778}"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

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
  "Use the Read tool to read ${ROOT_DIR}/package.json and tell me the project name and version."

run "Read JSON file (sample fixtures)" \
  "Use the Read tool to read ${ROOT_DIR}/test/fixtures/sample-messages.json and count how many test scenarios it contains. Just the number."

# --- Code file reads (should trigger text -> llmlingua if enabled) ---
run "Read JS source (compress.js)" \
  "Use the Read tool to read ${ROOT_DIR}/compress.js and list all exported functions."

run "Read Python source (sidecar)" \
  "Use the Read tool to read ${ROOT_DIR}/sidecar/server.py and tell me what model it loads."

# --- Bash output (text content) ---
run "Bash ls output" \
  "Run ls -la ${ROOT_DIR}/ and tell me how many files and directories are at the top level."

run "Bash multi-line output" \
  "Run cat ${ROOT_DIR}/config.js and tell me what the default port is."

# --- Multi-tool turn (Read + follow-up) ---
run "Multi-tool chain" \
  "Read ${ROOT_DIR}/detect.js, then run node -e \"console.log('hello')\" and tell me if both succeeded."

# --- Large-ish output (grep results) ---
run "Grep-like output" \
  "Run grep -n 'function' ${ROOT_DIR}/compress.js and count how many functions are defined."

# --- Edge: tiny file ---
run "Tiny file" \
  "Read ${ROOT_DIR}/.gitignore and tell me what it ignores."

# --- Edge: non-existent file ---
run "Error handling" \
  "Try to read ${ROOT_DIR}/does-not-exist.js and tell me what error you get."

echo ""
echo "=== Done: $N tests ==="
echo "Check proxy terminal for compression stats."
