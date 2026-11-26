import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSidecarUvArgs, startSidecar, resolveNonInteractiveConfig } from '../bin/tamp.js'
import { createProxy, probeSidecar, formatSidecarStartHint } from '../index.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function fakeReqRes(method, url, headers = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers

  let statusCode = null
  let responseHeaders = null
  const chunks = []
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
    res.writableEnded = true
    resolveDone({
      status: statusCode,
      headers: responseHeaders,
      body: Buffer.concat(chunks).toString('utf8'),
    })
  }
  res.destroy = () => {
    resolveDone({ status: statusCode, headers: responseHeaders, body: Buffer.concat(chunks).toString('utf8') })
  }

  return { req, res, done }
}

async function startStubServer(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function getClosedPort() {
  const s = http.createServer()
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))
  const { port } = s.address()
  await new Promise((resolve) => s.close(resolve))
  return port
}

describe('AC1: platform-gated --with mlx in bin/tamp.js uv spawn args', () => {
  it('includes --with mlx only on darwin + arm64', () => {
    assert.deepEqual(
      buildSidecarUvArgs(8788, { platform: 'darwin', arch: 'arm64' }),
      [
        'run', '--with', 'fastapi', '--with', 'uvicorn', '--with', 'llmlingua', '--with', 'mlx',
        'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', '8788',
      ]
    )
  })

  for (const [platform, arch] of [
    ['darwin', 'x64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['win32', 'x64'],
  ]) {
    it(`omits --with mlx on ${platform} + ${arch} while preserving base args and 127.0.0.1 bind`, () => {
      const args = buildSidecarUvArgs(9100, { platform, arch })
      assert.deepEqual(args, [
        'run', '--with', 'fastapi', '--with', 'uvicorn', '--with', 'llmlingua',
        'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', '9100',
      ])
      assert.equal(args.includes('mlx'), false)
    })
  }
})

describe('AC2: platform-gated --with mlx in index.js manual start hint', () => {
  it('includes --with mlx on darwin + arm64 and binds 127.0.0.1', () => {
    const hint = formatSidecarStartHint({ platform: 'darwin', arch: 'arm64' })
    assert.match(hint, /--with mlx\b/)
    assert.match(hint, /--host 127\.0\.0\.1\b/)
    assert.doesNotMatch(hint, /0\.0\.0\.0/)
  })

  for (const [platform, arch] of [
    ['darwin', 'x64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['win32', 'x64'],
  ]) {
    it(`omits --with mlx on ${platform} + ${arch} and binds 127.0.0.1`, () => {
      const hint = formatSidecarStartHint({ platform, arch })
      assert.doesNotMatch(hint, /--with mlx\b/)
      assert.match(hint, /--with fastapi --with uvicorn --with llmlingua uvicorn server:app --host 127\.0\.0\.1 --port 8788 --app-dir sidecar/)
      assert.doesNotMatch(hint, /0\.0\.0\.0/)
    })
  }

  it('logs the platform-appropriate hint when probeSidecar cannot reach sidecar (quiet=false)', async () => {
    const closedPort = await getClosedPort()
    const origError = console.error
    const logged = []
    console.error = (...args) => logged.push(args.join(' '))
    try {
      const stateLinux = { available: false }
      const okLinux = await probeSidecar(
        { llmLinguaUrl: `http://127.0.0.1:${closedPort}` },
        stateLinux,
        { quiet: false, platform: 'linux', arch: 'x64', timeoutMs: 500 }
      )
      assert.equal(okLinux, false)
      const linuxOut = logged.join('\n')
      assert.match(linuxOut, /start with: uv run --with fastapi --with uvicorn --with llmlingua uvicorn server:app --host 127\.0\.0\.1/)
      assert.doesNotMatch(linuxOut, /--with mlx/)

      logged.length = 0
      const stateArm = { available: false }
      const okArm = await probeSidecar(
        { llmLinguaUrl: `http://127.0.0.1:${closedPort}` },
        stateArm,
        { quiet: false, platform: 'darwin', arch: 'arm64', timeoutMs: 500 }
      )
      assert.equal(okArm, false)
      const armOut = logged.join('\n')
      assert.match(armOut, /start with: uv run --with fastapi --with uvicorn --with llmlingua --with mlx uvicorn server:app --host 127\.0\.0\.1/)
    } finally {
      console.error = origError
    }
  })
})

describe('AC3: startSidecar() honors configured TAMP_LLMLINGUA_URL with loopback enforcement', () => {
  const envKeys = ['TAMP_LLMLINGUA_URL', 'TAMP_CONFIG', 'TAMP_STAGES']
  const savedEnv = {}
  const tempDirs = []

  function snapshotEnv() {
    for (const k of envKeys) savedEnv[k] = process.env[k]
  }

  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    while (tempDirs.length) {
      try { rmSync(tempDirs.pop(), { recursive: true, force: true }) } catch {}
    }
  })

  it('returns normalized configured URL from env without probing or spawning port 8788', async () => {
    snapshotEnv()
    process.env.TAMP_LLMLINGUA_URL = 'http://127.0.0.1:9876///'
    // Interactive SidecarLoader calls startSidecar() with no args
    const url = await startSidecar()
    assert.equal(url, 'http://127.0.0.1:9876')
  })

  it('supports IPv6 loopback URLs and normalizes trailing slashes', async () => {
    const url = await startSidecar({ env: { TAMP_LLMLINGUA_URL: 'http://[::1]:9877/' } })
    assert.equal(url, 'http://[::1]:9877')
  })

  it('honors TAMP_LLMLINGUA_URL from TAMP_CONFIG file when env is unset', async () => {
    snapshotEnv()
    delete process.env.TAMP_LLMLINGUA_URL
    const dir = mkdtempSync(join(tmpdir(), 'tamp-sidecar-cfg-'))
    tempDirs.push(dir)
    const cfgPath = join(dir, 'config')
    writeFileSync(cfgPath, 'TAMP_LLMLINGUA_URL=http://localhost:9888/\n')
    process.env.TAMP_CONFIG = cfgPath

    const url = await startSidecar()
    assert.equal(url, 'http://localhost:9888')
  })

  it('gives env TAMP_LLMLINGUA_URL precedence over config file', async () => {
    snapshotEnv()
    const dir = mkdtempSync(join(tmpdir(), 'tamp-sidecar-cfg-'))
    tempDirs.push(dir)
    const cfgPath = join(dir, 'config')
    writeFileSync(cfgPath, 'TAMP_LLMLINGUA_URL=http://localhost:9111\n')
    process.env.TAMP_CONFIG = cfgPath
    process.env.TAMP_LLMLINGUA_URL = 'http://127.0.0.1:9222/'

    const url = await startSidecar()
    assert.equal(url, 'http://127.0.0.1:9222')
  })

  it('fails closed (returns null, no fallback to 8788) for non-loopback or malformed URLs', async () => {
    for (const bad of [
      'http://evil.example.com:8788',
      'https://169.254.169.254/latest',
      'http://127.evil.com:8788',
      'ftp://127.0.0.1:8788',
      'not-a-valid-url',
    ]) {
      const url = await startSidecar({ env: { TAMP_LLMLINGUA_URL: bad } })
      assert.equal(url, null, `expected null for ${bad}`)
    }
  })

  it('resolveNonInteractiveConfig passes through resolved sidecar URL without mutating process.env', async () => {
    snapshotEnv()
    delete process.env.TAMP_LLMLINGUA_URL
    delete process.env.TAMP_STAGES

    let readyUrl = null
    const res = await resolveNonInteractiveConfig({
      env: { TAMP_STAGES: 'minify,llmlingua', TAMP_LLMLINGUA_URL: 'http://127.0.0.1:9444/' },
      onSidecarReady: (url) => { readyUrl = url },
    })
    assert.equal(readyUrl, 'http://127.0.0.1:9444')
    assert.equal(res.overrides.llmLinguaUrl, 'http://127.0.0.1:9444')
    assert.equal(res.selectedStages.includes('llmlingua'), true)
    assert.equal(process.env.TAMP_LLMLINGUA_URL, undefined)
    assert.equal(process.env.TAMP_STAGES, undefined)
  })

  it('resolveNonInteractiveConfig strips llmlingua when configured TAMP_LLMLINGUA_URL is non-loopback', async () => {
    snapshotEnv()
    delete process.env.TAMP_LLMLINGUA_URL
    delete process.env.TAMP_STAGES

    let unavailable = false
    const res = await resolveNonInteractiveConfig({
      env: { TAMP_STAGES: 'minify,llmlingua', TAMP_LLMLINGUA_URL: 'https://remote.example.com:8788' },
      onSidecarUnavailable: () => { unavailable = true },
    })
    assert.equal(unavailable, true)
    assert.equal(res.selectedStages.includes('llmlingua'), false)
    assert.equal(res.overrides.llmLinguaUrl, undefined)
    assert.equal(process.env.TAMP_LLMLINGUA_URL, undefined)
    assert.equal(process.env.TAMP_STAGES, undefined)
  })

  it('non-interactive onSidecarReady displays the resolved url instead of hardcoded :8788', () => {
    const src = readFileSync(join(ROOT, 'bin', 'tamp.js'), 'utf8')
    assert.doesNotMatch(src, /LLMLingua-2 ready on :.*8788/)
    assert.match(src, /onSidecarReady:\s*\(url\)\s*=>/)
  })
})

describe('AC4: probeSidecar checks model_loaded, enforces loopback, and is awaitable/bounded', () => {
  const servers = []
  afterEach(async () => {
    while (servers.length) await servers.pop().close()
  })

  it('rejects non-loopback target URLs without issuing network I/O', async () => {
    const state = { available: true }
    const ok = await probeSidecar({ llmLinguaUrl: 'https://remote.example.com:8788' }, state, { quiet: true })
    assert.equal(ok, false)
    assert.equal(state.available, false)
  })

  it('interprets HTTP 200 model_loaded boolean (false -> false, true -> true)', async () => {
    let modelLoaded = false
    const stub = await startStubServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', model_loaded: modelLoaded }))
    })
    servers.push(stub)

    const state = { available: false }
    assert.equal(await probeSidecar({ llmLinguaUrl: stub.url }, state, { quiet: true }), false)
    assert.equal(state.available, false)

    modelLoaded = true
    assert.equal(await probeSidecar({ llmLinguaUrl: stub.url }, state, { quiet: true }), true)
    assert.equal(state.available, true)
  })

  it('treats HTTP 200 without model_loaded or with empty/non-JSON body as available (backwards-compatible)', async () => {
    let mode = 'json-no-field'
    const stub = await startStubServer((req, res) => {
      if (mode === 'json-no-field') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
      } else if (mode === 'empty') {
        res.writeHead(200)
        res.end()
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok')
      }
    })
    servers.push(stub)

    for (const m of ['json-no-field', 'empty', 'plain-text']) {
      mode = m
      const state = { available: false }
      assert.equal(await probeSidecar({ llmLinguaUrl: stub.url }, state, { quiet: true }), true, `mode=${m}`)
      assert.equal(state.available, true)
    }
  })

  it('bounds response body size and fails safely on oversized 200 body', async () => {
    const stub = await startStubServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('x'.repeat(2048))
    })
    servers.push(stub)

    const state = { available: true }
    const ok = await probeSidecar({ llmLinguaUrl: stub.url }, state, { quiet: true, maxBytes: 256 })
    assert.equal(ok, false)
    assert.equal(state.available, false)
  })

  it('returns false on non-200 status, connection refused, and bounded timeout', async () => {
    const stub503 = await startStubServer((req, res) => {
      res.writeHead(503)
      res.end('loading')
    })
    servers.push(stub503)
    const s1 = { available: true }
    assert.equal(await probeSidecar({ llmLinguaUrl: stub503.url }, s1, { quiet: true }), false)
    assert.equal(s1.available, false)

    const closedPort = await getClosedPort()
    const s2 = { available: true }
    assert.equal(await probeSidecar({ llmLinguaUrl: `http://127.0.0.1:${closedPort}` }, s2, { quiet: true }), false)
    assert.equal(s2.available, false)

    let openRes = null
    const slowStub = await startStubServer((req, res) => {
      openRes = res
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // Intentionally never end before timeout
    })
    servers.push(slowStub)
    const s3 = { available: true }
    const t0 = Date.now()
    const ok = await probeSidecar({ llmLinguaUrl: slowStub.url }, s3, { quiet: true, timeoutMs: 120 })
    const elapsed = Date.now() - t0
    if (openRes && !openRes.writableEnded) openRes.destroy()
    assert.equal(ok, false)
    assert.equal(s3.available, false)
    assert.ok(elapsed < 1000, `expected bounded timeout, took ${elapsed}ms`)
  })
})

describe('AC5: live, bounded/debounced sidecar refresh on /health and /health?text', () => {
  const servers = []
  afterEach(async () => {
    while (servers.length) await servers.pop().close()
  })

  it('transitions false -> true -> false across /health and /health?text while debouncing within TTL', async () => {
    let modelLoaded = false
    let hits = 0
    const stub = await startStubServer((req, res) => {
      if (req.url === '/health') hits++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', model_loaded: modelLoaded }))
    })
    servers.push(stub)

    const proxy = createProxy({
      log: false,
      stages: ['minify', 'llmlingua'],
      llmLinguaUrl: stub.url,
      sidecarProbeTtlMs: 80,
      sidecarProbeTimeoutMs: 500,
    })

    try {
      // Initial request awaits in-flight startup probe (no duplicate hit)
      const r1 = fakeReqRes('GET', '/health')
      proxy.server.emit('request', r1.req, r1.res)
      const h1 = JSON.parse((await r1.done).body)
      assert.equal(h1.sidecar, false)
      assert.equal(hits, 1)

      // Within TTL: /health?text uses cached result, no extra probe
      const t1 = fakeReqRes('GET', '/health?text')
      proxy.server.emit('request', t1.req, t1.res)
      const text1 = (await t1.done).body
      assert.ok(text1.includes('sidecar: not running'))
      assert.equal(hits, 1)

      // Flip sidecar to ready and wait past TTL
      modelLoaded = true
      await new Promise((r) => setTimeout(r, 100))

      const r2 = fakeReqRes('GET', '/health')
      proxy.server.emit('request', r2.req, r2.res)
      const h2 = JSON.parse((await r2.done).body)
      assert.equal(h2.sidecar, true)
      assert.equal(hits, 2)

      const t2 = fakeReqRes('GET', '/health?text')
      proxy.server.emit('request', t2.req, t2.res)
      const text2 = (await t2.done).body
      assert.ok(text2.includes('sidecar: ok'))
      assert.equal(hits, 2)

      // HEAD /health also works cleanly
      const headReq = fakeReqRes('HEAD', '/health')
      proxy.server.emit('request', headReq.req, headReq.res)
      const headOut = await headReq.done
      assert.equal(headOut.status, 200)
      assert.equal(headOut.body, '')

      // Flip back to model_loaded: false and wait past TTL
      modelLoaded = false
      await new Promise((r) => setTimeout(r, 100))

      const t3 = fakeReqRes('GET', '/health?text')
      proxy.server.emit('request', t3.req, t3.res)
      const text3 = (await t3.done).body
      assert.ok(text3.includes('sidecar: not running'))
      assert.equal(hits, 3)

      const r3 = fakeReqRes('GET', '/health')
      proxy.server.emit('request', r3.req, r3.res)
      const h3 = JSON.parse((await r3.done).body)
      assert.equal(h3.sidecar, false)
      assert.equal(hits, 3)

      // Stop sidecar completely and wait past TTL -> stays false
      await stub.close()
      servers.pop()
      await new Promise((r) => setTimeout(r, 100))

      const r4 = fakeReqRes('GET', '/health')
      proxy.server.emit('request', r4.req, r4.res)
      const h4 = JSON.parse((await r4.done).body)
      assert.equal(h4.sidecar, false)
    } finally {
      proxy.server.emit('close')
    }
  })

  it('coalesces concurrent /health requests into a single in-flight probe', async () => {
    let hits = 0
    const stub = await startStubServer((req, res) => {
      hits++
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', model_loaded: true }))
      }, 60)
    })
    servers.push(stub)

    const proxy = createProxy({
      log: false,
      stages: ['minify', 'llmlingua'],
      llmLinguaUrl: stub.url,
      sidecarProbeTtlMs: 50,
      sidecarProbeTimeoutMs: 500,
    })

    try {
      // Wait for initial startup probe to finish, then let TTL expire
      await proxy.sidecarState.inFlight
      assert.equal(hits, 1)
      await new Promise((r) => setTimeout(r, 70))

      // Fire 4 concurrent /health + /health?text requests
      const reqs = [
        fakeReqRes('GET', '/health'),
        fakeReqRes('GET', '/health?text'),
        fakeReqRes('GET', '/health'),
        fakeReqRes('HEAD', '/health'),
      ]
      for (const r of reqs) proxy.server.emit('request', r.req, r.res)
      const results = await Promise.all(reqs.map(r => r.done))

      assert.equal(hits, 2, 'concurrent requests must share a single probe')
      assert.equal(JSON.parse(results[0].body).sidecar, true)
      assert.ok(results[1].body.includes('sidecar: ok'))
      assert.equal(JSON.parse(results[2].body).sidecar, true)
      assert.equal(results[3].status, 200)
    } finally {
      proxy.server.emit('close')
    }
  })

  it('does not probe when llmlingua is not in stages and reports sidecar: n/a', async () => {
    let hits = 0
    const stub = await startStubServer((req, res) => {
      hits++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', model_loaded: true }))
    })
    servers.push(stub)

    const proxy = createProxy({
      log: false,
      stages: ['minify'],
      llmLinguaUrl: stub.url,
      sidecarProbeTtlMs: 0,
    })

    try {
      const r = fakeReqRes('GET', '/health?text')
      proxy.server.emit('request', r.req, r.res)
      const out = await r.done
      assert.ok(out.body.includes('sidecar: n/a'))
      assert.equal(hits, 0)
    } finally {
      proxy.server.emit('close')
    }
  })

  it('maintains per-proxy isolation across live probes', async () => {
    const stubUp = await startStubServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', model_loaded: true }))
    })
    const stubLoading = await startStubServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', model_loaded: false }))
    })
    servers.push(stubUp, stubLoading)

    const proxyA = createProxy({ log: false, stages: ['minify', 'llmlingua'], llmLinguaUrl: stubUp.url, sidecarProbeTtlMs: 500 })
    const proxyB = createProxy({ log: false, stages: ['minify', 'llmlingua'], llmLinguaUrl: stubLoading.url, sidecarProbeTtlMs: 500 })

    try {
      const rA = fakeReqRes('GET', '/health')
      const rB = fakeReqRes('GET', '/health')
      proxyA.server.emit('request', rA.req, rA.res)
      proxyB.server.emit('request', rB.req, rB.res)

      assert.equal(JSON.parse((await rA.done).body).sidecar, true)
      assert.equal(JSON.parse((await rB.done).body).sidecar, false)
    } finally {
      proxyA.server.emit('close')
      proxyB.server.emit('close')
    }
  })
})
