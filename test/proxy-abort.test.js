import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { startMockUpstream, startProxy } from './helpers/proxy-harness.js'

// A client that disconnects mid-upload (Ctrl-C, network blip) must not crash
// the proxy. The request-body read is async; an unguarded abort rejects the
// handler -> unhandledRejection -> Node terminates the process, killing every
// in-flight request. The proxy must drop the aborted request and stay up.
describe('client abort during request body (integration)', () => {
  const cleanups = []
  const rejections = []
  const onRej = (e) => rejections.push(e)

  before(() => process.on('unhandledRejection', onRej))
  after(() => {
    process.removeListener('unhandledRejection', onRej)
    return Promise.all(cleanups.reverse().map((c) => c()))
  })

  it('does not raise an unhandled rejection and keeps serving', async () => {
    const up = await startMockUpstream((req, res) => res.end('{}'))
    const proxy = await startProxy({ upstream: up.url })
    cleanups.push(up.close, proxy.close)

    await new Promise((resolve) => {
      const sock = net.connect(proxy.port, '127.0.0.1', () => {
        // Declare a large body, send only part, then hard-abort the socket.
        sock.write(
          'POST /v1/messages HTTP/1.1\r\nHost: x\r\n' +
          'Content-Type: application/json\r\nContent-Length: 100000\r\n\r\n',
        )
        sock.write('{"model":"claude","messages":[{"role":"user","content":"' + 'x'.repeat(2000))
        setTimeout(() => { sock.destroy(); resolve() }, 60)
      })
      sock.on('error', () => {})
    })

    // Give the aborted handler time to settle.
    await new Promise((r) => setTimeout(r, 300))

    assert.equal(rejections.length, 0, `unhandled rejection(s): ${rejections.map((e) => e?.code || e?.message).join(', ')}`)
    assert.equal(proxy.server.listening, true, 'proxy must still be listening')
  })

  it('survives a client abort on the passthrough (non-provider) path', async () => {
    const up = await startMockUpstream((req, res) => res.end('ok'))
    const proxy = await startProxy({ upstream: up.url })
    cleanups.push(up.close, proxy.close)
    const before = rejections.length

    await new Promise((resolve) => {
      const sock = net.connect(proxy.port, '127.0.0.1', () => {
        // A path no provider matches -> pipeRequest(req.pipe(upstream)).
        sock.write('POST /not/a/provider HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\n')
        sock.write('x'.repeat(2000))
        setTimeout(() => { sock.destroy(); resolve() }, 60)
      })
      sock.on('error', () => {})
    })

    await new Promise((r) => setTimeout(r, 300))

    assert.equal(rejections.length, before, 'no new unhandled rejection on passthrough abort')
    assert.equal(proxy.server.listening, true, 'proxy must still be listening')
  })
})
