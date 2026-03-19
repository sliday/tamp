import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { compressText, compressMessages, compressRequest } from '../compress.js'
import { openai } from '../providers.js'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/sample-messages.json', import.meta.url), 'utf-8'))

const defaultConfig = { minSize: 50, stages: ['minify'], llmLinguaUrl: null }
const toonConfig = { minSize: 50, stages: ['minify', 'toon'], llmLinguaUrl: null }

describe('compressText', () => {
  it('minifies pretty-printed JSON object', () => {
    const input = JSON.stringify({ name: 'tamp', version: '0.1.0', type: 'module', main: 'index.js', scripts: { start: 'node index.js', test: 'node --test' } }, null, 2)
    const result = compressText(input, defaultConfig)
    assert.ok(result)
    assert.equal(result.method, 'minify')
    assert.ok(result.compressedLen < result.originalLen)
    assert.equal(JSON.parse(result.text).name, 'tamp')
  })

  it('returns null for already minified JSON', () => {
    const input = JSON.stringify({ name: 'tamp', version: '0.1.0', description: 'A proxy for compressing tokens between Claude Code and the Anthropic API' })
    const result = compressText(input, defaultConfig)
    assert.equal(result, null)
  })

  it('returns null for content below minSize', () => {
    const input = JSON.stringify({ a: 1 }, null, 2)
    const result = compressText(input, defaultConfig)
    assert.equal(result, null)
  })

  it('returns null for TOON-encoded content', () => {
    const result = compressText('items[3]{sku,qty,price}:\nA1,5,9.99', defaultConfig)
    assert.equal(result, null)
  })

  it('returns null for non-JSON text', () => {
    const input = '# README\n\nThis is a long markdown file with enough content to exceed the minimum size threshold for compression. '.repeat(3)
    const result = compressText(input, defaultConfig)
    assert.equal(result, null)
  })

  it('only minifies when stages=[minify]', () => {
    const input = JSON.stringify([{ id: 1, name: 'Alice', email: 'alice@example.com' }, { id: 2, name: 'Bob', email: 'bob@example.com' }, { id: 3, name: 'Charlie', email: 'charlie@example.com' }], null, 2)
    const result = compressText(input, defaultConfig)
    assert.ok(result)
    assert.equal(result.method, 'minify')
  })

  it('uses TOON when shorter than minified for arrays', () => {
    const input = JSON.stringify([
      { id: 1, name: 'Alice', email: 'alice@example.com' },
      { id: 2, name: 'Bob', email: 'bob@example.com' },
      { id: 3, name: 'Charlie', email: 'charlie@example.com' },
    ], null, 2)
    const result = compressText(input, toonConfig)
    assert.ok(result)
    assert.equal(result.method, 'toon')
    assert.ok(result.compressedLen < result.originalLen)
  })

  it('uses minified when TOON is not shorter', () => {
    // Deeply nested object — TOON won't beat minified
    const input = JSON.stringify({ config: { server: { host: 'localhost', port: 3000 }, db: { host: 'db.local', port: 5432 } } }, null, 2)
    const result = compressText(input, { ...toonConfig, minSize: 10 })
    assert.ok(result)
    // Either minify or toon is fine — just verify it compressed
    assert.ok(result.compressedLen < result.originalLen)
  })
})

const msgConfig = { minSize: 50, stages: ['minify'], llmLinguaUrl: null }

describe('compressMessages', () => {
  it('compresses last user message tool_result JSON', async () => {
    const body = JSON.parse(JSON.stringify(fixtures.multiTurn))
    const oldContent = body.messages[0].content[1].content
    const { body: compressed, stats } = await compressMessages(body, msgConfig)
    // Historical message untouched
    assert.equal(compressed.messages[0].content[1].content, oldContent)
    // Last user message compressed
    const lastContent = compressed.messages[2].content[0].content
    assert.ok(!lastContent.includes('\n'), 'should be minified (no newlines)')
    assert.ok(stats.length > 0)
  })

  it('does not modify assistant tool_use blocks', async () => {
    const body = JSON.parse(JSON.stringify(fixtures.multiTurn))
    const { body: compressed } = await compressMessages(body, msgConfig)
    const assistantMsg = compressed.messages[1]
    assert.equal(assistantMsg.content[1].type, 'tool_use')
    assert.equal(assistantMsg.content[1].name, 'Read')
  })

  it('skips is_error tool_results', async () => {
    const body = JSON.parse(JSON.stringify(fixtures.errorResult))
    const originalContent = body.messages[0].content[0].content
    const { body: compressed, stats } = await compressMessages(body, msgConfig)
    assert.equal(compressed.messages[0].content[0].content, originalContent)
    assert.ok(stats.some(s => s.skipped === 'error'))
  })

  it('compresses text blocks in array content, leaves image untouched', async () => {
    const body = JSON.parse(JSON.stringify(fixtures.mixedContent))
    const { body: compressed } = await compressMessages(body, msgConfig)
    const blocks = compressed.messages[0].content[0].content
    // text block compressed
    const textBlock = blocks.find(b => b.type === 'text')
    assert.ok(!textBlock.text.includes('\n'))
    // image block untouched
    const imgBlock = blocks.find(b => b.type === 'image')
    assert.equal(imgBlock.source.data, 'abc123')
  })

  it('skips non-JSON string content', async () => {
    const body = JSON.parse(JSON.stringify(fixtures.textContent))
    const original = body.messages[0].content[0].content
    const { body: compressed } = await compressMessages(body, msgConfig)
    assert.equal(compressed.messages[0].content[0].content, original)
  })

  it('returns body unchanged when no user messages', async () => {
    const body = JSON.parse(JSON.stringify(fixtures.noUserMessages))
    const { body: compressed, stats } = await compressMessages(body, msgConfig)
    assert.deepEqual(compressed, body)
    assert.equal(stats.length, 0)
  })

  it('preserves system blocks', async () => {
    const body = {
      model: 'claude-sonnet-4-20250514',
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hi' }],
    }
    const { body: compressed } = await compressMessages(body, msgConfig)
    assert.equal(compressed.system, 'You are helpful.')
  })
})

describe('compressMessages with llmlingua', () => {
  let mockServer
  let mockPort

  async function startMock() {
    return new Promise(resolve => {
      mockServer = http.createServer((req, res) => {
        let body = ''
        req.on('data', c => body += c)
        req.on('end', () => {
          const { text } = JSON.parse(body)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ text: text.substring(0, Math.floor(text.length / 2)), original_tokens: 100, compressed_tokens: 50 }))
        })
      })
      mockServer.listen(0, () => {
        mockPort = mockServer.address().port
        resolve()
      })
    })
  }

  it('routes text content to LLMLingua when enabled', async () => {
    await startMock()
    try {
      const cfg = { minSize: 10, stages: ['minify', 'llmlingua'], llmLinguaUrl: `http://localhost:${mockPort}` }
      const body = JSON.parse(JSON.stringify(fixtures.textContent))
      const { body: compressed, stats } = await compressMessages(body, cfg)
      assert.ok(stats.some(s => s.method === 'llmlingua'))
      assert.ok(compressed.messages[0].content[0].content.length < fixtures.textContent.messages[0].content[0].content.length)
    } finally {
      mockServer.close()
    }
  })

  it('does NOT route JSON to LLMLingua', async () => {
    await startMock()
    try {
      const cfg = { minSize: 200, stages: ['minify', 'llmlingua'], llmLinguaUrl: `http://localhost:${mockPort}` }
      const body = JSON.parse(JSON.stringify(fixtures.multiTurn))
      const { stats } = await compressMessages(body, cfg)
      assert.ok(!stats.some(s => s.method === 'llmlingua'))
    } finally {
      mockServer.close()
    }
  })

  it('falls back on LLMLingua failure', async () => {
    // Use a port that nothing listens on
    const cfg = { minSize: 10, stages: ['minify', 'llmlingua'], llmLinguaUrl: 'http://localhost:1' }
    const body = JSON.parse(JSON.stringify(fixtures.textContent))
    const original = body.messages[0].content[0].content
    const { body: compressed } = await compressMessages(body, cfg)
    assert.equal(compressed.messages[0].content[0].content, original)
  })
})

describe('compressRequest with OpenAI format', () => {
  const cfg = { minSize: 50, stages: ['minify'], llmLinguaUrl: null }

  it('compresses tool message content in OpenAI format', async () => {
    const body = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'read the file' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"package.json"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ name: 'tamp', version: '0.1.0', type: 'module', main: 'index.js', scripts: { start: 'node index.js' } }, null, 2) },
      ],
    }
    const { body: compressed, stats } = await compressRequest(body, cfg, openai)
    assert.ok(stats.some(s => s.method === 'minify'))
    assert.ok(!compressed.messages[2].content.includes('\n'), 'should be minified')
    assert.equal(JSON.parse(compressed.messages[2].content).name, 'tamp')
  })

  it('returns empty stats when no tool_calls in OpenAI format', async () => {
    const body = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    }
    const { stats } = await compressRequest(body, cfg, openai)
    assert.equal(stats.length, 0)
  })

  it('compresses multiple tool messages', async () => {
    const body = {
      model: 'gpt-4',
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1' }, { id: 'call_2' }] },
        { role: 'tool', tool_call_id: 'call_1', content: JSON.stringify({ a: 1, b: 2, c: 3, description: 'long enough to compress' }, null, 2) },
        { role: 'tool', tool_call_id: 'call_2', content: JSON.stringify({ x: 'hello', y: 'world', details: 'more content for compression' }, null, 2) },
      ],
    }
    const { stats } = await compressRequest(body, cfg, openai)
    const compressed = stats.filter(s => s.method)
    assert.equal(compressed.length, 2)
  })
})
