import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createProxy } from '../index.js'

let mockUpstream, mockPort, proxy, proxyPort

function request(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port, method, path, headers }
    const req = http.request(opts, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    if (body) req.end(body)
    else req.end()
  })
}

describe('proxy integration', () => {
  before(async () => {
    await new Promise(resolve => {
      mockUpstream = http.createServer((req, res) => {
        const chunks = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => {
          const body = Buffer.concat(chunks)
          res.writeHead(200, {
            'Content-Type': req.headers['content-type'] || 'application/json',
            'x-echo': 'true',
          })
          res.end(body)
        })
      })
      mockUpstream.listen(0, () => {
        mockPort = mockUpstream.address().port
        resolve()
      })
    })

    const { server } = createProxy({
      port: 0,
      upstream: `http://127.0.0.1:${mockPort}`,
      log: false,
      minSize: 50,
    })
    proxy = server
    await new Promise(resolve => {
      proxy.listen(0, () => {
        proxyPort = proxy.address().port
        resolve()
      })
    })
  })

  after(() => {
    proxy.close()
    mockUpstream.close()
  })

  it('compresses tool_result JSON in POST /v1/messages', async () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: JSON.stringify({ name: 'toona', version: '0.1.0', type: 'module', main: 'index.js' }, null, 2),
        }],
      }],
    })

    const res = await request(proxyPort, 'POST', '/v1/messages', body, { 'Content-Type': 'application/json' })
    assert.equal(res.status, 200)
    const received = JSON.parse(res.body.toString())
    const content = received.messages[0].content[0].content
    assert.ok(!content.includes('\n'), 'tool_result should be minified')
  })

  it('passes through GET requests unchanged', async () => {
    const res = await request(proxyPort, 'GET', '/v1/models')
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-echo'], 'true')
  })

  it('recalculates Content-Length and removes Transfer-Encoding', async () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_2',
          content: JSON.stringify({ key: 'value', description: 'a somewhat long description for testing' }, null, 2),
        }],
      }],
    })

    const res = await request(proxyPort, 'POST', '/v1/messages', body, {
      'Content-Type': 'application/json',
      'Transfer-Encoding': 'chunked',
    })
    assert.equal(res.status, 200)
  })

  it('passes through malformed JSON body unchanged', async () => {
    const body = 'this is not json {'
    const res = await request(proxyPort, 'POST', '/v1/messages', body, { 'Content-Type': 'application/json' })
    assert.equal(res.status, 200)
    assert.equal(res.body.toString(), body)
  })

  it('does not modify historical messages', async () => {
    const historicalContent = JSON.stringify({ old: 'data', value: 'should not be touched at all' }, null, 2)
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: historicalContent }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new', content: JSON.stringify({ fresh: 'data', extra: 'fields here for length' }, null, 2) }] },
      ],
    })

    const res = await request(proxyPort, 'POST', '/v1/messages', body, { 'Content-Type': 'application/json' })
    const received = JSON.parse(res.body.toString())
    assert.equal(received.messages[0].content[0].content, historicalContent)
  })

  it('streams SSE responses through', async () => {
    // Create an SSE mock upstream
    const sseUpstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.write('data: {"type":"start"}\n\n')
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise(r => sseUpstream.listen(0, r))
    const ssePort = sseUpstream.address().port

    const { server: sseProxy } = createProxy({
      port: 0,
      upstream: `http://127.0.0.1:${ssePort}`,
      log: false,
    })
    await new Promise(r => sseProxy.listen(0, r))
    const sseProxyPort = sseProxy.address().port

    const res = await request(sseProxyPort, 'GET', '/v1/messages')
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'text/event-stream')
    assert.ok(res.body.toString().includes('[DONE]'))

    sseProxy.close()
    sseUpstream.close()
  })
})
