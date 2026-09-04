# tamp — Anthropic API Proxy for Input Token Compression

## Problem

Claude Code sends the full conversation history on every API turn. Tool results (Read, Bash, Grep, Glob) and prior tool_use arguments accumulate as JSON, consuming tokens rapidly. This accelerates context window exhaustion and increases cost.

`tooner` solves this for MCP tool results only. Built-in tool results, prior tool_use blocks, and tool schemas remain uncompressed — they go straight from Claude Code to the Anthropic API as verbose JSON.

## Solution

A local HTTP proxy between Claude Code and the Anthropic API. It intercepts outgoing requests, compresses eligible content using a multi-strategy pipeline, and forwards the modified request upstream.

```
Claude Code
    |
    v
http://localhost:8787  (tamp)
    |  intercept POST /v1/messages
    |  walk messages array
    |  apply compression pipeline
    |
    v
https://api.anthropic.com  (or any upstream)
    |
    v
response streamed back unchanged
```

## Activation

```bash
# Start the proxy
node ~/Playground/tamp/index.js

# Tell Claude Code to use it
export ANTHROPIC_BASE_URL=http://localhost:8787
```

---

## Compression Pipeline

Content passes through stages in order. Each stage is independently toggleable.

### Stage 1: JSON Minification (baseline, zero risk)

Strip whitespace from pretty-printed JSON: `JSON.stringify(JSON.parse(content))`

- ~15-20% savings on formatted JSON
- Zero semantic risk — Claude handles minified JSON perfectly
- Applied to: all valid JSON content above threshold

### Stage 2: TOON Structural Encoding (default on)

Convert JSON to TOON format using `@toon-format/toon` encoder.

- ~40-60% savings on tabular/array-heavy JSON
- Lossless — all data preserved, just different notation
- Risk: Claude wasn't trained on TOON. Accuracy may degrade on complex structures.
- Applied to: valid JSON content above threshold, after minification

### Stage 3: LLMLingua Semantic Compression (optional, off by default)

Use a small language model to remove low-information tokens from natural language content.

- Ref: https://microsoft.github.io/promptflow/integrations/tools/llmlingua-prompt-compression-tool.html
- 2-20x compression on prose/documentation while preserving meaning
- **Lossy** — removes tokens the model deems unimportant
- Best for: long text tool results (file reads of docs/markdown, verbose CLI output)
- NOT for: structured data, code, JSON, error messages
- Requires: Python runtime with `llmlingua` package, or a local small LM
- Implementation: call out to a sidecar Python process or local API

### Stage 4: Selective Truncation (optional)

For results exceeding a token limit, truncate with a summary marker.

- `[...truncated, 847 more lines]`
- Claude Code already does some truncation — this is a tighter backstop
- Configurable per content type

---

## What Gets Compressed

| Content block type | Source | Stage 1 | Stage 2 | Stage 3 | Stage 4 |
|---|---|---|---|---|---|
| `tool_result` text (JSON) | Read, Bash, Grep, Glob | Yes | Yes | No | Optional |
| `tool_result` text (prose) | Bash output, docs | No | No | Optional | Optional |
| `tool_use` input (prior turns) | Claude's own JSON args | Yes | Yes | No | No |
| `tool_result` text (already TOON) | tooner-wrapped MCP | Skip | Skip | No | No |
| `tool_result` image blocks | Screenshots | Skip | Skip | Skip | Skip |
| `tool_result` with is_error | Error messages | Skip | Skip | Skip | Skip |
| `system` blocks | Tool schemas, instructions | No | No | No | No |
| User/assistant text | Conversation | No | No | No | No |

---

## Edge Cases (Critical)

### 1. Prompt Caching Invalidation

**This is the single biggest risk.**

Anthropic caches message prefixes via `cache_control` blocks. If compression changes historical content on a subsequent turn, the cache key changes and the cache misses — potentially *increasing* cost.

**Mitigation strategies:**
- **Option A: Compress-once** — tag compressed blocks with a marker (`[tamp:v1]`). On subsequent turns, detect already-compressed content in history and leave it unchanged. Same input = same output = cache hit preserved.
- **Option B: Only compress new** — only compress tool_result blocks from the current turn (the last user message). Leave all historical messages untouched. Simpler but saves less.
- **Option C: Deterministic encoding** — ensure TOON encoding is fully deterministic (same JSON always produces identical TOON). Then re-compressing historical content produces the same output, preserving cache keys. Requires verifying `@toon-format/toon` is deterministic.

**Recommendation:** Start with Option B (only compress new), measure savings, then move to Option A if caching impact is acceptable.

### 2. Double Compression (tooner + tamp)

If MCP results were already TOON-compressed by tooner, they appear as TOON text in subsequent turns' history. The proxy must detect and skip:
- Content starting with TOON syntax patterns (tabular headers like `name[3]{...}:`)
- Content prefixed with `[TOON]` marker
- Content that fails JSON.parse (already not JSON — skip)

### 3. JSON Detection False Positives

Content that looks like JSON but isn't:
- Python dict repr (`{'key': 'value'}` — single quotes)
- Truncated JSON from large file reads
- Shell output starting with `{` or `[`
- JSONC (JSON with comments)

**Mitigation:** Wrap `JSON.parse()` in try/catch. If it fails, content is not JSON — skip compression entirely. No heuristic detection.

### 4. Token vs Character Mismatch

TOON may produce fewer characters but different token counts depending on how Claude's tokenizer splits TOON syntax.

**Mitigation:** Log both character savings and estimated token savings (using `@anthropic-ai/tokenizer` or tiktoken). If TOON produces more tokens than JSON on certain content, skip it.

### 5. Multi-modal Content Blocks

`tool_result` content can be:
- A plain string
- An array of content blocks: `[{type: "text", text: "..."}, {type: "image", ...}]`

**Mitigation:** Handle both formats. For arrays, only compress blocks where `type === "text"`. Never touch `type === "image"` (base64 data corruption would be catastrophic).

### 6. Large Request Bodies

After many turns, the messages array can be multi-MB. Parsing/re-serializing has CPU/memory cost.

**Mitigation:**
- Set a max body size (e.g., 10MB) beyond which the request passes through unmodified
- Use streaming JSON parser if needed (overkill for v1)

### 7. Streaming Request Bodies

Claude Code might send chunked request bodies.

**Mitigation:** Buffer the full request body before processing. The latency cost is negligible (<10ms for typical payloads) since we need the full body to walk the message tree.

### 8. Non-deterministic TOON Output

If `@toon-format/toon` doesn't produce deterministic output (e.g., object key ordering varies), then re-compressing the same content on different turns produces different strings, breaking prompt caching.

**Mitigation:** Test determinism. If non-deterministic, apply `JSON.stringify(parsed, Object.keys(parsed).sort())` before TOON encoding to normalize key order.

### 9. Tool Schema Compression

Tool definitions are JSON Schema, repeated every turn. Tempting to compress, but:
- Claude uses schemas to understand tool capabilities
- Altering schema format could break tool calling
- Schemas are relatively small compared to results

**Decision:** Never compress system blocks or tool definitions.

### 10. Anthropic API Versioning

Different `anthropic-version` headers may structure messages differently.

**Mitigation:** Parse defensively. If the message structure doesn't match expected format, pass through unmodified. Log a warning.

### 11. Content-Length Mismatch

After compression, the body is smaller. Must recalculate `Content-Length` header before forwarding.

### 12. Error Recovery

If TOON encoding throws on specific input:
- Catch the error
- Fall back to original (or minified) content
- Log the error for debugging
- Never let compression failure break the request

---

## Architecture

```
index.js          — HTTP server, request interception, response streaming
compress.js       — compression pipeline (minify → TOON → optional stages)
detect.js         — JSON detection, already-compressed detection, content type classification
stats.js          — token/character savings tracker, logging
config.js         — env var parsing, stage toggles
package.json      — deps: @toon-format/toon
```

### Request Flow

```
1. Receive POST /v1/messages
2. Buffer full request body
3. Parse JSON body
4. Walk messages[].content[] blocks:
   a. Skip: system blocks, image blocks, error results, already-compressed
   b. type === "tool_result" text → detect JSON → compress pipeline
   c. type === "tool_use" input (prior turns) → compress pipeline
5. Recalculate Content-Length
6. Forward to upstream
7. Pipe response stream back unchanged (SSE or regular)
```

### Response Handling

- **Streaming (SSE):** Pipe `text/event-stream` directly — no buffering, no modification
- **Non-streaming:** Pipe response body directly
- Forward all response headers unchanged
- The proxy NEVER modifies responses

---

## Configuration

| Env var | Default | Description |
|---|---|---|
| `TOONA_PORT` | `8787` | Proxy listen port |
| `TOONA_UPSTREAM` | `https://api.anthropic.com` | Upstream API URL |
| `TOONA_MIN_SIZE` | `200` | Min content length (chars) to attempt compression |
| `TOONA_STAGES` | `minify,toon` | Comma-separated active stages |
| `TOONA_LOG` | `true` | Log compression stats to stderr |
| `TOONA_LOG_FILE` | none | Write detailed logs to file |
| `TOONA_MAX_BODY` | `10485760` | Max request body size to process (bytes) |
| `TOONA_CACHE_SAFE` | `true` | Only compress new content (preserve prompt cache) |
| `TOONA_LLMLINGUA_URL` | none | URL of LLMLingua sidecar (enables stage 3) |

---

## Stats Logging

```
[tamp] POST /v1/messages — 5 tool_results, 3 compressed
[tamp]   tool_result[2]: 12847→7708 chars (-40.0%) [toon]
[tamp]   tool_result[3]: 892→756 chars (-15.2%) [minify]
[tamp]   tool_result[4]: skipped (already toon)
[tamp]   tool_use[1]: 2341→1404 chars (-40.0%) [toon]
[tamp]   total this request: 16080→9868 chars (-38.6%)
[tamp]   session cumulative: 89431 chars saved across 42 compressions
```

---

## Dependencies

- `@toon-format/toon` — JSON-to-TOON encoder
- Node.js built-in `http`/`https` — no framework
- Optional: `llmlingua` Python sidecar for stage 3

---

## Testing Plan

1. **Smoke test:** Start proxy, `curl` a sample /v1/messages request through it, verify response
2. **Integration:** Set `ANTHROPIC_BASE_URL`, run Claude Code, do a normal session with Read/Bash/Grep — verify identical behavior
3. **Compression verification:** Compare logs — actual chars/tokens saved per turn
4. **Cache safety:** Run with `TOONA_CACHE_SAFE=true`, verify historical content unchanged between turns
5. **Edge cases:** Feed malformed JSON, TOON-already-compressed content, huge payloads, image blocks — verify graceful handling
6. **A/B comparison:** Same task with and without proxy — compare total token usage and task completion quality
7. **Determinism:** Encode same JSON 1000 times, verify identical output every time

## Success Criteria

1. Claude Code works identically through the proxy (no behavioral regressions)
2. Measurable token savings in logs (target: 20-40% on tool-heavy sessions)
3. Latency overhead < 10ms per request
4. Prompt cache hit rate not degraded (when TOONA_CACHE_SAFE=true)
5. Zero data corruption across 100+ tool calls
