import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, statSync } from 'node:fs'
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

describe('br-cache — single payload larger than the whole budget', () => {
  const dir = freshDir('oversized')
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('put() returns null when one entry alone exceeds maxBytes (no phantom record)', () => {
    const cache = createBrCache({ cacheDir: dir, minSize: 1024, maxBytes: 4 * 1024 })
    // ~64 KB of incompressible data: the brotli output far exceeds the 4 KB
    // budget, so pruneInternal() evicts it immediately after the write.
    const text = `seed-${incompressible(64 * 1024)}`
    const put = cache.put(text)
    // Contract: if put() returns a record, the content MUST be retrievable.
    // Claiming success for content it just evicted creates a phantom brHash
    // that get() can never resolve.
    assert.equal(put, null, 'put must not claim success for content it immediately evicts')
    assert.equal(cache.stats().entries, 0, 'no entry should remain on disk')
  })
})

describe('br-cache — cached content is owner-only on disk', () => {
  const parent = freshDir('perms')
  after(() => rmSync(parent, { recursive: true, force: true }))

  // Cached bodies are full tool_results (code, file contents, command output)
  // and may contain secrets. They must not be readable by group/other.
  it('creates cache files and dirs with no group/other access', { skip: process.platform === 'win32' }, () => {
    const cacheDir = join(parent, 'br') // non-existent — br-cache must create it
    const cache = createBrCache({ cacheDir, minSize: 10 })
    const put = cache.put('sensitive cached tool_result body '.repeat(40))
    assert.ok(put)
    const shard = put.hash.slice(0, 2)
    const filePath = join(cacheDir, shard, `${put.hash}.br`)

    assert.equal(statSync(filePath).mode & 0o077, 0, 'cached file must not be group/other-readable')
    assert.equal(statSync(join(cacheDir, shard)).mode & 0o077, 0, 'shard dir must not be group/other-accessible')
    assert.equal(statSync(cacheDir).mode & 0o077, 0, 'cache dir must not be group/other-accessible')
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

describe('br-cache — incremental byte tracking (no full scan on every put)', () => {
  const dir = freshDir('tracked-bytes')
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('skips full directory scan while trackedBytes stays under maxBytes, then evicts once crossed', () => {
    const maxBytes = 40 * 1024
    const cache = createBrCache({ cacheDir: dir, minSize: 512, maxBytes })

    // First put initializes trackedBytes via scan() and stays well under maxBytes.
    const first = cache.put(`first-${incompressible(4 * 1024)}`)
    assert.ok(first)

    // Drop an external .br file into a shard dir AFTER initialization. If put()
    // ran a full scan() on every write, this 80 KB file would push disk usage
    // over maxBytes and get evicted immediately on the next small put().
    const shard = first.hash.slice(0, 2)
    const externalPath = join(dir, shard, `${'f'.repeat(64)}.br`)
    writeFileSync(externalPath, Buffer.alloc(80 * 1024, 0x41))

    const second = cache.put(`second-${incompressible(4 * 1024)}`)
    assert.ok(second)
    // Because trackedBytes (~8 KB) <= maxBytes (40 KB), no prune scan occurred.
    assert.equal(statSync(externalPath).size, 80 * 1024, 'put() under maxBytes should not trigger a full directory scan')

    // Now push trackedBytes past maxBytes — eviction must run and bring disk
    // total back under maxBytes.
    for (let i = 0; i < 8; i++) {
      cache.put(`push-${i}-${incompressible(8 * 1024)}`)
    }
    const s = cache.stats()
    assert.ok(s.totalBytes <= maxBytes, `totalBytes=${s.totalBytes} should be <= ${maxBytes}`)
    assert.ok(s.evictions > 0, 'eviction must trigger once trackedBytes crosses maxBytes')
  })

  it('accounts for pre-existing disk entries on first put of a new instance', () => {
    const preDir = freshDir('tracked-preexisting')
    try {
      const maxBytes = 20 * 1024
      const first = createBrCache({ cacheDir: preDir, minSize: 512, maxBytes: 100 * 1024 })
      for (let i = 0; i < 4; i++) {
        first.put(`pre-${i}-${incompressible(8 * 1024)}`)
      }
      // Second instance starts with a tighter maxBytes; its first put must
      // lazily seed trackedBytes from disk and evict down to maxBytes.
      const second = createBrCache({ cacheDir: preDir, minSize: 512, maxBytes })
      second.put(`new-${incompressible(4 * 1024)}`)
      const s = second.stats()
      assert.ok(s.totalBytes <= maxBytes, `totalBytes=${s.totalBytes} should be <= ${maxBytes}`)
      assert.ok(s.evictions > 0)
    } finally {
      rmSync(preDir, { recursive: true, force: true })
    }
  })
})
