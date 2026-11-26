# Agent North Star

You are operating within a harnessed environment. Write maintainable, reliable code within architectural boundaries.

## System of Record

- Stack: Node.js (ESM, plain JavaScript — no TypeScript)
- Entry points: `index.js` (proxy server), `bin/tamp.js` (CLI), `compress.js` (stage pipeline)
- Tests: `npm test` (`node --test test/*.test.js`), plus `node smoke.js`

## Constraints

- Never push to main — create `feat/` or `fix/` branches and open a PR
- New compression stages register in `metadata.js` and dispatch in `compress.js` — keep the 1–9 level ladder prefix-preserving
- Secrets must never leave the machine: stages that call out (`llmlingua`, `textpress`) run after any redaction, never before
- Keep diffs minimal — no unrelated reformatting or comment churn

## Harness Hooks Active

- **PreToolUse**: Security guard blocks dangerous shell commands
- **PostToolUse**: Trace logger appends tool calls to `.claude/agent-trace.jsonl`
- **Stop**: Quality gate runs `npm test` before completion

## Workflow

1. Understand → Read code, check LEARNED.md for gotchas
2. Plan → Break task into steps
3. Implement → Write code within constraints
4. Verify → Run quality gate (`npm test`) before finishing
5. Document → Update LEARNED.md if something was tricky

## Context Budget

- Keep this file under 60 lines — load skills on demand
- Delegate research to sub-agents — only summaries return
- After 30+ tool calls, compact and checkpoint

## Escape Hatches

- Quality gate stuck? Stop hook checks `stop_hook_active` — a retry lets you through
- Security guard wrong? Report the false positive, use an alternative command
- Same error 3 times? Stop and ask the human

<!-- repo-task-proof-loop:start -->
## Repo task proof loop

For substantial features, refactors, and bug fixes, use the repo-task-proof-loop workflow.

Required artifact path:
- Keep all task artifacts in `.agent/tasks/<TASK_ID>/` inside this repository.

Required sequence:
1. Freeze `.agent/tasks/<TASK_ID>/spec.md` before implementation.
2. Implement against explicit acceptance criteria (`AC1`, `AC2`, ...).
3. Create `evidence.md`, `evidence.json`, and raw artifacts.
4. Run a fresh verification pass against the current codebase and rerun checks.
5. If verification is not `PASS`, write `problems.md`, apply the smallest safe fix, and reverify.

Hard rules:
- Do not claim completion unless every acceptance criterion is `PASS`.
- Verifiers judge current code and current command results, not prior chat claims.
- Fixers should make the smallest defensible diff.

Installed workflow agents:
- `.codex/agents/task-spec-freezer.toml`
- `.codex/agents/task-builder.toml`
- `.codex/agents/task-verifier.toml`
- `.codex/agents/task-fixer.toml`
<!-- repo-task-proof-loop:end -->
