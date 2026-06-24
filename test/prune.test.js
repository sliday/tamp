import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compressText } from '../compress.js'

// The prune stage (default-on at balanced/L5) strips npm lockfile noise. It
// must only drop ACTUAL npm metadata — dropping a legitimately-named field
// like { "integrity": "high" } in a non-npm tool_result would be silent data
// loss, violating tamp's promise. `resolved` is already value-gated; this
// extends the same discipline to `integrity` and `shasum`.
const config = { minSize: 10, stages: ['prune'], llmLinguaUrl: null, log: false }

function pruneOutput(obj) {
  const r = compressText(JSON.stringify(obj, null, 2), config)
  return r ? JSON.parse(r.text) : obj
}

describe('prune stage — only strips actual npm lockfile metadata', () => {
  it('preserves non-npm fields named integrity/shasum (values are not hashes)', () => {
    const out = pruneOutput({ integrity: 'high', shasum: 'verified', note: 'x'.repeat(120), id: 1 })
    assert.equal(out.integrity, 'high', 'a non-hash integrity field must be preserved')
    assert.equal(out.shasum, 'verified', 'a non-hash shasum field must be preserved')
    assert.equal(out.id, 1)
  })

  it('still strips real npm SRI integrity and lockfile shasum hashes', () => {
    const out = pruneOutput({
      integrity: 'sha512-AbCdEf0123456789+/abcDEF==',
      shasum: 'a'.repeat(40),
      name: 'x'.repeat(120),
    })
    assert.equal(out.integrity, undefined, 'real SRI integrity hash should still be pruned')
    assert.equal(out.shasum, undefined, 'real lockfile shasum should still be pruned')
    assert.equal(out.name, 'x'.repeat(120))
  })

  it('strips npm-internal underscore keys and registry resolved URLs', () => {
    const out = pruneOutput({
      _id: 'pkg@1',
      _from: 'pkg',
      resolved: 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',
      keep: 'y'.repeat(120),
    })
    assert.equal(out._id, undefined)
    assert.equal(out._from, undefined)
    assert.equal(out.resolved, undefined)
    assert.equal(out.keep, 'y'.repeat(120))
  })

  it('preserves a non-registry resolved URL (e.g. a git/file source)', () => {
    const out = pruneOutput({ resolved: 'git+https://github.com/me/pkg.git', keep: 'z'.repeat(120) })
    assert.equal(out.resolved, 'git+https://github.com/me/pkg.git', 'non-registry resolved must be preserved')
  })
})
