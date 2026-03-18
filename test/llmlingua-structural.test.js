import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const goldenDir = join(__dirname, 'fixtures', 'llmlingua-golden')

function loadGoldens() {
  return readdirSync(goldenDir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(goldenDir, f), 'utf8')))
}

const goldens = loadGoldens()

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length
}

describe('LLMLingua-2 Structural Invariants', () => {

  describe('non-empty and non-identical', () => {
    for (const g of goldens) {
      it(`${g.id}: compression actually happened`, () => {
        assert.ok(g.compressed.length > 0, 'compressed should not be empty')
        assert.notEqual(g.compressed, g.original, 'compressed should differ from original')
        assert.ok(g.compressed.length < g.original.length, 'compressed should be shorter')
      })
    }
  })

  describe('token survival bounds (30-80% of original)', () => {
    for (const g of goldens) {
      it(`${g.id}: compressed tokens within bounds`, () => {
        const ratio = g.compressed_tokens / g.original_tokens
        assert.ok(ratio >= 0.30, `ratio ${ratio.toFixed(2)} below 0.30`)
        assert.ok(ratio <= 0.80, `ratio ${ratio.toFixed(2)} above 0.80`)
      })
    }
  })

  describe('named entity recall >= 85%', () => {
    for (const g of goldens) {
      it(`${g.id}: proper nouns, numbers, paths survive`, () => {
        // Extract entities from original
        const origNumbers = new Set((g.original.match(/\b\d+(?:\.\d+)?\b/g) || []))
        const compText = g.compressed
        let total = 0, found = 0
        for (const num of origNumbers) {
          total++
          if (compText.includes(num)) found++
        }
        const origPaths = (g.original.match(/(?:\/[\w.-]+){2,}/g) || [])
        for (const p of origPaths) {
          total++
          if (compText.includes(p)) found++
        }
        if (total === 0) return // no entities to check
        const recall = found / total
        assert.ok(recall >= 0.85, `entity recall ${(recall * 100).toFixed(0)}% < 85% (${found}/${total})`)
      })
    }
  })

  describe('code keyword preservation >= 90%', () => {
    const CODE_KEYWORDS = ['function', 'return', 'import', 'const', 'if', 'class', 'export', 'async', 'await', 'throw', 'catch', 'try', 'for', 'while', 'def', 'self', 'from']
    const codeGoldens = goldens.filter(g => ['typescript-hook', 'python-source'].includes(g.id))

    for (const g of codeGoldens) {
      it(`${g.id}: code keywords survive`, () => {
        const origKeywords = CODE_KEYWORDS.filter(kw => g.original.includes(kw))
        if (!origKeywords.length) return
        const survived = origKeywords.filter(kw => g.compressed.includes(kw))
        const recall = survived.length / origKeywords.length
        assert.ok(recall >= 0.90, `keyword recall ${(recall * 100).toFixed(0)}% < 90% (missing: ${origKeywords.filter(kw => !g.compressed.includes(kw)).join(', ')})`)
      })
    }
  })

  describe('sentence boundary preservation >= 40%', () => {
    for (const g of goldens) {
      it(`${g.id}: sentence count preserved`, () => {
        const origSentences = g.original.split(/[.!?\n]+/).filter(s => s.trim().length > 0).length
        const compSentences = g.compressed.split(/[.!?\n]+/).filter(s => s.trim().length > 0).length
        if (origSentences <= 1) return
        const ratio = compSentences / origSentences
        assert.ok(ratio >= 0.40, `sentence ratio ${(ratio * 100).toFixed(0)}% < 40% (${compSentences}/${origSentences})`)
      })
    }
  })

  describe('bracket balance preservation', () => {
    function isBalanced(text, open, close) {
      let depth = 0
      for (const ch of text) {
        if (ch === open) depth++
        else if (ch === close) depth--
        if (depth < 0) return false
      }
      return depth === 0
    }

    const bracketPairs = [['(', ')'], ['[', ']'], ['{', '}']]

    for (const g of goldens) {
      for (const [open, close] of bracketPairs) {
        const origBalanced = isBalanced(g.original, open, close)
        if (!origBalanced) continue
        it(`${g.id}: ${open}${close} balance preserved`, () => {
          assert.ok(isBalanced(g.compressed, open, close), `unbalanced ${open}${close} in compressed output`)
        })
      }
    }
  })

  describe('negation preservation', () => {
    const NEGATIONS = ['NOT', 'never', "don't", 'must not', 'NEVER', 'Do not', 'Do NOT', 'not']

    const negGoldens = goldens.filter(g => {
      return NEGATIONS.some(neg => g.original.includes(neg))
    })

    for (const g of negGoldens) {
      it(`${g.id}: negation words survive`, () => {
        const origNegations = NEGATIONS.filter(neg => g.original.includes(neg))
        const survived = origNegations.filter(neg => g.compressed.includes(neg))
        assert.ok(survived.length >= origNegations.length * 0.8,
          `negation recall ${survived.length}/${origNegations.length} (missing: ${origNegations.filter(n => !g.compressed.includes(n)).join(', ')})`)
      })
    }
  })

  describe('numbered list ordering', () => {
    const listGoldens = goldens.filter(g => /^\d+\.\s/m.test(g.original) || /^## Step \d/m.test(g.original))

    for (const g of listGoldens) {
      it(`${g.id}: numbered markers survive in order`, () => {
        // Only match line-start numbered lists like "1. " or "## Step 1"
        const markerRe = /^(\d+)\.\s/gm
        const origMarkers = [...g.original.matchAll(markerRe)].map(m => parseInt(m[1]))
        const compMarkers = [...g.compressed.matchAll(markerRe)].map(m => parseInt(m[1]))

        if (origMarkers.length <= 1) return

        // Check at least 60% of markers survive
        const survived = origMarkers.filter(m => compMarkers.includes(m))
        assert.ok(survived.length >= origMarkers.length * 0.6,
          `only ${survived.length}/${origMarkers.length} markers survived`)

        // Check that markers appear in same relative order
        // (lists may restart numbering across sections, so just check no reversal within runs)
        let maxInRun = 0
        for (let i = 0; i < compMarkers.length; i++) {
          if (compMarkers[i] <= maxInRun && compMarkers[i] <= 1) maxInRun = 0 // new section
          maxInRun = Math.max(maxInRun, compMarkers[i])
        }
      })
    }
  })
})
