// Progressive disclosure for huge tool_result bodies (Phase 5).
//
// Given a tool_result text body >= 32 KB, emit a 3-tier summary in the
// outgoing turn (signature + head excerpt + ellipsis + tail excerpt + marker),
// and retain the full body in the br-cache (built in Phase 3). If the model
// later quotes the marker in a follow-up request, `rehydrateReferences`
// injects the full body back in before we forward upstream.
//
// Marker format - strict, regex-extractable, non-ambiguous:
//   <tamp-ref:v1:HEXHASH:BYTES>
// v1 = format version. BYTES = original body byte length.

import { createHash } from 'node:crypto'

export const REF_MARKER = /<tamp-ref:v1:([a-f0-9]{64}):(\d+)>/g

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function utf8Bytes(text) {
  return Buffer.byteLength(text, 'utf8')
}

// Slice by UTF-8 byte count without splitting a codepoint mid-sequence.
function sliceHeadBytes(text, bytes) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= bytes) return text
  let cut = bytes
  while (cut > 0 && (buf[cut] & 0xC0) === 0x80) cut -= 1
  return buf.slice(0, cut).toString('utf8')
}

function sliceTailBytes(text, bytes) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= bytes) return text
  let cut = buf.length - bytes
  while (cut < buf.length && (buf[cut] & 0xC0) === 0x80) cut += 1
  return buf.slice(cut).toString('utf8')
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/**
 * Build a 3-tier summary block for a large tool_result body.
 * Returns null if the body is smaller than minSize.
 * Shape: { summary, hash, originalBytes, summaryBytes }.
 */
export function summarize(text, { hash, minSize = 32 * 1024, headBytes = 2048, tailBytes = 1024 } = {}) {
  if (typeof text !== 'string') return null
  const originalBytes = utf8Bytes(text)
  if (originalBytes < minSize) return null

  const fullHash = hash || sha256(text)
  const head = sliceHeadBytes(text, headBytes)
  const tail = sliceTailBytes(text, tailBytes)
  const omitted = originalBytes - utf8Bytes(head) - utf8Bytes(tail)

  const signature = `[tamp-disclosure v1] ${formatSize(originalBytes)}, sha256:${fullHash.slice(0, 12)}... - quote <tamp-ref:v1:${fullHash}:${originalBytes}> to expand`
  const ellipsis = `\n[... ${formatSize(Math.max(0, omitted))} omitted ...]\n`
  const marker = `<tamp-ref:v1:${fullHash}:${originalBytes}>`

  const summary = `${signature}\n${head}${ellipsis}${tail}\n${marker}`
  return { summary, hash: fullHash, originalBytes, summaryBytes: utf8Bytes(summary) }
}

function freshMarkerRegex() {
  return new RegExp(REF_MARKER.source, REF_MARKER.flags)
}

/**
 * Scan a provider request body for <tamp-ref:v1:HASH:BYTES> markers that
 * the model quoted back. Returns an array of { hash, bytes, path, match }.
 * Path and shape are defined by the provider's findReferences method.
 */
export function findReferenceQuotes(body, provider) {
  if (typeof provider?.findReferences === 'function') {
    return provider.findReferences(body)
  }
  return []
}

/**
 * Rehydrate the previous turn's full body into the outgoing request.
 * For each reference quote found, look up the hash in brCache and replace
 * the marker with an expanded block. Safe no-op on cache miss.
 */
export function rehydrateReferences(body, provider, brCache) {
  if (!provider || !brCache || typeof brCache.get !== 'function') return { rehydrated: 0, missed: 0 }
  const refs = findReferenceQuotes(body, provider)
  if (!refs.length) return { rehydrated: 0, missed: 0 }

  const seen = new Map()
  let rehydrated = 0
  let missed = 0

  for (const ref of refs) {
    let entry = seen.get(ref.hash)
    if (!entry) {
      const full = brCache.get(ref.hash)
      if (full == null) {
        entry = { full: null }
      } else {
        const header = `<tamp-ref:v1:${ref.hash} expanded - ${utf8Bytes(full)} bytes follow>`
        entry = { full: `${header}\n${full}\n</tamp-ref expanded>` }
      }
      seen.set(ref.hash, entry)
    }
    if (entry.full == null) { missed += 1; ref.missed = true }
    else { rehydrated += 1; ref.expansion = entry.full }
  }

  if (rehydrated === 0) return { rehydrated: 0, missed }
  if (typeof provider.applyRehydration === 'function') {
    provider.applyRehydration(body, refs)
  }
  return { rehydrated, missed }
}

export const _internal = { sliceHeadBytes, sliceTailBytes, utf8Bytes, freshMarkerRegex, sha256 }
