import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_STAGES,
  EXTRA_STAGES,
  ALL_STAGES,
  LOSSY_STAGES,
  isLossy,
  STAGE_DESCRIPTIONS,
  STAGE_HINTS,
  COMPRESSION_PRESETS,
  COMPRESSION_LEVELS,
  DEFAULT_LEVEL,
  LEVEL_ALIASES,
  resolveLevel,
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

  it('every opt-in EXTRA stage has a discoverability hint', () => {
    for (const s of EXTRA_STAGES) {
      assert.ok(STAGE_HINTS[s], `missing STAGE_HINTS entry for opt-in stage '${s}'`)
      assert.ok(typeof STAGE_HINTS[s].summary === 'string' && STAGE_HINTS[s].summary.length > 0,
        `STAGE_HINTS['${s}'] needs a non-empty summary`)
    }
  })

  it('llmlingua has a discoverability hint (default but may fail to start)', () => {
    assert.ok(STAGE_HINTS.llmlingua, 'llmlingua needs a hint for the sidecar-missing case')
    assert.ok(STAGE_HINTS.llmlingua.setup, 'llmlingua hint must include a setup command')
  })

  it('hint setup commands are concrete (no TBD/TODO placeholders)', () => {
    for (const [name, hint] of Object.entries(STAGE_HINTS)) {
      if (hint.setup) {
        assert.ok(!/TBD|TODO|FIXME/i.test(hint.setup), `STAGE_HINTS['${name}'].setup contains placeholder`)
      }
    }
  })
})

describe('COMPRESSION_LEVELS ladder', () => {
  const allStagesSet = new Set(ALL_STAGES)

  it('has exactly integer keys 1..9', () => {
    const keys = Object.keys(COMPRESSION_LEVELS).map(Number).sort((a, b) => a - b)
    assert.deepEqual(keys, [1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('every level\'s stages is a subset of ALL_STAGES', () => {
    for (let n = 1; n <= 9; n++) {
      for (const stage of COMPRESSION_LEVELS[n].stages) {
        assert.ok(allStagesSet.has(stage), `L${n} contains unknown stage '${stage}'`)
      }
    }
  })

  it('no duplicates inside any level\'s stages', () => {
    for (let n = 1; n <= 9; n++) {
      const stages = COMPRESSION_LEVELS[n].stages
      const seen = new Set()
      for (const s of stages) {
        assert.equal(seen.has(s), false, `L${n} has duplicate stage '${s}'`)
        seen.add(s)
      }
    }
  })

  it('monotonic inclusion: L_n.stages is a prefix-subset-by-order of L_{n+1}.stages', () => {
    for (let n = 1; n <= 8; n++) {
      const cur = COMPRESSION_LEVELS[n].stages
      const next = COMPRESSION_LEVELS[n + 1].stages
      assert.ok(next.length >= cur.length, `L${n + 1} should be at least as long as L${n}`)
      for (let i = 0; i < cur.length; i++) {
        assert.equal(next[i], cur[i],
          `L${n + 1}[${i}] should equal L${n}[${i}] (prefix invariant); got '${next[i]}' vs '${cur[i]}'`)
      }
    }
  })

  it('L4 stages match COMPRESSION_PRESETS.conservative.stages (set-equal)', () => {
    const level = new Set(COMPRESSION_LEVELS[4].stages)
    const preset = new Set(COMPRESSION_PRESETS.conservative.stages)
    assert.deepEqual([...level].sort(), [...preset].sort(),
      'L4 ladder must be set-equal to conservative preset stages')
  })

  it('L5 stages match COMPRESSION_PRESETS.balanced.stages (set-equal)', () => {
    const level = new Set(COMPRESSION_LEVELS[5].stages)
    const preset = new Set(COMPRESSION_PRESETS.balanced.stages)
    assert.deepEqual([...level].sort(), [...preset].sort(),
      'L5 ladder must be set-equal to balanced preset stages')
  })

  it('L8 stages match COMPRESSION_PRESETS.aggressive.stages (set-equal)', () => {
    const level = new Set(COMPRESSION_LEVELS[8].stages)
    const preset = new Set(COMPRESSION_PRESETS.aggressive.stages)
    assert.deepEqual([...level].sort(), [...preset].sort(),
      'L8 ladder must be set-equal to aggressive preset stages')
  })

  it('lossy flag is false for L1..L4 and true for L5..L9 (llmlingua lives in balanced=L5)', () => {
    for (let n = 1; n <= 4; n++) {
      assert.equal(COMPRESSION_LEVELS[n].lossy, false, `L${n} should be lossless`)
    }
    for (let n = 5; n <= 9; n++) {
      assert.equal(COMPRESSION_LEVELS[n].lossy, true, `L${n} should be lossy`)
    }
  })

  it('each level has a savings string', () => {
    for (let n = 1; n <= 9; n++) {
      assert.equal(typeof COMPRESSION_LEVELS[n].savings, 'string')
      assert.ok(COMPRESSION_LEVELS[n].savings.length > 0, `L${n} savings empty`)
    }
  })

  it('presets expose a cross-reference `level` field', () => {
    assert.equal(COMPRESSION_PRESETS.conservative.level, 4)
    assert.equal(COMPRESSION_PRESETS.balanced.level, 5)
    assert.equal(COMPRESSION_PRESETS.aggressive.level, 8)
  })

  it('DEFAULT_LEVEL is 5', () => {
    assert.equal(DEFAULT_LEVEL, 5)
  })
})

describe('resolveLevel', () => {
  it('resolves integer 1..9 to the matching level', () => {
    for (let n = 1; n <= 9; n++) {
      assert.equal(resolveLevel(n), COMPRESSION_LEVELS[n])
    }
  })

  it('resolveLevel(4).stages === COMPRESSION_LEVELS[4].stages', () => {
    assert.equal(resolveLevel(4).stages, COMPRESSION_LEVELS[4].stages)
  })

  it('resolveLevel("balanced").stages equals L5 stages', () => {
    assert.equal(resolveLevel('balanced').stages, COMPRESSION_LEVELS[5].stages)
  })

  it('resolves each preset alias', () => {
    assert.equal(resolveLevel('conservative'), COMPRESSION_LEVELS[4])
    assert.equal(resolveLevel('balanced'), COMPRESSION_LEVELS[5])
    assert.equal(resolveLevel('aggressive'), COMPRESSION_LEVELS[8])
    assert.equal(resolveLevel('max'), COMPRESSION_LEVELS[9])
  })

  it('returns null for unknown string', () => {
    assert.equal(resolveLevel('unknown'), null)
    assert.equal(resolveLevel(''), null)
  })

  it('returns null for out-of-range or non-integer numbers', () => {
    assert.equal(resolveLevel(0), null)
    assert.equal(resolveLevel(10), null)
    assert.equal(resolveLevel(-1), null)
    assert.equal(resolveLevel(4.5), null)
  })

  it('returns null for non-number/non-string inputs', () => {
    assert.equal(resolveLevel(null), null)
    assert.equal(resolveLevel(undefined), null)
    assert.equal(resolveLevel({}), null)
    assert.equal(resolveLevel([]), null)
  })

  it('LEVEL_ALIASES maps to canonical level numbers', () => {
    assert.equal(LEVEL_ALIASES.conservative, 4)
    assert.equal(LEVEL_ALIASES.balanced, 5)
    assert.equal(LEVEL_ALIASES.aggressive, 8)
    assert.equal(LEVEL_ALIASES.max, 9)
  })
})
