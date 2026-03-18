#!/usr/bin/env bash
set -euo pipefail

# Tamp — Token Compression Proxy for Claude Code
# curl -fsSL https://raw.githubusercontent.com/sliday/tamp/main/setup.sh | bash

REPO="https://github.com/sliday/tamp.git"
DIR="${TAMP_DIR:-$HOME/.tamp}"
PORT="${TAMP_PORT:-7778}"

echo ""
echo "  ┌─────────────────────────────────┐"
echo "  │         Tamp Setup              │"
echo "  │  Token compression for Claude   │"
echo "  └─────────────────────────────────┘"
echo ""

# Check deps
command -v node >/dev/null 2>&1 || { echo "  Error: node is required. Install from https://nodejs.org"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "  Error: git is required."; exit 1; }

# Clone or update
if [ -d "$DIR" ]; then
  echo "  → Updating existing install in $DIR"
  cd "$DIR" && git pull --quiet
else
  echo "  → Installing to $DIR"
  git clone --quiet "$REPO" "$DIR"
fi

cd "$DIR"

# Install deps
echo "  → Installing dependencies"
npm install --silent 2>/dev/null

# Detect shell
SHELL_NAME=$(basename "${SHELL:-/bin/sh}")
case "$SHELL_NAME" in
  zsh)  PROFILE="$HOME/.zshrc" ;;
  bash)
    if [ -f "$HOME/.bash_profile" ]; then
      PROFILE="$HOME/.bash_profile"
    else
      PROFILE="$HOME/.bashrc"
    fi
    ;;
  fish) PROFILE="$HOME/.config/fish/config.fish" ;;
  *)    PROFILE="$HOME/.profile" ;;
esac

EXPORT_LINE="export ANTHROPIC_BASE_URL=http://localhost:$PORT"
if [ "$SHELL_NAME" = "fish" ]; then
  EXPORT_LINE="set -gx ANTHROPIC_BASE_URL http://localhost:$PORT"
fi

# Idempotent shell config update
if [ -f "$PROFILE" ] && grep -qF "ANTHROPIC_BASE_URL" "$PROFILE" 2>/dev/null; then
  echo "  → ANTHROPIC_BASE_URL already in $(basename "$PROFILE")"
else
  echo "" >> "$PROFILE"
  echo "# Tamp proxy" >> "$PROFILE"
  echo "$EXPORT_LINE" >> "$PROFILE"
  echo "  → Added ANTHROPIC_BASE_URL to $(basename "$PROFILE")"
fi

# Create convenience alias
ALIAS_LINE="alias tamp='cd $DIR && node index.js'"
if [ "$SHELL_NAME" = "fish" ]; then
  ALIAS_LINE="alias tamp 'cd $DIR; and node index.js'"
fi

if ! grep -qF "alias tamp" "$PROFILE" 2>/dev/null; then
  echo "$ALIAS_LINE" >> "$PROFILE"
  echo "  → Added 'tamp' alias to $(basename "$PROFILE")"
fi

echo ""
echo "  ✓ Done! Restart your shell, then:"
echo ""
echo "    tamp          # start the proxy"
echo "    claude        # use claude as normal"
echo ""
