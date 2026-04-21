import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectProvider, anthropic, openai, openaiResponses, gemini, kimi, moonshot } from '../providers.js'
import { loadConfig } from '../config.js'

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

  it('returns openai for POST /chat/completions (no /v1 prefix)', () => {
    assert.equal(detectProvider('POST', '/chat/completions').name, 'openai')
  })

  it('returns openai-responses for POST /v1/responses', () => {
    assert.equal(detectProvider('POST', '/v1/responses').name, 'openai-responses')
  })

  it('returns openai-responses for POST /responses (no /v1 prefix)', () => {
    assert.equal(detectProvider('POST', '/responses').name, 'openai-responses')
  })

  it('does not match /v1/responses on GET', () => {
    assert.equal(detectProvider('GET', '/v1/responses'), null)
  })

})

describe('openai normalizeUrl', () => {
  it('prepends /v1 when missing', () => {
    assert.equal(openai.normalizeUrl('/chat/completions'), '/v1/chat/completions')
  })

  it('keeps /v1 prefix as-is', () => {
    assert.equal(openai.normalizeUrl('/v1/chat/completions'), '/v1/chat/completions')
  })

})

describe('anthropic adapter', () => {
  it('extracts tool_result from ALL user messages', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"a":1}' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: '{"b":2}' }] },
      ],
    }
    const targets = anthropic.extract(body)
    assert.equal(targets.length, 2)
    assert.equal(targets[0].text, '{"a":1}')
    assert.deepEqual(targets[0].path, ['messages', 0, 'content', 0, 'content'])
    assert.equal(targets[1].text, '{"b":2}')
    assert.deepEqual(targets[1].path, ['messages', 2, 'content', 0, 'content'])
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

  it('extracts only the newest eligible user message when cacheSafe=true', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: '{"a":1}' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new', content: '{"b":2}' }] },
      ],
    }
    const targets = anthropic.extract(body, { cacheSafe: true })
    assert.equal(targets.length, 1)
    assert.deepEqual(targets[0].path, ['messages', 2, 'content', 0, 'content'])
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
  it('extracts ALL tool messages across conversation', () => {
    const body = {
      messages: [
        { role: 'user', content: 'read file.js' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"file":"contents"}' },
        { role: 'user', content: 'now read other.js' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_2', content: '{"other":"data"}' },
      ],
    }
    const targets = openai.extract(body)
    assert.equal(targets.length, 2)
    assert.equal(targets[0].text, '{"file":"contents"}')
    assert.equal(targets[1].text, '{"other":"data"}')
  })

  it('returns empty when no tool messages', () => {
    const body = {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    }
    assert.deepEqual(openai.extract(body), [])
  })

  it('extracts only trailing tool messages when cacheSafe=true', () => {
    const body = {
      messages: [
        { role: 'tool', tool_call_id: 'call_1', content: '{"old":"data"}' },
        { role: 'assistant', content: 'done' },
        { role: 'tool', tool_call_id: 'call_2', content: '{"new":"data"}' },
        { role: 'tool', tool_call_id: 'call_3', content: '{"newer":"data"}' },
      ],
    }
    const targets = openai.extract(body, { cacheSafe: true })
    assert.equal(targets.length, 2)
    assert.deepEqual(targets.map(target => target.path), [
      ['messages', 2, 'content'],
      ['messages', 3, 'content'],
    ])
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

describe('openai-responses adapter', () => {
  it('extracts ALL function_call_output items from input array', () => {
    const body = {
      model: 'gpt-5-codex',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'read file.js' }] },
        { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: '{"file":"contents"}' },
        { role: 'user', content: [{ type: 'input_text', text: 'now read other.js' }] },
        { type: 'function_call', call_id: 'call_2', name: 'shell', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_2', output: '{"other":"data"}' },
      ],
    }
    const targets = openaiResponses.extract(body)
    assert.equal(targets.length, 2)
    assert.equal(targets[0].text, '{"file":"contents"}')
    assert.deepEqual(targets[0].path, ['input', 2, 'output'])
    assert.equal(targets[1].text, '{"other":"data"}')
    assert.deepEqual(targets[1].path, ['input', 5, 'output'])
  })

  it('skips function_call_output with non-string output', () => {
    const body = {
      input: [
        { type: 'function_call_output', call_id: 'c1', output: { nested: 'obj' } },
        { type: 'function_call_output', call_id: 'c2', output: '{"ok":true}' },
      ],
    }
    const targets = openaiResponses.extract(body)
    assert.equal(targets.length, 1)
    assert.equal(targets[0].text, '{"ok":true}')
  })

  it('ignores user/assistant messages and function_call items', () => {
    const body = {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' },
        { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
      ],
    }
    assert.deepEqual(openaiResponses.extract(body), [])
  })

  it('extracts only trailing function_call_output items when cacheSafe=true', () => {
    const body = {
      input: [
        { type: 'function_call_output', call_id: 'old', output: '{"old":"data"}' },
        { role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
        { type: 'function_call_output', call_id: 'new1', output: '{"new":"data"}' },
        { type: 'function_call_output', call_id: 'new2', output: '{"newer":"data"}' },
      ],
    }
    const targets = openaiResponses.extract(body, { cacheSafe: true })
    assert.equal(targets.length, 2)
    assert.deepEqual(targets.map(t => t.path), [
      ['input', 2, 'output'],
      ['input', 3, 'output'],
    ])
  })

  it('returns empty for missing or empty input', () => {
    assert.deepEqual(openaiResponses.extract({}), [])
    assert.deepEqual(openaiResponses.extract({ input: [] }), [])
    assert.deepEqual(openaiResponses.extract({ input: null }), [])
  })

  it('apply replaces function_call_output.output with compressed text', () => {
    const body = {
      input: [
        { type: 'function_call_output', call_id: 'c1', output: 'original' },
      ],
    }
    const targets = [{ path: ['input', 0, 'output'], compressed: 'compressed' }]
    openaiResponses.apply(body, targets)
    assert.equal(body.input[0].output, 'compressed')
  })

  it('normalizeUrl prepends /v1 when missing', () => {
    assert.equal(openaiResponses.normalizeUrl('/responses'), '/v1/responses')
    assert.equal(openaiResponses.normalizeUrl('/v1/responses'), '/v1/responses')
  })

  it('round-trip: extract, compress, apply produces valid body', () => {
    const body = {
      model: 'gpt-5-codex',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'read it' }] },
        { type: 'function_call_output', call_id: 'c1', output: '{\n  "result": "ok"\n}' },
      ],
    }
    const targets = openaiResponses.extract(body)
    for (const t of targets) { if (!t.skip) t.compressed = '{"result":"ok"}' }
    openaiResponses.apply(body, targets)
    assert.equal(body.input[1].output, '{"result":"ok"}')
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

  it('extracts only the last content with functionResponse when cacheSafe=true', () => {
    const body = {
      contents: [
        { parts: [{ functionResponse: { name: 'old', response: { a: 1 } } }] },
        { parts: [{ text: 'noop' }] },
        { parts: [{ functionResponse: { name: 'new', response: { b: 2 } } }] },
      ],
    }
    const targets = gemini.extract(body, { cacheSafe: true })
    assert.equal(targets.length, 1)
    assert.deepEqual(targets[0].path, ['contents', 2, 'parts', 0, 'functionResponse', 'response'])
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

// ---------------------------------------------------------------------------
// Track C: Kimi / Moonshot routing, adapter passthrough, upstream allowlist
// ---------------------------------------------------------------------------

describe('detectProvider (kimi / moonshot)', () => {
  it('returns kimi for POST /coding/v1/chat/completions', () => {
    const p = detectProvider('POST', '/coding/v1/chat/completions')
    assert.equal(p?.name, 'kimi')
  })

  it('returns kimi for POST /kimi/v1/chat/completions (tamp mount)', () => {
    const p = detectProvider('POST', '/kimi/v1/chat/completions')
    assert.equal(p?.name, 'kimi')
  })

  it('returns kimi when x-tamp-target: kimi on openai-compat path', () => {
    const p = detectProvider('POST', '/v1/chat/completions', { 'x-tamp-target': 'kimi' })
    assert.equal(p?.name, 'kimi')
  })

  it('returns moonshot for POST /moonshot/v1/chat/completions', () => {
    const p = detectProvider('POST', '/moonshot/v1/chat/completions')
    assert.equal(p?.name, 'moonshot')
  })

  it('returns moonshot when x-tamp-target: moonshot on openai-compat path', () => {
    const p = detectProvider('POST', '/v1/chat/completions', { 'x-tamp-target': 'moonshot' })
    assert.equal(p?.name, 'moonshot')
  })

  it('kimi normalizeUrl strips tamp mount prefix', () => {
    assert.equal(kimi.normalizeUrl('/kimi/coding/v1/chat/completions'), '/coding/v1/chat/completions')
    assert.equal(kimi.normalizeUrl('/kimi/v1/chat/completions'), '/coding/v1/chat/completions')
    assert.equal(kimi.normalizeUrl('/coding/v1/chat/completions'), '/coding/v1/chat/completions')
  })

  it('moonshot normalizeUrl strips tamp mount prefix', () => {
    assert.equal(moonshot.normalizeUrl('/moonshot/v1/chat/completions'), '/v1/chat/completions')
    assert.equal(moonshot.normalizeUrl('/moonshot/chat/completions'), '/v1/chat/completions')
  })
})

describe('kimi adapter (OpenAI-compat passthrough)', () => {
  it('extracts tool messages like openai adapter', () => {
    const body = {
      messages: [
        { role: 'user', content: 'read file' },
        { role: 'tool', tool_call_id: 'c1', content: '{"file":"contents"}' },
      ],
    }
    const targets = kimi.extract(body)
    assert.equal(targets.length, 1)
    assert.equal(targets[0].text, '{"file":"contents"}')
  })

  it('extract() skips thinking blocks on array content', () => {
    // Kimi/Moonshot sometimes emit typed blocks on tool content. The
    // "thinking" / "partial" block types are skipped — they must be passed
    // through verbatim so the model receives its own reasoning stream.
    const body = {
      messages: [
        {
          role: 'tool',
          tool_call_id: 'c1',
          content: [
            { type: 'thinking', thinking: 'hidden scratchpad' },
            { type: 'text', text: '{"ok":true}' },
            { type: 'partial', text: 'streaming fragment' },
          ],
        },
      ],
    }
    const targets = kimi.extract(body)
    // Only the text block should be extracted; thinking/partial must be
    // untouched and contribute no targets.
    assert.equal(targets.length, 1)
    assert.equal(targets[0].text, '{"ok":true}')
    assert.deepEqual(targets[0].path, ['messages', 0, 'content', 1, 'text'])
  })

  it('apply + round-trip works for kimi tool messages', () => {
    const body = {
      messages: [
        { role: 'tool', tool_call_id: 'c1', content: '{\n  "a": 1\n}' },
      ],
    }
    const targets = kimi.extract(body)
    for (const t of targets) { if (!t.skip) t.compressed = '{"a":1}' }
    kimi.apply(body, targets)
    assert.equal(body.messages[0].content, '{"a":1}')
  })
})

describe('config upstream allowlist (kimi / moonshot)', () => {
  it('defaults to api.kimi.com and api.moonshot.cn', () => {
    const c = loadConfig({})
    assert.equal(c.upstreams.kimi, 'https://api.kimi.com')
    assert.equal(c.upstreams.moonshot, 'https://api.moonshot.cn')
  })

  it('TAMP_UPSTREAM_KIMI overrides default', () => {
    const c = loadConfig({ TAMP_UPSTREAM_KIMI: 'https://test.kimi.local' })
    assert.equal(c.upstreams.kimi, 'https://test.kimi.local')
  })

  it('TAMP_UPSTREAM_MOONSHOT overrides default', () => {
    const c = loadConfig({ TAMP_UPSTREAM_MOONSHOT: 'https://test.moonshot.local' })
    assert.equal(c.upstreams.moonshot, 'https://test.moonshot.local')
  })

  it('leaves openai and anthropic upstreams untouched when kimi override is set', () => {
    const c = loadConfig({ TAMP_UPSTREAM_KIMI: 'https://x' })
    assert.equal(c.upstreams.openai, 'https://api.openai.com')
    assert.equal(c.upstreams.anthropic, 'https://api.anthropic.com')
  })
})
