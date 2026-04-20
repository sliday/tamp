// Session-scoped LRU cache of last-seen Read bodies, keyed by
// `sessionKey + ':' + path`. Used by the `read-diff` stage to replace a
// re-read of a known file with a unified diff against the prior copy.
// Map insertion order gives us LRU for free.

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 256

function makeKey(sessionKey, path) {
  return `${sessionKey}:${path}`
}

export function createReadCache({ maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS } = {}) {
  const store = new Map()
  let hits = 0
  let misses = 0

  function prune() {
    const cutoff = Date.now() - ttlMs
    for (const [k, entry] of store) {
      if (entry.lastSeen < cutoff) store.delete(k)
    }
  }

  function get(sessionKey, path) {
    if (!sessionKey || !path) return null
    prune()
    const key = makeKey(sessionKey, path)
    const entry = store.get(key)
    if (!entry) { misses += 1; return null }
    // Refresh LRU position.
    store.delete(key)
    entry.lastSeen = Date.now()
    store.set(key, entry)
    hits += 1
    return entry.text
  }

  function put(sessionKey, path, text) {
    if (!sessionKey || !path || typeof text !== 'string') return
    const key = makeKey(sessionKey, path)
    if (store.has(key)) store.delete(key)
    else if (store.size >= maxEntries) {
      const oldest = store.keys().next().value
      store.delete(oldest)
    }
    store.set(key, { text, lastSeen: Date.now() })
  }

  function stats() {
    return { entries: store.size, hits, misses }
  }

  return { get, put, stats, prune, _store: store }
}
