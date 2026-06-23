import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sendUpstreamError } from '../index.js'

// A minimal fake of http.ServerResponse that records what the handler does.
function fakeRes({ headersSent = false, writableEnded = false } = {}) {
  const calls = { writeHead: [], end: [], destroyed: false }
  return {
    headersSent,
    writableEnded,
    writeHead(...args) { calls.writeHead.push(args) },
    end(...args) { calls.end.push(args) },
    destroy() { calls.destroyed = true },
    _calls: calls,
  }
}

describe('sendUpstreamError', () => {
  it('writes a clean 502 JSON body when no response has been sent yet', () => {
    const res = fakeRes({ headersSent: false })
    const wrote = sendUpstreamError(res)
    assert.equal(wrote, true)
    assert.equal(res._calls.writeHead.length, 1)
    assert.equal(res._calls.writeHead[0][0], 502)
    assert.equal(res._calls.end.length, 1)
    const payload = JSON.parse(res._calls.end[0][0])
    assert.equal(payload.error, 'upstream_error')
    assert.equal(res._calls.destroyed, false)
  })

  it('does NOT append JSON once the response has started streaming', () => {
    // Mid-stream upstream drop (e.g. ECONNRESET during an SSE response).
    // Appending JSON here would corrupt the event stream the client sees.
    const res = fakeRes({ headersSent: true })
    const wrote = sendUpstreamError(res)
    assert.equal(wrote, false)
    assert.equal(res._calls.writeHead.length, 0)
    assert.equal(res._calls.end.length, 0)
    assert.equal(res._calls.destroyed, true)
  })

  it('does NOT write again once the response is already ended', () => {
    const res = fakeRes({ headersSent: true, writableEnded: true })
    const wrote = sendUpstreamError(res)
    assert.equal(wrote, false)
    assert.equal(res._calls.end.length, 0)
    assert.equal(res._calls.destroyed, true)
  })
})
