import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectProvider, anthropic, openai, gemini } from '../providers.js'

describe('detectProvider', () => {
  it('returns anthropic for POST /v1/messages', () => {
    assert.equal(detectProvider('POST', '/v1/messages').name, 'anthropic')
  })

  it('returns openai for POST /v1/chat/completions', () => {
    assert.equal(detectProvider('POST', '/v1/chat/completions').name, 'openai')
  })

  it('returns gemini for POST with generateContent in URL', () => {
    assert.equal(detectProvider('POST', '/v1beta/models/gemini-pro:generateContent').name, 'gemini')
  })

  it('returns null for GET /v1/models', () => {
    assert.equal(detectProvider('GET', '/v1/models'), null)
  })

  it('returns null for POST /v1/embeddings', () => {
    assert.equal(detectProvider('POST', '/v1/embeddings'), null)
  })

  it('returns null for GET /v1/messages (wrong method)', () => {
    assert.equal(detectProvider('GET', '/v1/messages'), null)
  })
})

describe('anthropic adapter', () => {
  it('extracts tool_result string content from last user message', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"a":1}' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: '{"b":2}' }] },
      ],
    }
    const targets = anthropic.extract(body)
    assert.equal(targets.length, 1)
    assert.equal(targets[0].text, '{"b":2}')
    assert.deepEqual(targets[0].path, ['messages', 2, 'content', 0, 'content'])
  })

  it('extracts nested text blocks from array content', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: [{ type: 'text', text: '{"nested":true}' }],
        }],
      }],
    }
    const targets = anthropic.extract(body)
    assert.equal(targets.length, 1)
    assert.equal(targets[0].text, '{"nested":true}')
  })

  it('skips is_error tool_results', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: 'error msg' },
          { type: 'tool_result', tool_use_id: 'tu_2', content: '{"ok":true}' },
        ],
      }],
    }
    const targets = anthropic.extract(body)
    assert.equal(targets.length, 2)
    assert.equal(targets[0].skip, 'error')
    assert.equal(targets[1].text, '{"ok":true}')
  })

  it('extracts string content from user message', () => {
    const body = { messages: [{ role: 'user', content: '{"plain":"string"}' }] }
    const targets = anthropic.extract(body)
    assert.equal(targets.length, 1)
    assert.equal(targets[0].text, '{"plain":"string"}')
  })

  it('returns empty for no messages', () => {
    assert.deepEqual(anthropic.extract({}), [])
    assert.deepEqual(anthropic.extract({ messages: [] }), [])
  })

  it('apply replaces content with compressed text', () => {
    const body = {
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'original' }] }],
    }
    const targets = [{ path: ['messages', 0, 'content', 0, 'content'], compressed: 'compressed' }]
    anthropic.apply(body, targets)
    assert.equal(body.messages[0].content[0].content, 'compressed')
  })
})

describe('openai adapter', () => {
  it('extracts tool messages after last assistant with tool_calls', () => {
    const body = {
      messages: [
        { role: 'user', content: 'read file.js' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"file":"contents"}' },
        { role: 'tool', tool_call_id: 'call_2', content: '{"other":"data"}' },
      ],
    }
    const targets = openai.extract(body)
    assert.equal(targets.length, 2)
    assert.equal(targets[0].text, '{"file":"contents"}')
    assert.equal(targets[1].text, '{"other":"data"}')
  })

  it('stops at non-tool message', () => {
    const body = {
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call_1' }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"a":1}' },
        { role: 'user', content: 'next question' },
      ],
    }
    const targets = openai.extract(body)
    assert.equal(targets.length, 1)
  })

  it('returns empty when no assistant with tool_calls', () => {
    const body = {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    }
    assert.deepEqual(openai.extract(body), [])
  })

  it('returns empty for no messages', () => {
    assert.deepEqual(openai.extract({}), [])
    assert.deepEqual(openai.extract({ messages: [] }), [])
  })

  it('apply replaces tool message content', () => {
    const body = {
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call_1' }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'original' },
      ],
    }
    const targets = [{ path: ['messages', 1, 'content'], compressed: 'compressed' }]
    openai.apply(body, targets)
    assert.equal(body.messages[1].content, 'compressed')
  })
})

describe('gemini adapter', () => {
  it('extracts functionResponse from last content', () => {
    const body = {
      contents: [
        { parts: [{ functionResponse: { name: 'read', response: { file: 'data', extra: 'field' } } }] },
      ],
    }
    const targets = gemini.extract(body)
    assert.equal(targets.length, 1)
    assert.ok(targets[0].text.includes('"file"'))
    assert.equal(targets[0].wasObject, true)
  })

  it('handles string response in functionResponse', () => {
    const body = {
      contents: [{ parts: [{ functionResponse: { name: 'read', response: 'plain text' } }] }],
    }
    const targets = gemini.extract(body)
    assert.equal(targets.length, 1)
    assert.equal(targets[0].text, 'plain text')
    assert.equal(targets[0].wasObject, false)
  })

  it('returns empty for no contents', () => {
    assert.deepEqual(gemini.extract({}), [])
    assert.deepEqual(gemini.extract({ contents: [] }), [])
  })

  it('apply parses compressed JSON back to object when wasObject', () => {
    const body = {
      contents: [{ parts: [{ functionResponse: { name: 'f', response: { a: 1, b: 2 } } }] }],
    }
    const targets = [{
      path: ['contents', 0, 'parts', 0, 'functionResponse', 'response'],
      compressed: '{"a":1,"b":2}',
      wasObject: true,
    }]
    gemini.apply(body, targets)
    assert.deepEqual(body.contents[0].parts[0].functionResponse.response, { a: 1, b: 2 })
  })

  it('apply sets string when wasObject but parse fails', () => {
    const body = {
      contents: [{ parts: [{ functionResponse: { name: 'f', response: { a: 1 } } }] }],
    }
    const targets = [{
      path: ['contents', 0, 'parts', 0, 'functionResponse', 'response'],
      compressed: 'not json',
      wasObject: true,
    }]
    gemini.apply(body, targets)
    assert.equal(body.contents[0].parts[0].functionResponse.response, 'not json')
  })
})

describe('round-trip extract -> apply', () => {
  it('anthropic: extract, compress, apply produces valid body', () => {
    const body = {
      model: 'claude-sonnet-4-20250514',
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"key": "value"}' }],
      }],
    }
    const targets = anthropic.extract(body)
    for (const t of targets) { if (!t.skip) t.compressed = '{"key":"value"}' }
    anthropic.apply(body, targets)
    assert.equal(body.messages[0].content[0].content, '{"key":"value"}')
  })

  it('openai: extract, compress, apply produces valid body', () => {
    const body = {
      model: 'gpt-4',
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{\n  "result": "ok"\n}' },
      ],
    }
    const targets = openai.extract(body)
    for (const t of targets) { if (!t.skip) t.compressed = '{"result":"ok"}' }
    openai.apply(body, targets)
    assert.equal(body.messages[1].content, '{"result":"ok"}')
  })

  it('gemini: extract, compress, apply produces valid body', () => {
    const body = {
      contents: [{
        parts: [{ functionResponse: { name: 'tool', response: { data: [1, 2, 3] } } }],
      }],
    }
    const targets = gemini.extract(body)
    for (const t of targets) { if (!t.skip) t.compressed = '{"data":[1,2,3]}' }
    gemini.apply(body, targets)
    assert.deepEqual(body.contents[0].parts[0].functionResponse.response, { data: [1, 2, 3] })
  })
})
