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
])

export const ALL_STAGES = Object.freeze([
  ...DEFAULT_STAGES,
  ...EXTRA_STAGES,
])

// Stages that can drop or paraphrase content (semantic/neural/comment removal).
// `graph` is opt-in but fully lossless — it substitutes a reference marker for
// content the model has already seen earlier in the same session. `br-cache`
// is also lossless: it's a disk-backed store for large bodies, not a rewriter.
export const LOSSY_STAGES = Object.freeze(new Set([
  'llmlingua',
  'foundation-models',
  'textpress',
  'strip-comments',
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
})

export const COMPRESSION_PRESETS = Object.freeze({
  conservative: {
    name: 'Conservative',
    description: 'Safe, lossless compression only',
    stages: ['cmd-strip', 'minify', 'toon', 'strip-lines', 'whitespace', 'dedup', 'diff'],
    expectedSavings: '45-50%',
    risk: 'None',
  },
  balanced: {
    name: 'Balanced',
    description: 'Default, includes semantic compression',
    stages: ['cmd-strip', 'minify', 'toon', 'strip-lines', 'whitespace', 'llmlingua', 'dedup', 'diff', 'read-diff', 'prune'],
    expectedSavings: '52-58%',
    risk: 'Low',
  },
  aggressive: {
    name: 'Aggressive',
    description: 'Maximum compression, lossy stages enabled',
    stages: ['cmd-strip', 'minify', 'toon', 'strip-lines', 'whitespace', 'llmlingua', 'dedup', 'diff', 'read-diff', 'prune', 'strip-comments', 'textpress'],
    expectedSavings: '60-68%',
    risk: 'Medium (may lose comments, verbose text)',
  },
})
