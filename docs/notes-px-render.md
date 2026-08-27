# px-render: image compression for dense tool_results

Borrowed from [teamchong/pxpipe](https://github.com/teamchong/pxpipe) (MIT).
Anthropic prices image input by pixel area (~pixels/750 tokens), not text
volume. Dense text (paths, hashes, grep output) tokenizes at ~1-3 chars/token
as text but packs ~18 chars/token rendered as a 5×8-glyph PNG. Rendering such
blocks as images cuts their input cost 80%+.

## Why this fills a real gap

The v0.8.20 autoresearch study showed tamp's own blind spot: code/path-heavy
blocks get 0% at L5 (the verbatim guard correctly keeps llmlingua off them),
bm25-trim only fires above 64KB and needs a user query, and textpress needs a
network backend. px-render handles exactly that class — 4-64KB dense blocks —
locally, with no query and no third party. Measured on the study fixtures:
big-source 8,308 → 1,533 tokens (82%, one image) vs textpress's 76% via
OpenRouter; big-grep stays with bm25-trim (85%, runs first by design).

## Safety design (all borrowed from pxpipe's findings)

- **Model allowlist, not price list** (`TAMP_PX_MODELS`, default
  `claude-fable-5`). Vision legibility varies wildly: pxpipe measured Fable 5
  at 13/15 dense-hex recall, opus-class at 2/15. Expensive ≠ legible; the
  most expensive model happens to also be the most legible one, which is why
  it is the default.
- **Factsheet**: precision-critical tokens (SHAs, paths, versions, numbers,
  CONST_IDS) are extracted deterministically and ride beside the images as
  plain text, so exact identifiers never depend on glyph reading. Short opaque
  ids outrank long URLs in the 64-token budget (length is anti-correlated
  with OCR-risk × consequence).
- **Two-stage profitability gate**: a cheap density pre-gate (skip clean prose
  at ≥4.0 chars/text-token — worst legibility, least upside), then an exact
  post-render check (imageTokens + factsheetTokens must beat textTokens by
  20%) before the block is claimed.
- **Dangerous-task bypass** (same rule as bm25-trim) and the standard
  claim-guard chain: dedup/diff/read-diff/graph/disclosure/bm25 all outrank it.
- **String-content tool_results only**: `applyTargets` writes the block array
  at `tool_result.content`, which the Anthropic API accepts; sub-text paths
  (`...content[j].text`) must stay strings and are never claimed.
- **droppedChars > 0 aborts the render** — atlas gaps render as blank cells,
  which is silent loss.

## Limitations / future work

- Anthropic provider only; OpenAI `image_url` variant is possible later.
- pxpipe-proxy is an optionalDependency — the stage no-ops when absent.
- Not in the `recommended` preset: image-reading QA needs a vision judge
  (the recommend-eval harness grades via a text judge). A fable-5 A/B on the
  study's 20 questions is the obvious next eval; pxpipe's own evals (gist
  98/98, SWE-bench Lite 10/10 at −65% request size) are the current evidence.
- Misreads are silent confabulations, not errors (vision isn't OCR). The
  factsheet mitigates for identifiers; reasoning-over-prose stays text by the
  density gate.
