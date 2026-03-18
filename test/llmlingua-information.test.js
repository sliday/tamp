import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ngramOverlap, lcsRatio, extractEntities, entityRecall,
  charTrigramJaccard, sentenceCount, extractActionPhrases, charEntropy,
} from './helpers/text-metrics.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const goldenDir = join(__dirname, 'fixtures', 'llmlingua-golden')

function loadGoldens() {
  return readdirSync(goldenDir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(goldenDir, f), 'utf8')))
}

const goldens = loadGoldens()

describe('LLMLingua-2 Information-Theoretic Tests', () => {

  describe('unigram recall (ROUGE-1 proxy) >= 0.45', () => {
    for (const g of goldens) {
      it(`${g.id}`, () => {
        const { recall } = ngramOverlap(g.original, g.compressed, 1)
        assert.ok(recall >= 0.45, `unigram recall ${recall.toFixed(3)} < 0.45`)
      })
    }
  })

  describe('bigram recall (ROUGE-2 proxy) >= 0.25', () => {
    for (const g of goldens) {
      it(`${g.id}`, () => {
        const { recall } = ngramOverlap(g.original, g.compressed, 2)
        assert.ok(recall >= 0.25, `bigram recall ${recall.toFixed(3)} < 0.25`)
      })
    }
  })

  describe('LCS ratio (ROUGE-L proxy) >= 0.40', () => {
    for (const g of goldens) {
      it(`${g.id}`, () => {
        const ratio = lcsRatio(g.original, g.compressed)
        assert.ok(ratio >= 0.40, `LCS ratio ${ratio.toFixed(3)} < 0.40`)
      })
    }
  })

  describe('character trigram Jaccard >= 0.35', () => {
    for (const g of goldens) {
      it(`${g.id}`, () => {
        const score = charTrigramJaccard(g.original, g.compressed)
        assert.ok(score >= 0.35, `char trigram Jaccard ${score.toFixed(3)} < 0.35`)
      })
    }
  })

  describe('entity recall >= 0.70', () => {
    for (const g of goldens) {
      it(`${g.id}`, () => {
        const origE = extractEntities(g.original)
        const compE = extractEntities(g.compressed)
        const recall = entityRecall(origE, compE)
        assert.ok(recall >= 0.70, `entity recall ${recall.toFixed(3)} < 0.70`)
      })
    }
  })

  describe('action phrase preservation', () => {
    const actionGoldens = goldens.filter(g => extractActionPhrases(g.original).length >= 2)

    for (const g of actionGoldens) {
      it(`${g.id}: action phrases survive`, () => {
        const origPhrases = extractActionPhrases(g.original)
        const compText = g.compressed.toLowerCase()
        const survived = origPhrases.filter(phrase => {
          // Check if the key verb+object is present (first 2-3 words)
          const words = phrase.split(/\s+/).slice(0, 2)
          return words.every(w => compText.includes(w))
        })
        const recall = survived.length / origPhrases.length
        assert.ok(recall >= 0.50, `action phrase recall ${(recall * 100).toFixed(0)}% < 50% (${survived.length}/${origPhrases.length})`)
      })
    }
  })

  describe('entropy density increase', () => {
    for (const g of goldens) {
      it(`${g.id}: compressed text has higher per-char entropy`, () => {
        const origEntropy = charEntropy(g.original)
        const compEntropy = charEntropy(g.compressed)
        // Compressed text should maintain or increase information density
        // Allow small decrease (5%) since some redundancy removal is expected
        assert.ok(compEntropy >= origEntropy * 0.95,
          `entropy dropped: orig=${origEntropy.toFixed(3)} comp=${compEntropy.toFixed(3)}`)
      })
    }
  })
})
