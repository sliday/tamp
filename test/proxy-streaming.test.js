import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { startMockUpstream, startProxy, rawRequest } from './helpers/proxy-harness.js'

// End-to-end coverage for response streaming and upstream-failure handling,
// driven through the real proxy via the integration harness.
describe('proxy streaming + upstream errors (integration)', () => {
  const cleanups = []
  after(async () => { for (const c of cleanups.reverse()) await c() })

  it('pipes a streamed SSE response back to the client intact', async () => {
    const up = await startMockUpstream(async (req, res) => {
      await req // drain
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: one\n\n')
      res.write('data: two\n\n')
      res.end('data: [DONE]\n\n')
    })
    const proxy = await startProxy({ upstream: up.url })
    cleanups.push(up.close, proxy.close)

    const r = await rawRequest(proxy.port, {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    })

    assert.equal(r.status, 200)
    assert.equal(r.reset, false)
    const text = r.body.toString('utf-8')
    assert.ok(text.includes('data: one'))
    assert.ok(text.includes('data: two'))
    assert.ok(text.includes('[DONE]'))
  })

  it('returns a clean 502 JSON error when the upstream is unreachable', async () => {
    // Start an upstream, capture its url, then close it so connects refuse.
    const dead = await startMockUpstream((req, res) => res.end('never'))
    const deadUrl = dead.url
    await dead.close()

    const proxy = await startProxy({ upstream: deadUrl })
    cleanups.push(proxy.close)

    const r = await rawRequest(proxy.port, {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    })

    assert.equal(r.status, 502)
    const payload = JSON.parse(r.body.toString('utf-8'))
    assert.equal(payload.error, 'upstream_error')
  })

  it('does not inject error JSON into an already-started stream', async () => {
    // Upstream sends headers + a partial chunk, then drops the socket
    // mid-stream. The client must never see an `upstream_error` blob spliced
    // onto the end of the event stream.
    const up = await startMockUpstream(async (req, res, ctx) => {
      await req
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: partial\n\n')
      // Give the chunk time to reach the client before tearing the socket down.
      setTimeout(() => ctx.dropAfter(res), 20)
    })
    const proxy = await startProxy({ upstream: up.url })
    cleanups.push(up.close, proxy.close)

    const r = await rawRequest(proxy.port, {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    })

    const text = r.body.toString('utf-8')
    assert.ok(!text.includes('upstream_error'), 'must not splice error JSON into a live stream')
  })
})
