import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  levelReducer,
  initialLevel,
  buildLevelPayload,
} from '../bin/ui/LevelPicker.js'
import { COMPRESSION_LEVELS, DEFAULT_LEVEL, resolveLevel } from '../metadata.js'

describe('LevelPicker reducer', () => {
  it('starts at envLevel when provided and valid', () => {
    assert.equal(initialLevel(3), 3)
    assert.equal(initialLevel(9), 9)
    assert.equal(initialLevel(1), 1)
  })

  it('falls back to DEFAULT_LEVEL when envLevel is missing or invalid', () => {
    assert.equal(initialLevel(undefined), DEFAULT_LEVEL)
    assert.equal(initialLevel(null), DEFAULT_LEVEL)
    assert.equal(initialLevel(0), DEFAULT_LEVEL)
    assert.equal(initialLevel(10), DEFAULT_LEVEL)
    assert.equal(initialLevel(NaN), DEFAULT_LEVEL)
    assert.equal(initialLevel('5'), DEFAULT_LEVEL) // strings rejected
  })

  it('moveRight increments and clamps at 9', () => {
    assert.equal(levelReducer(5, { type: 'moveRight' }), 6)
    assert.equal(levelReducer(8, { type: 'moveRight' }), 9)
    assert.equal(levelReducer(9, { type: 'moveRight' }), 9)
  })

  it('moveLeft decrements and clamps at 1', () => {
    assert.equal(levelReducer(5, { type: 'moveLeft' }), 4)
    assert.equal(levelReducer(2, { type: 'moveLeft' }), 1)
    assert.equal(levelReducer(1, { type: 'moveLeft' }), 1)
  })

  it('jumpTo accepts 1..9 and rejects out-of-range/NaN', () => {
    assert.equal(levelReducer(5, { type: 'jumpTo', value: 1 }), 1)
    assert.equal(levelReducer(5, { type: 'jumpTo', value: 9 }), 9)
    assert.equal(levelReducer(5, { type: 'jumpTo', value: 7 }), 7)
    // out of range: preserve current state
    assert.equal(levelReducer(5, { type: 'jumpTo', value: 0 }), 5)
    assert.equal(levelReducer(5, { type: 'jumpTo', value: 10 }), 5)
    assert.equal(levelReducer(5, { type: 'jumpTo', value: -1 }), 5)
    // non-numeric: preserve
    assert.equal(levelReducer(5, { type: 'jumpTo', value: NaN }), 5)
    assert.equal(levelReducer(5, { type: 'jumpTo', value: 'abc' }), 5)
  })

  it('jumpTo accepts numeric strings (simulating keystroke input)', () => {
    // useInput passes key chars as strings; Number('7') = 7 so it should work.
    assert.equal(levelReducer(5, { type: 'jumpTo', value: '7' }), 7)
    assert.equal(levelReducer(5, { type: 'jumpTo', value: '3' }), 3)
  })

  it('unknown actions are no-ops', () => {
    assert.equal(levelReducer(5, { type: 'nope' }), 5)
    assert.equal(levelReducer(5, {}), 5)
  })
})

describe('LevelPicker payload builder', () => {
  it('returns kind=level with stages matching resolveLevel', () => {
    for (let n = 1; n <= 9; n++) {
      const payload = buildLevelPayload(n)
      assert.equal(payload.kind, 'level')
      assert.equal(payload.level, n)
      assert.deepEqual(payload.stages, [...resolveLevel(n).stages])
      assert.deepEqual(payload.stages, [...COMPRESSION_LEVELS[n].stages])
    }
  })

  it('payload.stages is a copy (not a frozen reference)', () => {
    const payload = buildLevelPayload(5)
    // Should be mutable — consumers expect to be able to filter/push
    assert.doesNotThrow(() => payload.stages.push('extra'))
  })
})
