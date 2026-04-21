import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

export const VERSION = pkg.version

export const DEFAULT_STAGES = Object.freeze([
  'cmd-strip',
  'minify',
  'toon',
  'strip-lines',
  'whitespace',
  'llmlingua',
  'dedup',
  'diff',
  'read-diff',
  'prune',
])

export const EXTRA_STAGES = Object.freeze([
  'strip-comments',
  'textpress',
  'foundation-models',
  'graph',
  'br-cache',
  'disclosure',
  'bm25-trim',
])

export const ALL_STAGES = Object.freeze([
  ...DEFAULT_STAGES,
  ...EXTRA_STAGES,
])

// Stages that can drop or paraphrase content (semantic/neural/comment removal).
// `graph` is opt-in but fully lossless — it substitutes a reference marker for
// content the model has already seen earlier in the same session. `br-cache`
// is also lossless: it's a disk-backed store for large bodies, not a rewriter.
// `disclosure` IS lossy: it drops body content from the outgoing turn and
// relies on the model quoting the marker to trigger rehydration next turn.
// `bm25-trim` drops low-relevance lines from huge tool_results (lossy).
export const LOSSY_STAGES = Object.freeze(new Set([
  'llmlingua',
  'foundation-models',
  'textpress',
  'strip-comments',
  'disclosure',
  'bm25-trim',
]))

export function isLossy(stage) {
  return LOSSY_STAGES.has(stage)
}

// Hints shown in the banner when a stage is NOT active. summary describes
// the value the user is missing; setup is a copy-pasteable enable command
// (or null if the stage just needs TAMP_STAGES=...,<name>).
export const STAGE_HINTS = Object.freeze({
  llmlingua: {
    summary: 'neural text compression, +7-12% savings',
    setup: 'install uv: curl -LsSf https://astral.sh/uv/install.sh | sh',
  },
  graph: {
    summary: 'cross-request dedup, lossless, -99% on re-reads',
    setup: 'TAMP_STAGES=...,graph',
  },
  'read-diff': {
    summary: 'replace re-reads with diffs, lossless, -80% on common flows',
    setup: 'enabled by default in balanced preset',
  },
  'strip-comments': {
    summary: 'remove code comments (lossy)',
    setup: null,
  },
  textpress: {
    summary: 'LLM semantic compression via Ollama/OpenRouter (lossy)',
    setup: null,
  },
  'foundation-models': {
    summary: 'Apple Intelligence neural (macOS 15+, lossy)',
    setup: null,
  },
  'br-cache': {
    summary: 'Brotli disk cache, persists across sessions, enables Phase 5 disclosure',
    setup: 'TAMP_STAGES=...,br-cache',
  },
  disclosure: {
    summary: 'progressive disclosure for >32KB tool_results, model can quote hash to expand',
    setup: 'TAMP_STAGES=...,disclosure (requires br-cache)',
  },
  'bm25-trim': {
    summary: 'query-aware line ranking, preserves first+last, bypasses dangerous tasks',
    setup: 'TAMP_STAGES=...,bm25-trim',
  },
})

export const STAGE_DESCRIPTIONS = Object.freeze({
  'cmd-strip': 'Strip progress bars and spinners from command output (lossless)',
  minify: 'Strip JSON whitespace (lossless)',
  toon: 'Columnar array encoding (lossless)',
  'strip-lines': 'Remove line-number prefixes',
  whitespace: 'Collapse blank lines, trim trailing',
  llmlingua: 'Neural compression via LLMLingua-2',
  'foundation-models': 'Apple Intelligence neural compression (macOS 15+, Apple Silicon, 100% local)',
  dedup: 'Deduplicate identical tool_results',
  diff: 'Replace similar re-reads with diffs',
  'read-diff': 'Session-scoped unified diff for re-reads (lossless, opt-in)',
  prune: 'Strip lockfile hashes & npm metadata',
  'strip-comments': 'Remove code comments (lossy)',
  textpress: 'LLM semantic compression (Ollama/OpenRouter)',
  graph: 'Session-scoped dedup across requests (lossless, opt-in)',
  'br-cache': 'Disk-backed Brotli store for large tool_results (lossless, opt-in)',
  disclosure: '3-tier summary for huge tool_results with on-demand rehydration (lossy, aggressive-only)',
  'bm25-trim': 'Drop low-relevance lines from huge tool_results via BM25 (lossy, aggressive-only)',
})

export const COMPRESSION_PRESETS = Object.freeze({
  conservative: {
    name: 'Conservative',
    description: 'Safe, lossless compression only',
    stages: ['cmd-strip', 'minify', 'toon', 'strip-lines', 'whitespace', 'dedup', 'diff'],
    expectedSavings: '45-50%',
    risk: 'None',
    level: 4,
  },
  balanced: {
    name: 'Balanced',
    description: 'Default, includes semantic compression',
    stages: ['cmd-strip', 'minify', 'toon', 'strip-lines', 'whitespace', 'llmlingua', 'dedup', 'diff', 'read-diff', 'prune'],
    expectedSavings: '52-58%',
    risk: 'Low',
    level: 5,
  },
  aggressive: {
    name: 'Aggressive',
    description: 'Maximum compression, lossy stages enabled',
    stages: ['cmd-strip', 'minify', 'toon', 'strip-lines', 'whitespace', 'llmlingua', 'dedup', 'diff', 'read-diff', 'prune', 'strip-comments', 'textpress', 'br-cache', 'disclosure', 'bm25-trim'],
    expectedSavings: '65-72%',
    risk: 'Medium (may lose comments, verbose text)',
    level: 8,
  },
})

// Flat 1..9 compression ladder, parallel to the named presets. Each level
// extends the previous level's stage list (prefix-preserving). L4/L5/L8 are
// set-equal to conservative/balanced/aggressive respectively; L6-L7 interpolate
// between balanced and aggressive; L9 extends past aggressive (max).
//
// NOTE: `lossy` goes true at L5 because `llmlingua` lives in the balanced
// preset (= L5). The ladder is aligned to preset semantics per spec.
function extend(base, adds) { return Object.freeze([...base, ...adds]) }

const L1_STAGES = extend([], ['minify'])
const L2_STAGES = extend(L1_STAGES, ['whitespace', 'strip-lines'])
const L3_STAGES = extend(L2_STAGES, ['cmd-strip'])
const L4_STAGES = extend(L3_STAGES, ['toon', 'dedup', 'diff'])
const L5_STAGES = extend(L4_STAGES, ['llmlingua', 'read-diff', 'prune'])
const L6_STAGES = extend(L5_STAGES, ['strip-comments'])
const L7_STAGES = extend(L6_STAGES, ['textpress', 'br-cache'])
const L8_STAGES = extend(L7_STAGES, ['disclosure', 'bm25-trim'])
const L9_STAGES = extend(L8_STAGES, ['graph', 'foundation-models'])

export const COMPRESSION_LEVELS = Object.freeze({
  1: Object.freeze({ stages: L1_STAGES, lossy: false, savings: '~15%' }),
  2: Object.freeze({ stages: L2_STAGES, lossy: false, savings: '~25%' }),
  3: Object.freeze({ stages: L3_STAGES, lossy: false, savings: '~35%' }),
  4: Object.freeze({ stages: L4_STAGES, lossy: false, savings: '~45%' }),
  5: Object.freeze({ stages: L5_STAGES, lossy: true, savings: '~53%' }),
  6: Object.freeze({ stages: L6_STAGES, lossy: true, savings: '~58%' }),
  7: Object.freeze({ stages: L7_STAGES, lossy: true, savings: '~62%' }),
  8: Object.freeze({ stages: L8_STAGES, lossy: true, savings: '~67%' }),
  9: Object.freeze({ stages: L9_STAGES, lossy: true, savings: '~72%' }),
})

export const DEFAULT_LEVEL = 5

export const LEVEL_ALIASES = Object.freeze({
  conservative: 4,
  balanced: 5,
  aggressive: 8,
  max: 9,
})

export function resolveLevel(input) {
  if (typeof input === 'number' && Number.isInteger(input) && input >= 1 && input <= 9) {
    return COMPRESSION_LEVELS[input]
  }
  if (typeof input === 'string' && input in LEVEL_ALIASES) {
    return COMPRESSION_LEVELS[LEVEL_ALIASES[input]]
  }
  return null
}
