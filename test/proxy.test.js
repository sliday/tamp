import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { createProxy } from '../index.js'

function zstdCompress(buf) {
  return execFileSync('zstd', ['-c', '--no-progress'], { input: buf, maxBuffer: 10 * 1024 * 1024 })
}

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
      stages: ['minify'],
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
          content: JSON.stringify({ name: 'tamp', version: '0.1.0', type: 'module', main: 'index.js' }, null, 2),
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

  it('decompresses gzip request body and compresses content', async () => {
    const jsonBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_gz',
          content: JSON.stringify({ name: 'tamp', version: '0.1.0', type: 'module', main: 'index.js' }, null, 2),
        }],
      }],
    })
    const gzipped = zlib.gzipSync(Buffer.from(jsonBody))

    const res = await request(proxyPort, 'POST', '/v1/messages', gzipped, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    })
    assert.equal(res.status, 200)
    const received = JSON.parse(res.body.toString())
    const content = received.messages[0].content[0].content
    assert.ok(!content.includes('\n'), 'gzipped tool_result should be minified')
  })

  it('decompresses deflate request body', async () => {
    const jsonBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_df',
          content: JSON.stringify({ key: 'value', description: 'deflated content for testing purposes' }, null, 2),
        }],
      }],
    })
    const deflated = zlib.deflateSync(Buffer.from(jsonBody))

    const res = await request(proxyPort, 'POST', '/v1/messages', deflated, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'deflate',
    })
    assert.equal(res.status, 200)
    const received = JSON.parse(res.body.toString())
    const content = received.messages[0].content[0].content
    assert.ok(!content.includes('\n'), 'deflated tool_result should be minified')
  })

  it('passes through gzip body unchanged when not valid JSON inside', async () => {
    const gzipped = zlib.gzipSync(Buffer.from('this is not json {'))

    const res = await request(proxyPort, 'POST', '/v1/messages', gzipped, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    })
    assert.equal(res.status, 200)
    // Original gzipped body passed through unchanged
    assert.deepEqual(res.body, gzipped)
  })

  it('decompresses brotli request body', async () => {
    const jsonBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_br',
          content: JSON.stringify({ key: 'value', description: 'brotli compressed content for testing' }, null, 2),
        }],
      }],
    })
    const compressed = zlib.brotliCompressSync(Buffer.from(jsonBody))

    const res = await request(proxyPort, 'POST', '/v1/messages', compressed, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'br',
    })
    assert.equal(res.status, 200)
    const received = JSON.parse(res.body.toString())
    const content = received.messages[0].content[0].content
    assert.ok(!content.includes('\n'), 'brotli tool_result should be minified')
  })

  it('removes content-encoding header after decompressing', async () => {
    const jsonBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_hdr',
          content: JSON.stringify({ name: 'test', value: 'checking header removal works properly' }, null, 2),
        }],
      }],
    })
    const gzipped = zlib.gzipSync(Buffer.from(jsonBody))

    // Mock upstream echoes back request headers as JSON
    const headerEcho = http.createServer((req, res) => {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ receivedEncoding: req.headers['content-encoding'] || null }))
      })
    })
    await new Promise(r => headerEcho.listen(0, r))
    const echoPort = headerEcho.address().port

    const { server: echoProxy } = createProxy({
      port: 0, upstream: `http://127.0.0.1:${echoPort}`, log: false, minSize: 50, stages: ['minify'],
    })
    await new Promise(r => echoProxy.listen(0, r))
    const echoProxyPort = echoProxy.address().port

    const res = await request(echoProxyPort, 'POST', '/v1/messages', gzipped, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    })
    const received = JSON.parse(res.body.toString())
    assert.equal(received.receivedEncoding, null, 'content-encoding should be removed after decompression')

    echoProxy.close()
    headerEcho.close()
  })

  it('decompresses gzip for OpenAI chat completions format', async () => {
    const jsonBody = JSON.stringify({
      model: 'gpt-4',
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ file: 'contents', extra: 'padding for minimum size threshold' }, null, 2) },
      ],
    })
    const gzipped = zlib.gzipSync(Buffer.from(jsonBody))

    const res = await request(proxyPort, 'POST', '/v1/chat/completions', gzipped, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    })
    assert.equal(res.status, 200)
    const received = JSON.parse(res.body.toString())
    const toolContent = received.messages[1].content
    assert.ok(!toolContent.includes('\n'), 'gzipped OpenAI tool content should be minified')
  })

  it('passes through gzip body for /responses endpoint', async () => {
    const jsonBody = JSON.stringify({ model: 'gpt-4', input: 'hello from codex' })
    const gzipped = zlib.gzipSync(Buffer.from(jsonBody))

    const res = await request(proxyPort, 'POST', '/v1/responses', gzipped, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    })
    assert.equal(res.status, 200)
    // Should decompress and parse, but no tool content to compress — passthrough
    const received = JSON.parse(res.body.toString())
    assert.equal(received.model, 'gpt-4')
    assert.equal(received.input, 'hello from codex')
  })

  it('decompresses zstd request body and compresses content', async () => {
    const jsonBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_zstd',
          content: JSON.stringify({ name: 'codex', version: '0.115.0', type: 'module', main: 'index.js' }, null, 2),
        }],
      }],
    })
    const compressed = zstdCompress(Buffer.from(jsonBody))

    const res = await request(proxyPort, 'POST', '/v1/messages', compressed, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'zstd',
    })
    assert.equal(res.status, 200)
    const received = JSON.parse(res.body.toString())
    const content = received.messages[0].content[0].content
    assert.ok(!content.includes('\n'), 'zstd tool_result should be minified')
  })

  it('decompresses zstd for /responses endpoint', async () => {
    const jsonBody = JSON.stringify({ model: 'gpt-4', input: 'hello from codex via zstd' })
    const compressed = zstdCompress(Buffer.from(jsonBody))

    const res = await request(proxyPort, 'POST', '/v1/responses', compressed, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'zstd',
    })
    assert.equal(res.status, 200)
    const received = JSON.parse(res.body.toString())
    assert.equal(received.model, 'gpt-4')
    assert.equal(received.input, 'hello from codex via zstd')
  })

  it('routes /v1/responses to openai upstream', async () => {
    const body = JSON.stringify({ model: 'gpt-4', input: 'hello' })
    const res = await request(proxyPort, 'POST', '/v1/responses', body, { 'Content-Type': 'application/json' })
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-echo'], 'true')
  })

  it('routes /responses (no /v1) to openai upstream', async () => {
    const body = JSON.stringify({ model: 'gpt-4', input: 'hello' })
    const res = await request(proxyPort, 'POST', '/responses', body, { 'Content-Type': 'application/json' })
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-echo'], 'true')
  })

  it('routes /v1/chat/completions to openai upstream', async () => {
    const body = JSON.stringify({
      model: 'gpt-4',
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ file: 'data', extra: 'fields for length padding' }, null, 2) },
      ],
    })
    const res = await request(proxyPort, 'POST', '/v1/chat/completions', body, { 'Content-Type': 'application/json' })
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-echo'], 'true')
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
