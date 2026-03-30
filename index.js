import http from 'node:http'
import https from 'node:https'
import { appendFileSync } from 'node:fs'
import zlib from 'node:zlib'
import * as fzstd from 'fzstd'
import { loadConfig } from './config.js'
import { compressRequest } from './compress.js'
import { detectProvider } from './providers.js'
import { createSession, formatRequestLog } from './stats.js'

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
    config.upstreams = { anthropic: overrides.upstream, openai: overrides.upstream, gemini: overrides.upstream }
  }
  const session = createSession()
  return { config, session, server: _createServer(config, session) }
}

function _createServer(config, session) {
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
    res.end(JSON.stringify({ error: 'upstream_error', message: err.message }))
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
  if (req.url === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    const body = JSON.stringify({ status: 'ok', version: config.version, stages: config.stages })
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
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
  try {
    if (encoding === 'gzip') {
      textBody = zlib.gunzipSync(rawBody)
      decompressed = true
    } else if (encoding === 'deflate') {
      textBody = zlib.inflateSync(rawBody)
      decompressed = true
    } else if (encoding === 'br') {
      textBody = zlib.brotliDecompressSync(rawBody)
      decompressed = true
    } else if (encoding === 'zstd') {
      textBody = Buffer.from(fzstd.decompress(new Uint8Array(rawBody)))
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

  try {
    const parsed = JSON.parse(textBody.toString('utf-8'))

    const { body, stats } = await compressRequest(parsed, config, provider)
    finalBody = Buffer.from(JSON.stringify(body), 'utf-8')
    // Send uncompressed — simpler and content-length is accurate
    if (decompressed) delete headers['content-encoding']

    session.record(stats)
    log(formatRequestLog(stats, session, provider.name, req.url, textBody.length, config.tokenCost))
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

const isMain = !process.argv[1]?.includes('node_modules') && process.argv[1] === new URL(import.meta.url).pathname

if (isMain) {
  const { config, server } = createProxy()
  server.listen(config.port, () => {
    console.error(`[tamp] proxy listening on http://localhost:${config.port}`)
    console.error(`[tamp] upstream: ${config.upstream}`)
    console.error(`[tamp] stages: ${config.stages.join(', ')}`)
  })
}
