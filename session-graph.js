import { createHash } from 'node:crypto'

const SESSION_TTL_MS = 2 * 60 * 60 * 1000
const MAX_SESSIONS = 50
const MIN_BYTES = 512

export function createSessionStore({ ttlMs = SESSION_TTL_MS, maxSessions = MAX_SESSIONS } = {}) {
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
    bucket = { refs: new Map(), nextId: 0, lastSeen: Date.now() }
    store.set(key, bucket)
    return bucket
  }

  return { getBucket, prune, _store: store }
}

export function deriveSessionKey(headers) {
  if (!headers) return null
  const auth = headers.authorization || headers['x-api-key'] || ''
  if (!auth) return null
  return createHash('sha256').update(auth).digest('hex').slice(0, 16)
}

export function graphDeduplicateTargets(targets, bucket, { minBytes = MIN_BYTES } = {}) {
  if (!bucket) return
  for (const target of targets) {
    if (target.skip || target.dedup || target.diffed || target.compressed) continue
    if (typeof target.text !== 'string' || target.text.length < minBytes) continue

    const hash = createHash('sha256').update(target.text).digest('hex').slice(0, 12)
    const existing = bucket.refs.get(hash)
    if (existing) {
      target.compressed = `<tamp-file-ref id="${existing.id}" sha="${hash}" bytes="${target.text.length}"/>`
      target.graphed = true
      continue
    }
    bucket.nextId += 1
    bucket.refs.set(hash, { id: bucket.nextId, bytes: target.text.length })
  }
}
