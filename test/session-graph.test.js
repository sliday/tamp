import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSessionStore,
  deriveSessionKey,
  graphDeduplicateTargets,
} from '../session-graph.js'

const big = (marker, size = 1024) => marker.repeat(Math.ceil(size / marker.length)).slice(0, size)

describe('deriveSessionKey', () => {
  it('returns stable 16-char hex for same authorization header', () => {
    const a = deriveSessionKey({ authorization: 'Bearer sk-abc' })
    const b = deriveSessionKey({ authorization: 'Bearer sk-abc' })
    assert.equal(a, b)
    assert.match(a, /^[a-f0-9]{16}$/)
  })

  it('returns distinct keys for distinct auth headers', () => {
    const a = deriveSessionKey({ authorization: 'Bearer sk-one' })
    const b = deriveSessionKey({ authorization: 'Bearer sk-two' })
    assert.notEqual(a, b)
  })

  it('falls back to x-api-key when authorization is missing', () => {
    const key = deriveSessionKey({ 'x-api-key': 'claude-key-xyz' })
    assert.match(key, /^[a-f0-9]{16}$/)
  })

  it('returns null when no auth header present', () => {
    assert.equal(deriveSessionKey({}), null)
    assert.equal(deriveSessionKey(null), null)
  })
})

describe('createSessionStore', () => {
  it('returns same bucket for same key within TTL', () => {
    const store = createSessionStore()
    const a = store.getBucket('k1')
    const b = store.getBucket('k1')
    assert.equal(a, b)
  })

  it('returns distinct buckets for distinct keys', () => {
    const store = createSessionStore()
    const a = store.getBucket('k1')
    const b = store.getBucket('k2')
    assert.notEqual(a, b)
  })

  it('returns null for null/empty key', () => {
    const store = createSessionStore()
    assert.equal(store.getBucket(null), null)
    assert.equal(store.getBucket(''), null)
  })

  it('prune drops buckets older than TTL', async () => {
    const store = createSessionStore({ ttlMs: 10 })
    store.getBucket('k1')
    await new Promise(r => setTimeout(r, 20))
    store.prune()
    assert.equal(store._store.has('k1'), false)
  })

  it('evicts oldest when maxSessions exceeded', () => {
    const store = createSessionStore({ maxSessions: 2 })
    store.getBucket('a')
    store.getBucket('b')
    store.getBucket('c') // triggers eviction of 'a'
    assert.equal(store._store.has('a'), false)
    assert.equal(store._store.has('b'), true)
    assert.equal(store._store.has('c'), true)
  })
})

describe('graphDeduplicateTargets', () => {
  it('leaves first occurrence alone, replaces second with ref marker', () => {
    const store = createSessionStore()
    const bucket = store.getBucket('session-1')
    const content = big('a', 1024)

    const req1 = [{ text: content, index: 0 }]
    graphDeduplicateTargets(req1, bucket)
    assert.equal(req1[0].compressed, undefined)
    assert.equal(req1[0].graphed, undefined)

    const req2 = [{ text: content, index: 0 }]
    graphDeduplicateTargets(req2, bucket)
    assert.equal(req2[0].graphed, true)
    assert.match(req2[0].compressed, /^<tamp-file-ref id="1" sha="[a-f0-9]{12}" bytes="1024"\/>$/)
  })

  it('skips targets smaller than minBytes threshold', () => {
    const store = createSessionStore()
    const bucket = store.getBucket('s')
    const small = 'tiny output'

    graphDeduplicateTargets([{ text: small, index: 0 }], bucket)
    const r = [{ text: small, index: 0 }]
    graphDeduplicateTargets(r, bucket)
    assert.equal(r[0].graphed, undefined)
    assert.equal(r[0].compressed, undefined)
  })

  it('skips already-compressed, dedup, diffed, or skip targets', () => {
    const store = createSessionStore()
    const bucket = store.getBucket('s')
    const content = big('b', 1024)
    bucket.refs.set('precomputed', { id: 99, bytes: 1024 })

    const targets = [
      { text: content, index: 0, skip: 'error' },
      { text: content, index: 1, dedup: true, compressed: 'already' },
      { text: content, index: 2, diffed: true, compressed: 'already' },
      { text: content, index: 3, compressed: 'already' },
    ]
    graphDeduplicateTargets(targets, bucket)
    assert.equal(targets[0].graphed, undefined)
    assert.equal(targets[1].graphed, undefined)
    assert.equal(targets[2].graphed, undefined)
    assert.equal(targets[3].graphed, undefined)
  })

  it('isolates refs between distinct session buckets', () => {
    const store = createSessionStore()
    const b1 = store.getBucket('user-1')
    const b2 = store.getBucket('user-2')
    const content = big('c', 1024)

    graphDeduplicateTargets([{ text: content, index: 0 }], b1)
    const crossSession = [{ text: content, index: 0 }]
    graphDeduplicateTargets(crossSession, b2)
    assert.equal(crossSession[0].graphed, undefined, 'user-2 must not see user-1 content')
  })

  it('no-ops when bucket is null', () => {
    const targets = [{ text: big('d', 1024), index: 0 }]
    graphDeduplicateTargets(targets, null)
    assert.equal(targets[0].graphed, undefined)
    assert.equal(targets[0].compressed, undefined)
  })

  it('assigns sequential ref ids across distinct payloads', () => {
    const store = createSessionStore()
    const bucket = store.getBucket('s')
    const first = big('x', 1024)
    const second = big('y', 1024)

    graphDeduplicateTargets([{ text: first, index: 0 }], bucket)
    graphDeduplicateTargets([{ text: second, index: 0 }], bucket)

    const repeatFirst = [{ text: first, index: 0 }]
    graphDeduplicateTargets(repeatFirst, bucket)
    const repeatSecond = [{ text: second, index: 0 }]
    graphDeduplicateTargets(repeatSecond, bucket)

    assert.match(repeatFirst[0].compressed, /id="1"/)
    assert.match(repeatSecond[0].compressed, /id="2"/)
  })
})
