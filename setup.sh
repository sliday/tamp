#!/usr/bin/env bash
set -euo pipefail

PORT="${TAMP_PORT:-7778}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
warn() { echo -e "  ${YELLOW}→${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1"; }
step() { echo -e "\n  ${CYAN}${BOLD}$1${RESET}"; }

echo ""
echo -e "  ${CYAN}${BOLD}┌─────────────────────────────────┐${RESET}"
echo -e "  ${CYAN}│${RESET}       ${BOLD}  Tamp Setup  ${RESET}           ${CYAN}│${RESET}"
echo -e "  ${CYAN}│${RESET}  ${DIM}Token compression for agents${RESET}   ${CYAN}│${RESET}"
echo -e "  ${CYAN}${BOLD}└─────────────────────────────────┘${RESET}"

# --- Check node ---
step "Checking dependencies"
command -v node >/dev/null 2>&1 || { fail "node is required. Install from https://nodejs.org"; exit 1; }
ok "node $(node --version)"

# --- Install via npm ---
step "Installing Tamp"
if command -v tamp >/dev/null 2>&1; then
  CURRENT=$(tamp --version 2>/dev/null || echo "unknown")
  warn "Tamp already installed (${DIM}${CURRENT}${RESET}), updating..."
  npm install -g @sliday/tamp@latest --silent 2>/dev/null
  ok "Updated"
else
  npm install -g @sliday/tamp --silent 2>/dev/null
  ok "Installed @sliday/tamp"
fi

# --- Shell configuration ---
SHELL_NAME=$(basename "${SHELL:-/bin/sh}")
case "$SHELL_NAME" in
  zsh)  PROFILE="$HOME/.zshrc" ;;
  bash) PROFILE="${HOME}/.bash_profile"; [ -f "$PROFILE" ] || PROFILE="$HOME/.bashrc" ;;
  fish) PROFILE="$HOME/.config/fish/config.fish" ;;
  *)    PROFILE="$HOME/.profile" ;;
esac

step "Shell configuration ($(basename "$PROFILE"))"

add_var() {
  local name="$1" value="$2" comment="$3"
  local line="export ${name}=${value}"
  [ "$SHELL_NAME" = "fish" ] && line="set -gx ${name} ${value}"

  if [ -f "$PROFILE" ] && grep -qF "$name" "$PROFILE" 2>/dev/null; then
    ok "${name} already set"
  else
    echo "" >> "$PROFILE"
    echo "# Tamp — ${comment}" >> "$PROFILE"
    echo "$line" >> "$PROFILE"
    ok "Added ${name} ${DIM}(${comment})${RESET}"
  fi
}

add_var "ANTHROPIC_BASE_URL" "http://localhost:$PORT" "Claude Code"
add_var "OPENAI_API_BASE" "http://localhost:$PORT/v1" "Aider, Cursor, Cline"

# --- Done ---
echo ""
echo -e "  ${GREEN}${BOLD}┌─────────────────────────────────────────────────────────┐${RESET}"
echo -e "  ${GREEN}${BOLD}│${RESET}  ${GREEN}✓ Done!${RESET} Restart your shell, then:                      ${GREEN}${BOLD}│${RESET}"
echo -e "  ${GREEN}${BOLD}│${RESET}                                                         ${GREEN}${BOLD}│${RESET}"
echo -e "  ${GREEN}${BOLD}│${RESET}  ${CYAN}${BOLD}tamp${RESET}                 ${DIM}# start proxy (interactive)${RESET}       ${GREEN}${BOLD}│${RESET}"
echo -e "  ${GREEN}${BOLD}│${RESET}  ${CYAN}${BOLD}tamp -y${RESET}              ${DIM}# start proxy (non-interactive)${RESET}   ${GREEN}${BOLD}│${RESET}"
echo -e "  ${GREEN}${BOLD}│${RESET}                                                         ${GREEN}${BOLD}│${RESET}"
echo -e "  ${GREEN}${BOLD}│${RESET}  ${BOLD}Claude Code plugin:${RESET} auto-starts Tamp; still requires   ${GREEN}${BOLD}│${RESET}"
echo -e "  ${GREEN}${BOLD}│${RESET}  ANTHROPIC_BASE_URL in ~/.claude/settings.json          ${GREEN}${BOLD}│${RESET}"
echo -e "  ${GREEN}${BOLD}│${RESET}  ${DIM}claude plugin marketplace add sliday/claude-plugins${RESET}    ${GREEN}${BOLD}│${RESET}"
echo -e "  ${GREEN}${BOLD}│${RESET}  ${DIM}claude plugin install tamp@sliday${RESET}                      ${GREEN}${BOLD}│${RESET}"
echo -e "  ${GREEN}${BOLD}└─────────────────────────────────────────────────────────┘${RESET}"
echo ""
