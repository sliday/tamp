// Replay memo: remembers what tamp emitted for each tool_result so the same
// raw tool_result, re-sent as history in a later request, goes out
// byte-identical. Without it cacheSafe compresses (and redacts) a turn only
// while it is newest, so request N+1 forwards that turn raw: savings vanish,
// the prompt-cache prefix breaks, and a masked secret leaves unmasked.
//
// In-memory LRU bounded by the bytes of stored values. A value is a string,
// an array of content blocks (px-render), or null ("was sent unchanged").
// Raw text never enters the memo; callers key on its hash.

export const DEFAULT_REPLAY_MAX_BYTES = 64 * 1024 * 1024
const MAX_ANCHORS = 20_000

function valueBytes(value) {
  if (value === null || value === undefined) return 0
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

export function createReplayMemo({ maxBytes = DEFAULT_REPLAY_MAX_BYTES } = {}) {
  const store = new Map()
  let bytes = 0
  let evictions = 0

  function drop(key) {
    const entry = store.get(key)
    if (!entry) return
    bytes -= entry.size
    store.delete(key)
  }

  function get(key) {
    const entry = store.get(key)
    if (!entry) return undefined
    // Map insertion order is the LRU order: re-insert to mark as recent.
    store.delete(key)
    store.set(key, entry)
    return entry
  }

  function put(key, value, meta = {}) {
    drop(key)
    // Count the key too, so a flood of null entries stays bounded.
    const size = valueBytes(value) + key.length
    if (size > maxBytes) return false
    store.set(key, { value, meta, size })
    bytes += size
    while (bytes > maxBytes) {
      drop(store.keys().next().value)
      evictions += 1
    }
    return true
  }

  function stats() {
    return { entries: store.size, bytes, maxBytes, evictions }
  }

  // read-diff anchors: raw hash of the read that each cached file copy came
  // from, so a replayed diff can check its base is still in the request.
  const anchors = new Map()
  function setAnchor(key, hash) {
    anchors.delete(key)
    if (!hash) return
    anchors.set(key, hash)
    if (anchors.size > MAX_ANCHORS) anchors.delete(anchors.keys().next().value)
  }
  function getAnchor(key) {
    return anchors.get(key)
  }

  return { get, put, stats, setAnchor, getAnchor }
}
