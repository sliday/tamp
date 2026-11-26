import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startMockUpstream, startProxy, rawRequest } from './helpers/proxy-harness.js'

const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":900,"cache_creation_input_tokens":88,"output_tokens":1}}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":40}}',
  '',
  '',
].join('\n')

const big = JSON.stringify({ rows: Array.from({ length: 60 }, (_, i) => ({ id: i, name: 'row-' + i })) }, null, 2)
const turn1 = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: big }] }
const head = [
  { role: 'user', content: [{ type: 'text', text: 'look at the rows' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: {} }] },
]
const post = (port, messages) => rawRequest(port, {
  method: 'POST',
  path: '/v1/messages',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'claude-sonnet-5-5', messages }),
})

describe('proxy usage telemetry and replay, end to end', () => {
  it('reads cache counters off the response without changing it', async () => {
    const up = await startMockUpstream(async (req, res, ctx) => {
      await ctx.body()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(SSE.slice(0, 70))
      res.end(SSE.slice(70))
    })
    const proxy = await startProxy({ upstream: up.url })
    try {
      const r = await post(proxy.port, [...head, turn1])
      assert.equal(r.body.toString(), SSE)
      const health = JSON.parse((await rawRequest(proxy.port, { path: '/health' })).body.toString())
      assert.deepEqual(health.usage, {
        requests: 1,
        inputTokens: 12,
        outputTokens: 40,
        cacheReadTokens: 900,
        cacheCreationTokens: 88,
        cacheHitRate: 0.9,
      })
    } finally {
      await proxy.close(); await up.close()
    }
  })

  it('stops reading the upstream once the client is gone', async () => {
    // The tap listens on 'data'; without the detach a dead client's stream
    // would be drained forever instead of back-pressuring the upstream.
    let written = 0
    let stop = false
    const up = await startMockUpstream(async (req, res, ctx) => {
      await ctx.body()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = Buffer.alloc(64 * 1024, 0x20)
      const pump = () => {
        if (stop) return
        written += chunk.length
        if (res.write(chunk)) setImmediate(pump)
        else res.once('drain', pump)
      }
      pump()
    })
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const proxy = await startProxy({ upstream: up.url })
    try {
      const req = http.request({ hostname: '127.0.0.1', port: proxy.port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json' } }, (res) => {
        res.once('data', () => req.destroy())
      })
      req.on('error', () => {})
      req.end(JSON.stringify({ model: 'claude-sonnet-5-5', messages: head }))
      await wait(300)
      const settled = written
      await wait(300)
      assert.equal(written, settled, 'upstream writes stalled after the client left')
    } finally {
      stop = true
      up.server.closeAllConnections(); proxy.server.closeAllConnections()
      await proxy.close(); await up.close()
    }
  })

  it('sends an older turn upstream with the same bytes on the next request', async () => {
    const seen = []
    const up = await startMockUpstream(async (req, res, ctx) => {
      seen.push(JSON.parse((await ctx.body()).toString()))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    const proxy = await startProxy({ upstream: up.url })
    try {
      await post(proxy.port, [...head, turn1])
      await post(proxy.port, [
        ...head, turn1,
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: big.replace('row-0', 'row-zero') }] },
      ])
      const first = seen[0].messages[2].content[0].content
      assert.ok(first.length < big.length, 'newest turn was compressed in request 1')
      assert.equal(seen[1].messages[2].content[0].content, first)
      const health = JSON.parse((await rawRequest(proxy.port, { path: '/health' })).body.toString())
      assert.equal(health.replay.hits, 1)
    } finally {
      await proxy.close(); await up.close()
    }
  })

  it('invokes config.onUsage with (snapshot, usage) on streamed responses', async () => {
    const calls = []
    const up = await startMockUpstream(async (req, res, ctx) => {
      await ctx.body()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(SSE.slice(0, 70))
      res.end(SSE.slice(70))
    })
    const proxy = await startProxy({
      upstream: up.url,
      onUsage: (snapshot, u) => calls.push({ snapshot, u }),
    })
    try {
      const r = await post(proxy.port, [...head, turn1])
      assert.equal(r.body.toString(), SSE)
      assert.equal(calls.length, 1)
      assert.deepEqual(calls[0].snapshot, {
        requests: 1,
        inputTokens: 12,
        outputTokens: 40,
        cacheReadTokens: 900,
        cacheCreationTokens: 88,
        cacheHitRate: 0.9,
      })
      assert.deepEqual(calls[0].u, {
        provider: 'anthropic',
        inputTokens: 12,
        outputTokens: 40,
        cacheReadTokens: 900,
        cacheCreationTokens: 88,
      })
    } finally {
      await proxy.close(); await up.close()
    }
  })

  it('isolates throwing config.onUsage without disrupting response streaming or usage totals', async () => {
    let called = 0
    const up = await startMockUpstream(async (req, res, ctx) => {
      await ctx.body()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(SSE)
    })
    const proxy = await startProxy({
      upstream: up.url,
      onUsage: () => {
        called++
        throw new Error('boom from interactive telemetry')
      },
    })
    try {
      const r = await post(proxy.port, [...head, turn1])
      assert.equal(r.status, 200)
      assert.equal(r.body.toString(), SSE)
      assert.equal(called, 1)
      const health = JSON.parse((await rawRequest(proxy.port, { path: '/health' })).body.toString())
      assert.equal(health.usage.requests, 1)
      assert.equal(health.usage.cacheHitRate, 0.9)
    } finally {
      await proxy.close(); await up.close()
    }
  })
})
