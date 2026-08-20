# Recommended Defaults: An Autoresearch Study

**Date:** 2026-08-20 · **Tamp:** v0.8.19 · **Method:** [autoresearch](https://github.com/trevin-creator/autoresearch-mlx)-style goal-directed iteration (Modify → Verify → Keep/Discard → Repeat, 14 bounded iterations) · **Eval model:** `~deepseek/deepseek-v4-flash-latest` via OpenRouter, `temperature: 0`, `thinking: disabled`

## TL;DR

The shipped default (`level 5`, `TAMP_MIN_SIZE=200`) **fails a fact-retention gate**: llmlingua corrupts numerals and deletes load-bearing comments on small prose blocks. The recommended configuration below scores **79.95% input-token savings at 20/20 fact retention** — 8× the savings of the shipped default with strictly better quality:

```
TAMP_COMPRESSION_PRESET=recommended   # aggressive minus llmlingua
TAMP_MIN_SIZE=1024
TAMP_OUTPUT_MODE=off                  # unchanged
```

Without any network-dependent stage (no Ollama, no OpenRouter key), the same stage list degrades gracefully to **62.92% at 20/20** — still 6× the shipped default.

## 1. Why the old benchmark could not answer this question

Two defects made the existing `bench/runner.js` sweep unable to rank configurations:

1. **The quality metric was a tautology.** `qualityOK()` at `bench/runner.js:189` returns `/\bok\b/.test(t) || t.length > 0` — true for any non-empty response. Every config scored "100% quality" by construction.
2. **Fixtures could not reach the stages.** The largest fixture was 18.5 KB; `disclosure` and `bm25-trim` gate at >32 KB. Hence the exact 0.00% leave-one-out deltas in the v0.8.0 sweep.

## 2. Method

### Harness (`bench/recommend-eval.js`, fixtures in `bench/recommend-fixtures.js`)

- **9 scenarios, 20 questions**, each planting facts a specific stage could destroy: package versions (toon/minify), noisy CLI output (cmd-strip), line-numbered code (strip-lines), lockfile with integrity hashes (prune), parallel duplicate reads (dedup/diff), a fact stated *only in a comment* (strip-comments), prose with precise numerals (llmlingua/textpress), a 46 KB grep output with 3 planted needles at start/middle/end (bm25-trim), and a 40 KB source module (textpress/disclosure).
- **A/B protocol:** control = raw body, treatment = `compressMessages()` output; both sent to the eval model; answers graded mechanically (substring/regex/set). Control answers are cached on disk, so sweeping N configs costs N treatment runs.
- **Quality gate:** treatment may lose at most 1 of 20 answers vs control. Score = token savings if the gate passes, else 0.
- **Savings metric:** client-side `@anthropic-ai/tokenizer` count of the serialized messages before/after compression. API-reported `input_tokens` proved unusable — DeepSeek's server-side context cache reports only uncached tokens (we observed `input_tokens: 1` for an 84 KB prompt).
- **Determinism:** DeepSeek is not perfectly deterministic at temperature 0; rows where the arms disagree are revoted (majority of 3) so a single flaky sample cannot decide the gate.
- **Faithful request shape:** tamp's cache-safe extraction compresses only the *latest eligible message group* (preserving the Anthropic prompt-cache prefix). The QA question therefore rides as a text block in the same user message as the tool_result — simulating the request where the tool_result arrives, which is when the proxy actually compresses it.

### Iteration log (autoresearch loop)

| # | Config | Savings % | QA (treat/ctrl) | Gate | Verdict |
|---|--------|-----------|-----------------|------|---------|
| 0 | baseline L5, ms200 | 10.03 | 18/20 | **FAIL** | baseline |
| 1 | L4 (lossless) | 1.66 | 20/20 | pass | keep |
| 2 | L5 − llmlingua | 4.40 | 20/20 | pass | keep |
| 3 | L6 | 10.09 | 18/20 | **FAIL** | discard |
| 4 | L7 | 8.23 | 19/20 | pass | keep |
| 5 | L8 | 68.92 | 19/20 | pass | keep |
| 6 | L9 | 68.92 | 19/20 | pass | discard (= L8) |
| 7 | L8, ms1024 | 68.51 | 20/20 | pass | keep |
| 8 | L8 − llmlingua | 80.37 | 19/20 | pass | keep |
| 9 | **L8 − llmlingua, ms1024** | **79.95** | **20/20** | pass | **champion** |
| 10 | local-only (− textpress), ms1024 | 62.92 | 20/20 | pass | keep |
| 11 | champion + output-mode balanced | 79.95 | 20/20 | pass | keep |
| 12 | champion + output-mode aggressive | 77.69 | 19/19 | pass | discard |
| 13 | champion rerun (stability) | 79.95 | 20/20 | pass | confirmed |
| 14 | L5, ms1024 (minimal fix) | 9.62 | 20/20 | pass | keep |

## 3. Findings

### F1. The shipped default fails the gate — llmlingua corrupts small prose

Two stable, revote-confirmed losses at L5/ms200:

- `comment-fact`: the comment "TTL below is in MINUTES" was compressed away; the model answered **"seconds"**.
- `prose-numbers`: "1,240ms" was compressed to "…240"; the model answered **"240"** instead of 1,240.

Both losses reproduce at every level that includes llmlingua with `min_size 200` (L5, L6). Both facts sit in blocks of 200–900 bytes where the absolute savings are ~30 tokens — all risk, no reward.

### F2. `min_size 1024` eliminates every observed quality loss for ≤0.5 pt

Raising the floor from 200 to 1024 bytes skips exactly the block class where lossy stages do damage. Cost at L8: 68.92% → 68.51%. Even keeping the shipped level 5, `ms1024` alone repairs the gate (iteration 14: 20/20).

### F3. llmlingua is dominated: removing it *raises* savings

In `compressBlock()` llmlingua runs ahead of textpress, so any block it claims never reaches the stronger stage. On the 40 KB source fixture: llmlingua 25% vs textpress 76%. Dropping llmlingua from L8 moved the total from 68.51% → 79.95% *and* removed its numeral corruption. Separately, the v0.8.18 verbatim-critical guard already makes llmlingua skip code/path-like text (our 46 KB grep fixture: 0% at L5), so its remaining territory is exactly the prose where it is least safe.

### F4. bm25-trim is the workhorse on huge tool_results — and it is local

85% reduction on the 46 KB grep output with **3/3 planted needles still answered correctly** (needles at line 4, 350, and 697). Query-aware trimming does what it promises, needs no network, no sidecar, no key.

### F5. Graceful degradation of the recommended stage list

| Tier | textpress backend available | Measured savings | QA |
|------|------------------------------|------------------|-----|
| Full | OpenRouter key (or local Ollama model) | 79.95% | 20/20 |
| Local-only | none — textpress no-ops | 62.92% | 20/20 |

Same stage list, no reconfiguration: savings scale with what the machine has. Note the privacy trade-off: with a key present, textpress ships tool_result text to a third-party model (Ollama is tried first when present).

### F6. Output hints are an input-token tax; `off` stays the default

The injected hint costs ~95 (conservative) to ~131 (aggressive) input tokens *per request*; on small requests the aggressive-mode row-mean savings went **negative** (−6%). Correctness was unaffected (gate passed in both modes), but this terse-answer suite cannot measure the long-form output benefit, so the data does not justify changing `TAMP_OUTPUT_MODE=off`.

### F7. Not exercised (honest gaps)

`read-diff`, `graph`, and `disclosure` never fired: they require proxy-session infrastructure (`config.readCache`/`sessionBucket`/`brCache`) that bare `loadConfig()` does not construct. They are retained in the recommended set (the first two are lossless; disclosure's rehydration loop needs a multi-turn harness to grade fairly). L9's `foundation-models` added zero over L8 on this corpus.

## 4. Recommended defaults

```
TAMP_COMPRESSION_PRESET=recommended
# = cmd-strip,minify,toon,strip-lines,whitespace,dedup,diff,read-diff,prune,
#   strip-comments,textpress,br-cache,disclosure,bm25-trim   (aggressive − llmlingua)
TAMP_MIN_SIZE=1024
TAMP_OUTPUT_MODE=off
```

Shipped as the `recommended` preset in `metadata.js` (v0.8.19+).

## 5. Limitations

- Single judge (deepseek-v4-flash), single run per row (with mismatch revoting). Cross-judge triangulation is future work.
- The corpus is code-assistant-shaped and single-turn; token-weighted savings depend on the mix (the 46 KB grep fixture carries ~70% of corpus weight — deliberate, since huge tool_results dominate real sessions, but a different mix shifts the headline number; the unweighted row mean for the champion is 28.96%).
- textpress quality was measured with `google/gemini-3.1-flash-lite-preview` as the compressor; the default local path (`qwen3.5:0.8b` via Ollama) is unmeasured.
- strip-comments' comment-loss risk on files ≥1 KB where a fact lives *only* in a comment is only partially probed (our clean comment probe fell under the 1024 floor).

## Reproduce

```bash
export OPENROUTER_API_KEY=...
# sidecar optional: uv run --with fastapi --with uvicorn --with llmlingua --with mlx \
#   uvicorn server:app --host 127.0.0.1 --port 8788 --app-dir sidecar
node bench/recommend-eval.js --id champion \
  --stages cmd-strip,minify,toon,strip-lines,whitespace,dedup,diff,read-diff,prune,strip-comments,textpress,br-cache,disclosure,bm25-trim \
  --min-size 1024
```

Per-config JSON: `bench/results/recommend-*.json`. Iteration log: `autoresearch-results.tsv` (gitignored, local).
