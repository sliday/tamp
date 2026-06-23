import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { startMockUpstream, startProxy, rawRequest } from './helpers/proxy-harness.js'

// When Tamp decompresses a request, compresses its content, and re-serializes,
// the forwarded request must stay internally consistent for the upstream:
//   - content-encoding removed (body is now plain JSON, not gzip)
//   - content-length equals the actual forwarded byte count
//   - body is still valid JSON
// A mismatch here makes the upstream 400 or hang waiting for bytes.
describe('decompress -> recompress request integrity (integration)', () => {
  const cleanups = []
  after(async () => { for (const c of cleanups.reverse()) await c() })

  function bigJsonBody() {
    return JSON.stringify({
      model: 'claude',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 't1',
          content: JSON.stringify(
            { note: '   lots   of   spaces   ', rows: Array.from({ length: 60 }, (_, i) => ({ i, v: i * 2 })) },
            null,
            4,
          ),
        }],
      }],
    })
  }

  async function probe(encoding, encode) {
    let seen = {}
    const up = await startMockUpstream(async (req, res, ctx) => {
      const body = await ctx.body()
      let validJson = false
      try { JSON.parse(body.toString('utf8')); validJson = true } catch { /* */ }
      seen = {
        clenHeader: req.headers['content-length'],
        actualLen: body.length,
        encoding: req.headers['content-encoding'] || null,
        validJson,
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    const proxy = await startProxy({ upstream: up.url, stages: ['minify'], minSize: 10 })
    cleanups.push(up.close, proxy.close)

    const headers = { 'content-type': 'application/json' }
    if (encoding) headers['content-encoding'] = encoding
    const r = await rawRequest(proxy.port, {
      method: 'POST', path: '/v1/messages', headers, body: encode(bigJsonBody()),
    })
    assert.equal(r.status, 200)
    return seen
  }

  it('gzip request: strips encoding, content-length matches, body valid JSON', async () => {
    const seen = await probe('gzip', (s) => zlib.gzipSync(Buffer.from(s)))
    assert.equal(seen.encoding, null, 'content-encoding must be removed')
    assert.equal(String(seen.clenHeader), String(seen.actualLen), 'content-length must match body')
    assert.equal(seen.validJson, true)
  })

  it('identity request: content-length matches forwarded body', async () => {
    const seen = await probe(null, (s) => Buffer.from(s))
    assert.equal(String(seen.clenHeader), String(seen.actualLen), 'content-length must match body')
    assert.equal(seen.validJson, true)
  })
})
