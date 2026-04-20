import http from 'node:http'
import https from 'node:https'
import { appendFileSync } from 'node:fs'
import zlib from 'node:zlib'
import * as fzstd from 'fzstd'
import { loadConfig } from './config.js'
import { compressRequest } from './compress.js'
import { detectProvider } from './providers.js'
import { createSession, formatRequestLog } from './stats.js'
import { createSessionStore, deriveSessionKey } from './session-graph.js'
import { createReadCache } from './lib/read-cache.js'
import { createBrCache } from './lib/br-cache.js'
import { generateOutputRules, PER_AGENT_OVERRIDES } from './lib/rules-generator.js'

// Regex source strings used by the task classifier — surfaced via
// /caveman-help so operators can see exactly how their inputs are scored.
const CLASSIFIER_PATTERNS = Object.freeze({
  safe: [
    '^(add|remove|update|set|unset)\\s+(env\\s+var|environment variable|config|configuration|\\w+=)',
    '^fix\\s+typo',
    '^update\\s+(README|readme|documentation|docs)',
    '^(install|uninstall).*package',
    '^add\\s+\\w+\\s+(as\\s+)?dependency',
    '^update\\s+version',
    '^(format|lint|fmt)|run linter',
  ],
  dangerous: [
    'security|vulnerability|exploit|attack',
    'debug|investigate|diagnose|troubleshoot',
    'memory leak|performance|optimization|optimize',
    '^refactor|^architecture|^design',
    '^fix\\s+bug',
    '^explain|^why|^how\\s+(does|work)',
    'test|spec|coverage',
  ],
  complex: 'default when neither safe nor dangerous patterns match',
})

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

export function createProxy(overrides = {}) {
  const base = loadConfig()
  const config = { ...base, ...overrides }
  if (overrides.upstream && !overrides.upstreams) {
    config.upstreams = { anthropic: overrides.upstream, openai: overrides.upstream, 'openai-responses': overrides.upstream, gemini: overrides.upstream }
  }
  const session = createSession()
  const brCache = (config.stages?.includes('graph') || config.stages?.includes('br-cache'))
    ? createBrCache()
    : null
  const sessionStore = createSessionStore({ brCache })
  const readCache = createReadCache()
  return { config, session, sessionStore, readCache, brCache, server: _createServer(config, session, sessionStore, readCache) }
}

function _createServer(config, session, sessionStore, readCache) {
const log = createRequestLogger(config)

function openUpstream(method, upstreamUrl, headers, res) {
  const mod = upstreamUrl.protocol === 'https:' ? https : http
  const upstream = mod.request({
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port,
    path: upstreamUrl.pathname + upstreamUrl.search,
    method,
    headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
    upstreamRes.pipe(res)
    upstreamRes.on('error', (err) => {
      log(`[tamp] response stream error: ${err.code || ''} ${err.message}`)
      res.destroy()
    })
  })

  upstream.on('error', (err) => {
    log(`[tamp] upstream error: ${err.code || ''} ${err.message}`)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
    }
    res.end(JSON.stringify({ error: 'upstream_error', message: 'failed to connect to upstream' }))
  })

  res.on('error', (err) => {
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
  if (prefixChunks) {
    for (const chunk of prefixChunks) upstream.write(chunk)
  }
  req.pipe(upstream)
}

return http.createServer(async (req, res) => {
  // Health check endpoint
  if ((req.url === '/health' || req.url === '/health?text') && (req.method === 'GET' || req.method === 'HEAD')) {
    const totals = session.getTotals()
    if (req.url === '/health?text') {
      const ratio = totals.totalOriginal > 0 ? (totals.totalSaved * 100 / totals.totalOriginal).toFixed(1) + '%' : 'n/a'
      const sidecarStatus = config.stages.includes('llmlingua') ? (sidecarAvailable ? 'ok' : 'not running') : 'n/a'
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
      const body = lines.join('\n') + '\n'
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) })
      return res.end(req.method === 'HEAD' ? undefined : body)
    }
    const body = JSON.stringify({
      status: 'ok', version: config.version, stages: config.stages, sidecar: sidecarAvailable,
      session: {
        requests: totals.requestCount,
        tokensSaved: totals.totalTokensSaved,
        charsSaved: totals.totalSaved,
        charsOriginal: totals.totalOriginal,
        blocksCompressed: totals.compressionCount,
      },
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

  const provider = detectProvider(req.method, req.url)

  if (!provider) {
    log(`[tamp] ${req.method} ${req.url}`)
    const upstreamUrl = buildUpstreamUrl(req.url, config.upstream)
    return pipeRequest(req, res, upstreamUrl)
  }

  const upstream = config.upstreams?.[provider.name] || config.upstream
  const reqUrl = provider.normalizeUrl ? provider.normalizeUrl(req.url) : req.url
  const upstreamUrl = buildUpstreamUrl(reqUrl, upstream)

  const chunks = []
  let size = 0
  let overflow = false

  for await (const chunk of req) {
    size += chunk.length
    chunks.push(chunk)
    if (size > config.maxBody) {
      overflow = true
      break
    }
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
      const decompressedBytes = fzstd.decompress(new Uint8Array(rawBody))
      if (decompressedBytes.length > MAX_DECOMPRESSED) {
        throw new Error('zstd decompression exceeded size limit')
      }
      textBody = Buffer.from(decompressedBytes)
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

  try {
    const parsed = JSON.parse(textBody.toString('utf-8'))

    const sessionKey = (config.stages?.includes('graph') || config.stages?.includes('read-diff'))
      ? deriveSessionKey(req.headers)
      : null
    const sessionBucket = config.stages?.includes('graph') && sessionKey
      ? sessionStore.getBucket(sessionKey)
      : null
    const { body, stats } = await compressRequest(parsed, { ...config, sessionBucket, sessionKey, readCache }, provider)
    finalBody = Buffer.from(JSON.stringify(body), 'utf-8')
    // Send uncompressed — simpler and content-length is accurate
    if (decompressed) delete headers['content-encoding']

    session.record(stats)
    log(formatRequestLog(stats, session, provider.name, req.url, textBody.length, config.tokenCost, sessionBucket))
    config.onCompress?.(stats, session.getTotals(), { provider: provider.name, url: req.url, bodySize: textBody.length })
  } catch (err) {
    log(`[tamp] passthrough (parse error): ${err.message}`)
    finalBody = rawBody
  }

  headers['content-length'] = Buffer.byteLength(finalBody)
  delete headers['transfer-encoding']

  forwardRequest(req.method, upstreamUrl, headers, finalBody, res)
})
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

let sidecarAvailable = false

function probeSidecar(config) {
  const req = http.get(`${SIDECAR_URL}/health`, { timeout: 2000 }, (res) => {
    if (res.statusCode === 200) {
      sidecarAvailable = true
      if (!config.llmLinguaUrl) config.llmLinguaUrl = SIDECAR_URL
      console.error(`[tamp] llmlingua sidecar: ok (${config.llmLinguaUrl})`)
    }
    res.resume()
  })
  req.on('error', () => {
    sidecarAvailable = false
    console.error('[tamp] \u26a0 llmlingua stage enabled but sidecar not running \u2014 text blocks won\u2019t compress')
    console.error('[tamp]   start with: uv run --with fastapi --with uvicorn --with llmlingua --with mlx uvicorn server:app --host 0.0.0.0 --port 8788 --app-dir sidecar')
  })
  req.on('timeout', () => { req.destroy() })
}

const isMain = !process.argv[1]?.includes('node_modules') && process.argv[1] === new URL(import.meta.url).pathname

if (isMain) {
  const { config, server } = createProxy()
  server.listen(config.port, () => {
    console.error(`[tamp] proxy listening on http://localhost:${config.port}`)
    console.error(`[tamp] upstream: ${config.upstream}`)
    console.error(`[tamp] stages: ${config.stages.join(', ')}`)

    if (config.stages.includes('llmlingua')) {
      probeSidecar(config)
    }
  })
}
