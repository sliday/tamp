// Disk-backed, content-addressable Brotli store for large bodies.
// Hash = SHA-256(text).digest('hex'); file path = <cacheDir>/<hash[0:2]>/<hash>.br
//
// Intended as the storage substrate for Phase 5 progressive disclosure. In
// Phase 3 we just offload large referenced bodies out of RAM and surface
// counters in the banner — we do NOT emit new markers upstream yet.

import { createHash } from 'node:crypto'
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  statSync,
  utimesSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024
const DEFAULT_MIN_SIZE = 8 * 1024
const BROTLI_QUALITY = 4

function defaultCacheDir() {
  const home = homedir() || tmpdir()
  return join(home, '.cache', 'tamp', 'br')
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex')
}

function filePathFor(cacheDir, hash) {
  return join(cacheDir, hash.slice(0, 2), `${hash}.br`)
}

export function createBrCache({ cacheDir = defaultCacheDir(), maxBytes = DEFAULT_MAX_BYTES, minSize = DEFAULT_MIN_SIZE } = {}) {
  try { mkdirSync(cacheDir, { recursive: true }) } catch { /* ignore */ }

  let hits = 0
  let misses = 0
  let evictions = 0

  function scan() {
    const files = []
    let totalBytes = 0
    let shards
    try { shards = readdirSync(cacheDir) } catch { return { files, totalBytes } }
    for (const shard of shards) {
      const shardPath = join(cacheDir, shard)
      let entries
      try { entries = readdirSync(shardPath) } catch { continue }
      for (const name of entries) {
        if (!name.endsWith('.br')) continue
        const p = join(shardPath, name)
        try {
          const st = statSync(p)
          if (!st.isFile()) continue
          files.push({ path: p, size: st.size, atimeMs: st.atimeMs })
          totalBytes += st.size
        } catch { /* skip unreadable */ }
      }
    }
    return { files, totalBytes }
  }

  function pruneInternal() {
    const { files, totalBytes } = scan()
    if (totalBytes <= maxBytes) return { totalBytes, evicted: 0 }
    files.sort((a, b) => a.atimeMs - b.atimeMs) // oldest access first
    let current = totalBytes
    let evicted = 0
    for (const f of files) {
      if (current <= maxBytes) break
      try { unlinkSync(f.path); current -= f.size; evicted += 1; evictions += 1 } catch { /* ignore */ }
    }
    return { totalBytes: current, evicted }
  }

  function put(text) {
    if (typeof text !== 'string') return null
    const byteLen = Buffer.byteLength(text, 'utf8')
    if (byteLen < minSize) return null

    const hash = hashText(text)
    const finalPath = filePathFor(cacheDir, hash)
    const shardDir = join(cacheDir, hash.slice(0, 2))

    let brotliBytes
    if (existsSync(finalPath)) {
      try {
        brotliBytes = statSync(finalPath).size
        // Refresh access time for LRU.
        const now = new Date()
        try { utimesSync(finalPath, now, now) } catch { /* ignore */ }
        return { hash, storedBytes: byteLen, brotliBytes }
      } catch { /* fall through and rewrite */ }
    }

    try { mkdirSync(shardDir, { recursive: true }) } catch { /* ignore */ }

    let compressed
    try {
      compressed = brotliCompressSync(Buffer.from(text, 'utf8'), {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
      })
    } catch {
      return null
    }

    const tmpPath = `${finalPath}.tmp`
    try {
      writeFileSync(tmpPath, compressed)
      renameSync(tmpPath, finalPath)
      brotliBytes = compressed.length
    } catch {
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
      return null
    }

    pruneInternal()
    return { hash, storedBytes: byteLen, brotliBytes }
  }

  function get(hash) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) { misses += 1; return null }
    const p = filePathFor(cacheDir, hash)
    let buf
    try { buf = readFileSync(p) } catch { misses += 1; return null }
    let decoded
    try { decoded = brotliDecompressSync(buf) } catch { misses += 1; return null }
    const now = new Date()
    try { utimesSync(p, now, now) } catch { /* ignore */ }
    hits += 1
    return decoded.toString('utf8')
  }

  function has(hash) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return false
    return existsSync(filePathFor(cacheDir, hash))
  }

  function stats() {
    const { files, totalBytes } = scan()
    return { entries: files.length, totalBytes, hits, misses, evictions }
  }

  function prune() {
    return pruneInternal()
  }

  return { put, get, has, stats, prune, minSize, cacheDir }
}
