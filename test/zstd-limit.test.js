import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { decompressZstd } from '../index.js'

function zstdCompress(buf) {
  return execFileSync('zstd', ['-c', '--no-progress'], { input: buf, maxBuffer: 10 * 1024 * 1024 })
}

describe('decompressZstd', () => {
  it('round-trips a valid zstd body', () => {
    const original = Buffer.from(JSON.stringify({ hello: 'world', n: [1, 2, 3] }))
    const out = decompressZstd(zstdCompress(original), 1_000_000)
    assert.equal(out.toString('utf-8'), original.toString('utf-8'))
  })

  it('aborts when decompressed output exceeds the limit (compression bomb)', () => {
    // 50KB of repeated bytes compresses tiny but expands past a small limit.
    const big = Buffer.alloc(50_000, 0x61)
    const compressed = zstdCompress(big)
    assert.ok(compressed.length < big.length, 'fixture must actually compress')
    assert.throws(
      () => decompressZstd(compressed, 4_000),
      /exceeded size limit/,
    )
  })

  it('accepts output exactly within the limit', () => {
    const data = Buffer.alloc(2_000, 0x62)
    const out = decompressZstd(zstdCompress(data), 2_000)
    assert.equal(out.length, 2_000)
  })
})
