import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { createUsageTap, createUsageTotals } from '../lib/usage-tap.js'

// The tap reads usage out of the upstream response as it streams past. It must
// never throw, never touch the client's bytes, and must not care where the
// chunk boundaries fall: a usage event split mid-character has to read the same
// as one delivered whole.

const SSE = 'text/event-stream; charset=utf-8'
const JSON_CT = 'application/json'

const sse = events => events.map(e => (e.event ? `event: ${e.event}\n` : '') + `data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`).join('')

const ANTHROPIC_SSE = ': keepalive\n\n' + sse([
  { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-x',
    usage: { input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000, output_tokens: 1 } } } },
  { event: 'ping', data: { type: 'ping' } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'héllo 日本 🎉 — usage talk' } } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 57 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
])
const ANTHROPIC_EXPECTED = { provider: 'anthropic', inputTokens: 12, outputTokens: 57, cacheReadTokens: 4000, cacheCreationTokens: 300 }

// Multi-byte characters inside the usage event itself, so splits land in them.
const MULTIBYTE_SSE = sse([
  { data: { type: 'message_start', message: { id: 'msg_日本語🎉', type: 'message', model: 'ñ—é', usage: { input_tokens: 7, cache_read_input_tokens: 9, output_tokens: 1 } } } },
  { data: { type: 'message_delta', delta: { stop_reason: '🎉' }, usage: { output_tokens: 3 } } },
])
const MULTIBYTE_EXPECTED = { provider: 'anthropic', inputTokens: 7, outputTokens: 3, cacheReadTokens: 9, cacheCreationTokens: 0 }

const CHAT_SSE = sse([
  { data: { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hi' } }], usage: null } },
  { data: { id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_tokens_details: { cached_tokens: 768 } } } },
  { data: '[DONE]' },
])
const CHAT_EXPECTED = { provider: 'openai', inputTokens: 232, outputTokens: 20, cacheReadTokens: 768, cacheCreationTokens: 0 }

const RESPONSES_SSE = sse([
  { event: 'response.created', data: { type: 'response.created', response: { id: 'r1', object: 'response', usage: null } } },
  { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'Hi' } },
  { event: 'response.completed', data: { type: 'response.completed', response: { id: 'r1', object: 'response',
    usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1536 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 2040 } } } },
])
const RESPONSES_EXPECTED = { provider: 'openai-responses', inputTokens: 464, outputTokens: 40, cacheReadTokens: 1536, cacheCreationTokens: 0 }

const GEMINI_SSE = sse([
  { data: { candidates: [{ content: { parts: [{ text: 'Hi' }] } }], usageMetadata: { promptTokenCount: 500, cachedContentTokenCount: 400, totalTokenCount: 500 } } },
  { data: { candidates: [{ content: { parts: [{ text: ' there' }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 30, cachedContentTokenCount: 400, totalTokenCount: 530 } } },
])
const GEMINI_EXPECTED = { provider: 'gemini', inputTokens: 100, outputTokens: 30, cacheReadTokens: 400, cacheCreationTokens: 0 }

const SSE_FIXTURES = [
  ['anthropic', ANTHROPIC_SSE, ANTHROPIC_EXPECTED],
  ['multi-byte', MULTIBYTE_SSE, MULTIBYTE_EXPECTED],
  ['openai chat', CHAT_SSE, CHAT_EXPECTED],
  ['openai responses', RESPONSES_SSE, RESPONSES_EXPECTED],
  ['gemini', GEMINI_SSE, GEMINI_EXPECTED],
]

// Synchronous run (identity encoding): onUsage fires inside end().
function runSync(chunks, opts) {
  const calls = []
  const tap = createUsageTap({ onUsage: u => calls.push(u), ...opts })
  for (const c of chunks) tap.write(c)
  tap.end()
  return calls
}

// Encoded runs decode on a zlib side path, so onUsage arrives asynchronously.
function runAsync(chunks, opts, waitMs = 2000) {
  return new Promise((resolve) => {
    const calls = []
    let timer = null
    const done = () => { clearTimeout(timer); setTimeout(() => resolve(calls), 20) }
    const tap = createUsageTap({ onUsage: (u) => { calls.push(u); done() }, ...opts })
    for (const c of chunks) tap.write(c)
    tap.end()
    timer = setTimeout(() => resolve(calls), waitMs)
  })
}

function chunked(buf, size) {
  const out = []
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size))
  return out
}

describe('usage-tap — streaming formats', () => {
  for (const [name, text, expected] of SSE_FIXTURES) {
    it(`reads ${name} usage from SSE`, () => {
      assert.deepEqual(runSync([Buffer.from(text)], { contentType: SSE }), [expected])
    })

    it(`${name}: a split at every byte offset gives the unsplit result`, () => {
      const buf = Buffer.from(text)
      for (let i = 0; i <= buf.length; i++) {
        const calls = runSync([buf.subarray(0, i), buf.subarray(i)], { contentType: SSE })
        assert.deepEqual(calls, [expected], `split at byte ${i}`)
      }
    })

    it(`${name}: CRLF line endings, split at every byte offset`, () => {
      const buf = Buffer.from(text.replace(/\n/g, '\r\n'))
      for (let i = 0; i <= buf.length; i++) {
        const calls = runSync([buf.subarray(0, i), buf.subarray(i)], { contentType: SSE })
        assert.deepEqual(calls, [expected], `split at byte ${i}`)
      }
    })
  }

  it('reads a stream fed one byte at a time', () => {
    const buf = Buffer.from(MULTIBYTE_SSE)
    assert.deepEqual(runSync(chunked(buf, 1), { contentType: SSE }), [MULTIBYTE_EXPECTED])
  })

  it('reads the last event when the stream ends without a trailing newline', () => {
    const text = 'data: ' + JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 2 } })
    assert.deepEqual(runSync([Buffer.from(text)], { contentType: SSE }),
      [{ provider: 'openai', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 }])
  })

  it('anthropic: input fields repeated in message_delta win over message_start', () => {
    const text = sse([
      { data: { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 1 } } } },
      { data: { type: 'message_delta', usage: { input_tokens: 11, cache_read_input_tokens: 120, cache_creation_input_tokens: null, output_tokens: 42 } } },
    ])
    assert.deepEqual(runSync([Buffer.from(text)], { contentType: SSE }),
      [{ provider: 'anthropic', inputTokens: 11, outputTokens: 42, cacheReadTokens: 120, cacheCreationTokens: 5 }])
  })

  it('joins multi-line data fields', () => {
    const text = 'data: {"usage":\ndata: {"prompt_tokens":5,"completion_tokens":1}}\n\n'
    assert.deepEqual(runSync([Buffer.from(text)], { contentType: SSE }),
      [{ provider: 'openai', inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }])
  })
})

describe('usage-tap — non-streaming JSON', () => {
  const cases = [
    ['anthropic', { id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000, output_tokens: 57 } }, ANTHROPIC_EXPECTED],
    ['openai chat', { id: 'c1', object: 'chat.completion', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 768 } } }, CHAT_EXPECTED],
    ['openai responses', { id: 'r1', object: 'response', usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1536 }, output_tokens: 40 } }, RESPONSES_EXPECTED],
    ['gemini', { candidates: [], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 30, cachedContentTokenCount: 400 } }, GEMINI_EXPECTED],
    ['gemini streamGenerateContent array', [
      { candidates: [], usageMetadata: { promptTokenCount: 500, cachedContentTokenCount: 400 } },
      { candidates: [], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 30, cachedContentTokenCount: 400 } },
    ], GEMINI_EXPECTED],
  ]
  for (const [name, body, expected] of cases) {
    it(`reads ${name} usage`, () => {
      const buf = Buffer.from(JSON.stringify(body, null, 2))
      assert.deepEqual(runSync(chunked(buf, 13), { contentType: JSON_CT }), [expected])
    })
  }

  it('missing fields become 0', () => {
    const buf = Buffer.from(JSON.stringify({ type: 'message', usage: { input_tokens: 4 } }))
    assert.deepEqual(runSync([buf], { contentType: JSON_CT }),
      [{ provider: 'anthropic', inputTokens: 4, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }])
  })

  it('openai cache_write_tokens counts as cache creation and leaves uncached input disjoint', () => {
    const buf = Buffer.from(JSON.stringify({ object: 'chat.completion', usage: { prompt_tokens: 1000, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 } } }))
    assert.deepEqual(runSync([buf], { contentType: JSON_CT }),
      [{ provider: 'openai', inputTokens: 100, outputTokens: 1, cacheReadTokens: 600, cacheCreationTokens: 300 }])
  })

  it('gemini thinking tokens count as output', () => {
    const buf = Buffer.from(JSON.stringify({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 } }))
    assert.equal(runSync([buf], { contentType: JSON_CT })[0].outputTokens, 12)
  })

  it('never reports negative uncached input', () => {
    const buf = Buffer.from(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 50 } } }))
    assert.equal(runSync([buf], { contentType: JSON_CT })[0].inputTokens, 0)
  })
})

describe('usage-tap — content encoding', () => {
  const encoders = [
    ['gzip', zlib.gzipSync],
    ['br', zlib.brotliCompressSync],
    ['deflate', zlib.deflateSync],
    ['deflate (raw)', zlib.deflateRawSync],
  ]
  for (const [name, encode] of encoders) {
    const contentEncoding = name.split(' ')[0]
    it(`decodes ${name} SSE fed in small chunks`, async () => {
      const buf = encode(Buffer.from(ANTHROPIC_SSE))
      assert.deepEqual(await runAsync(chunked(buf, 7), { contentType: SSE, contentEncoding }), [ANTHROPIC_EXPECTED])
    })
    it(`decodes ${name} JSON fed in small chunks`, async () => {
      const buf = encode(Buffer.from(JSON.stringify({ object: 'chat.completion', usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 768 } } })))
      assert.deepEqual(await runAsync(chunked(buf, 5), { contentType: JSON_CT, contentEncoding }), [CHAT_EXPECTED])
    })
  }

  it('zstd and unknown encodings are a no-op', async () => {
    for (const contentEncoding of ['zstd', 'compress', 'gzip, br']) {
      const calls = await runAsync([Buffer.from(CHAT_SSE)], { contentType: SSE, contentEncoding }, 50)
      assert.deepEqual(calls, [], contentEncoding)
    }
  })

  it('a corrupt gzip body does not throw and does not report', async () => {
    const calls = await runAsync([Buffer.from('not gzip at all, just text')], { contentType: SSE, contentEncoding: 'gzip' }, 100)
    assert.deepEqual(calls, [])
  })

  it('a gzip body over the bound gives up quietly', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(200_000), usage: { prompt_tokens: 1, completion_tokens: 1 } })
    const buf = zlib.gzipSync(Buffer.from(big))
    const calls = await runAsync(chunked(buf, 64), { contentType: JSON_CT, contentEncoding: 'gzip', maxBufferBytes: 4096 }, 200)
    assert.deepEqual(calls, [])
  })
})

describe('usage-tap — bounds and garbage', () => {
  it('drops an oversize SSE line and still reads later events', () => {
    const huge = 'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: 'y'.repeat(50_000) }, usage: 'decoy' }) + '\n\n'
    const buf = Buffer.from(huge + CHAT_SSE)
    for (const size of [1000, 4096, buf.length]) {
      assert.deepEqual(runSync(chunked(buf, size), { contentType: SSE, maxBufferBytes: 2048 }), [CHAT_EXPECTED], `chunk ${size}`)
    }
  })

  it('an oversize SSE line does not grow memory past the bound', () => {
    const chunk = Buffer.alloc(64 * 1024, 0x61) // 'a', no newline: one endless line
    const before = process.memoryUsage().arrayBuffers
    const tap = createUsageTap({ contentType: SSE, onUsage: () => assert.fail('no usage expected'), maxBufferBytes: 64 * 1024 })
    tap.write(Buffer.from('data: '))
    for (let i = 0; i < 800; i++) tap.write(chunk) // ~50 MB
    const grown = process.memoryUsage().arrayBuffers - before
    tap.end()
    assert.ok(grown < 8 * 1024 * 1024, `arrayBuffers grew ${grown} bytes`)
  })

  it('an oversize JSON body does not throw, does not report, and does not grow memory past the bound', () => {
    const chunk = Buffer.alloc(64 * 1024, 0x20)
    const before = process.memoryUsage().arrayBuffers
    const calls = []
    const tap = createUsageTap({ contentType: JSON_CT, onUsage: u => calls.push(u), maxBufferBytes: 64 * 1024 })
    tap.write(Buffer.from('{"usage":{"prompt_tokens":1},"pad":"'))
    for (let i = 0; i < 800; i++) tap.write(chunk)
    tap.write(Buffer.from('"}'))
    const grown = process.memoryUsage().arrayBuffers - before
    tap.end()
    assert.deepEqual(calls, [])
    assert.ok(grown < 8 * 1024 * 1024, `arrayBuffers grew ${grown} bytes`)
  })

  it('garbage never throws and never reports', () => {
    const garbage = [
      Buffer.from([0xff, 0xfe, 0x00, 0x0a, 0xc3, 0x0a, 0x0a, 0xe2, 0x82]),
      Buffer.from('data: {"usage": "nope"}\n\n'),
      Buffer.from('data: {"usage": null}\n\n'),
      Buffer.from('data: {"usage": [1,2,3]}\n\n'),
      Buffer.from('data: {"usage": {"input_tokens": 5}}\n\n'), // ambiguous shape
      Buffer.from('data: {not json "usage"\n\n'),
      Buffer.from('data: null\n\ndata: 42\n\ndata: "usage"\n\n'),
      Buffer.from('data: {"type":"message_start","message":{"usage":"x"}}\n\n'),
      Buffer.from('data: {"usageMetadata": 7}\n\n'),
      Buffer.from('\r\r\r\n\n::::\nevent:\ndata\n\n'),
    ]
    for (const contentType of [SSE, JSON_CT]) {
      for (const g of garbage) {
        assert.deepEqual(runSync([g], { contentType }), [], `${contentType}: ${g.toString('hex').slice(0, 40)}`)
      }
      assert.deepEqual(runSync(garbage, { contentType }), [])
    }
    for (let seed = 1; seed <= 200; seed++) {
      let x = seed
      const bytes = Buffer.alloc(512)
      for (let i = 0; i < bytes.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; bytes[i] = x & 0xff }
      assert.deepEqual(runSync(chunked(bytes, 1 + (seed % 37)), { contentType: SSE }), [])
      assert.deepEqual(runSync(chunked(bytes, 1 + (seed % 37)), { contentType: JSON_CT }), [])
    }
  })

  it('bad arguments and odd call orders are silent no-ops', () => {
    const quiet = [
      createUsageTap(),
      createUsageTap({}),
      createUsageTap({ contentType: SSE }),
      createUsageTap({ contentType: 42, onUsage: () => assert.fail() }),
      createUsageTap({ contentType: 'text/html', onUsage: () => assert.fail() }),
      createUsageTap({ contentType: SSE, contentEncoding: ['gzip'], onUsage: () => assert.fail() }),
    ]
    for (const tap of quiet) {
      tap.write(Buffer.from(CHAT_SSE))
      tap.write('a string')
      tap.write(null)
      tap.write(undefined)
      tap.end()
      tap.end()
      tap.write(Buffer.from('after end'))
    }
    const calls = []
    const tap = createUsageTap({ contentType: SSE, onUsage: u => calls.push(u) })
    tap.write(Buffer.from(CHAT_SSE))
    tap.end()
    tap.end()
    tap.write(Buffer.from(CHAT_SSE))
    tap.end()
    assert.equal(calls.length, 1, 'onUsage fires at most once')
  })

  it('a throwing onUsage does not escape end()', () => {
    const tap = createUsageTap({ contentType: SSE, onUsage: () => { throw new Error('boom') } })
    tap.write(Buffer.from(CHAT_SSE))
    assert.doesNotThrow(() => tap.end())
  })

  it('write returns nothing to await', () => {
    const tap = createUsageTap({ contentType: SSE, onUsage: () => {} })
    assert.equal(tap.write(Buffer.from(CHAT_SSE)), undefined)
    assert.equal(tap.end(), undefined)
  })

  it('write does not mutate its chunk', async () => {
    for (const [contentEncoding, encode] of [[undefined, b => b], ['gzip', zlib.gzipSync]]) {
      const src = encode(Buffer.from(ANTHROPIC_SSE.replace(/\n/g, '\r\n')))
      const chunks = chunked(src, 11)
      const copies = chunks.map(c => Buffer.from(c))
      const calls = contentEncoding
        ? await runAsync(chunks, { contentType: SSE, contentEncoding })
        : runSync(chunks, { contentType: SSE })
      assert.deepEqual(calls, [ANTHROPIC_EXPECTED])
      chunks.forEach((c, i) => assert.ok(c.equals(copies[i]), `chunk ${i} changed`))
    }
  })
})

describe('usage-tap — totals', () => {
  it('sums usage and computes the cache hit rate', () => {
    const totals = createUsageTotals()
    totals.record(ANTHROPIC_EXPECTED)
    totals.record(CHAT_EXPECTED)
    const s = totals.snapshot()
    assert.equal(s.requests, 2)
    assert.equal(s.inputTokens, 12 + 232)
    assert.equal(s.outputTokens, 57 + 20)
    assert.equal(s.cacheReadTokens, 4000 + 768)
    assert.equal(s.cacheCreationTokens, 300)
    assert.equal(s.cacheHitRate, 4768 / (244 + 4768 + 300))
  })

  it('hit rate is null with no input tokens', () => {
    const totals = createUsageTotals()
    assert.deepEqual(totals.snapshot(), { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheHitRate: null })
    totals.record({ provider: 'openai', inputTokens: 0, outputTokens: 9, cacheReadTokens: 0, cacheCreationTokens: 0 })
    assert.equal(totals.snapshot().cacheHitRate, null)
    assert.equal(totals.snapshot().requests, 1)
  })

  it('ignores junk values in recorded usage', () => {
    const totals = createUsageTotals()
    totals.record(null)
    totals.record({ inputTokens: 'x', outputTokens: NaN, cacheReadTokens: -5, cacheCreationTokens: Infinity })
    const s = totals.snapshot()
    assert.equal(s.requests, 1)
    assert.equal(s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreationTokens, 0)
  })

  it('snapshot is a copy', () => {
    const totals = createUsageTotals()
    const s = totals.snapshot()
    s.requests = 99
    assert.equal(totals.snapshot().requests, 0)
  })
})
