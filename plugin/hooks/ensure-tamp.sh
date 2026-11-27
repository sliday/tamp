#!/bin/bash
# Ensure Tamp proxy is running on session start.

msg() {
  MSG="$1" awk '
    BEGIN {
      for (k = 1; k < 32; k++) {
        ctrl[sprintf("%c", k)] = sprintf("\\u%04x", k)
      }
      ctrl["\b"] = "\\b"
      ctrl["\f"] = "\\f"
      ctrl["\n"] = "\\n"
      ctrl["\r"] = "\\r"
      ctrl["\t"] = "\\t"

      s = ENVIRON["MSG"]
      out = ""
      n = length(s)
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (c == "\\") out = out "\\\\"
        else if (c == "\"") out = out "\\\""
        else if (c in ctrl) out = out ctrl[c]
        else out = out c
      }
      printf "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"%s\"}}\n", out
    }
  '
}

read_config_port() {
  local cfg="$1"
  [ -n "$cfg" ] && [ -f "$cfg" ] && [ -r "$cfg" ] || return 0
  awk -v sq="'" '
    {
      line = $0
      sub(/\r$/, "", line)
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+$/, "", line)
      if (line == "" || substr(line, 1, 1) == "#") next
      eq = index(line, "=")
      if (eq < 2) next
      key = substr(line, 1, eq - 1)
      sub(/[[:space:]]+$/, "", key)
      if (key != "TAMP_PORT") next
      val = substr(line, eq + 1)
      sub(/^[[:space:]]+/, "", val)
      sub(/[[:space:]]+$/, "", val)
      len = length(val)
      if (len >= 2) {
        first = substr(val, 1, 1)
        last = substr(val, len, 1)
        if ((first == "\"" && last == "\"") || (first == sq && last == sq)) {
          val = substr(val, 2, len - 2)
        }
      }
      found = 1
      result = val
    }
    END {
      if (found) printf "%s", result
    }
  ' "$cfg" 2>/dev/null || true
}

validate_port() {
  local raw="$1"
  local prefix
  local num
  case "$raw" in
    ''|*[!0123456789]*)
      printf '%s' "7778"
      return 0
      ;;
  esac
  prefix="${raw%%[!0]*}"
  num="${raw#"$prefix"}"
  if [ -z "$num" ] || [ "${#num}" -gt 5 ]; then
    printf '%s' "7778"
    return 0
  fi
  if [ "$num" -ge 1 ] && [ "$num" -le 65535 ]; then
    printf '%s' "$num"
  else
    printf '%s' "7778"
  fi
}

extract_version() {
  printf '%s' "$1" | awk '
    { buf = (NR == 1 ? $0 : buf "\n" $0) }
    END {
      if (!match(buf, /"version"[[:space:]]*:[[:space:]]*"/)) exit 0
      s = substr(buf, RSTART + RLENGTH)
      out = ""
      i = 1
      n = length(s)
      while (i <= n) {
        c = substr(s, i, 1)
        if (c == "\"") break
        if (c == "\\" && i < n) {
          i++
          esc = substr(s, i, 1)
          if (esc == "\"" || esc == "\\" || esc == "/") out = out esc
          else if (esc == "n") out = out "\n"
          else if (esc == "r") out = out "\r"
          else if (esc == "t") out = out "\t"
          else if (esc == "b") out = out "\b"
          else if (esc == "f") out = out "\f"
          else out = out "\\" esc
        } else {
          out = out c
        }
        i++
      }
      printf "%s", out
    }
  '
}

if [ -n "${TAMP_PORT:-}" ]; then
  RAW_PORT="$TAMP_PORT"
else
  CONFIG_FILE="${TAMP_CONFIG:-${HOME:-}/.config/tamp/config}"
  RAW_PORT="$(read_config_port "$CONFIG_FILE")"
fi
PORT="$(validate_port "$RAW_PORT")"
HEALTH_URL="http://127.0.0.1:${PORT}/health"

# Already running? Done.
if HEALTH_BODY="$(curl -sf --max-time 2 "$HEALTH_URL" 2>/dev/null)"; then
  VERSION="$(extract_version "$HEALTH_BODY")"
  if [ -n "$VERSION" ]; then
    msg "Tamp v${VERSION} running on :${PORT}. Token compression active."
  else
    msg "Tamp running on :${PORT}. Token compression active."
  fi
  exit 0
fi

# Port taken by a listening TCP process?
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  msg "Port ${PORT} in use by another process. Run 'lsof -nP -iTCP:${PORT} -sTCP:LISTEN' to check."
  exit 0
fi

# Tamp installed?
if ! command -v tamp >/dev/null 2>&1; then
  msg "Tamp not installed. Run: npm i -g @sliday/tamp@latest"
  exit 0
fi

# Start tamp
nohup tamp -y </dev/null >/dev/null 2>&1 &

# Wait for health (max 8 seconds wall clock)
SECONDS=0
while [ "$SECONDS" -lt 8 ]; do
  if HEALTH_BODY="$(curl -sf --max-time 2 "$HEALTH_URL" 2>/dev/null)"; then
    VERSION="$(extract_version "$HEALTH_BODY")"
    if [ -n "$VERSION" ]; then
      msg "Tamp v${VERSION} auto-started on :${PORT}. Token compression active."
    else
      msg "Tamp auto-started on :${PORT}. Token compression active."
    fi
    exit 0
  fi
  sleep 0.1
done

msg "Tamp installed but failed to start within 8s. Run 'tamp -y' manually to diagnose."
exit 0
