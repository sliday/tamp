import http from 'node:http'
import https from 'node:https'
import { loadConfig } from './config.js'
import { compressMessages } from './compress.js'
import { createSession, formatRequestLog } from './stats.js'

export function createProxy(overrides = {}) {
  const config = { ...loadConfig(), ...overrides }
  const session = createSession()
  return { config, session, server: _createServer(config, session) }
}

function _createServer(config, session) {

function forwardRequest(method, upstreamUrl, headers, body, res) {
  const mod = upstreamUrl.protocol === 'https:' ? https : http
  const opts = {
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port,
    path: upstreamUrl.pathname + upstreamUrl.search,
    method,
    headers,
  }

  const upstream = mod.request(opts, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
    upstreamRes.pipe(res)
  })

  upstream.on('error', (err) => {
    console.error(`[toona] upstream error: ${err.message}`)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
    }
    res.end(JSON.stringify({ error: 'upstream_error', message: err.message }))
  })

  if (body) {
    upstream.end(body)
  } else {
    upstream.end()
  }

  return upstream
}

function pipeRequest(req, res, upstreamUrl, prefixChunks) {
  const mod = upstreamUrl.protocol === 'https:' ? https : http
  const headers = { ...req.headers }
  delete headers.host

  const opts = {
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port,
    path: upstreamUrl.pathname + upstreamUrl.search,
    method: req.method,
    headers,
  }

  const upstream = mod.request(opts, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
    upstreamRes.pipe(res)
  })

  upstream.on('error', (err) => {
    console.error(`[toona] upstream error: ${err.message}`)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
    }
    res.end(JSON.stringify({ error: 'upstream_error', message: err.message }))
  })

  if (prefixChunks) {
    for (const chunk of prefixChunks) {
      upstream.write(chunk)
    }
  }

  req.pipe(upstream)
}

return http.createServer(async (req, res) => {
  const upstreamUrl = new URL(req.url, config.upstream)
  const isMessages = req.method === 'POST' && req.url === '/v1/messages'

  if (!isMessages) {
    return pipeRequest(req, res, upstreamUrl)
  }

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
    if (config.log) console.error('[toona] passthrough (body too large)')
    return pipeRequest(req, res, upstreamUrl, chunks)
  }

  const rawBody = Buffer.concat(chunks)
  let finalBody = rawBody
  const headers = { ...req.headers }
  delete headers.host

  try {
    const parsed = JSON.parse(rawBody.toString('utf-8'))
    const { body, stats } = await compressMessages(parsed, config)
    finalBody = Buffer.from(JSON.stringify(body), 'utf-8')

    if (config.log && stats.length) {
      session.record(stats)
      console.error(formatRequestLog(stats, session))
    }
  } catch (err) {
    if (config.log) console.error(`[toona] passthrough (parse error): ${err.message}`)
    finalBody = rawBody
  }

  headers['content-length'] = Buffer.byteLength(finalBody)
  delete headers['transfer-encoding']

  forwardRequest(req.method, upstreamUrl, headers, finalBody, res)
})
}

const isMain = !process.argv[1]?.includes('node_modules') && process.argv[1] === new URL(import.meta.url).pathname

if (isMain) {
  const { config, server } = createProxy()
  server.listen(config.port, () => {
    console.error(`[toona] proxy listening on http://localhost:${config.port}`)
    console.error(`[toona] upstream: ${config.upstream}`)
    console.error(`[toona] stages: ${config.stages.join(', ')}`)
  })
}
