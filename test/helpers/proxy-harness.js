// Integration test harness for the Tamp proxy.
//
// Lets a test stand up the real proxy (createProxy) in front of a scriptable
// mock upstream, then drive raw HTTP requests through it and inspect exactly
// what the client sees — including partial bodies and connection resets. This
// is what makes end-to-end TDD possible for streaming, retries, aborts, and
// upstream-failure paths that a plain echo server can't express.
//
// Usage:
//   const up = await startMockUpstream((req, res) => { ... })
//   const proxy = await startProxy({ upstream: up.url })
//   const r = await rawRequest(proxy.port, { method: 'POST', path: '/v1/messages', body })
//   ...
//   await proxy.close(); await up.close()

import http from 'node:http'
import { createProxy } from '../../index.js'

// Start a mock upstream HTTP server. `handler(req, res, ctx)` runs per request.
// ctx exposes helpers for the awkward cases real upstreams produce:
//   ctx.body()              -> Promise<Buffer> of the full request body
//   ctx.dropAfter(res, buf) -> write `buf`, then hard-destroy the socket
//                              (simulates a mid-stream ECONNRESET)
export async function startMockUpstream(handler) {
  const server = http.createServer((req, res) => {
    const ctx = {
      body: () => new Promise((resolve) => {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => resolve(Buffer.concat(chunks)))
      }),
      dropAfter: (response, buf) => {
        if (buf) response.write(buf)
        // Tear the underlying socket down without a clean FIN.
        response.socket?.destroy()
      },
    }
    Promise.resolve(handler(req, res, ctx)).catch((err) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(err?.message || err))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// Start the real proxy. Defaults keep logging off and a tiny minSize so test
// bodies actually exercise the compression path. Override anything via opts.
export async function startProxy(opts = {}) {
  const { server, config } = createProxy({
    port: 0,
    log: false,
    minSize: 50,
    stages: ['minify'],
    ...opts,
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    config,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// Make a raw request and capture exactly what the client observes. Unlike a
// normal client, this never rejects on a mid-stream reset — it resolves with
// whatever bytes arrived plus a `reset` flag, so tests can assert on partial
// streams and torn connections.
export function rawRequest(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        reset: false,
      }))
      res.on('error', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        reset: true,
      }))
    })
    // Connection-level failure before any response (e.g. proxy down).
    req.on('error', (err) => {
      if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
        resolve({ status: 0, headers: {}, body: Buffer.alloc(0), reset: true, error: err.code })
        return
      }
      reject(err)
    })
    if (body) req.end(body)
    else req.end()
  })
}
