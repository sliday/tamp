# Maintainer note: `graph` stage sends unresolvable refs (semantic risk)

Status: open design issue. Stage is opt-in (level 9 only, `lossy: true`).
Found during continuous-improvement review. Not yet fixed — needs a design call.

## Problem

The `graph` stage (`graphDeduplicateTargets`, `session-graph.js`) deduplicates
tool_result content **across requests** using a session-scoped bucket. When the
same content was seen in an earlier request, it replaces the block with:

```
<tamp-file-ref id="N" sha="..." bytes="..."/>
```

That marker is then applied to the body and forwarded to the upstream model.

The model is **stateless per request**. The content this marker points to lived
in a *previous* request, not the current one. Nothing rehydrates the marker on
the way out: the rehydration path (`findAnthropicReferences` / `applyRehydration`
in `providers.js`) only matches the disclosure format `<tamp-ref:v1:...>`, not
`<tamp-file-ref ...>`. So the model receives an opaque placeholder it cannot
resolve, losing the referenced content's meaning.

This differs from `dedup`/`diff`, which are **within-request**: they point to a
block that is still present elsewhere in the same prompt, so the model can read
it. `graph`'s cross-request reference has no in-prompt anchor.

## Why current tests don't catch it

`test/session-graph.test.js:90` and `test/compress.test.js:296` assert only the
**shape** of the produced marker. Neither verifies the model can recover the
content, so they stay green while the wire output is semantically lossy.

## Options (pick one)

1. **Scope graph to in-request anchors** — only emit a ref when the referenced
   content is also present in the current request (same guarantee as `dedup`).
   Safest; preserves meaning. Reduces cross-request savings.
2. **Rehydrate before send** — teach the request path to expand `<tamp-file-ref>`
   back to full content for blocks not present in the current request. Negates
   the savings; effectively makes the stage a no-op on the wire.
3. **Keep cross-request dedup but make the marker self-describing** — include
   enough context for the model to proceed (e.g. a short summary + sha), turning
   it into a `disclosure`-style lossy reference rather than an opaque id.
4. **Drop the stage** if real-world savings don't justify the complexity.

## Scope guard

Default level is 5; `graph` is level-9 only, so default users are unaffected.
No code changed for this note.
