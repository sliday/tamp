#!/usr/bin/env node
/**
 * Self-checking smoke test for tamp proxy.
 * Spins up echo server + proxy, sends requests, validates compression.
 * Exit 0 = all checks pass, exit 1 = failure.
 */
import http from 'node:http'
import { createProxy } from './index.js'

const PASS = '\x1b[32mPASS\x1b[0m'
const FAIL = '\x1b[31mFAIL\x1b[0m'
let failures = 0

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ${PASS} ${name}`)
  } else {
    console.log(`  ${FAIL} ${name} ${detail}`)
    failures++
  }
}

function request(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }))
    })
    req.on('error', reject)
    if (body) req.end(body)
    else req.end()
  })
}

// --- Echo server captures what proxy sends upstream ---
let lastUpstreamBody = null
const echo = http.createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    lastUpstreamBody = Buffer.concat(chunks).toString()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
})

await new Promise(r => echo.listen(0, r))
const echoPort = echo.address().port

const { server: proxy } = createProxy({
  port: 0,
  upstream: `http://127.0.0.1:${echoPort}`,
  log: false,
  minSize: 50,
  stages: ['minify', 'toon'],
})
await new Promise(r => proxy.listen(0, r))
const proxyPort = proxy.address().port

console.log(`\ntamp smoke test (proxy :${proxyPort} -> echo :${echoPort})\n`)

// ============================================================
// Test 1: Pretty-printed JSON gets minified
// ============================================================
console.log('Test 1: JSON minification')
const prettyJSON = JSON.stringify({
  name: 'tamp', version: '0.1.0', type: 'module',
  main: 'index.js',
  scripts: { start: 'node index.js', test: 'node --test test/*.test.js' },
  dependencies: { '@toon-format/toon': '^2.1.0' },
}, null, 2)

const body1 = JSON.stringify({
  model: 'test', max_tokens: 10,
  messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: prettyJSON }] }],
})

lastUpstreamBody = null
await request(proxyPort, 'POST', '/v1/messages', body1, { 'Content-Type': 'application/json' })
const upstream1 = JSON.parse(lastUpstreamBody)
const compressed1 = upstream1.messages[0].content[0].content

const minified1 = JSON.stringify(JSON.parse(prettyJSON))
const isJSON1 = (() => { try { JSON.parse(compressed1); return true } catch { return false } })()
const isTOON1 = compressed1.includes(': ') && !compressed1.startsWith('{')
check('compressed (minify or toon)', isJSON1 || isTOON1, `got: ${compressed1.substring(0, 80)}...`)
check('shorter than original', compressed1.length < prettyJSON.length,
  `${compressed1.length} vs ${prettyJSON.length}`)
check('shorter than or equal to minified', compressed1.length <= minified1.length,
  `compressed=${compressed1.length} vs minified=${minified1.length}`)
const saving1 = ((1 - compressed1.length / prettyJSON.length) * 100).toFixed(1)
console.log(`  method: ${isJSON1 ? 'minify' : 'toon'}`)
console.log(`  savings: ${prettyJSON.length} -> ${compressed1.length} chars (-${saving1}%)\n`)

// ============================================================
// Test 2: Array of objects gets TOON-encoded (shorter than minified)
// ============================================================
console.log('Test 2: TOON encoding for tabular data')
const tabularData = JSON.stringify([
  { id: 1, name: 'Alice', email: 'alice@example.com', role: 'admin' },
  { id: 2, name: 'Bob', email: 'bob@example.com', role: 'user' },
  { id: 3, name: 'Charlie', email: 'charlie@example.com', role: 'user' },
  { id: 4, name: 'Diana', email: 'diana@example.com', role: 'admin' },
  { id: 5, name: 'Eve', email: 'eve@example.com', role: 'user' },
], null, 2)

const body2 = JSON.stringify({
  model: 'test', max_tokens: 10,
  messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: tabularData }] }],
})

lastUpstreamBody = null
await request(proxyPort, 'POST', '/v1/messages', body2, { 'Content-Type': 'application/json' })
const upstream2 = JSON.parse(lastUpstreamBody)
const compressed2 = upstream2.messages[0].content[0].content
const minified2 = JSON.stringify(JSON.parse(tabularData))

check('TOON is shorter than minified', compressed2.length < minified2.length,
  `toon=${compressed2.length} vs minified=${minified2.length}`)
check('TOON is shorter than original', compressed2.length < tabularData.length)
const saving2 = ((1 - compressed2.length / tabularData.length) * 100).toFixed(1)
console.log(`  savings: ${tabularData.length} -> ${compressed2.length} chars (-${saving2}%)\n`)

// ============================================================
// Test 3: Cache-safe mode — only latest message compressed
// ============================================================
console.log('Test 3: Cache-safe mode (only latest message compressed)')
const histContent = JSON.stringify({ old: 'data', key: 'value', nested: { a: 1, b: 2 } }, null, 2)
const body3 = JSON.stringify({
  model: 'test', max_tokens: 10,
  messages: [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: histContent }] },
    { role: 'assistant', content: [{ type: 'text', text: 'noted' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new', content: JSON.stringify({ fresh: 'data', extra: 'fields', description: 'this needs to be long enough to compress' }, null, 2) }] },
  ],
})

lastUpstreamBody = null
await request(proxyPort, 'POST', '/v1/messages', body3, { 'Content-Type': 'application/json' })
const upstream3 = JSON.parse(lastUpstreamBody)
check('historical tool_result unchanged (cache-safe)', upstream3.messages[0].content[0].content === histContent,
  `got length ${upstream3.messages[0].content[0].content.length} vs original ${histContent.length}`)
const latest3 = upstream3.messages[2].content[0].content
const latestOriginal = JSON.stringify({ fresh: 'data', extra: 'fields', description: 'this needs to be long enough to compress' }, null, 2)
check('latest tool_result compressed', latest3.length < latestOriginal.length,
  `compressed=${latest3.length} vs original=${latestOriginal.length}`)
console.log()

// ============================================================
// Test 4: is_error results skipped
// ============================================================
console.log('Test 4: Error results skipped')
const errContent = JSON.stringify({ error: 'not found', code: 404 }, null, 2)
const body4 = JSON.stringify({
  model: 'test', max_tokens: 10,
  messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'err', is_error: true, content: errContent }] }],
})

lastUpstreamBody = null
await request(proxyPort, 'POST', '/v1/messages', body4, { 'Content-Type': 'application/json' })
const upstream4 = JSON.parse(lastUpstreamBody)
check('error content unchanged', upstream4.messages[0].content[0].content === errContent)
console.log()

// ============================================================
// Test 5: Non-JSON text passes through
// ============================================================
console.log('Test 5: Non-JSON text passthrough')
const textContent = '# README\n\nThis is markdown content that should not be minified.\nIt has multiple lines and paragraphs.\n\nAnother paragraph with code: `const x = 1`\n'
const body5 = JSON.stringify({
  model: 'test', max_tokens: 10,
  messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'txt', content: textContent }] }],
})

lastUpstreamBody = null
await request(proxyPort, 'POST', '/v1/messages', body5, { 'Content-Type': 'application/json' })
const upstream5 = JSON.parse(lastUpstreamBody)
check('text content unchanged', upstream5.messages[0].content[0].content === textContent)
console.log()

// ============================================================
// Test 6: GET passthrough
// ============================================================
console.log('Test 6: GET passthrough')
lastUpstreamBody = null
const res6 = await request(proxyPort, 'GET', '/v1/models')
check('status 200', res6.status === 200)
check('response body passed through', res6.body === '{"ok":true}')
console.log()

// ============================================================
// Summary
// ============================================================
proxy.close()
echo.close()

console.log('─'.repeat(40))
if (failures === 0) {
  console.log(`\x1b[32mAll checks passed!\x1b[0m`)
  process.exit(0)
} else {
  console.log(`\x1b[31m${failures} check(s) failed\x1b[0m`)
  process.exit(1)
}
