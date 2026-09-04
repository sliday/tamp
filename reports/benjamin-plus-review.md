# Benjamin-Plus in Tamp — review

Date: 2026-08-19
Subject: JetBrains/benjamin-plus-skill (MIT, ~745 injected tokens)
Method: 17-agent fan-out (recon / design / adversarial verify / synthesize), then hand verification of every load-bearing claim.

---

## Verdict

**Do not ship it as a proxy-side injection. Ship the two bugs it exposed.**

Benjamin-plus is a real result, honestly reported. It is also the wrong thing to bolt onto a compression proxy right now, for one measured reason and one structural one.

---

## What Benjamin-Plus is

Five behaviours, 2996 bytes, ~505 words:

1. Recon in one pass. Chain probes with `;`, sample two examples of a convention, not one.
2. Look through a keyhole. Inspection commands end in `| head -50`, `grep -m 20`, Read with offset/limit. Ingestion is exempt.
3. Probe the environment once. One `python3 -c "import x, y, z"`, install everything missing together.
4. Green means the task's own check. Exit zero. Environmental failure is still your failure. Same check failing twice means wrong approach.
5. Polling is a step. Wait 30s+, never 1s, never send empty input to peek.

Measured: −17.9% cost median, 80 paired SkillsBench tasks, quality flat (sign test p=0.77, 7 better / 5 worse / 68 ties). Cross-platform check on Java SWE-bench + Codex CLI: −4.4% cost [−7.5, −1.5], p=0.003, tool calls −20%, solve rate unchanged.

Their own null result matters most: shipped as a **discoverable skill folder** it measured **−0.5%, not significant**, because agents burned steps locating SKILL.md. Injection is the entire mechanism.

---

## Why it fits Tamp on paper

Orthogonal axes. Tamp shrinks bytes per tool result. Benjamin shrinks the count of tool results. Tamp already sits in the request path, so it injects by construction and skips the discovery tax that killed the skill-folder variant.

---

## Why it does not fit in practice

### 1. The payload poisons Tamp's own classifier (verified by execution)

```
detectTaskType(payload)  = 'dangerous'
isDangerousTask(payload) = true
```

`isDangerousTask` gates two lossy stages, both `return 0`:

- `compress.js:136` — disclosure (tool_result bodies ≥ 32 KB → br-cache + 3-tier summary)
- `compress.js:168` — bm25-trim (bodies > 64 KB → BM25 line ranking against user intent)

`providers.js:53` (`getLastUserTextFromAnthropicMessages`) walks **backward** past tool_result-only messages to find human text. On the normal agentic loop it reaches whatever was appended. Turning Benjamin on disables disclosure and bm25-trim for the whole session.

The feature partially disables the product.

### 2. Tamp cannot measure the benefit

```
grep -n "usage\|input_tokens\|cache_read_input_tokens" compress.js index.js stats.js providers.js
→ no matches
```

Zero billed-token parsing anywhere. `stats.js:80-83` derives `$X saved` from request-side character deltas at a flat `$3/Mtok` fallback.

Worse, the sign is inverted. Benjamin Rule 2 makes the agent read 50 lines instead of 500. Smaller blocks mean less for Tamp to compress. **Enabling Benjamin makes Tamp's headline number fall while the actual bill falls.** Every signal shown to the user argues for turning it off.

### 3. Prompt cache risk on the maximalist design

Claude Code caches a large system prefix. Relocating `cache_control` onto an appended system block, on a wire shape this repo has never captured (`cache_control` appears once in the tree, `PRD.md:105`, zero fixtures), risks swallowing per-turn content into the cached prefix. Roughly +$0.069/request at Sonnet pricing.

A trailing push into the last user message avoids this by construction, because it lands after every breakpoint. `appendToLastUserMessageAnthropic` (`providers.js:73`) is already that primitive. But it feeds the classifier directly, which is failure mode 1.

### 4. Product honesty

Tamp is a compression proxy. Silently re-instructing someone's agent is a different promise. Three of the fan-out's own adversarial lenses flagged the design as prompt-injection-shaped, and one recon agent was blocked outright by a safety classifier for the same reason. The flags are correct in kind even though the intent here is benign and the upstream is public MIT. A user who discovers their agent was re-instructed by a tool sold as byte compression has a fair complaint.

---

## The bigger find: a live bug, independent of Benjamin

`lib/rules-generator.js:26` holds unanchored alternations:

```js
/test|spec|coverage/i
/debug|investigate|diagnose|troubleshoot/i
/memory leak|performance|optimization|optimize/i
/security|vulnerability|exploit|attack/i
```

Substring matching on ordinary English. Measured:

| Prompt | Classified |
|---|---|
| `make the button specific to mobile` | DANGEROUS (`spec`ific) |
| `inspect the response headers` | DANGEROUS (in`spec`t) |
| `use the latest version of react` | DANGEROUS (la`test`) |
| `add a contest banner` | DANGEROUS (con`test`) |
| `fix the attack surface` | DANGEROUS |
| `update the specification doc` | DANGEROUS |
| `add a trailing comma` | complex ✓ |
| `the design is fine, just change the color` | complex ✓ |

`latest` and `specific` are among the most common words in coding prompts. Any one of them silently disables disclosure and bm25-trim for the session.

Severity: **costs money, does not corrupt output.** The failure is conservative, which is why it survived. Test coverage exists at `test/rules-generator.test.js` and does not catch it.

Fix: anchor on word boundaries.

```js
/\btests?\b|\bspecs?\b|\bcoverage\b/i
/\bdebug\w*\b|\binvestigat\w*\b|\bdiagnos\w*\b|\btroubleshoot\w*\b/i
```

Note the `^refactor|^architecture|^design` entry is already anchored and behaves correctly. The unanchored four are the outliers.

---

## Second find: `ensure-claude-md.sh` says the wrong filename

`plugin/hooks/ensure-claude-md.sh:7` writes `CLAUDE.local.md`. Lines 2, 25, 29, 32 all report "CLAUDE.md" to the user. Three user-facing messages and the file header, all naming a file the script never touches.

Also, `:24` greps only `MARKER_START`. `MARKER_END` is written into the block but never read, so there is no update path and no uninstall path. Content appended once cannot be revised or removed by the hook.

---

## Recommended order of work

| # | Change | File:line | Effort |
|---|---|---|---|
| 1 | Anchor the four unanchored dangerous patterns; add false-positive cases to the test | `lib/rules-generator.js:20-28`, `test/rules-generator.test.js` | 1h |
| 2 | Fix the filename lie; grep `MARKER_END` for update/uninstall | `plugin/hooks/ensure-claude-md.sh:2,7,24-32` | 1h |
| 3 | Usage tee. Passive `.on('data')` SSE scanner beside the pipe; read `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` from `message_start`, `output_tokens` from `message_delta` | `index.js:150` | 8h |
| 4 | Drive the dollar line from real billed deltas instead of char deltas at a flat rate | `stats.js:80-83` | 3h |

Steps 3 and 4 are the precondition for evaluating Benjamin, or any future behavioural feature, on real traffic. Without them every claim is borrowed from someone else's benchmark, model, and agent.

---

## If Benjamin ships later

Only after step 3 lands.

- Flag `TAMP_BEHAVIOR=benjamin`, **default off**. Uppercase so it survives the systemd `EnvironmentFile` path (`bin/tamp.js:298`). Add a commented line to `CONFIG_TEMPLATE` (`config.js:262`), because the macOS LaunchAgent passes no environment (`bin/tamp.js:240`).
- Resolve in its own block after `config.js:204`, mirroring `outputMode`. Do not touch `LEVEL_ALIASES` (`metadata.js:177`) or `COMPRESSION_PRESETS` (`metadata.js:117`). Behaviour is not a compression stage.
- Wrap the payload in a sentinel and teach `providers.js:53` to skip marked blocks, or failure mode 1 fires every session.
- Claude Code only at first. `injectOutputHint` is wired across six providers (`providers.js:235,318,369,389,437,543`), which makes the fan-out tempting. JetBrains measured −17.9% on Claude Code and −4.4% on Codex. Exporting a Claude-measured effect to five untested surfaces buys five untested regressions.
- MIT attribution: `LICENSE-THIRD-PARTY.md`, verbatim copyright line plus the permission paragraph.
- Disclosure, not silence. If the proxy modifies the prompt, `tamp status` says so and the startup banner says so.

## Measurement, cheapest honest version

**Safety check first, one week.** With the tee, compute per session `cacheReadShare = cache_read / (cache_read + cache_creation + input)`. One week flag on, one week off. **Kill if cacheReadShare drops more than 2 points.**

**Effect test.** 40 paired tasks, order alternated, Wilcoxon signed-rank on billed cost. **Kill below 5% median reduction, or if the 95% CI includes zero.**

Be honest about power. At n=40 against a true −10% effect the test fails most of the time. n=40 detects roughly 15% or larger. Set the threshold there or do not pre-register a gate.

---

## What not to do

**Do not `cat injected-instruction.md >> CLAUDE.local.md` in the hook.** Two lines of bash, no proxy risk, feels free. It appends once with no update path, poisons the classifier permanently on disk, and writes into the user's repo where you never see which arm they are in.

**Do not ship it across all six providers at once.**

**Do not report savings from JetBrains' benchmark as Tamp's own.** The `llmlingua` section of the README ("that guard fires on 92% of text blocks, which is the honest measure") is the most valuable paragraph in the project. Borrowing numbers spends it.
