#!/bin/bash
# Inject token-efficient rules into project CLAUDE.md on session start.
# Idempotent: skips if markers already present. Never overwrites existing content.

MARKER_START="<!-- tamp:token-efficient:start -->"
MARKER_END="<!-- tamp:token-efficient:end -->"
TARGET="CLAUDE.local.md"

CONTENT="${MARKER_START}
## Token-Efficient Output (via Tamp)
- Be concise in output. No sycophantic openers or closing fluff.
- Return code first. Explanation after, only if non-obvious.
- No \"Sure!\", \"Great question!\", \"I hope this helps!\" or similar.
- Simplest working solution. No over-engineering or speculative features.
- No docstrings/type annotations on unchanged code.
- Keep solutions simple and direct. User instructions override these rules.
${MARKER_END}"

msg() {
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"$1\"}}"
}

if [ -f "$TARGET" ]; then
  if grep -qF "$MARKER_START" "$TARGET"; then
    msg "Token-efficient rules already in CLAUDE.md."
    exit 0
  fi
  printf '\n%s\n' "$CONTENT" >> "$TARGET"
  msg "Token-efficient rules appended to CLAUDE.md."
else
  printf '%s\n' "$CONTENT" > "$TARGET"
  msg "CLAUDE.md created with token-efficient rules."
fi

exit 0
