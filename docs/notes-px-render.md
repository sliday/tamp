# px-render: image compression for dense tool_results

Borrowed from [teamchong/pxpipe](https://github.com/teamchong/pxpipe) (MIT).
Anthropic prices image input by pixel area (one token per 28×28-px patch,
⌈w/28⌉×⌈h/28⌉ per image), not text volume. Dense text (paths, hashes, grep output) tokenizes at ~1-3 chars/token
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
  ids outrank long URLs in the 96-token budget (length is anti-correlated
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

## pxpipe-proxy 0.16 sync

- **Per-model render profile.** The stage passes the request model (with
  `[1m]`-style tags stripped) to `renderTextToImages({ model })`. Upstream
  routes every Claude id to its Claude profile (`claude-model-profiles.ts`):
  the original `claude-fable-5` keeps bare 5×8 rows, while Fable 5.1/5.2 and
  every other Claude id get +2px row spacing. Upstream measured dense hex on
  5.1 at 6/15 → 14/15 and 5.2 at 7/15 → 13/15 with spacing. The default
  allowlist `claude-fable-5` already admits `claude-fable-5-2` by prefix, so
  before this change those requests rendered at the geometry they misread.
  Non-Claude ids are not passed: they would resolve to a GPT or Gemini layout.
- **Patch pricing.** Image cost is now Σ⌈w/28⌉×⌈h/28⌉ over the real rendered
  pages, via the exported `openAIVisionTokens(model, w, h)` (family-agnostic
  despite the name; it resolves Claude ids to the `patch28` regime). The old
  `pixels/750` overstated a full 1568×728 page by ~4.5% and understated thin
  tail pages. Spaced pages are taller, and the gate charges them in full.
- **Factsheet.** Synced with upstream `factsheet.ts`: adds `LABEL=value`,
  lowercase `field=value`, emails, IBANs, currency amounts, dir paths, CLI
  flags, decimals, camelCase and ticket codes (`PROJ-1482`, must hold a
  digit); the cap rises from 64 to 96 tokens. Upstream's occurrence counts
  (`×N`) and per-page extraction were not ported. Three patterns differ from
  upstream to stay linear on a whole 200k-char string: email and file-path
  matches start only at the head of a run (lookbehind), the ticket digit check
  runs after the match instead of in a 120-char lookahead, and the trailing
  punctuation strip uses a lookbehind (a dotted URL took ~590 ms per 200 KB
  before). A test drains every pattern over 200k-char adversarial strings.

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
