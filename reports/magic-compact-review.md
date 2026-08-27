# magic-compact → tamp: review, correction, and what shipped

Source: https://github.com/aerovato/magic-compact (v1.3.1)
License: **BSD-3-Clause** — borrowable with attribution.
Date: 2026-08-27

---

## 0. Correction notice

An earlier revision of this report ranked the opportunities using a token
estimate of `chars / 4` applied to every block, including base64 images. That
estimator is wrong for images by a factor of **112x**: Anthropic bills an image
by pixel area, roughly `(width x height) / 750`, not by base64 length. A
780x1688 screenshot costs ~1,756 tokens but carries ~145,000 base64 characters.

Measured on one real transcript:

| Accounting | Image cost |
|---|---:|
| `chars / 4` (wrong) | 23,878,039 "tokens" |
| `(w x h) / 750` (actual) | 211,802 tokens |

Everything downstream of that error moved. The corrected ranking inverts the
original: `tool_use.input` pruning, which the first draft ranked **last**, is
the largest addressable win. Image eviction, which the first draft called the
headline finding at "74% of all tokens", is worth ~9%. The corrected numbers
are in §2 and the measured outcome is in §5.

## 1. What magic-compact is

A Claude Code / OpenCode plugin. On `/magic-compact` it rewrites the session
transcript once: per-turn assistant summaries replace the built-in single-blob
compaction, user messages stay verbatim, and bulky tool I/O is replaced with
omission notices. Pruned content goes to a JSON cache keyed by content ID, and a
`read_omitted_content` MCP tool hands it back on demand.

~1,750 lines of TypeScript. The part that matters to tamp is `src/prune.ts`
(304 lines): a per-tool rule table deciding what is safe to drop and why.

**Layer mismatch.** magic-compact is a one-shot transcript rewriter run on
explicit user command. Tamp is a per-request proxy stage. The summarization
loop, the JSONL surgery, and the MCP retrieval tool are all wrong-layer for
tamp. The rule table is not.

**Cache constraint.** Tamp's `cacheSafe` mode (`providers.js:11`,
`findLatestEligibleGroup`) walks backwards and returns only the **newest**
tool_result group, specifically so tamp never invalidates the prompt cache. A
naive port of magic-compact's "Read output → always omit" would therefore delete
the file the agent just asked for. magic-compact's rules are *staleness* rules
aimed at old turns; tamp's default path targets the freshest turn. Every rule
borrowed below is age-scoped for this reason, and every one is opt-in because
rewriting old turns costs a cache invalidation.

## 2. Corrected measurements

Method: 60 sessions over 200 KB under `~/.claude/projects`. Text estimated at
`chars / 4`; images at `(w x h) / 750` with PNG IHDR and JPEG SOF header
decoding. Scripts in the session scratchpad (`redo.mjs`, `other.mjs`,
`imgtok.mjs`, `honest.mjs`).

| Bucket | Real tokens | Share | Status in tamp |
|---|---:|---:|---|
| `thinking` (signed) | 3,957,171 | 32.7% | **untouchable** |
| `tool_use.input` | 3,143,619 | **26.0%** | untouched, addressable |
| text `tool_result` | 2,532,149 | 20.9% | tamp's current turf |
| assistant / user text | 1,359,315 | 11.2% | mostly untouched |
| images | ~1,107,000 | 9.1% | invisible to the extractor |

Two findings drive the work:

**Thinking blocks are the largest single mass and cannot be touched.** All 7,087
sampled thinking blocks carry a `signature` field, verified upstream. Rewriting
them breaks the request. This closes off 32.7% permanently.

**`tool_use.input` is the largest addressable mass at 26.0%.** Tamp's extractor
(`providers.js:22`) only walks `role === 'user'` messages collecting
`tool_result` blocks, so it has never seen the input side at all. Within it,
Bash commands dominate, followed by Write content and Edit strings.

Images are 9.1%, not the 74% the first draft claimed. Still real, still
completely invisible to tamp (the extractor collects only `type: 'text'`
sub-blocks), and they additionally carry 227.6M base64 characters of wire
payload across the corpus — a bandwidth cost separate from tokens.

## 3. What shipped

### Enabler: tool-name attribution

`lib/path-extract.js` already mapped `tool_use_id → file_path` for read-diff. It
now also exposes `extractTargetToolNames(body, targets)`, giving every target
the name of the tool that produced it. Every rule below needs that signal.
No behavior change on its own.

### Always-on: AskUserQuestion exemption

`compress.js` now marks AskUserQuestion tool_results `skip: 'user-decision'`
before any stage sees them. Re-running the tool would re-prompt the human, so
its result is the one body in a transcript that cannot be regenerated — the same
reasoning that already exempts errored results. These bodies are tiny, so the
forgone compression costs nothing. Previously llmlingua or textpress could
paraphrase a recorded user decision.

This is the only always-on change. It is cache-safe: it removes work rather than
adding rewrites.

### Opt-in: `stale-inputs` (lib/stale-inputs.js)

Prunes payloads from `tool_use.input` in turns older than the newest 2, keeping
the call header. Rule table adapted from magic-compact's `src/prune.ts`:

| Tool | Rule |
|---|---|
| `Bash` | command > 1024 chars → keep first 512 + marker |
| `Write` | `content` → notice |
| `Edit` | `old_string` + `new_string` → notices |
| `NotebookEdit` | `new_source` → notice |
| `Agent` / `Workflow` / `SendMessage` | prompt / script / message → notice |
| `AskUserQuestion` | never touched |

The call header survives because it is the record of what the agent did; the
payload does not, because the written file is on disk and the edit already
landed. Notices name the recovery move ("Re-read the file...").

### Opt-in: `stale-images` (lib/stale-images.js)

Replaces base64 image blocks in turns older than the newest 2 with a text notice
naming the source path. Images are reloadable — the agent can re-Read the file
or re-screenshot. The newest turns keep their pixels so the image the agent is
currently working with is never dropped.

Both stages are registered in `metadata.js` as EXTRA (opt-in) and LOSSY.

## 4. Not pulled

- **Summarization loop** (`compact.ts`) — needs an LLM call and whole-transcript
  access. Wrong layer for a proxy.
- **Transcript surgery** (`transcript.ts`) — Claude Code JSONL specific; tamp is
  agent-agnostic.
- **`read_omitted_content` MCP tool** (`mcp.ts`) — tamp is not a plugin, and its
  existing `<tamp-ref:v1:...>` marker plus `rehydrateReferences`
  (`lib/disclosure.js`) already solves retrieval without spending an extra turn.
- **`Read` output eviction** — magic-compact's strongest rule, but text reads are
  only a slice of the 20.9% tamp already compresses via dedup / diff / read-diff.
  Lower value than it appears, and it overlaps existing stages.

## 5. Measured outcome

12 realistic requests, each the ~200K-token tail of a real transcript, scored
with correct image accounting. Stages measured standalone, not stacked on
tamp's defaults:

| Stages | Real tokens | Saved |
|---|---|---:|
| `stale-inputs` | 2,227,067 → 1,826,669 | **18.0%** |
| `stale-images` | 2,227,067 → 2,129,975 | 4.4% |
| both | 2,227,067 → 1,731,043 | **22.3%** |

Spread is wide: a code-heavy session with large Write and Edit calls hit 22.5%
from `stale-inputs` alone, while a session dominated by short Bash calls saw
4.3%.

Tests: 713 pass, 0 fail. 25 new tests across `test/tool-rules.test.js`,
`test/stale-images.test.js`, `test/stale-inputs.test.js`.

## 6. Open items

- Both stages invalidate the prompt cache by rewriting old turns. The 22.3%
  token saving must be weighed against cache-read pricing on the turns that get
  rewritten. Not yet measured — this is the main reason both stay opt-in.
- `keepRecent` is fixed at 2 turns, tunable via `config.staleInputKeepRecent`
  and `config.staleImageKeepRecent` but not yet exposed as an env var.
- The omission-notice A/B (does naming the recovery move change model behavior?)
  is still unrun.
