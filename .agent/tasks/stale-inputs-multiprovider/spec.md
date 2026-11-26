# Task Spec: stale-inputs-multiprovider

## Metadata
- Task ID: stale-inputs-multiprovider
- Status: FROZEN
- Created: 2026-11-26T23:33:42+00:00
- Repo root: /Users/stas/Playground/tamp
- Working directory at init: /Users/stas/Playground/tamp

## Guidance sources
- AGENTS.md
- CLAUDE.md
- LEARNED.md

## Original task statement
Fix T-04 (RICE #1, score 7.9): Multi-provider stale-inputs pruning. 1) Extend lib/stale-inputs.js to prune bulky payloads from older tool calls across Anthropic (messages[].content[] tool_use), OpenAI Chat / Kimi / Moonshot (messages[].tool_calls[] with JSON arguments), and OpenAI Responses / Codex CLI (input[] function_call with JSON arguments and custom_tool_call with raw string or JSON input, e.g. Codex apply_patch). 2) Preserve call shape/headers (file paths, patch file headers like *** Update/Add/Delete File:, command heads) and never touch AskUserQuestion or malformed JSON arguments. 3) Group contiguous OpenAI Responses tool-call items into turns and enforce keepRecent + batchSize epoch batching identically across all providers for prompt-cache prefix stability. 4) Support common coding-agent tool aliases (Write/write_file/write_to_file/create_file, Edit/edit_file/replace_file_content, Bash/shell/exec_command/run_command/execute_command, apply_patch, NotebookEdit, Agent, Workflow, SendMessage). 5) Update compress.js so stale-inputs runs for anthropic, openai, openai-responses, kimi, and moonshot (not just anthropic). 6) Add deterministic unit and compressRequest integration tests in test/stale-inputs.test.js covering all providers, epoch batching, malformed JSON safety, protected tools, and Codex apply_patch header retention.

## Acceptance criteria

- **AC1 (Anthropic parity preserved):** Existing Anthropic (`body.messages[]` assistant `content[]` `tool_use`) behavior is 100% preserved — same default thresholds (`DEFAULT_KEEP_RECENT = 2`, `DEFAULT_BATCH_SIZE = 1`, `LIMIT = { words: 128, chars: 1024 }`, `BASH_LIMIT = 1024`, `BASH_HEAD = 512`), same exact recovery notices (`RECOVERY_FILE`, `RECOVERY_OMITTED`) and truncation notice format (`[tamp: command truncated, <N> chars total]`), same `AskUserQuestion` exemption, same per-call `pruned` counter, and all existing tests in `test/stale-inputs.test.js` continue to pass unchanged.
- **AC2 (OpenAI Chat / Kimi / Moonshot `tool_calls[]` support):** `pruneStaleInputs(body, { keepRecent, batchSize })` recognizes assistant messages in `body.messages[]` with non-empty `Array.isArray(msg.tool_calls)` as call turns. For each tool call in evicted turns:
  - Safely parses `tc.function.arguments` via `JSON.parse` inside `try/catch`; silently skips non-string, malformed JSON, null, primitive, or array values without throwing or mutating `tc.function.arguments`.
  - Only re-serializes `tc.function.arguments = JSON.stringify(parsed)` when at least one field was actually pruned; unpruned calls (small payloads, unknown tools, protected tools) keep their exact original `arguments` string byte-for-byte.
  - Preserves all non-pruned header fields (e.g., `file_path`, `path`, `filePath`, `filename`, line numbers, flags).
- **AC3 (OpenAI Responses / Codex CLI `input[]` support & contiguous turn grouping):** `pruneStaleInputs(body, { keepRecent, batchSize })` recognizes `body.input[]` items of type `function_call` and `custom_tool_call`:
  - Groups contiguous runs of `function_call` / `custom_tool_call` items into a single call turn (any non-tool-call item such as `function_call_output`, `custom_tool_call_output`, `message`, or `reasoning` ends the run), matching `findLatestContiguousGroup` semantics in `providers.js`. Parallel tool calls in the same turn are never split by `keepRecent` or `batchSize`.
  - For `function_call`: safely parses `item.arguments` as a JSON object (skip silently on non-string, malformed JSON, or non-object), prunes matching fields, and only overwrites `item.arguments = JSON.stringify(parsed)` when modified.
  - For `custom_tool_call`: supports plain JSON object `item.input`, JSON-object string `item.input` (re-serialized only if modified), and raw freeform string `item.input` (for `apply_patch` and shell-family tools; unknown freeform strings are left untouched).
- **AC4 (Codex `apply_patch` header retention):** Pruning `apply_patch` (whether via `custom_tool_call.input` raw string, or JSON object `patch` / `input` field in `tool_use` / `tool_calls` / `function_call` / `custom_tool_call`):
  - Skips payloads where `tooSmall(text)` is true (`words <= 128 && length <= 1024`).
  - Extracts and preserves all Codex file-operation header lines matching `/^\*\*\*\s+(?:Update File|Add File|Delete File|Move to):/` in their original order, followed by `\n` and `[tamp: patch body omitted from this older turn (<N> chars). Re-read the file if you need the current contents.]`.
  - If no such header lines are present, replaces the payload with the recovery notice alone.
- **AC5 (Explicit tool alias normalization & protected tool exemption):** Tool names are matched case-insensitively (`name.toLowerCase()`) against an explicit rule table across all supported providers:
  - Protected: `askuserquestion` (`AskUserQuestion`) is **never** pruned under any provider format (`tool_use`, `tool_calls`, `function_call`, `custom_tool_call`).
  - Write family (`write`, `write_file`, `write_to_file`, `create_file`): prunes `content` and/or `file_text` when `!tooSmall(val)` using label `'file contents'` and `RECOVERY_FILE`.
  - Edit family (`edit`, `edit_file`, `replace_file_content`):
    - If both `old_string` and `new_string` are strings: prunes both when `!tooSmall(`${old_string}\n${new_string}`)` using labels `'edit old_string'` / `'edit new_string'` and `RECOVERY_FILE`.
    - Else if both `old_str` and `new_str` are strings: prunes both when `!tooSmall(`${old_str}\n${new_str}`)` using labels `'edit old_str'` / `'edit new_str'` and `RECOVERY_FILE`.
    - Else if `replacement_content` is a string: if `target_content` is also a string, prunes both when `!tooSmall(`${target_content}\n${replacement_content}`)` using labels `'edit target_content'` / `'edit replacement_content'` and `RECOVERY_FILE`; otherwise prunes `replacement_content` when `!tooSmall(replacement_content)` using label `'edit replacement_content'` and `RECOVERY_FILE`.
  - Shell family (`bash`, `shell`, `exec_command`, `run_command`, `execute_command`, `local_shell`): for JSON objects, checks `command` then `cmd`; for raw `custom_tool_call` string, uses the raw string directly. Truncates only when `length > BASH_LIMIT` (1024) to `${text.slice(0, BASH_HEAD)}\n[tamp: command truncated, ${text.length} chars total]` (`BASH_HEAD = 512`).
  - Patch family (`apply_patch`): prunes raw string `custom_tool_call.input` or JSON object `patch` / `input` string fields per AC4.
  - Other Anthropic tools: `notebookedit` (`new_source`, `'notebook source'`, `RECOVERY_FILE`), `agent` (`prompt`, `'agent prompt'`, `RECOVERY_OMITTED`), `workflow` (`script`, `'workflow script'`, `RECOVERY_OMITTED`), `sendmessage` (`message`, `'inter-agent message'`, `RECOVERY_OMITTED`).
  - Unlisted tool names are never modified.
- **AC6 (Identical `keepRecent` + `batchSize` epoch batching across all providers):** For Anthropic, OpenAI Chat/Kimi/Moonshot, and OpenAI Responses, `eligible = callTurns.length - keepRecent`, `batch = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : DEFAULT_BATCH_SIZE`, `evictCount = Math.floor(eligible / batch) * batch`. When `evictCount <= 0`, nothing is mutated and `{ pruned: 0 }` is returned. Adding a new turn within the same epoch leaves the previously pruned prefix byte-identical.
- **AC7 (`compress.js` multi-provider dispatch & safe no-op for Gemini/unknown):** `compress.js` runs `stale-inputs` when `config.stages.includes('stale-inputs')` for `provider.name` in `{'anthropic', 'openai', 'openai-responses', 'kimi', 'moonshot'}` and returns `staleInputs: { pruned }` when `pruned > 0` (else `null`). `gemini` (and any unknown body shape such as `{ contents: [...] }`, `{}`, `null`) is not mutated and returns `staleInputs: null` / `{ pruned: 0 }`.
- **AC8 (Deterministic unit & integration test coverage):** `test/stale-inputs.test.js` contains deterministic unit tests (`pruneStaleInputs`) and `compressRequest` integration tests covering:
  - All supported providers (`anthropic`, `openai`, `openai-responses`, `kimi`, `moonshot`) plus `gemini` no-op.
  - All tool alias families (Write, Edit, Shell, Patch, NotebookEdit/Agent/Workflow/SendMessage) and unknown tools.
  - OpenAI Responses contiguous parallel tool-call grouping, `function_call`, and `custom_tool_call` (both raw string and JSON string/object).
  - Codex `apply_patch` multi-file header retention (`*** Update File:`, `*** Add File:`, `*** Delete File:`, `*** Move to:`) and small-patch skip.
  - Epoch batching (`keepRecent` + `batchSize`) prefix stability on OpenAI Chat and OpenAI Responses in addition to Anthropic.
  - Malformed JSON arguments safety (no throw, exact string preserved) and unpruned-call byte-for-byte preservation.
  - `AskUserQuestion` exemption across Anthropic, OpenAI Chat, and OpenAI Responses (`function_call` & `custom_tool_call`).

## Constraints
- Plain Node.js ESM JavaScript only (no TypeScript, no build step).
- Zero new external npm dependencies (`package.json` unchanged).
- Keep diffs minimal and scoped strictly to `lib/stale-inputs.js`, `compress.js`, and `test/stale-inputs.test.js`.
- Do not modify `metadata.js` or the 1–9 compression level ladder (`stale-inputs` remains an opt-in lossy extra stage).
- Do not modify `stale-images` behavior or provider guard in `compress.js`.
- Do not introduce non-deterministic values (timestamps, random IDs) in notices or tests.
- Never push to `main` (stay on task/feature branch conventions per `AGENTS.md`).

## Non-goals
- Adding Gemini (`body.contents[].parts[].functionCall`) stale-inputs pruning (explicitly out of scope; remains safe no-op).
- Extending `stale-images` to non-Anthropic providers.
- Changing default stages, presets, compression levels, or CLI flags.
- Adding redaction or neural stages to tool inputs.
- Modifying `providers.js` or `lib/path-extract.js`.

## Narrow ambiguity resolutions
1. **Mixed assistant message containing both `content[]` (`tool_use`) and `tool_calls[]`:** Count the message index once in `callTurns`, and when evicted, prune both its `content[]` `tool_use` blocks and its `tool_calls[]` entries.
2. **Body containing both `messages` and `input`:** Prefer `body.messages` if `Array.isArray(body?.messages)`, else `body.input` if `Array.isArray(body?.input)`. (No real provider sends both in one request.)
3. **JSON-string vs raw-string `custom_tool_call.input`:** If `typeof item.input === 'string'`, attempt `JSON.parse` only when the trimmed string starts with `'{'`; if parsing produces a non-null non-array object, treat it as JSON arguments (and only overwrite `item.input` if `pruneInput` returns `true`); otherwise treat it as a raw freeform string (`apply_patch` / shell family).
4. **Edit `old_string`/`new_string` when only one is present:** Preserve existing Anthropic rule — `old_string`/`new_string` and `old_str`/`new_str` require both sides to be strings and evaluate `tooSmall(`${oldStr}\n${newStr}`)` together.
5. **Shell tool with both `command` and `cmd`:** Check `command` first; if `typeof input.command === 'string'`, operate on `command` (even if short, do not fall through unless `command` is absent/non-string), else check `cmd`.
6. **Return value of `pruneStaleInputs`:** Always `{ pruned: <integer >= 0> }` counting individual pruned tool calls (not turns), matching existing Anthropic contract.

## Verification plan
- **Build:** N/A (plain Node.js ESM; syntax verified by executing tests).
- **Unit & Integration tests (targeted):** `node --test test/stale-inputs.test.js`
- **Full test suite & retrieval eval:** `npm test` (`node --test test/*.test.js && node bench/retrieval-eval.js`)
- **Smoke test:** `node smoke.js`
- **Diff & scope check:** `git status --short` and `git diff --stat` confirming only `lib/stale-inputs.js`, `compress.js`, `test/stale-inputs.test.js` (plus `.agent/tasks/stale-inputs-multiprovider/` artifacts) are modified, with no new dependencies.
