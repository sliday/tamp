#!/bin/bash
# Inject token-efficient rules into the project's CLAUDE.local.md on session start.
# Idempotent: refreshes the block in place when it drifts, never touching content
# outside the markers. Remove it with --uninstall or TAMP_RULES=off.

MARKER_START="<!-- tamp:token-efficient:start -->"
MARKER_END="<!-- tamp:token-efficient:end -->"
TARGET="CLAUDE.local.md"
TMP="${TARGET}.tamp.tmp"

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

# Print $1 with the marked block and any trailing blank lines removed.
strip_block() {
  awk -v s="$MARKER_START" -v e="$MARKER_END" '
    index($0, s) { skip = 1 }
    !skip { buf[n++] = $0 }
    index($0, e) { skip = 0 }
    END {
      last = n
      while (last > 0 && buf[last - 1] ~ /^[[:space:]]*$/) last--
      for (i = 0; i < last; i++) print buf[i]
    }
  ' "$1"
}

# Print just the marked block from $1, so a drifted copy can be detected.
read_block() {
  awk -v s="$MARKER_START" -v e="$MARKER_END" '
    index($0, s) { keep = 1 }
    keep { print }
    index($0, e) { keep = 0 }
  ' "$1"
}

if [ "${1:-}" = "--uninstall" ] || [ "${TAMP_RULES:-}" = "off" ]; then
  if [ -f "$TARGET" ] && grep -qF "$MARKER_START" "$TARGET"; then
    strip_block "$TARGET" > "$TMP" && mv "$TMP" "$TARGET"
    if ! grep -q '[^[:space:]]' "$TARGET" 2>/dev/null; then rm -f "$TARGET"; fi
    msg "Token-efficient rules removed from ${TARGET}."
  else
    msg "Token-efficient rules not present in ${TARGET}."
  fi
  exit 0
fi

if [ -f "$TARGET" ]; then
  if grep -qF "$MARKER_START" "$TARGET"; then
    if [ "$(read_block "$TARGET")" = "$CONTENT" ]; then
      msg "Token-efficient rules already in ${TARGET}."
      exit 0
    fi
    strip_block "$TARGET" > "$TMP"
    if [ -s "$TMP" ]; then
      printf '\n%s\n' "$CONTENT" >> "$TMP"
    else
      printf '%s\n' "$CONTENT" > "$TMP"
    fi
    mv "$TMP" "$TARGET"
    msg "Token-efficient rules refreshed in ${TARGET}."
    exit 0
  fi
  printf '\n%s\n' "$CONTENT" >> "$TARGET"
  msg "Token-efficient rules appended to ${TARGET}."
else
  printf '%s\n' "$CONTENT" > "$TARGET"
  msg "${TARGET} created with token-efficient rules."
fi

exit 0
