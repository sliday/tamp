#!/usr/bin/env python3
"""PreToolUse hook — blocks dangerous shell commands before execution.

Why: https://harn.app/kb/safety.html — "Tools should be hard to misuse"
Docs: https://harn.app/kb/safety.html — "Mitigating Prompt Injection Attacks"
"""
import sys
import json
import re

def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.exit(0)

    if not isinstance(payload, dict):
        sys.exit(0)

    if payload.get("tool_name") != "Bash":
        sys.exit(0)

    command = payload.get("parameters", {}).get("command", "")

    dangerous = [
        r"rm\s+-r[fF]",
        r"git\s+push\s+.*main",
        r"git\s+push\s+.*master",
        r"chmod\s+777",
        r">\s*~/",
        r"curl\s+.*\|\s*(?:sudo\s+)?(?:bash|sh)",
        r"sudo\s+rm",
        r"mkfs\.",
        r"dd\s+if=",
    ]

    for pattern in dangerous:
        try:
            if re.search(pattern, command):
                print(f"HARNESS BLOCK: Matches prohibited pattern ({pattern}).", file=sys.stderr)
                print("Find a safer alternative.", file=sys.stderr)
                sys.exit(2)
        except re.error:
            print(f"HARNESS WARNING: Invalid pattern skipped: {pattern}", file=sys.stderr)
            continue

    sys.exit(0)

if __name__ == "__main__":
    main()
