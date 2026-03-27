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
  dedup: 'Deduplicate identical tool_results',
  diff: 'Replace similar re-reads with diffs',
  prune: 'Strip lockfile hashes & npm metadata',
  'strip-comments': 'Remove code comments (lossy)',
  textpress: 'LLM semantic compression (Ollama/OpenRouter)',
})
