# Maintainer note: `tamp stop` can signal a PID-reused unrelated process

Status: open safety consideration. Found during continuous-improvement review.
No code changed — the fix has a UX trade-off that needs a maintainer call.
Severity: low frequency, but the worst case is SIGKILLing an innocent process.

## The gap

`tamp stop` (bin/tamp.js) flow when a PID file exists:

1. `reconcileStalePidFile(port)` — clears the PID file **only if** `isProcessAlive(pid)`
   is false.
2. `readPidFile(port)` → `{ pid, startedAt }`.
3. `process.kill(pid, 'SIGTERM')`, wait up to 2s, then `process.kill(pid, 'SIGKILL')`.

The only liveness gate is `process.kill(pid, 0)` (signal 0). That proves *a*
process with that PID exists — not that it is **tamp**.

If tamp dies uncleanly (crash, OOM-kill, `kill -9`) the shutdown handler never
runs, so the PID file is left behind. If the OS later recycles that PID for an
unrelated process, `reconcileStalePidFile` sees it "alive", keeps the file, and
`tamp stop` sends SIGTERM → SIGKILL to **that unrelated process**.

The `if (!rec)` branch already health-checks the port before advising a manual
kill; the `rec`-exists branch does not verify identity before killing.

## Why it's not trivially fixable

A pure health-gate ("only kill if `checkPort(port)` confirms tamp on the port")
would refuse to stop a tamp that is alive but whose `/health` endpoint is hung —
exactly when the user most wants `tamp stop` to work. So health alone can't tell
"reused PID (not tamp)" from "hung tamp".

## Options (pick one)

1. **Health-gate with explicit fallback** — if `checkPort(port)` fails but the PID
   is alive, do NOT auto-SIGKILL; print the pid and `lsof -ti:PORT | xargs kill`
   guidance and exit non-zero. Safe; costs auto-kill of a hung tamp.
2. **Verify process start time** — compare the PID file's `startedAt` against the
   process's real start time (`ps -p PID -o lstart=` on macOS/Linux). A mismatch
   means reuse → refuse. Robust but platform-specific shell-out.
3. **Verify identity via /proc or ps cmdline** — confirm the PID's command line
   mentions tamp before killing. Platform-specific.
4. **Accept and document** — note in the CLI help that a stale PID file after an
   unclean exit can, in the rare PID-reuse case, target the wrong process.

## Scope guard

Requires all of: unclean tamp exit (stale PID file) + OS PID recycling back to
tamp's old PID + user runs `tamp stop`. `startedAt` is already recorded in the
PID file (lifecycle.js `writePidFile`), so option 2 needs no new on-disk state.
No code changed for this note.
