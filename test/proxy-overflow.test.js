import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { startMockUpstream, startProxy, rawRequest } from './helpers/proxy-harness.js'

// When a request body exceeds maxBody, Tamp must pass it through UNCHANGED —
// too big to compress, so forward verbatim. Truncating the body while keeping
// the original content-length would corrupt the request / hang the upstream.
describe('large-body passthrough (integration)', () => {
  const cleanups = []
  after(async () => { for (const c of cleanups.reverse()) await c() })

  it('forwards the full body when it exceeds maxBody (no truncation)', { timeout: 15000 }, async () => {
    let receivedLen = -1
    const up = await startMockUpstream(async (req, res, ctx) => {
      const body = await ctx.body()
      receivedLen = body.length
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ receivedLen }))
    })
    // Tiny maxBody so the overflow path triggers after the first read, while
    // the body spans several socket reads (256KB >> highWaterMark).
    const proxy = await startProxy({ upstream: up.url, maxBody: 1000 })
    cleanups.push(up.close, proxy.close)

    const big = JSON.stringify({
      model: 'claude',
      messages: [{ role: 'user', content: 'x'.repeat(256 * 1024) }],
    })
    const sentLen = Buffer.byteLength(big)

    const r = await rawRequest(proxy.port, {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: big,
    })

    assert.equal(r.status, 200)
    assert.equal(receivedLen, sentLen, `upstream received ${receivedLen} of ${sentLen} bytes (truncated)`)
  })
})
