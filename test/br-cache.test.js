import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBrCache } from '../lib/br-cache.js'

function freshDir(tag) {
  return mkdtempSync(join(tmpdir(), `tamp-br-${tag}-`))
}

function lorem(approxBytes) {
  const chunk = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '
  return chunk.repeat(Math.ceil(approxBytes / chunk.length)).slice(0, approxBytes)
}

// Random ASCII-safe filler that brotli cannot meaningfully compress, so each
// entry actually contributes its own weight toward the eviction threshold.
function incompressible(bytes) {
  return randomBytes(bytes).toString('base64').slice(0, bytes)
}

describe('br-cache — round-trip fidelity', () => {
  const dir = freshDir('roundtrip')
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('preserves 100 KB payload byte-for-byte', () => {
    const cache = createBrCache({ cacheDir: dir, minSize: 1024 })
    const text = lorem(100 * 1024)
    const put = cache.put(text)
    assert.ok(put, 'put should return a record')
    assert.match(put.hash, /^[a-f0-9]{64}$/)
    const got = cache.get(put.hash)
    assert.equal(got, text)
  })

  it('preserves 5 MB payload byte-for-byte', () => {
    const cache = createBrCache({ cacheDir: dir, minSize: 1024 })
    const text = lorem(5 * 1024 * 1024)
    const put = cache.put(text)
    assert.ok(put)
    const got = cache.get(put.hash)
    assert.equal(got.length, text.length)
    assert.equal(got, text)
  })
})

describe('br-cache — minSize gate', () => {
  const dir = freshDir('minsize')
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('returns null and writes no file for bodies smaller than minSize', () => {
    const cache = createBrCache({ cacheDir: dir, minSize: 8 * 1024 })
    const small = 'x'.repeat(1024)
    const result = cache.put(small)
    assert.equal(result, null)
    assert.equal(cache.stats().entries, 0)
  })
})

describe('br-cache — has / stats', () => {
  const dir = freshDir('has')
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('has() is true after put and false for unknown hashes', () => {
    const cache = createBrCache({ cacheDir: dir, minSize: 256 })
    const put = cache.put(lorem(2048))
    assert.ok(cache.has(put.hash))
    assert.equal(cache.has('0'.repeat(64)), false)
    assert.equal(cache.has('not-a-hash'), false)
  })

  it('stats().entries reflects put count', () => {
    const cache = createBrCache({ cacheDir: dir, minSize: 256 })
    const before = cache.stats().entries
    cache.put(lorem(2048) + 'A')
    cache.put(lorem(2048) + 'B')
    cache.put(lorem(2048) + 'C')
    const after = cache.stats().entries
    assert.equal(after - before, 3)
  })
})

describe('br-cache — atomic writes', () => {
  const dir = freshDir('atomic')
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('no .tmp files appear in stats().entries', () => {
    const cache = createBrCache({ cacheDir: dir, minSize: 256 })
    cache.put(lorem(4096))
    cache.put(lorem(8192) + 'distinct')
    // Manually drop a stray .tmp file next to real entries — it must not be
    // counted as a cache entry.
    const shards = readdirSync(dir)
    const shard = shards.find(s => s.length === 2)
    if (shard) {
      writeFileSync(join(dir, shard, 'deadbeef.br.tmp'), 'corrupt')
    }
    const s = cache.stats()
    // Entries must only be the .br files, not .tmp files.
    assert.equal(s.entries, 2)
  })
})

describe('br-cache — eviction', () => {
  const dir = freshDir('evict')
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('evicts older entries when totalBytes exceeds maxBytes', () => {
    const cache = createBrCache({ cacheDir: dir, minSize: 1024, maxBytes: 50 * 1024 })
    const hashes = []
    for (let i = 0; i < 20; i++) {
      // Incompressible filler means each file weighs ~its raw size, so the
      // 50 KB budget is exceeded quickly and eviction is forced.
      const put = cache.put(`seed-${i}-${incompressible(8 * 1024)}`)
      if (put) hashes.push(put.hash)
    }
    const s = cache.stats()
    assert.ok(s.totalBytes <= 50 * 1024, `totalBytes=${s.totalBytes} should be <= 50KB`)
    assert.ok(s.evictions > 0, 'at least one eviction must have occurred')
    assert.ok(s.entries < hashes.length, 'entry count must have shrunk')
  })
})

describe('br-cache — decompression failure is a miss', () => {
  const dir = freshDir('corrupt')
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('get() returns null and does not throw when file is corrupt', () => {
    const cache = createBrCache({ cacheDir: dir, minSize: 256 })
    const put = cache.put(lorem(4096))
    // Corrupt the on-disk file with non-brotli data.
    const shard = put.hash.slice(0, 2)
    const filePath = join(dir, shard, `${put.hash}.br`)
    writeFileSync(filePath, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]))
    assert.doesNotThrow(() => {
      const got = cache.get(put.hash)
      assert.equal(got, null)
    })
    assert.ok(cache.stats().misses >= 1)
  })

  it('get() for a random hash returns null without throwing', () => {
    const cache = createBrCache({ cacheDir: dir, minSize: 256 })
    const got = cache.get('0'.repeat(64))
    assert.equal(got, null)
  })
})

describe('br-cache — cross-instance persistence', () => {
  const dir = freshDir('persist')
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('a second cache instance finds entries from the first', () => {
    const a = createBrCache({ cacheDir: dir, minSize: 256 })
    const put = a.put(lorem(4096) + 'persist-me')
    const b = createBrCache({ cacheDir: dir, minSize: 256 })
    assert.ok(b.has(put.hash))
    assert.equal(b.get(put.hash), lorem(4096) + 'persist-me')
  })
})
