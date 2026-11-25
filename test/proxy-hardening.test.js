import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createProxy, sendUpstreamError, decompressZstd } from '../index.js'
import { CLASSIFIER_PATTERNS, detectTaskType } from '../lib/rules-generator.js'

function fakeReqRes(method, url, headers = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers

  let statusCode = null
  let responseHeaders = null
  const chunks = []
  let ended = false
  let resolveDone
  const done = new Promise((r) => { resolveDone = r })

  const res = new EventEmitter()
  res.headersSent = false
  res.writableEnded = false
  res.writeHead = (code, hdrs) => {
    statusCode = code
    responseHeaders = hdrs
    res.headersSent = true
  }
  res.end = (chunk) => {
    if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    ended = true
    res.writableEnded = true
    resolveDone({
      status: statusCode,
      headers: responseHeaders,
      body: Buffer.concat(chunks).toString('utf8'),
      ended,
    })
  }
  res.destroy = () => {
    resolveDone({ status: statusCode, headers: responseHeaders, body: Buffer.concat(chunks).toString('utf8'), ended })
  }

  return { req, res, done }
}

describe('CLASSIFIER_PATTERNS parity', () => {
  it('exports frozen safe/dangerous regex sources from lib/rules-generator.js', () => {
    assert.ok(Object.isFrozen(CLASSIFIER_PATTERNS))
    assert.ok(Object.isFrozen(CLASSIFIER_PATTERNS.safe))
    assert.ok(Object.isFrozen(CLASSIFIER_PATTERNS.dangerous))
    assert.ok(CLASSIFIER_PATTERNS.safe.length > 0)
    assert.ok(CLASSIFIER_PATTERNS.dangerous.length > 0)
    assert.equal(typeof CLASSIFIER_PATTERNS.complex, 'string')

    for (const src of [...CLASSIFIER_PATTERNS.safe, ...CLASSIFIER_PATTERNS.dangerous]) {
      assert.doesNotThrow(() => new RegExp(src, 'i'))
    }

    // Dangerous patterns must carry the real word-boundary guards (no drift)
    assert.ok(CLASSIFIER_PATTERNS.dangerous.some(s => s.includes('\\bsecurity\\b')))
    assert.ok(CLASSIFIER_PATTERNS.dangerous.some(s => s.includes('\\btest(s|ing)?\\b')))
    assert.equal(detectTaskType('use the latest version'), 'complex')
  })

  it('/caveman-help serves the exact CLASSIFIER_PATTERNS exported by lib/rules-generator.js', async () => {
    const proxy = createProxy({ log: false, stages: ['minify'] })
    const { req, res, done } = fakeReqRes('GET', '/caveman-help')
    proxy.server.emit('request', req, res)
    const out = await done
    assert.equal(out.status, 200)
    const payload = JSON.parse(out.body)
    assert.deepEqual(payload.taskClassifierRules, CLASSIFIER_PATTERNS)
    proxy.server.emit('close')
  })
})

describe('proxy hardening — per-proxy state & /health telemetry', () => {
  it('isolates sidecarState per proxy instance instead of sharing module global state', async () => {
    const a = createProxy({ log: false, stages: ['minify', 'llmlingua'] })
    const b = createProxy({ log: false, stages: ['minify', 'llmlingua'] })

    a.sidecarState.available = true
    assert.equal(b.sidecarState.available, false)

    const reqA = fakeReqRes('GET', '/health')
    a.server.emit('request', reqA.req, reqA.res)
    const healthA = JSON.parse((await reqA.done).body)

    const reqB = fakeReqRes('GET', '/health')
    b.server.emit('request', reqB.req, reqB.res)
    const healthB = JSON.parse((await reqB.done).body)

    assert.equal(healthA.sidecar, true)
    assert.equal(healthB.sidecar, false)

    const textA = fakeReqRes('GET', '/health?text')
    a.server.emit('request', textA.req, textA.res)
    assert.ok((await textA.done).body.includes('sidecar: ok'))

    const textB = fakeReqRes('GET', '/health?text')
    b.server.emit('request', textB.req, textB.res)
    assert.ok((await textB.done).body.includes('sidecar: not running'))

    a.server.emit('close')
    b.server.emit('close')
  })

  it('/health exposes redacted, staleImages, and staleInputs telemetry fields', async () => {
    const proxy = createProxy({ log: false, stages: ['minify'] })
    const { req, res, done } = fakeReqRes('GET', '/health')
    proxy.server.emit('request', req, res)
    const out = await done
    assert.equal(out.status, 200)
    const payload = JSON.parse(out.body)
    assert.equal(payload.redacted, 0)
    assert.deepEqual(payload.staleImages, { evicted: 0, chars: 0 })
    assert.deepEqual(payload.staleInputs, { pruned: 0 })
    assert.ok('usage' in payload)
    proxy.server.emit('close')
  })
})

describe('proxy hardening — sendUpstreamError & decompressZstd', () => {
  it('sendUpstreamError writes 502 JSON only before headers are sent', () => {
    const before = fakeReqRes('POST', '/v1/messages')
    assert.equal(sendUpstreamError(before.res), true)

    const afterHeaders = fakeReqRes('POST', '/v1/messages')
    afterHeaders.res.headersSent = true
    assert.equal(sendUpstreamError(afterHeaders.res), false)

    const afterEnd = fakeReqRes('POST', '/v1/messages')
    afterEnd.res.writableEnded = true
    assert.equal(sendUpstreamError(afterEnd.res), false)
  })

  it('decompressZstd throws on invalid frame or excess size', () => {
    assert.throws(() => decompressZstd(Buffer.from('not-zstd'), 1024))
  })
})
