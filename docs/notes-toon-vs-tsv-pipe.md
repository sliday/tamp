# Decision: TSV/PIPE encoders alongside TOON?

## 1. Verdict

**SKIP.** Do not add TSV or PIPE encoders. Ship one adjacent fix instead: make the candidate
picker at `compress.js:458` compare `countTokens`, not `.length`.

## 2. The numbers that decide it

All counts from `@anthropic-ai/tokenizer` (the tokenizer tamp bills with), over 27 payloads:
25 real tool_results pulled from `bench/fixtures.js` and `test/fixtures/sample-messages.json`,
plus 2 reconstructions of the graphic.

| Fixture | Shape | JSON min | TOON | TSV | TSV gain |
|---|---|---|---|---|---|
| `bench:tabular-data` | 50 x 5 flat | 2156 | 1618 | 1614 | 4 tok (0.2%) |
| `sample:arrayData` | 3 x 3 flat | 52 | 39 | 35 | 4 tok (10.3%) |
| graphic reconstruction | 3 x 4 flat | 55 | 40 | 36 | 4 tok (10.0%) |

Three facts kill the proposal:

- **Applicability is 15%.** Only 4 of 27 payloads are arrays of flat uniform-key objects. Over
  the repo's real fixtures it is 2 of 25 (8%). Everything else is a nested root object, where a
  delimited encoder needs dotted-path flattening and inflates.
- **The win is a constant 4 tokens, not a percentage.** That 4 is TOON's `[N]{...}:` header
  line, measured identical on 7 shapes from 100 to 5000 rows. TOON's 2-space row indent costs 0
  tokens when the first column starts with a word, path, uuid, date, bool, or IP, because
  `countTokens("\n  ") == countTokens("\n") == 1`. So the percentage gain shrinks as payloads
  grow: 10% on 3 rows, 0.2% on 50 rows. Savings are largest exactly where they do not matter.
  The indent is not free for numeric-leading tables (57-152 extra tokens on 500x4), and the
  realistic ceiling is a 2000x2 int-id table: 516 tokens on a 9341-token payload, 5.5%. Still
  not worth a second encoder and its decoder contract.
- **Naive TSV breaks the lossless guarantee.** Reproduced: a tab inside a value shifts fields
  and drops the last one (`{id:1,cmd:'grep\tfoo',note:'ok'}` decodes to
  `{"id":"1","cmd":"grep","note":"foo"}`); a pipe inside a value splits a column; a newline
  fabricates a row (2 in, 3 out). On clean data it still loses types (`1` -> `"1"`, `true` ->
  `"true"`, `null` and `""` collapse), drops ragged keys, and cannot express nesting.
  `test/toon-fidelity.test.js` pins all of these; TOON round-trips all 27 payloads exactly.
  Quoting fixes the corruption and gives back roughly half the win (50-row file listing: TOON
  3121 chars, lossless quoted TSV 3014, naive TSV 2914).

## 3. What the graphic gets right and wrong

Right: the ordering TSV = PIPE < TOON < JSON holds, in chars and in tokens.

Wrong on magnitude. The 412/154/136/136 figures do not reproduce. Padding a flat 3-row table
until pretty JSON is exactly 412 chars gives TOON 197 and TSV 185, not 154 and 136. Measured
TOON is 47.8% of JSON (graphic claims 37.4%), TSV 44.9% (claims 33.0%), TSV/TOON 93.9% (claims
88.3%). The graphic overstates every ratio and picks 3 rows, the best possible case.

Wrong on the tie. TSV and PIPE have identical character counts by construction, so `136 = 136`
is arithmetic, not a finding. In tokens they diverge and tab is the worse one: on a 500x6 float
table TOON is 15063 tokens, PIPE 14906, TSV **16162**, while TSV is 1008 chars shorter. A
char-based picker would take TSV there and pay 1099 extra tokens.

Also a dead end already in the box: `@toon-format/toon@2.1.0` accepts
`encode(v, {delimiter: '\t' | '|'})` losslessly, but across all 20 JSON payloads in
`bench/fixtures.js` tab and pipe are 0-11 chars *worse* than comma. The win in raw TSV comes
from dropping TOON's header and quoting, not from the delimiter.

## 4. Adjacent higher-value change

`compress.js:458` selects with `tooned.length < best.text.length` (characters) while
`compress.js:464` reports `compressedTokens: countTokens(...)`. Selection and billing use
different units.

Measured mis-selection on a 100-row English-word table (fruit/colour/status/region): TSV is
2618 chars against TOON's 2830, a 7.5% "win" on the axis the picker reads, while costing 32
*more* tokens (889 vs 857). A 100-shape sweep found zero inversions between today's two
candidates (minify and TOON), so nothing is mis-picked in production right now. The unit
mismatch is a latent trap that any third candidate would spring.

Change: compare `countTokens(tooned) < countTokens(best.text)` at `compress.js:458`, cache the
baseline count so it runs once per call, and keep `compressedLen` reporting chars. Land this
before evaluating any new encoder, including a future quoted TSV.

One caveat on all numbers above: `@anthropic-ai/tokenizer` ships the claude-2 vocabulary, not
the vocabulary current models bill on. Under `cl100k_base` and `o200k_base` the same 100-row
fixture gives TOON 911 tokens vs TSV 655, a 28% gap. If tamp ever moves to Anthropic's
`count_tokens` API for measurement, re-run this comparison before treating it as settled.
