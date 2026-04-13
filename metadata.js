import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

export const VERSION = pkg.version

export const DEFAULT_STAGES = Object.freeze([
  'minify',
  'toon',
  'strip-lines',
  'whitespace',
  'llmlingua',
  'dedup',
  'diff',
  'prune',
])

export const EXTRA_STAGES = Object.freeze([
  'strip-comments',
  'textpress',
  'foundation-models',
  'graph',
])

export const ALL_STAGES = Object.freeze([
  ...DEFAULT_STAGES,
  ...EXTRA_STAGES,
])

export const STAGE_DESCRIPTIONS = Object.freeze({
  minify: 'Strip JSON whitespace (lossless)',
  toon: 'Columnar array encoding (lossless)',
  'strip-lines': 'Remove line-number prefixes',
  whitespace: 'Collapse blank lines, trim trailing',
  llmlingua: 'Neural compression via LLMLingua-2',
  'foundation-models': 'Apple Intelligence neural compression (macOS 15+, Apple Silicon, 100% local)',
  dedup: 'Deduplicate identical tool_results',
  diff: 'Replace similar re-reads with diffs',
  prune: 'Strip lockfile hashes & npm metadata',
  'strip-comments': 'Remove code comments (lossy)',
  textpress: 'LLM semantic compression (Ollama/OpenRouter)',
  graph: 'Session-scoped dedup across requests (lossless, opt-in)',
})

export const COMPRESSION_PRESETS = Object.freeze({
  conservative: {
    name: 'Conservative',
    description: 'Safe, lossless compression only',
    stages: ['minify', 'toon', 'strip-lines', 'whitespace', 'dedup', 'diff'],
    expectedSavings: '45-50%',
    risk: 'None',
  },
  balanced: {
    name: 'Balanced',
    description: 'Default, includes semantic compression',
    stages: ['minify', 'toon', 'strip-lines', 'whitespace', 'llmlingua', 'dedup', 'diff', 'prune'],
    expectedSavings: '52-58%',
    risk: 'Low',
  },
  aggressive: {
    name: 'Aggressive',
    description: 'Maximum compression, lossy stages enabled',
    stages: ['minify', 'toon', 'strip-lines', 'whitespace', 'llmlingua', 'dedup', 'diff', 'prune', 'strip-comments', 'textpress'],
    expectedSavings: '60-68%',
    risk: 'Medium (may lose comments, verbose text)',
  },
})
