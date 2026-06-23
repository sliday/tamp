import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { startMockUpstream, startProxy, rawRequest } from './helpers/proxy-harness.js'

// End-to-end guard for the OpenAI Responses (Codex) path: a function_call_output
// is compressed while every sibling item — user message, function_call, ids —
// is forwarded unchanged, and the compressed output stays a string (the
// Responses API requires function_call_output.output to be a string).
describe('openai-responses function_call_output round-trip (integration)', () => {
  const cleanups = []
  after(async () => { for (const c of cleanups.reverse()) await c() })

  it('compresses the tool output and preserves all other request structure', async () => {
    let received
    const up = await startMockUpstream(async (req, res, ctx) => {
      received = JSON.parse((await ctx.body()).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    const proxy = await startProxy({ upstream: up.url, stages: ['minify', 'toon'], minSize: 10 })
    cleanups.push(up.close, proxy.close)

    const bigOutput = JSON.stringify(
      { rows: Array.from({ length: 80 }, (_, i) => ({ id: i, name: 'n' + i, val: i * 3 })) },
      null,
      4,
    )
    const body = {
      model: 'gpt-5',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'analyze' }] },
        { type: 'function_call', call_id: 'c1', name: 'q', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: bigOutput },
      ],
    }

    const r = await rawRequest(proxy.port, {
      method: 'POST', path: '/v1/responses',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(r.status, 200)

    assert.equal(received.input.length, 3, 'no items added or dropped')
    const fco = received.input.find((x) => x.type === 'function_call_output')
    assert.equal(typeof fco.output, 'string', 'output must remain a string')
    assert.ok(fco.output.length < bigOutput.length, 'output should be compressed')
    assert.equal(fco.call_id, 'c1', 'call_id preserved')
    // Sibling items untouched.
    assert.equal(received.input[0].content[0].text, 'analyze')
    assert.equal(received.input[1].type, 'function_call')
    assert.equal(received.input[1].arguments, '{}')
  })
})
