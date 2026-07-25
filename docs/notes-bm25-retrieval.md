# notes: bm25-trim retrieval quality

Working notes on the Phase 7 rework of `bm25-trim`. Prompted by reading
[semble](https://minish.ai/packages/semble/introduction/), a code-search library for
agents, against what Tamp already had.

## The bug

`bm25-trim` ranks lines of a >64 KB `tool_result` against the last user message and drops
the low scorers. Its tokenizer collapsed identifiers and never split them:

```
query "parse config"     -> ['parse', 'config']
"function parseConfig("  -> ['function', 'parseconfig', 'opts']   score 0
"def parse_config(opts)" -> ['def', 'parse_config', 'opts']       score 0
```

`INTRA_WORD_RE` joins `parse_config` into a single token, and lowercasing destroys the
camelCase boundary in `parseConfig`. Neither shares a term with the query. The definition
line the user asked about scored exactly **0** and was among the first dropped.

The stage still looked like it worked, because once the high scorers are taken, greedy
selection spends the remaining budget in file order. Anything in the first half of a file
survived by accident. Anything past the budget cut was silently deleted.

## What changed

**Identifier subtokens.** `tokenize` now emits the collapsed form *and* its parts, splitting
on camelCase, acronym runs (`parseHTTPResponse` -> `parse`, `http`, `response`), and
underscores. Case must survive until the split, so lowercasing moved to the end. Parts are
emitted only when an identifier actually splits, otherwise an atomic `config` would be
counted twice and skew its term frequency. Capped at 4 parts to avoid diluting IDF.

**Block-aware dropping** (`lib/code-chunks.js`). Keeping a line without its signature and
closing brace emits code that no longer parses. Two detectors — brace depth for C-family,
indentation for Python/YAML — produce block ranges, and selection charges a candidate for
the enclosing headers and closers it drags in. Both detectors refuse to guess: the brace
detector returns null unless the whole body balances, and an unrecognised body falls back
to plain line trimming. Deliberately not tree-sitter, which is a native dependency.

Closure has to run in both directions, and both leaks produce unbalanced output:

- A bare `}` sits *outside* its own block's body, so it looks parentless, gets selected on
  its own cheapness, and strands a `}` with no signature. Fixed with the inverse map
  (`headerOf`).
- A header is not inside its own body either, so a signature picked directly on merit never
  charged for its own `}`. Only visible at scale — small fixtures balanced by luck; a
  73 KB body leaked exactly one brace.

**Rerank signals.** Definition boost (a line defining a query term beats one calling it),
comment penalty, and neighbour coherence so survivors read as contiguous code.

A path-based penalty (test files, `.d.ts`) was considered and dropped: `bm25-trim` ranks
lines *within* one `tool_result`, so a multiplier constant across the body cannot change any
relative ordering. Path is used for language detection only.

**Blank-line run merging.** Blank lines cost zero tokens, so greedy selection always kept
them, punching holes through dropped runs. Each hole costs another ~12-token marker — on a
fragmented body the markers alone overshot the budget several times over. A blank line
stranded between two dropped lines is now folded into the run. One fixture went from 30
markers to 2.

## The performance defect found on the way

`countTokens` from `@anthropic-ai/tokenizer` costs **~21 ms per call regardless of input
length** — fixed overhead, not proportional work:

```
short 35ch   500 calls  10539ms  21.08ms/call
med 120ch    500 calls  10677ms  21.35ms/call
long 800ch   100 calls   2211ms  22.11ms/call
one 80KB call                     3306ms
```

The trimmer called it once per line to build the budget. A 1000-line `tool_result` therefore
cost ~20 seconds of blocking CPU on the proxy hot path, for a budget that is approximate by
nature. Per-line costs are now estimated from a chars-per-token ratio calibrated off the
single whole-body count already taken: two tokenizer calls instead of N + 2. Reported
original and trimmed token counts stay exact. The eval harness went from >120 s to 1.5 s.

## Numbers

`npm run bench:retrieval` — 15 fixtures, offline, no API key. Gold lines are buried at ~85%
file depth so the file-order budget fill cannot save them by accident.

| | before | after |
|---|---|---|
| NDCG@10 (mean) | 0.348 | 0.931 |
| Recall@4096 (mean) | 40.0% | 100.0% |
| definition survival | — | 100% |

Eight of fifteen fixtures went from 0% recall — the answer silently deleted — to 100%.

The harness gates on definition survival, and fails if mean NDCG or recall regresses against
the legacy tokenizer. `bm25Scores` and `trimLinesByRelevance` take `tokenizer` and `rerank`
options purely so the bench can replay the same fixtures through the old behaviour.

## Tier

Unchanged: `bm25-trim` stays L8, aggressive-only, off by default, with the
`isDangerousTask` bypass intact. The fixes make it safer, not safe enough to enable
blindly. Promotion should follow evidence from the harness, not from these numbers alone.

## Not done

Semble's second retriever — static embeddings (Model2Vec `potion-code-16M`) fused with BM25
via reciprocal rank fusion — would help on natural-language queries where lexical overlap is
genuinely absent. It needs the Python sidecar and an HTTP hop per `tool_result` on the hot
path, for a stage that currently needs neither. Left out on purpose.

Embedding semble itself is the wrong shape: it is repo-scoped and stateful, Tamp is a
stateless per-request proxy. The two are complementary — semble stops the grep+read from
happening, Tamp compresses what survives.
