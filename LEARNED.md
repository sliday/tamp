# Learned

Gotchas worth carrying between sessions. AGENTS.md workflow step 5 feeds this file.

## Never commit or push to `main`

`AGENTS.md` constraint 1 says work goes on a `feat/` or `fix/` branch behind a PR.
This gets violated repeatedly: `docs/designs/bm25-hotpath-hardening.md` item 5 flagged
it, and v0.8.21 was committed and pushed straight to `main` anyway.

The trap is that `git log` looks like main-direct is the house style (one merge commit
in the whole history), so the habit reads as sanctioned. It is not. Read `AGENTS.md`
before the first `git commit`, not after.

Once a release is published to npm, rewriting `main` stops being an option: the registry
holds that exact tree, so a revert desyncs git from the published artifact. The violation
becomes permanent the moment `npm publish` succeeds.

## Never estimate image tokens as `chars / 4`

Anthropic bills images by pixel area, roughly `(width x height) / 750`, not by base64
length. The naive estimator overstates image cost by ~112x: a 780x1688 screenshot is
~1,756 tokens but ~145,000 base64 characters.

Getting this wrong inverted an entire opportunity ranking. Under `chars / 4`, images
looked like 74% of all tokens and `tool_use.input` like 5%. Corrected, images are ~9%
and `tool_use.input` is ~26% — the largest addressable mass in a request.

Anything measuring token savings on a corpus containing screenshots must decode image
dimensions (PNG IHDR, JPEG SOF) rather than measure payload length. See
`reports/magic-compact-review.md` §0.

## `thinking` blocks cannot be rewritten

Every `thinking` block carries a `signature` verified upstream. They are ~33% of tokens
in a typical session and permanently off-limits to any compression stage.

## cacheSafe mode only exposes the newest tool_result group

`findLatestEligibleGroup` (`providers.js:11`) walks backwards and returns one group, so
stages see the *freshest* turn, not old ones. Any rule borrowed from a transcript
compactor is a *staleness* rule aimed at the opposite end of the conversation. Porting
one naively (for example "Read output → always omit") deletes the file the agent just
asked for. Age-scope such rules and keep them opt-in, since rewriting old turns costs a
prompt-cache invalidation.
