import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_STAGES,
  EXTRA_STAGES,
  ALL_STAGES,
  LOSSY_STAGES,
  isLossy,
  STAGE_DESCRIPTIONS,
} from '../metadata.js'

describe('isLossy classification', () => {
  it('flags semantic/neural/comment-stripping stages as lossy', () => {
    assert.equal(isLossy('llmlingua'), true)
    assert.equal(isLossy('foundation-models'), true)
    assert.equal(isLossy('textpress'), true)
    assert.equal(isLossy('strip-comments'), true)
  })

  it('flags structural/lossless stages as NOT lossy', () => {
    assert.equal(isLossy('minify'), false)
    assert.equal(isLossy('toon'), false)
    assert.equal(isLossy('strip-lines'), false)
    assert.equal(isLossy('whitespace'), false)
    assert.equal(isLossy('dedup'), false)
    assert.equal(isLossy('diff'), false)
    assert.equal(isLossy('prune'), false)
  })

  it('flags graph as NOT lossy — it is an opt-in lossless stage', () => {
    assert.equal(isLossy('graph'), false, 'graph substitutes a ref marker for already-seen content; it is lossless')
    assert.ok(EXTRA_STAGES.includes('graph'), 'graph is opt-in')
    assert.ok(!LOSSY_STAGES.has('graph'), 'graph must not be in LOSSY_STAGES')
  })

  it('returns false for unknown stage names', () => {
    assert.equal(isLossy('does-not-exist'), false)
    assert.equal(isLossy(''), false)
  })
})

describe('metadata invariants', () => {
  it('every stage in ALL_STAGES has a description', () => {
    for (const stage of ALL_STAGES) {
      assert.ok(STAGE_DESCRIPTIONS[stage], `missing description for '${stage}'`)
    }
  })

  it('DEFAULT_STAGES and EXTRA_STAGES are disjoint', () => {
    const defaults = new Set(DEFAULT_STAGES)
    for (const s of EXTRA_STAGES) {
      assert.equal(defaults.has(s), false, `'${s}' is in both DEFAULT_STAGES and EXTRA_STAGES`)
    }
  })

  it('ALL_STAGES is the union of DEFAULT and EXTRA with no duplicates', () => {
    const seen = new Set()
    for (const s of ALL_STAGES) {
      assert.equal(seen.has(s), false, `duplicate '${s}' in ALL_STAGES`)
      seen.add(s)
    }
    assert.equal(ALL_STAGES.length, DEFAULT_STAGES.length + EXTRA_STAGES.length)
  })

  it('every lossy stage is a known stage', () => {
    for (const s of LOSSY_STAGES) {
      assert.ok(ALL_STAGES.includes(s), `LOSSY_STAGES contains unknown stage '${s}'`)
    }
  })
})
