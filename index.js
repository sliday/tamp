import http from 'node:http'
import https from 'node:https'
import { appendFileSync } from 'node:fs'
import zlib from 'node:zlib'
import * as fzstd from 'fzstd'
import { loadConfig } from './config.js'
import { compressRequest, isLoopbackUrl } from './compress.js'
import { detectProvider, detectOpenAIAuthMode, resolveOpenAIUpstream } from './providers.js'
import { createSession, formatRequestLog, redactUrl } from './stats.js'
import { createSessionStore, deriveSessionKey } from './session-graph.js'
import { createReadCache } from './lib/read-cache.js'
import { createBrCache } from './lib/br-cache.js'
import { createReplayMemo } from './lib/replay-memo.js'
import { createUsageTap, createUsageTotals } from './lib/usage-tap.js'
import { generateOutputRules, PER_AGENT_OVERRIDES, CLASSIFIER_PATTERNS } from './lib/rules-generator.js'

function buildUpstreamUrl(reqPath, base) {
  const parsed = new URL(base)
  const basePath = parsed.pathname.replace(/\/+$/, '')
  // Split reqPath into pathname and query string — the WHATWG URL pathname
  // setter encodes '?' as '%3F', which drops the query on the floor.
  const qIdx = reqPath.indexOf('?')
  if (qIdx !== -1) {
    parsed.pathname = basePath + reqPath.substring(0, qIdx)
    parsed.search = reqPath.substring(qIdx)
  } else {
    parsed.pathname = basePath + reqPath
  }
  return parsed
}

// Pick the upstream base + path transform for a resolved provider. For
// OpenAI-like providers we inspect auth headers to detect Codex CLI ChatGPT
// Plus mode (OAuth JWT + chatgpt-account-id), which must be routed to
// chatgpt.com/backend-api/codex instead of api.openai.com.
export function resolveUpstream(provider, headers, config) {
  const defaultBase = config.upstreams?.[provider.name] || config.upstream
  if (config.disableChatgptRoute) {
    return { base: defaultBase, transformPath: (p) => p, mode: 'api-key' }
  }
  if (provider.name === 'openai' || provider.name === 'openai-responses') {
    const mode = detectOpenAIAuthMode(headers)
    if (mode === 'chatgpt-oauth') {
      return resolveOpenAIUpstream({
        mode,
        base: config.chatgptUpstream || 'https://chatgpt.com',
        providerName: provider.name,
      })
    }
  }
  return { base: defaultBase, transformPath: (p) => p, mode: 'api-key' }
}

export function createProxy(overrides = {}, loadOpts = {}) {
  const base = loadConfig(process.env, loadOpts)
  const config = { ...base, ...overrides }
  if (overrides.upstream && !overrides.upstreams) {
    config.upstreams = {
      anthropic: overrides.upstream,
      openai: overrides.upstream,
      'openai-responses': overrides.upstream,
      gemini: overrides.upstream,
      kimi: overrides.upstream,
      moonshot: overrides.upstream,
    }
  }
  const session = createSession()
  const brCache = (config.stages?.includes('graph') || config.stages?.includes('br-cache') || config.stages?.includes('disclosure'))
    ? createBrCache()
    : null
  const sessionStore = createSessionStore({ brCache })
  const readCache = createReadCache()
  const replayMemo = config.replay ? createReplayMemo({ maxBytes: config.replayMaxBytes }) : null
  const sidecarState = {
    available: false,
    checkedAt: 0,
    inFlight: null,
    autoProbe: Boolean(config.sidecarAutoProbe),
  }
  // `tamp -y` starts the sidecar itself and hands the URL down via env, so the
  // isMain probe below never runs and /health kept reporting sidecar:false
  // while llmlingua was in fact wired up. Probe here too, quietly.
  if (config.stages?.includes('llmlingua') && config.llmLinguaUrl && !config._deferSidecarProbe) {
    probeSidecar(config, sidecarState, { quiet: true })
  }
  return { config, session, sessionStore, readCache, brCache, replayMemo, sidecarState, server: _createServer(config, session, sessionStore, readCache, brCache, replayMemo, sidecarState) }
}

// Stream-decompress a zstd body, aborting as soon as the running output size
// crosses `limit`. fzstd's one-shot decompress() inflates the entire frame
// into memory before any size check, so a small "bomb" frame could OOM the
// proxy; streaming bounds peak memory to ~limit + one block. Throws on excess.
export function decompressZstd(bytes, limit) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const parts = []
  let total = 0
  const dctx = new fzstd.Decompress((chunk) => {
    total += chunk.length
    if (total > limit) throw new Error('zstd decompression exceeded size limit')
    parts.push(chunk)
  })
  dctx.push(input, true)
  const out = Buffer.allocUnsafe(total)
  let offset = 0
  for (const p of parts) { out.set(p, offset); offset += p.length }
  return out
}

// Surface an upstream connection error to the client. Before any response
// bytes are sent we can emit a clean 502 JSON body. Once the response has
// started streaming (headersSent) or finished (writableEnded), appending JSON
// would corrupt the (possibly SSE) stream the client is reading, so we tear
// the socket down instead. Returns true if a JSON error body was written.
export function sendUpstreamError(res) {
  if (res.headersSent || res.writableEnded) {
    res.destroy()
    return false
  }
  res.writeHead(502, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'upstream_error', message: 'failed to connect to upstream' }))
  return true
}

function _createServer(config, session, sessionStore, readCache, brCache, replayMemo, sidecarState = { available: false }) {
const log = createRequestLogger(config)
const disclosureTotals = { rehydrated: 0, missed: 0, disclosed: 0 }
const replayTotals = { hits: 0, misses: 0, tokensHeld: 0 }
let redactedTotal = 0
const staleImagesTotals = { evicted: 0, chars: 0 }
const staleInputsTotals = { pruned: 0 }
const usageTotals = createUsageTotals()
const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({ keepAlive: true })

function openUpstream(method, upstreamUrl, headers, res) {
  const isHttps = upstreamUrl.protocol === 'https:'
  const mod = isHttps ? https : http
  const reqOpts = {
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port,
    path: upstreamUrl.pathname + upstreamUrl.search,
    method,
    headers,
    agent: isHttps ? httpsAgent : httpAgent,
  }
  if (config.upstreamTimeout > 0) reqOpts.timeout = config.upstreamTimeout

  let clientAborted = false
  let activeUpstreamRes = null
  let onUpstreamData = null

  const upstream = mod.request(reqOpts, (upstreamRes) => {
    activeUpstreamRes = upstreamRes
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
    upstreamRes.pipe(res)
    // Passive read of provider usage (incl. prompt-cache counters) off the
    // response as it streams past; never alters what the client receives.
    const tap = createUsageTap({
      contentType: upstreamRes.headers['content-type'],
      contentEncoding: upstreamRes.headers['content-encoding'],
      onUsage: (u) => {
        usageTotals.record(u)
        try { config.onUsage?.(usageTotals.snapshot(), u) } catch {}
        log(`[tamp]   usage: in=${u.inputTokens} cache_read=${u.cacheReadTokens} cache_write=${u.cacheCreationTokens} out=${u.outputTokens}`)
      },
    })
    onUpstreamData = (chunk) => tap.write(chunk)
    upstreamRes.on('data', onUpstreamData)
    // 'close' also fires on an aborted upstream, so the tap always gets ended.
    upstreamRes.on('close', () => tap.end())
    upstreamRes.on('error', (err) => {
      if (clientAborted) return
      log(`[tamp] response stream error: ${err.code || ''} ${err.message}`)
      res.destroy()
    })
  })

  if (config.upstreamTimeout > 0) {
    upstream.on('timeout', () => {
      log(`[tamp] upstream timeout after ${config.upstreamTimeout}ms`)
      upstream.destroy(new Error('upstream timeout'))
    })
  }

  // A 'data' listener keeps the source flowing after pipe() unpipes a dead
  // client; detach, pause, and abort the upstream request if the client left
  // before the response finished so generation stops and sockets don't leak.
  res.on('close', () => {
    if (activeUpstreamRes && onUpstreamData) {
      activeUpstreamRes.off('data', onUpstreamData)
      if (!activeUpstreamRes.readableEnded) activeUpstreamRes.pause()
    }
    if (!res.writableEnded) {
      clientAborted = true
      upstream.destroy()
    }
  })

  upstream.on('error', (err) => {
    if (clientAborted) return
    log(`[tamp] upstream error: ${err.code || ''} ${err.message}`)
    sendUpstreamError(res)
  })

  res.on('error', (err) => {
    clientAborted = true
    log(`[tamp] client disconnect: ${err.code || ''} ${err.message}`)
    upstream.destroy()
  })

  return upstream
}

function forwardRequest(method, upstreamUrl, headers, body, res) {
  const upstream = openUpstream(method, upstreamUrl, headers, res)
  if (body) upstream.end(body)
  else upstream.end()
  return upstream
}

function pipeRequest(req, res, upstreamUrl, prefixChunks) {
  const headers = { ...req.headers }
  delete headers.host
  const upstream = openUpstream(req.method, upstreamUrl, headers, res)
  // Guard the inbound stream: a client RST mid-upload emits 'error' on `req`,
  // and with no listener Node rethrows it and crashes the whole proxy. The
  // buffered path already guards this; the piped passthrough must too.
  req.on('error', (err) => {
    log(`[tamp] client upload error: ${err.code || ''} ${err.message}`)
    upstream.destroy()
  })
  if (prefixChunks) {
    for (const chunk of prefixChunks) upstream.write(chunk)
  }
  req.pipe(upstream)
}

const server = http.createServer(async (req, res) => {
  // Codex CLI 0.146+ opens a WebSocket to <base>/responses before falling
  // back to HTTPS. Tamp only proxies HTTP, and forwarding the upgrade
  // upstream earns a Cloudflare 503 that Codex retries five times (~17s of
  // dead time per session). Refuse it locally and immediately: 501 is not
  // retryable, so Codex drops to the HTTP transport on the first try.
  if (String(req.headers.upgrade || '').toLowerCase() === 'websocket') {
    const body = JSON.stringify({ error: { message: 'Tamp does not proxy WebSocket transport; use HTTP.', type: 'not_implemented' } })
    res.writeHead(501, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' })
    return res.end(body)
  }

  // Health check endpoint
  if ((req.url === '/health' || req.url === '/health?text') && (req.method === 'GET' || req.method === 'HEAD')) {
    await refreshSidecarState(config, sidecarState)
    const totals = session.getTotals()
    const usage = usageTotals.snapshot()
    if (req.url === '/health?text') {
      const ratio = totals.totalOriginal > 0 ? (totals.totalSaved * 100 / totals.totalOriginal).toFixed(1) + '%' : 'n/a'
      const sidecarStatus = config.stages.includes('llmlingua') ? (sidecarState.available ? 'ok' : 'not running') : 'n/a'
      const lines = [`Tamp v${config.version} | ${config.stages.length} stages active | sidecar: ${sidecarStatus}`]
      if (totals.requestCount === 0) {
        lines.push('No requests yet this session')
      } else {
        lines.push(`Requests: ${totals.requestCount} | Blocks: ${totals.compressionCount}`)
        lines.push(`Tokens saved: ${totals.totalTokensSaved} | Chars: ${totals.totalSaved}/${totals.totalOriginal} (${ratio})`)
        if (totals.totalTokensSaved > 0) {
          const son = (totals.totalTokensSaved * 3 / 1e6).toFixed(4)
          const opus = (totals.totalTokensSaved * 15 / 1e6).toFixed(4)
          lines.push(`Est. savings: $${son} (Sonnet $3/Mtok) | $${opus} (Opus $15/Mtok)`)
        }
      }
      if (usage.cacheHitRate !== null) {
        lines.push(`Prompt cache hit rate: ${(usage.cacheHitRate * 100).toFixed(1)}% (${usage.cacheReadTokens} read / ${usage.inputTokens} uncached / ${usage.cacheCreationTokens} write)`)
      }
      const extras = []
      if (redactedTotal > 0) extras.push(`redacted: ${redactedTotal}`)
      if (staleImagesTotals.evicted > 0) extras.push(`stale images: ${staleImagesTotals.evicted} (${staleImagesTotals.chars} chars)`)
      if (staleInputsTotals.pruned > 0) extras.push(`stale inputs: ${staleInputsTotals.pruned}`)
      if (extras.length > 0) lines.push(extras.join(' | '))
      const body = lines.join('\n') + '\n'
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) })
      return res.end(req.method === 'HEAD' ? undefined : body)
    }
    const body = JSON.stringify({
      status: 'ok', version: config.version, stages: config.stages, sidecar: sidecarState.available,
      session: {
        requests: totals.requestCount,
        tokensSaved: totals.totalTokensSaved,
        charsSaved: totals.totalSaved,
        charsOriginal: totals.totalOriginal,
        blocksCompressed: totals.compressionCount,
      },
      disclosure: disclosureTotals,
      replay: replayMemo ? { ...replayTotals, ...replayMemo.stats() } : null,
      redacted: redactedTotal,
      staleImages: staleImagesTotals,
      staleInputs: staleInputsTotals,
      usage,
    })
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
    return res.end(req.method === 'HEAD' ? undefined : body)
  }

  // Caveman Mode diagnostic endpoint (v1.5.0 parity)
  if (req.url === '/caveman-help' && (req.method === 'GET' || req.method === 'HEAD')) {
    const sampleSafe = generateOutputRules(config.outputMode, 'safe', config.agent)
    const sampleDangerous = generateOutputRules(config.outputMode, 'dangerous', config.agent)
    const body = JSON.stringify({
      mode: config.outputMode,
      defaultFromEnv: config.outputModeDefault || null,
      agent: config.agent || null,
      taskClassifierRules: CLASSIFIER_PATTERNS,
      sampleInjection: {
        safe: sampleSafe || null,
        dangerous: sampleDangerous || null,
      },
      perAgent: Object.keys(PER_AGENT_OVERRIDES),
    })
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
    return res.end(req.method === 'HEAD' ? undefined : body)
  }

  const provider = detectProvider(req.method, req.url, req.headers)

  if (!provider) {
    log(`[tamp] ${req.method} ${redactUrl(req.url)}`)
    const upstreamUrl = buildUpstreamUrl(req.url, config.upstream)
    return pipeRequest(req, res, upstreamUrl)
  }

  const route = resolveUpstream(provider, req.headers, config)
  const upstream = route.base
  const normalizedUrl = provider.normalizeUrl ? provider.normalizeUrl(req.url) : req.url
  const reqUrl = route.transformPath(normalizedUrl)
  const upstreamUrl = buildUpstreamUrl(reqUrl, upstream)

  const chunks = []
  let size = 0
  let overflow = false

  // destroyOnReturn:false so breaking out on overflow does NOT destroy the
  // request stream — pipeRequest() still needs to forward the unread remainder
  // to the upstream. Without this, an over-maxBody body is truncated while its
  // original content-length is preserved, hanging the upstream.
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length
      chunks.push(chunk)
      if (size > config.maxBody) {
        overflow = true
        break
      }
    }
  } catch (err) {
    // Client aborted mid-upload (ECONNRESET / premature close). The client is
    // gone, so there's nothing to forward — drop the request without letting
    // the rejection bubble up and crash the proxy process.
    log(`[tamp] client aborted during request body: ${err.code || err.message}`)
    if (!res.writableEnded) res.destroy()
    return
  }

  if (overflow) {
    log('[tamp] passthrough (body too large)')
    return pipeRequest(req, res, upstreamUrl, chunks)
  }

  const rawBody = Buffer.concat(chunks)
  let finalBody = rawBody
  const headers = { ...req.headers }
  delete headers.host

  // Decompress request body if content-encoding is set
  const encoding = (req.headers['content-encoding'] || '').toLowerCase()
  let textBody
  let decompressed = false

  // Safety limit: decompressed body must not exceed 5× maxBody
  // Prevents compression bomb DoS (small gzip → huge expansion)
  const MAX_DECOMPRESSED = config.maxBody * 5

  try {
    if (encoding === 'gzip') {
      textBody = zlib.gunzipSync(rawBody, { maxOutputLength: MAX_DECOMPRESSED })
      decompressed = true
    } else if (encoding === 'deflate') {
      textBody = zlib.inflateSync(rawBody, { maxOutputLength: MAX_DECOMPRESSED })
      decompressed = true
    } else if (encoding === 'br') {
      textBody = zlib.brotliDecompressSync(rawBody, { maxOutputLength: MAX_DECOMPRESSED })
      decompressed = true
    } else if (encoding === 'zstd') {
      textBody = decompressZstd(rawBody, MAX_DECOMPRESSED)
      decompressed = true
    } else if (encoding && encoding !== 'identity') {
      // Unknown encoding — can't decompress, passthrough as-is
      log(`[tamp] passthrough (unsupported encoding: ${encoding})`)
      forwardRequest(req.method, upstreamUrl, headers, rawBody, res)
      return
    } else {
      textBody = rawBody
    }
  } catch {
    // Decompression failed — passthrough original body
    log('[tamp] passthrough (decompression failed)')
    forwardRequest(req.method, upstreamUrl, headers, rawBody, res)
    return
  }

  // Double-check decompressed size
  if (textBody.length > MAX_DECOMPRESSED) {
    log('[tamp] passthrough (decompressed body too large)')
    forwardRequest(req.method, upstreamUrl, headers, rawBody, res)
    return
  }

  let parsed
  let parseOk = false
  try {
    parsed = JSON.parse(textBody.toString('utf-8'))
    parseOk = true
  } catch (err) {
    log(`[tamp] passthrough (parse error): ${err.message}`)
    finalBody = rawBody
  }

  if (parseOk) {
    try {
      const sessionKey = (config.stages?.includes('graph') || config.stages?.includes('read-diff'))
        ? deriveSessionKey(req.headers, parsed)
        : null
      const sessionBucket = config.stages?.includes('graph') && sessionKey
        ? sessionStore.getBucket(sessionKey)
        : null
      const { body, stats, disclosure, replay, redacted, staleImages, staleInputs } = await compressRequest(parsed, { ...config, sessionBucket, sessionKey, readCache, brCache, replayMemo }, provider)
      finalBody = Buffer.from(JSON.stringify(body), 'utf-8')
      // Send uncompressed — simpler and content-length is accurate
      if (decompressed) delete headers['content-encoding']

      session.record(stats)
      if (disclosure) {
        disclosureTotals.rehydrated += disclosure.rehydrated || 0
        disclosureTotals.missed += disclosure.missed || 0
        disclosureTotals.disclosed += disclosure.disclosed || 0
      }
      if (redacted) redactedTotal += redacted
      if (staleImages) {
        staleImagesTotals.evicted += staleImages.evicted || 0
        staleImagesTotals.chars += staleImages.chars || 0
      }
      if (staleInputs) {
        staleInputsTotals.pruned += staleInputs.pruned || 0
      }
      log(formatRequestLog(stats, session, provider.name, req.url, textBody.length, config.tokenCost, sessionBucket, {
        redacted,
        staleImages,
        staleInputs,
        usageSnapshot: usageTotals.snapshot(),
      }))
      if (replay) {
        replayTotals.hits += replay.hits
        replayTotals.misses += replay.misses
        replayTotals.tokensHeld += replay.tokensHeld
        if (replay.hits > 0) log(`[tamp]   replay: ${replay.hits} block${replay.hits !== 1 ? 's' : ''} re-sent as before, ${replay.tokensHeld} tok held`)
      }
      config.onCompress?.(stats, session.getTotals(), { provider: provider.name, url: req.url, bodySize: textBody.length })
    } catch (err) {
      log(`[tamp] passthrough (compress error): ${err.message}`)
      finalBody = rawBody
    }
  }

  headers['content-length'] = Buffer.byteLength(finalBody)
  delete headers['transfer-encoding']

  forwardRequest(req.method, upstreamUrl, headers, finalBody, res)
})

server.on('close', () => {
  httpAgent.destroy()
  httpsAgent.destroy()
})

return server
}

function createRequestLogger(config) {
  if (!config.log) return () => {}

  let fileLoggingEnabled = Boolean(config.logFile)
  let warned = false

  return (message) => {
    console.error(message)

    if (!fileLoggingEnabled) return

    try {
      appendFileSync(config.logFile, `${message}\n`, 'utf8')
    } catch (err) {
      fileLoggingEnabled = false
      if (!warned) {
        warned = true
        process.stderr.write(`[tamp] log file disabled: ${err.message}\n`)
      }
    }
  }
}

const SIDECAR_PORT = 8788
const SIDECAR_URL = `http://localhost:${SIDECAR_PORT}`
const DEFAULT_SIDECAR_PROBE_TTL_MS = 5000
const DEFAULT_SIDECAR_PROBE_TIMEOUT_MS = 2000
const MAX_SIDECAR_HEALTH_BYTES = 65536

export function formatSidecarStartHint({ platform = process.platform, arch = process.arch, port = SIDECAR_PORT } = {}) {
  const mlxFlag = platform === 'darwin' && arch === 'arm64' ? ' --with mlx' : ''
  return `uv run --with fastapi --with uvicorn --with llmlingua${mlxFlag} uvicorn server:app --host 127.0.0.1 --port ${port} --app-dir sidecar`
}

function shouldProbeSidecar(config, sidecarState) {
  return Boolean(config.stages?.includes('llmlingua') && (config.llmLinguaUrl || sidecarState.autoProbe))
}

async function refreshSidecarState(config, sidecarState) {
  if (!shouldProbeSidecar(config, sidecarState)) return sidecarState.available
  if (sidecarState.inFlight) return sidecarState.inFlight
  const ttlMs = (Number.isFinite(config.sidecarProbeTtlMs) && config.sidecarProbeTtlMs >= 0)
    ? config.sidecarProbeTtlMs
    : DEFAULT_SIDECAR_PROBE_TTL_MS
  if (sidecarState.checkedAt > 0 && (Date.now() - sidecarState.checkedAt) < ttlMs) {
    return sidecarState.available
  }
  return probeSidecar(config, sidecarState, { quiet: true })
}

export function probeSidecar(config, sidecarState, opts = false) {
  if (sidecarState.inFlight) return sidecarState.inFlight

  const quiet = typeof opts === 'boolean' ? opts : Boolean(opts?.quiet)
  const timeoutMs = (typeof opts === 'object' && opts !== null && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0)
    ? opts.timeoutMs
    : (Number.isFinite(config.sidecarProbeTimeoutMs) && config.sidecarProbeTimeoutMs > 0
      ? config.sidecarProbeTimeoutMs
      : DEFAULT_SIDECAR_PROBE_TIMEOUT_MS)
  const maxBytes = (typeof opts === 'object' && opts !== null && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0)
    ? opts.maxBytes
    : MAX_SIDECAR_HEALTH_BYTES
  const platform = (typeof opts === 'object' && opts !== null && opts.platform) || process.platform
  const arch = (typeof opts === 'object' && opts !== null && opts.arch) || process.arch

  const targetBase = String(config.llmLinguaUrl || SIDECAR_URL).trim().replace(/\/+$/, '')

  let healthUrl
  try {
    if (!isLoopbackUrl(targetBase)) {
      sidecarState.available = false
      sidecarState.checkedAt = Date.now()
      return Promise.resolve(false)
    }
    healthUrl = new URL(`${targetBase}/health`)
    if (!isLoopbackUrl(healthUrl.href)) {
      sidecarState.available = false
      sidecarState.checkedAt = Date.now()
      return Promise.resolve(false)
    }
  } catch {
    sidecarState.available = false
    sidecarState.checkedAt = Date.now()
    return Promise.resolve(false)
  }

  const mod = healthUrl.protocol === 'https:' ? https : http

  let settled = false
  let promise
  promise = new Promise((resolve) => {
    let req = null
    let resRef = null
    let timer = null

    const finish = (available, { unreachable = false } = {}) => {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      sidecarState.available = available
      sidecarState.checkedAt = Date.now()
      if (sidecarState.inFlight === promise) sidecarState.inFlight = null

      if (available) {
        if (!config.llmLinguaUrl && !Object.isFrozen(config)) config.llmLinguaUrl = SIDECAR_URL
        if (!quiet) console.error(`[tamp] llmlingua sidecar: ok (${config.llmLinguaUrl || SIDECAR_URL})`)
      } else if (unreachable && !quiet) {
        console.error('[tamp] \u26a0 llmlingua stage enabled but sidecar not running \u2014 text blocks won\u2019t compress')
        console.error(`[tamp]   start with: ${formatSidecarStartHint({ platform, arch })}`)
      }
      resolve(available)
    }

    timer = setTimeout(() => {
      try { resRef?.destroy() } catch {}
      try { req?.destroy() } catch {}
      finish(false, { unreachable: true })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    try {
      req = mod.get(healthUrl, { timeout: timeoutMs, agent: false }, (res) => {
        resRef = res
        if (res.statusCode !== 200) {
          res.resume()
          finish(false)
          return
        }

        const chunks = []
        let total = 0
        let exceeded = false

        res.on('data', (chunk) => {
          if (settled || exceeded) return
          total += chunk.length
          if (total > maxBytes) {
            exceeded = true
            res.destroy()
            finish(false)
            return
          }
          chunks.push(chunk)
        })

        res.on('end', () => {
          if (settled || exceeded) return
          const raw = Buffer.concat(chunks).toString('utf8').trim()
          if (!raw) {
            finish(true)
            return
          }
          let parsed
          try {
            parsed = JSON.parse(raw)
          } catch {
            finish(true)
            return
          }
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
              Object.hasOwn(parsed, 'model_loaded') && typeof parsed.model_loaded === 'boolean') {
            finish(parsed.model_loaded === true)
            return
          }
          finish(true)
        })

        res.on('error', () => {
          finish(false)
        })

        res.on('close', () => {
          if (!settled) finish(false)
        })
      })
    } catch {
      finish(false, { unreachable: true })
      return
    }

    req.on('error', () => {
      finish(false, { unreachable: true })
    })

    req.on('timeout', () => {
      req.destroy()
      finish(false, { unreachable: true })
    })
  })

  if (!settled) sidecarState.inFlight = promise
  return promise
}

const isMain = !process.argv[1]?.includes('node_modules') && process.argv[1] === new URL(import.meta.url).pathname

if (isMain) {
  const { config, server, sidecarState } = createProxy({ sidecarAutoProbe: true, _deferSidecarProbe: true })
  server.listen(config.port, config.host, () => {
    console.error(`[tamp] proxy listening on http://${config.host}:${config.port}`)
    console.error(`[tamp] upstream: ${config.upstream}`)
    console.error(`[tamp] stages: ${config.stages.join(', ')}`)

    if (config.stages.includes('llmlingua')) {
      probeSidecar(config, sidecarState)
    }
  })
}
