# Maintainer note: `isDangerousTask` serves two callers with opposite needs

Status: open design observation. Found during continuous-improvement review.
No code changed — needs a tuning call. Severity: low–moderate, phrasing-dependent.

## The dual use

`detectTaskType` / `isDangerousTask` (`lib/rules-generator.js`) classifies the
latest human message, and the result drives **two** different decisions:

1. **Output verbosity rules** (`compress.js:576`, `generateOutputRules`) — tells
   the model how terse to be. Here a *false positive* (calling a simple task
   "dangerous") wastes output tokens by keeping the model verbose. Wants high
   precision → anchored patterns are correct.

2. **Lossy input-stage bypass** (`discloseTargets` / `bm25TrimTargets`,
   `compress.js:127,159`) — skips `disclosure` and `bm25-trim` so a large
   `tool_result` is forwarded in full. Here a *false negative* (missing a real
   dangerous task) silently drops/trims context the task needs. Wants high
   recall → broad patterns are safer.

The same predicate can't be optimal for both. Today it is tuned for (1).

## Where this bites

`DANGEROUS_TASK_PATTERNS` mixes unanchored entries (`security`, `debug`,
`performance`, `test` — match anywhere) with anchored ones (`^refactor`,
`^architecture`, `^design`, `^fix\s+bug`, `^explain`, `^why`, `^how`).

The anchored entries only fire when the phrase starts the message. So:

- `"refactor the auth module"` → dangerous (bypasses lossy). 
- `"Can you refactor the auth module?"` → **complex**, not dangerous → a ≥32 KB
  `tool_result` for that turn is eligible for `disclosure`/`bm25-trim`.

The high-stakes cases (security/debug/perf/test) are unanchored and unaffected.
`bm25-trim` also keeps the top BM25-ranked lines (degraded, not dropped), and
`disclosure` leaves a rehydratable summary. So this is a fidelity *softening*,
not a hard data loss — but it is a silent one, against Tamp's promise.

## Options (pick one)

1. **Split the predicate** — keep anchored patterns for verbosity, add a
   broader `mayNeedFullFidelity()` (unanchored refactor/explain/design/review)
   for the lossy bypass only. Most surgical; preserves output-token savings.
2. **Unanchor a few verbs** in `DANGEROUS_TASK_PATTERNS` and accept slightly
   more verbose output on tasks that merely mention them.
3. **Leave as-is** — accept that non-leading refactor/explain phrasing may be
   lossy-compressed; document it as expected behavior.

## Scope guard

`disclosure` and `bm25-trim` are aggressive-only (level 9 / explicit
`TAMP_STAGES`). Default (L5) users never hit the lossy path, so default
fidelity is unaffected. No code changed for this note.
