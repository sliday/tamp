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

## A compressed turn must replay byte-identical once it becomes history

cacheSafe compresses and redacts a tool_result only while it is newest. The client
re-sends it raw in the next request, so without the replay memo
(`lib/replay-memo.js`) the savings last one request, the prompt-cache prefix
breaks at that turn, and a secret masked in request N leaves unmasked in N+1.

The memo keys on provider + conversation (hash of the first turn and the first
user turn; the first turn alone is a shared system prompt on OpenAI chat) + position +
tool id + sha256 of the raw text, and stores what tamp emitted. Rules that keep
it honest, each one a defect found in review:

- Older turns only ever get a memo hit, never a fresh compression. On a miss
  (restart, eviction, `TAMP_REPLAY=false`) they still get redaction, which is
  deterministic, so a masked secret cannot go out in clear one request later.
- A tool id is not identity. Kimi-style ids (`functions.read:0`) repeat across
  conversations and turns, so the key carries conversation and position too.
- A marker is replayed only while its referent is still in the request. Clients
  clear old tool results (`[Old tool result content cleared]`), which leaves a
  dedup, diff or read-diff marker pointing at nothing. `graph` markers point at
  session state the memo cannot check, so they are not stored at all.
- Stored px-render images replay only to models on `TAMP_PX_MODELS`. A request
  from another model gets text and must not overwrite the stored images.
- Older turns honor `exemptProtectedTools` like the newest group does.
- A replayed target still goes through redaction, because read-diff caches
  skipped targets' text and a raw prior would leak in a later patch.

Known limit: when one conversation outgrows `TAMP_REPLAY_MAX_BYTES`, each new
entry evicts that conversation's oldest one, which then flips to uncompressed and
moves the cache break forward each request. Watch `replay.evictions` in
`/health`.

## Claude image tokens are counted in 28 px patches

`ceil(w/28) * ceil(h/28)` per image is the current upstream formula
(pxpipe 0.16 `anthropic-vision.ts`); `pixels / 750` above is the older
approximation and reads about 3% high. `lib/px-render.js` uses the patch count.
