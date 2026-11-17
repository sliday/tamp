import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createProxy } from '../index.js'
import { compressRequest } from '../compress.js'
import { anthropic, openai, openaiResponses, gemini } from '../providers.js'
import { loadConfig, CONFIG_TEMPLATE } from '../config.js'
import { createReplayMemo } from '../lib/replay-memo.js'
import { createReadCache } from '../lib/read-cache.js'

// cacheSafe only exposes the newest tool_result group, so a turn used to be
// compressed and redacted while newest, then forwarded raw once the client
// re-sent it as history. The replay memo re-sends it exactly as first emitted.

const big = (tag = 'row') => JSON.stringify({ rows: Array.from({ length: 60 }, (_, i) => ({ id: i, name: `${tag}-${i}`, ok: true })) }, null, 2)
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const secretText = `export AWS_SECRET_ACCESS_KEY=${SECRET}\n` + 'plain log line\n'.repeat(30)

const cfg = (memo, extra = {}) => ({ minSize: 50, stages: ['minify'], llmLinguaUrl: null, log: false, cacheSafe: true, replayMemo: memo, ...extra })
const run = async (body, config, provider = anthropic) => compressRequest(structuredClone(body), config, provider)
const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b))

// Anthropic transcript: one assistant tool_use turn + its tool_result turn per entry.
function anthropicBody(turns) {
  const messages = [{ role: 'user', content: 'look at the data' }]
  for (const results of turns) {
    messages.push({ role: 'assistant', content: results.map(r => ({ type: 'tool_use', id: r.id, name: r.name || 'Bash', input: r.input || {} })) })
    messages.push({ role: 'user', content: results.map(r => ({ type: 'tool_result', ...(r.id ? { tool_use_id: r.id } : {}), content: r.content })) })
  }
  return { model: 'claude-sonnet-5-5', messages }
}

describe('replay memo — LRU', () => {
  it('bounds total bytes and evicts least recently used first', () => {
    const memo = createReplayMemo({ maxBytes: 100 })
    for (const k of ['a', 'b', 'c']) assert.equal(memo.put(k, k.repeat(30)), true)
    assert.equal(memo.stats().bytes, 93, 'value bytes plus key bytes')
    memo.get('a') // a becomes most recent; b is now the oldest
    memo.put('d', 'd'.repeat(30))
    assert.equal(memo.get('b'), undefined)
    for (const k of ['a', 'c', 'd']) assert.equal(memo.get(k).value, k.repeat(30))
    const s = memo.stats()
    assert.ok(s.bytes <= 100)
    assert.equal(s.entries, 3)
    assert.equal(s.evictions, 1)
  })

  it('refuses a value larger than the bound and keeps null entries distinct from misses', () => {
    const memo = createReplayMemo({ maxBytes: 50 })
    assert.equal(memo.put('big', 'x'.repeat(100)), false)
    assert.equal(memo.get('big'), undefined)
    memo.put('n', null, { originalTokens: 5 })
    assert.equal(memo.get('n').value, null)
    assert.deepEqual(memo.get('n').meta, { originalTokens: 5 })
  })

  it('re-putting a key replaces its size instead of adding to it', () => {
    const memo = createReplayMemo({ maxBytes: 1000 })
    memo.put('k', 'x'.repeat(100))
    memo.put('k', 'x'.repeat(10))
    assert.equal(memo.stats().bytes, 11)
  })
})

describe('replay memo — Anthropic', () => {
  const turn1 = [{ id: 'toolu_1', content: big() }, { id: 'toolu_1b', content: secretText }]
  const turn2 = [{ id: 'toolu_2', content: big('next') }]

  it('older turn goes out byte-identical, secret stays masked, newest turn still compressed', async () => {
    const memo = createReplayMemo()
    const n = await run(anthropicBody([turn1]), cfg(memo))
    const n1 = await run(anthropicBody([turn1, turn2]), cfg(memo))

    same(n1.body.messages[2], n.body.messages[2])
    assert.ok(!JSON.stringify(n.body).includes(SECRET), 'masked in request N')
    assert.ok(!JSON.stringify(n1.body).includes(SECRET), 'still masked in request N+1')
    const newest = n1.body.messages[4].content[0].content
    assert.ok(newest.length < big('next').length, 'newest turn is compressed')
    assert.deepEqual(JSON.parse(newest), JSON.parse(big('next')))
    assert.equal(n1.replay.hits, 2)
    assert.ok(n1.replay.tokensHeld > 0, 'replay accounting comes from stored token counts')
  })

  it('a retried latest group yields identical bytes', async () => {
    const memo = createReplayMemo()
    const body = anthropicBody([turn1])
    const first = await run(body, cfg(memo))
    const retry = await run(body, cfg(memo))
    same(retry.body, first.body)
    assert.equal(retry.replay.hits, 2)
    assert.ok(retry.stats.every(s => s.skipped === 'replayed'))
  })

  it('a read-diff replays while its base read is in the request, and goes raw once the base is gone', async () => {
    const memo = createReplayMemo()
    const readCache = createReadCache()
    const lines = Array.from({ length: 120 }, (_, i) => `line ${i}: representative source content for size`)
    const v1 = lines.join('\n')
    const v2 = lines.map((l, i) => i === 60 ? 'line 60: CHANGED' : l).join('\n')
    const c = cfg(memo, { stages: ['read-diff'], readCache, sessionKey: 's' })
    const read = (id, content) => [{ id, name: 'Read', input: { file_path: '/f.js' }, content }]
    await run(anthropicBody([read('tu_a', v1)]), c)
    const both = anthropicBody([read('tu_a', v1), read('tu_b', v2)])
    const second = await run(both, c)
    assert.match(second.body.messages[4].content[0].content, /^\[read-diff/)
    // Without the memo a retry diffs the read against itself and sends it raw.
    same((await run(both, c)).body, second.body)
    const later = await run(anthropicBody([read('tu_a', v1), read('tu_b', v2), turn2]), c)
    same(later.body.messages[4], second.body.messages[4])

    // Client cleared the base read: a diff against it would dangle.
    const cleared = anthropicBody([read('tu_a', '[Old tool result content cleared]'), read('tu_b', v2), turn2])
    const gone = await run(cleared, c)
    assert.equal(gone.body.messages[4].content[0].content, v2)
  })

  it('a dedup marker is not replayed once the block it points at changed', async () => {
    const memo = createReplayMemo()
    const c = cfg(memo, { stages: ['dedup', 'minify'] })
    const dup = big('dup')
    await run(anthropicBody([[{ id: 'toolu_x', content: dup }, { id: 'toolu_y', content: dup }]]), c)
    const cleared = [{ id: 'toolu_x', content: '[Old tool result content cleared]' }, { id: 'toolu_y', content: dup }]
    const n1 = await run(anthropicBody([cleared, turn2]), c)
    assert.equal(n1.body.messages[2].content[1].content, dup)
  })

  it('the same tool id and text in another conversation or position does not share an entry', async () => {
    const memo = createReplayMemo()
    const c = cfg(memo, { stages: ['dedup', 'minify'] })
    const dup = big('dup')
    const a = await run(anthropicBody([[{ id: 'f:0', content: dup }, { id: 'f:1', content: dup }]]), c)
    assert.match(a.body.messages[2].content[1].content, /^\[see tool_result/)
    const other = anthropicBody([[{ id: 'f:0', content: big('different') }, { id: 'f:1', content: dup }], turn2])
    other.messages[0].content = 'another conversation'
    const b = await run(other, c)
    assert.equal(b.body.messages[2].content[1].content, dup)
  })

  it('a memo miss on an older turn (restart, eviction) still masks its secret, with stable bytes', async () => {
    const body = anthropicBody([turn1, turn2])
    const fresh = await run(body, cfg(createReplayMemo()))
    assert.ok(!JSON.stringify(fresh.body).includes(SECRET))
    assert.equal(fresh.body.messages[2].content[0].content, big(), 'never compressed fresh')

    const tiny = createReplayMemo({ maxBytes: 600 })
    const a = await run(body, cfg(tiny))
    const b = await run(body, cfg(tiny))
    assert.ok(!JSON.stringify(a.body).includes(SECRET))
    same(b.body.messages[2], a.body.messages[2])
  })

  it('two identical bodies in one turn: the dedup marker replays as sent', async () => {
    const memo = createReplayMemo()
    const dupTurn = [{ id: 'toolu_x', content: big('dup') }, { id: 'toolu_y', content: big('dup') }]
    const c = cfg(memo, { stages: ['dedup', 'minify'] })
    const n = await run(anthropicBody([dupTurn]), c)
    assert.match(n.body.messages[2].content[1].content, /^\[see tool_result/)
    const n1 = await run(anthropicBody([dupTurn, turn2]), c)
    same(n1.body.messages[2], n.body.messages[2])
  })

  it('changed raw text (client compaction) misses and stays as the client sent it', async () => {
    const memo = createReplayMemo()
    await run(anthropicBody([turn1]), cfg(memo))
    const compacted = [{ id: 'toolu_1', content: '[compacted by client] ' + big('other') }, turn1[1]]
    const n1 = await run(anthropicBody([compacted, turn2]), cfg(memo))
    assert.equal(n1.body.messages[2].content[0].content, compacted[0].content)
    assert.equal(n1.replay.hits, 1, 'only the untouched sibling replays')
    assert.ok(n1.replay.misses >= 1)
  })

  it('a target without an id replays by conversation and position', async () => {
    const memo = createReplayMemo()
    const noId = [{ id: undefined, content: big() }]
    const n = await run(anthropicBody([noId]), cfg(memo))
    assert.ok(n.body.messages[2].content[0].content.length < big().length)
    const n1 = await run(anthropicBody([noId, turn2]), cfg(memo))
    same(n1.body.messages[2], n.body.messages[2])
    assert.equal(n1.body.messages[0].content, 'look at the data')
  })

  it('sub-text blocks inside array content replay by tool_use_id#j', async () => {
    const memo = createReplayMemo()
    const arr = [{ id: 'toolu_arr', content: [{ type: 'text', text: big('a') }, { type: 'text', text: big('b') }] }]
    const n = await run(anthropicBody([arr]), cfg(memo))
    const n1 = await run(anthropicBody([arr, turn2]), cfg(memo))
    same(n1.body.messages[2], n.body.messages[2])
    assert.equal(n1.replay.hits, 2)
  })

  it('replays block arrays (px-render) as arrays, isolated from later body mutation', async () => {
    const inner = createReplayMemo()
    const keys = []
    const memo = { ...inner, put: (k, v, m) => { keys.push(k); return inner.put(k, v, m) } }
    const one = [{ id: 'toolu_px', content: big() }]
    const px = (m) => cfg(m, { pxModels: 'claude-sonnet-5-5' })
    await run(anthropicBody([one]), px(memo))
    const blocks = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'facts' }]
    inner.put(keys.find(k => k.includes('toolu_px')), blocks, { originalTokens: 900, compressedTokens: 100 })

    const n1 = await run(anthropicBody([one, turn2]), px(memo))
    assert.deepEqual(n1.body.messages[2].content[0].content, blocks)
    assert.equal(n1.replay.tokensHeld, 800)
    n1.body.messages[2].content[0].content[0].source.data = 'MUTATED'
    const n2 = await run(anthropicBody([one, turn2]), px(memo))
    assert.deepEqual(n2.body.messages[2].content[0].content, blocks)

    // A model outside the px allowlist must get text, never the stored images.
    const other = { ...anthropicBody([one, turn2]), model: 'claude-haiku-5-5' }
    const n3 = await run(other, px(memo))
    assert.equal(n3.body.messages[2].content[0].content, big())
    // ...and that request must not cost the px model its stored images.
    const n4 = await run(anthropicBody([one, turn2]), px(memo))
    assert.deepEqual(n4.body.messages[2].content[0].content, blocks)
  })

  it('a recorded user decision stays exactly as the client sent it, newest or older', async () => {
    const memo = createReplayMemo()
    const ask = [{ id: 'toolu_ask', name: 'AskUserQuestion', content: secretText }]
    const n = await run(anthropicBody([ask]), cfg(memo))
    assert.equal(n.body.messages[2].content[0].content, secretText)
    const n1 = await run(anthropicBody([ask, turn2]), cfg(memo))
    assert.equal(n1.body.messages[2].content[0].content, secretText)
    const off = await run(anthropicBody([ask, turn2]), cfg(undefined))
    assert.equal(off.body.messages[2].content[0].content, secretText)
  })

  it('without a memo, older turns go out uncompressed but still redacted', async () => {
    const off = cfg(undefined)
    const n1 = await run(anthropicBody([turn1, turn2]), off)
    assert.equal(n1.body.messages[2].content[0].content, big())
    assert.ok(!n1.body.messages[2].content[1].content.includes(SECRET))
    const noRedact = await run(anthropicBody([turn1, turn2]), { ...off, redact: false })
    assert.ok(noRedact.body.messages[2].content[1].content.includes(SECRET))
    assert.equal(n1.replay, null)
    const disabled = await run(anthropicBody([turn1, turn2]), { ...off, replay: false })
    assert.equal(disabled.replay, null)
  })

  it('cacheSafe=false also replays hits, so non-deterministic stages stay stable', async () => {
    const memo = createReplayMemo()
    const c = cfg(memo, { cacheSafe: false })
    const n = await run(anthropicBody([turn1]), c)
    const n1 = await run(anthropicBody([turn1, turn2]), c)
    same(n1.body.messages[2], n.body.messages[2])
    assert.equal(n1.replay.hits, 2)
    assert.ok(n1.body.messages[4].content[0].content.length < big('next').length)
  })
})

describe('replay memo — OpenAI chat', () => {
  const body = (turns) => {
    const messages = [{ role: 'user', content: 'go' }]
    for (const calls of turns) {
      messages.push({ role: 'assistant', content: null, tool_calls: calls.map(([id]) => ({ id, type: 'function', function: { name: 'run', arguments: '{}' } })) })
      for (const [id, content] of calls) messages.push({ role: 'tool', tool_call_id: id, content })
    }
    return { model: 'gpt-5', messages }
  }

  it('keys differ by conversation (shared system prompt) and by position', async () => {
    const inner = createReplayMemo()
    const keys = []
    const memo = { ...inner, put: (k, v, m) => { keys.push(k); return inner.put(k, v, m) } }
    const convo = (ask, turns) => {
      const b = body(turns)
      b.messages = [{ role: 'system', content: 'shared system prompt' }, { role: 'user', content: ask }, ...b.messages.slice(1)]
      return b
    }
    const call = [['functions.read:0', big()]]
    await run(convo('fix the parser', [call]), cfg(memo), openai)
    const a = keys.filter(k => k.includes('functions.read:0'))
    await run(convo('rm -rf the build dir', [call]), cfg(memo), openai)
    await run(convo('fix the parser', [call, call]), cfg(memo), openai)
    const all = keys.filter(k => k.includes('functions.read:0'))
    assert.equal(a.length, 1)
    assert.equal(new Set(all).size, 3, 'same id and text: one key per conversation and per position')
  })

  it('older tool messages go out byte-identical and masked', async () => {
    const memo = createReplayMemo()
    const turn1 = [['call_1', big()], ['call_1s', secretText]]
    const n = await run(body([turn1]), cfg(memo), openai)
    const n1 = await run(body([turn1, [['call_2', big('next')]]]), cfg(memo), openai)
    same(n1.body.messages.slice(0, 4), n.body.messages)
    assert.ok(!JSON.stringify(n1.body).includes(SECRET))
    assert.ok(n1.body.messages[5].content.length < big('next').length)
    assert.equal(n1.replay.hits, 2)
  })
})

describe('replay memo — OpenAI Responses', () => {
  const body = (turns) => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'go' }] }]
    for (const [id, output] of turns) {
      input.push({ type: 'function_call', call_id: id, name: 'run', arguments: '{}' })
      input.push({ type: 'function_call_output', call_id: id, output })
    }
    return { model: 'gpt-5', input }
  }

  it('string and array outputs replay byte-identical', async () => {
    const memo = createReplayMemo()
    const arrOut = [{ type: 'input_text', text: big('arr') }, { type: 'input_text', text: secretText }]
    const n = await run(body([['c1', big()]]), cfg(memo), openaiResponses)
    await run(body([['c1', big()], ['c2', arrOut]]), cfg(memo), openaiResponses)
    const n2 = await run(body([['c1', big()], ['c2', arrOut], ['c3', big('next')]]), cfg(memo), openaiResponses)
    same(n2.body.input[2], n.body.input[2])
    assert.ok(n2.body.input[4].output[0].text.length < big('arr').length)
    assert.ok(!JSON.stringify(n2.body).includes(SECRET))
    assert.equal(n2.replay.hits, 3)
  })
})

describe('replay memo — Gemini', () => {
  it('replays through apply so functionResponse stays an object', async () => {
    const memo = createReplayMemo()
    const part = (id, response) => ({ role: 'user', parts: [{ functionResponse: { id, name: 'run', response } }] })
    const resp = JSON.parse(big())
    const n = await run({ contents: [part('g1', resp)] }, cfg(memo), gemini)
    const n1 = await run({ contents: [part('g1', resp), { role: 'model', parts: [{ text: 'ok' }] }, part('g2', JSON.parse(big('next')))] }, cfg(memo), gemini)
    same(n1.body.contents[0], n.body.contents[0])
    assert.equal(typeof n1.body.contents[0].parts[0].functionResponse.response, 'object')
    assert.equal(n1.replay.hits, 1)
  })
})

describe('replay memo — proxy', () => {
  const post = (port, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => { res.resume(); res.on('end', resolve) })
    req.on('error', reject)
    req.end(data)
  })
  const health = port => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/health' }, res => {
      let s = ''
      res.on('data', c => { s += c })
      res.on('end', () => resolve(JSON.parse(s)))
    }).on('error', reject)
  })

  it('one memo per proxy: history reaches upstream as first sent, /health reports replay', async () => {
    const received = []
    const upstream = http.createServer((req, res) => {
      let s = ''
      req.on('data', c => { s += c })
      req.on('end', () => { received.push(JSON.parse(s)); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
    })
    await new Promise(r => upstream.listen(0, '127.0.0.1', r))
    const { server, replayMemo } = createProxy({ port: 0, upstream: `http://127.0.0.1:${upstream.address().port}`, log: false, minSize: 50, stages: ['minify'] })
    const { server: offServer, replayMemo: offMemo } = createProxy({ port: 0, upstream: `http://127.0.0.1:${upstream.address().port}`, log: false, minSize: 50, stages: ['minify'], replay: false })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    await new Promise(r => offServer.listen(0, '127.0.0.1', r))
    try {
      const turn1 = [{ id: 'toolu_p1', content: big() }, { id: 'toolu_p1s', content: secretText }]
      await post(server.address().port, anthropicBody([turn1]))
      await post(server.address().port, anthropicBody([turn1, [{ id: 'toolu_p2', content: big('next') }]]))
      same(received[1].messages[2], received[0].messages[2])
      assert.ok(!JSON.stringify(received[1]).includes(SECRET))
      const h = await health(server.address().port)
      assert.equal(h.replay.hits, 2)
      assert.ok(h.replay.tokensHeld > 0)
      assert.ok(h.replay.entries >= 3)
      assert.ok(replayMemo)

      assert.equal(offMemo, null)
      assert.equal((await health(offServer.address().port)).replay, null)
    } finally {
      server.close(); offServer.close(); upstream.close()
    }
  })
})

describe('replay memo — config', () => {
  it('defaults on with a 64 MiB bound and honours TAMP_REPLAY / TAMP_REPLAY_MAX_BYTES', () => {
    const d = loadConfig({})
    assert.equal(d.replay, true)
    assert.equal(d.replayMaxBytes, 67108864)
    const c = loadConfig({ TAMP_REPLAY: 'false', TAMP_REPLAY_MAX_BYTES: '1024' })
    assert.equal(c.replay, false)
    assert.equal(c.replayMaxBytes, 1024)
    assert.match(CONFIG_TEMPLATE, /# TAMP_REPLAY=true/)
    assert.match(CONFIG_TEMPLATE, /# TAMP_REPLAY_MAX_BYTES=67108864/)
  })
})
