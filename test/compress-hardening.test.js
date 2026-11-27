import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { safeCountTokens, countTokens } from '../lib/tokens.js'
import { safeCountTokens as bm25SafeCountTokens, trimLinesByRelevance } from '../lib/bm25.js'
import {
  compressText,
  compressBlock,
  compressRequest,
  clearCache,
  isLoopbackUrl,
} from '../compress.js'
import { anthropic } from '../providers.js'
import { assertCpuBudget, assertCpuBudgetAsync } from './helpers/timing.js'

describe('safe tokenizer (lib/tokens.js)', () => {
  it('handles 512KB space-padded adversarial payload fast with no WASM crash', async () => {
    safeCountTokens('warm')
    const payload = ' '.repeat(512 * 1024) + 'trailing'
    const { result: tokens } = assertCpuBudget(
      'safeCountTokens(512KB space-padded)',
      () => safeCountTokens(payload),
      500,
      { maxWallMs: 5000 }
    )
    assert.ok(tokens > 0)
    assert.equal(countTokens, safeCountTokens)
    assert.equal(bm25SafeCountTokens, safeCountTokens)

    // End-to-end through compressRequest (whitespace stage compresses spaces and counts tokens)
    const body = {
      model: 'claude-sonnet-4-20250514',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_adv', content: 'x' + ' '.repeat(512 * 1024) + '\n' }] },
      ],
    }
    const { result: { stats } } = await assertCpuBudgetAsync(
      'compressRequest(512KB space-padded)',
      () => compressRequest(body, { minSize: 50, stages: ['whitespace'], log: false }, anthropic),
      1000,
      { maxWallMs: 5000 }
    )
    assert.equal(stats[0].method, 'normalize')
  })
})

describe('compressBlock cache isolation across stage configs', () => {
  it('does not collide when stages or minSize differ for the same input', async () => {
    clearCache()
    const input = JSON.stringify([
      { id: 1, name: 'Alice', email: 'alice@example.com' },
      { id: 2, name: 'Bob', email: 'bob@example.com' },
      { id: 3, name: 'Charlie', email: 'charlie@example.com' },
      { id: 4, name: 'Diana', email: 'diana@example.com' },
    ], null, 2)

    const minified = await compressBlock(input, { minSize: 50, stages: ['minify'], log: false })
    assert.equal(minified?.method, 'minify')

    const tooned = await compressBlock(input, { minSize: 50, stages: ['minify', 'toon'], log: false })
    assert.equal(tooned?.method, 'toon', 'different stages must not hit stale minify cache entry')

    const skippedByMinSize = await compressBlock(input, { minSize: input.length + 100, stages: ['minify'], log: false })
    assert.equal(skippedByMinSize, null, 'higher minSize must not hit cached entry from lower minSize')
  })
})

describe('verbatim-critical guard covers all neural/LLM stages', () => {
  it('does not fall through to textpress or foundation-models when llmlingua skips verbatim-critical text', async () => {
    clearCache()
    let ollamaHits = 0
    const server = http.createServer((req, res) => {
      ollamaHits += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: { content: 'short' } }))
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const { port } = server.address()

    try {
      const text = [
        'Logs written to /Users/stas/.config/tamp/tamp.err.log during deploy.',
        'More prose explaining the startup status without extra whitespace to avoid normalize.',
        'The configuration service confirmed all handlers registered cleanly at startup time.',
      ].join('\n')

      const sync = compressText(text, {
        minSize: 10,
        stages: ['llmlingua', 'foundation-models', 'textpress'],
        llmLinguaUrl: 'http://127.0.0.1:8788',
        foundationModelsPath: '/usr/bin/true',
        textpressOllamaUrl: `http://127.0.0.1:${port}`,
        log: false,
      })
      assert.equal(sync, null, 'must not route verbatim-critical text to any neural stage')

      const block = await compressBlock(text, {
        minSize: 10,
        stages: ['textpress'],
        textpressOllamaUrl: `http://127.0.0.1:${port}`,
        log: false,
      })
      assert.equal(block, null)
      assert.equal(ollamaHits, 0, 'textpress backend must never be called on verbatim-critical text')
    } finally {
      server.close()
    }
  })
})

describe('SSRF loopback URL validation', () => {
  it('allows localhost, 127.x.y.z, and IPv6 [::1]; blocks lookalike domains and non-http schemes', () => {
    assert.equal(isLoopbackUrl('http://localhost:8788'), true)
    assert.equal(isLoopbackUrl('http://127.0.0.1:8788'), true)
    assert.equal(isLoopbackUrl('http://127.0.1.5:11434'), true)
    assert.equal(isLoopbackUrl('http://[::1]:8788'), true)
    assert.equal(isLoopbackUrl('https://[::1]:8788'), true)

    assert.equal(isLoopbackUrl('http://127.evil.com:8788'), false)
    assert.equal(isLoopbackUrl('http://127.0.0.1.evil.com:8788'), false)
    assert.equal(isLoopbackUrl('http://127.0.0.999:8788'), false)
    assert.equal(isLoopbackUrl('http://localhost@evil.com:8788'), false)
    assert.equal(isLoopbackUrl('file:///etc/passwd'), false)
    assert.equal(isLoopbackUrl('not-a-url'), false)
  })
})

describe('strip-comments hardening', () => {
  const cfg = { minSize: 1, stages: ['strip-comments'], log: false }

  it('preserves JS private fields, C/Rust directives, CSS hex colors, and handles escaped backslashes', () => {
    const padding = '// ' + 'comment padding to ensure >10% compression savings '.repeat(6)
    const source = [
      padding,
      '#include <stdio.h>',
      '#define MAX_SIZE 128',
      '#pragma once',
      '#if DEBUG',
      '#[derive(Debug)]',
      'const next = ++this.#count + obj.#priv',
      'const style = "color: #fff; bg: #1a2b3c;"',
      'color: #fff; background: #1a2b3c;',
      "const escaped = 'foo\\\\' // trailing comment after escaped backslash",
      "const inside = 'foo\\' // stays inside string'",
      'x = 1  # python inline comment',
      '# standalone python comment',
    ].join('\n')

    const res = compressText(source, cfg)
    assert.ok(res, 'should compress via strip-comments')
    const out = res.text

    assert.ok(out.includes('#include <stdio.h>'), 'preserves #include')
    assert.ok(out.includes('#define MAX_SIZE 128'), 'preserves #define')
    assert.ok(out.includes('#pragma once'), 'preserves #pragma')
    assert.ok(out.includes('#if DEBUG'), 'preserves #if')
    assert.ok(out.includes('#[derive(Debug)]'), 'preserves Rust attribute #[')
    assert.ok(out.includes('this.#count'), 'preserves JS private field access')
    assert.ok(out.includes('color: #fff; background: #1a2b3c;'), 'preserves CSS hex colors')
    assert.ok(out.includes("const escaped = 'foo\\\\'"), 'preserves string ending in escaped backslash')
    assert.ok(!out.includes('trailing comment after escaped backslash'), 'strips // comment after escaped backslash string')
    assert.ok(out.includes("const inside = 'foo\\' // stays inside string'"), 'preserves // inside string with escaped quote')
    assert.ok(out.includes('x = 1') && !out.includes('python inline comment'), 'strips inline # comment')
    assert.ok(!out.includes('standalone python comment'), 'strips standalone # comment')
  })
})

describe('bm25-trim precomputed token reuse', () => {
  it('reuses bm25OriginalTokens and bm25TrimmedTokens in compressRequest stats', async () => {
    const lines = ['FILE: /var/log/app.log']
    const filler = 'debug heartbeat cache miss status=ok latency=1ms session=abc request=xyz '.repeat(12)
    for (let i = 0; i < 100; i++) lines.push(`LINE${i} ${filler}`)
    lines.splice(30, 0, 'async error handling failed in worker')
    lines.splice(60, 0, 'caught async exception timeout')
    lines.push('TRAILER: end')
    const text = lines.join('\n')
    const query = 'trace async error handling'

    const direct = trimLinesByRelevance(text, query)
    assert.ok(direct)

    const body = {
      model: 'claude-sonnet-4-20250514',
      messages: [
        { role: 'user', content: query },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/var/log/app.log' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: text }] },
      ],
    }

    const { stats } = await compressRequest(body, { minSize: 50, stages: ['bm25-trim'], log: false }, anthropic)
    const stat = stats.find(s => s.method === 'bm25-trim')
    assert.ok(stat)
    assert.equal(stat.originalTokens, direct.originalTokens)
    assert.equal(stat.compressedTokens, direct.trimmedTokens)
  })
})

describe('foundation-models argv length guard', () => {
  it('returns null cleanly without spawning when input exceeds 64KB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamp-fm-argv-'))
    const markerFile = join(dir, 'ran.txt')
    const fakeApfel = join(dir, 'apfel.sh')
    writeFileSync(fakeApfel, `#!/bin/sh\necho ran > "${markerFile}"\nexit 0\n`)
    chmodSync(fakeApfel, 0o755)
    try {
      clearCache()
      const hugeProse = 'The quick brown fox jumps over the lazy dog in a long paragraph. '.repeat(1200)
      assert.ok(Buffer.byteLength(hugeProse, 'utf8') > 65536)
      const res = await compressBlock(hugeProse, {
        minSize: 50,
        stages: ['foundation-models'],
        foundationModelsPath: fakeApfel,
        log: false,
      })
      assert.equal(res, null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
