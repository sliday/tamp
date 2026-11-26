# Evidence Bundle: stale-inputs-multiprovider

## Summary
- Overall status: PASS
- Last updated: 2026-11-26T23:41:00+00:00
- Branch: `feat/stale-inputs-multiprovider` (base commit `33ae649`)
- Changed files: `lib/stale-inputs.js`, `compress.js`, `test/stale-inputs.test.js`

## Acceptance criteria evidence

### AC1 — Anthropic parity preserved
- Status: PASS
- Proof:
  - `lib/stale-inputs.js` preserves exact thresholds (`DEFAULT_KEEP_RECENT = 2`, `DEFAULT_BATCH_SIZE = 1`, `LIMIT = { words: 128, chars: 1024 }`, `BASH_LIMIT = 1024`, `BASH_HEAD = 512`), exact recovery notices (`RECOVERY_FILE`, `RECOVERY_OMITTED`), command truncation notice format, `AskUserQuestion` exemption, and per-call `pruned` counter.
  - All 11 pre-existing Anthropic tests in `test/stale-inputs.test.js` remain unmodified and pass (`raw/test-unit.txt`).
- Gaps:
  - None.

### AC2 — OpenAI Chat / Kimi / Moonshot `tool_calls[]` support
- Status: PASS
- Proof:
  - `lib/stale-inputs.js` (`hasMessageToolCalls`, `pruneMessages`, `pruneJsonArgs`) recognizes assistant messages with non-empty `Array.isArray(msg.tool_calls)` as call turns, handles mixed `content[]` + `tool_calls[]` assistant messages as a single turn, parses `tc.function.arguments` safely inside `try/catch`, skips non-string / malformed / null / primitive / array values without throwing or mutating, preserves non-pruned header fields, and only writes `JSON.stringify(parsed)` when modified (keeping unpruned strings byte-for-byte identical).
  - Verified by unit and `compressRequest` integration tests for `openai`, `kimi`, and `moonshot` in `test/stale-inputs.test.js` (`raw/test-unit.txt`, `raw/test-integration.txt`).
- Gaps:
  - None.

### AC3 — OpenAI Responses / Codex CLI `input[]` support & contiguous turn grouping
- Status: PASS
- Proof:
  - `lib/stale-inputs.js` (`isResponsesToolCall`, `pruneResponsesInput`, `pruneCustomToolCall`, `pruneJsonArgs`, `pruneRawInput`) recognizes `function_call` and `custom_tool_call` items in `body.input[]`, groups contiguous runs into single turns (split by any non-tool-call item such as `function_call_output`, `custom_tool_call_output`, `message`, or `reasoning`), safely handles `function_call.arguments`, and supports plain object, JSON-object string (parsed only when trimmed string starts with `{`), and raw freeform string `custom_tool_call.input`.
  - Verified by `test/stale-inputs.test.js` Responses suite (`raw/test-unit.txt`, `raw/test-integration.txt`).
- Gaps:
  - None.

### AC4 — Codex `apply_patch` header retention
- Status: PASS
- Proof:
  - `lib/stale-inputs.js` (`PATCH_HEADER_RE`, `prunePatchText`, `pruneInput`, `pruneRawInput`) skips patches where `tooSmall(text)` is true, extracts and preserves all lines matching `/^\*\*\*\s+(?:Update File|Add File|Delete File|Move to):/` in original order followed by `\n[tamp: patch body omitted from this older turn (<N> chars). Re-read the file if you need the current contents.]`, and emits the notice alone when no header lines exist.
  - Verified across raw `custom_tool_call.input`, JSON-string `custom_tool_call.input`, `function_call.arguments`, and OpenAI `tool_calls` in `test/stale-inputs.test.js` (`raw/test-unit.txt`).
- Gaps:
  - None.

### AC5 — Explicit tool alias normalization & protected tool exemption
- Status: PASS
- Proof:
  - `lib/stale-inputs.js` normalizes tool names via `name.toLowerCase()` against explicit `PROTECTED_TOOLS`, `OMIT_FIELDS` (`Map`), `EDIT_TOOLS`, `SHELL_TOOLS`, and `apply_patch`:
    - `askuserquestion` protected across all provider formats (`tool_use`, `tool_calls`, `function_call`, `custom_tool_call`).
    - Write family (`write`, `write_file`, `write_to_file`, `create_file`) prunes `content` and/or `file_text`.
    - Edit family (`edit`, `edit_file`, `replace_file_content`) supports `old_string`/`new_string`, `old_str`/`new_str`, and `target_content`+`replacement_content` / `replacement_content`-only.
    - Shell family (`bash`, `shell`, `exec_command`, `run_command`, `execute_command`, `local_shell`) checks `command` then `cmd` (without falling through if `command` is a string) and handles raw strings in `custom_tool_call`.
    - Patch family (`apply_patch`) handles raw string and JSON `patch`/`input` fields.
    - Other tools (`notebookedit`, `agent`, `workflow`, `sendmessage`) preserve exact labels and recovery notices; unlisted tools and `Object.prototype` keys are never modified.
  - Verified by tool-alias and `AskUserQuestion` tests in `test/stale-inputs.test.js` (`raw/test-unit.txt`).
- Gaps:
  - None.

### AC6 — Identical `keepRecent` + `batchSize` epoch batching across all providers
- Status: PASS
- Proof:
  - `lib/stale-inputs.js` (`computeEvictCount`) uses the identical formula (`eligible = turnCount - keepRecent`, `batch = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : DEFAULT_BATCH_SIZE`, `evictCount = Math.floor(eligible / batch) * batch`) for both `pruneMessages` and `pruneResponsesInput`, returning `{ pruned: 0 }` with zero mutation when `evictCount <= 0`.
  - Prefix byte-stability within epochs verified on Anthropic, OpenAI Chat, and OpenAI Responses in `test/stale-inputs.test.js` (`raw/test-unit.txt`).
- Gaps:
  - None.

### AC7 — `compress.js` multi-provider dispatch & safe no-op for Gemini/unknown
- Status: PASS
- Proof:
  - `compress.js` defines `STALE_INPUTS_PROVIDERS = new Set(['anthropic', 'openai', 'openai-responses', 'kimi', 'moonshot'])` and dispatches `pruneStaleInputs` when `config.stages.includes('stale-inputs') && STALE_INPUTS_PROVIDERS.has(provider.name)`, returning `staleInputs: { pruned }` when `pruned > 0` else `null`. `stale-images` remains unchanged (`provider.name === 'anthropic'`).
  - Verified with `compressRequest` integration tests across `anthropic`, `openai`, `openai-responses`, `kimi`, `moonshot`, and `gemini` (safe no-op) plus `pruneStaleInputs` on `{ contents: [...] }`, `{}`, `null`, `undefined` (`raw/test-unit.txt`, `raw/test-integration.txt`).
- Gaps:
  - None.

### AC8 — Deterministic unit & integration test coverage
- Status: PASS
- Proof:
  - `test/stale-inputs.test.js` runs 25 deterministic tests across 6 suites covering all providers, tool alias families, contiguous Responses grouping, Codex `apply_patch` header retention, epoch batching prefix stability, malformed JSON safety, `AskUserQuestion` exemption, mixed turns, and `gemini`/unknown no-ops.
  - Full suite `npm test` passed 957/957 tests plus `bench/retrieval-eval.js` PASS, and `node smoke.js` passed all 6 proxy checks (`raw/test-unit.txt`, `raw/test-integration.txt`).
- Gaps:
  - None.

## Commands run
- `node -v` -> `v22.17.0`
- `node --check lib/stale-inputs.js` -> exit 0
- `node --check compress.js` -> exit 0
- `node --check test/stale-inputs.test.js` -> exit 0
- `node --test test/stale-inputs.test.js` -> exit 0 (25/25 pass, 6 suites)
- `npm test` -> exit 0 (957/957 pass, 217 suites; `bench/retrieval-eval.js` PASS)
- `node smoke.js` -> exit 0 (All checks passed!)
- `git status --short` & `git diff --stat` -> exit 0 (strictly 3 scoped files changed)

## Raw artifacts
- `.agent/tasks/stale-inputs-multiprovider/raw/build.txt`
- `.agent/tasks/stale-inputs-multiprovider/raw/lint.txt`
- `.agent/tasks/stale-inputs-multiprovider/raw/test-unit.txt`
- `.agent/tasks/stale-inputs-multiprovider/raw/test-integration.txt`

## Known gaps
- None.
