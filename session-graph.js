import { createHash } from 'node:crypto'

const SESSION_TTL_MS = 2 * 60 * 60 * 1000
const MAX_SESSIONS = 50
const MIN_BYTES = 512

export function createSessionStore({ ttlMs = SESSION_TTL_MS, maxSessions = MAX_SESSIONS, brCache = null } = {}) {
  const store = new Map()

  function prune() {
    const cutoff = Date.now() - ttlMs
    for (const [k, bucket] of store) {
      if (bucket.lastSeen < cutoff) store.delete(k)
    }
  }

  function getBucket(key) {
    if (!key) return null
    prune()
    let bucket = store.get(key)
    if (bucket) {
      bucket.lastSeen = Date.now()
      return bucket
    }
    if (store.size >= maxSessions) {
      const oldest = store.keys().next().value
      store.delete(oldest)
    }
    bucket = createSessionBucket({ brCache })
    store.set(key, bucket)
    return bucket
  }

  return { getBucket, prune, _store: store }
}

// A bucket tracks per-session graph state. Optionally pipes large target
// bodies through a Brotli disk cache so the in-memory structure stays lean
// and content persists across proxy restarts for Phase 5 rehydration.
export function createSessionBucket({ brCache = null } = {}) {
  const refs = new Map()
  let brotliBytes = 0
  let offloaded = 0
  let hits = 0

  return {
    refs,
    nextId: 0,
    lastSeen: Date.now(),
    brCache,
    // Counters incremented by graphDeduplicateTargets when brCache is attached.
    brStats() { return { brotliBytes, offloaded, hits } },
    _recordOffload(bytes) { brotliBytes += bytes; offloaded += 1 },
    _recordHit() { hits += 1 },
  }
}

export function deriveSessionKey(headers) {
  if (!headers) return null
  const auth = headers.authorization || headers['x-api-key'] || ''
  if (!auth) return null
  return createHash('sha256').update(auth).digest('hex').slice(0, 16)
}

export function graphDeduplicateTargets(targets, bucket, { minBytes = MIN_BYTES } = {}) {
  if (!bucket) return
  const brCache = bucket.brCache
  for (const target of targets) {
    if (target.skip || target.dedup || target.diffed || target.compressed) continue
    if (typeof target.text !== 'string' || target.text.length < minBytes) continue

    const hash = createHash('sha256').update(target.text).digest('hex').slice(0, 12)
    const existing = bucket.refs.get(hash)
    if (existing) {
      target.compressed = `<tamp-file-ref id="${existing.id}" sha="${hash}" bytes="${target.text.length}"/>`
      target.graphed = true
      if (brCache && existing.brHash) bucket._recordHit()
      continue
    }
    bucket.nextId += 1
    const entry = { id: bucket.nextId, bytes: target.text.length }
    // Opportunistic offload to the disk store — Phase 3 collects the hash
    // for forward-compat with Phase 5 rehydration; no markers change yet.
    if (brCache && typeof brCache.put === 'function' && target.text.length >= brCache.minSize) {
      const stored = brCache.put(target.text)
      if (stored) {
        entry.brHash = stored.hash
        bucket._recordOffload(stored.brotliBytes)
      }
    }
    bucket.refs.set(hash, entry)
  }
}
