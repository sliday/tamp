import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compressRequest } from '../compress.js'
import { anthropic, openai, openaiResponses, gemini } from '../providers.js'

const baseConfig = { minSize: 50, stages: [], llmLinguaUrl: null, cacheSafe: false }

describe('output-mode injection — provider injectOutputHint contracts', () => {
  it('anthropic: appends to last user message string content', () => {
    const body = {
      messages: [
        { role: 'user', content: 'fix typo in README' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'now also update the version' },
      ],
    }
    const ok = anthropic.injectOutputHint(body, '[TAMP RULES]')
    assert.equal(ok, true)
    assert.equal(body.messages[2].content, 'now also update the version\n\n[TAMP RULES]')
    assert.equal(body.messages[0].content, 'fix typo in README', 'earlier user message must NOT be touched (cache safety)')
  })

  it('anthropic: appends to last text block in array content', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'first block' },
          { type: 'text', text: 'second block' },
        ],
      }],
    }
    anthropic.injectOutputHint(body, '[RULES]')
    assert.equal(body.messages[0].content[1].text, 'second block\n\n[RULES]')
    assert.equal(body.messages[0].content[0].text, 'first block', 'earlier text block in same message must NOT be touched')
  })

  it('anthropic: pushes new text block when array has no text', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }],
      }],
    }
    anthropic.injectOutputHint(body, '[RULES]')
    assert.equal(body.messages[0].content.length, 2)
    assert.equal(body.messages[0].content[1].type, 'text')
    assert.equal(body.messages[0].content[1].text, '[RULES]')
  })

  it('openai chat: appends to last user message', () => {
    const body = {
      messages: [
        { role: 'user', content: 'first' },
        { role: 'tool', tool_call_id: 't1', content: 'result' },
        { role: 'user', content: 'second' },
      ],
    }
    openai.injectOutputHint(body, '[RULES]')
    assert.equal(body.messages[2].content, 'second\n\n[RULES]')
    assert.equal(body.messages[0].content, 'first')
  })

  it('openai-responses: appends to last input_text in last user item', () => {
    const body = {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'first ask' }] },
        { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: '...' },
        { role: 'user', content: [{ type: 'input_text', text: 'second ask' }] },
      ],
    }
    openaiResponses.injectOutputHint(body, '[RULES]')
    assert.equal(body.input[3].content[0].text, 'second ask\n\n[RULES]')
    assert.equal(body.input[0].content[0].text, 'first ask', 'earlier user message must stay cache-safe')
  })

  it('gemini: appends to last text part in last user content', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'ok' }] },
        { role: 'user', parts: [{ text: 'second' }] },
      ],
    }
    gemini.injectOutputHint(body, '[RULES]')
    assert.equal(body.contents[2].parts[0].text, 'second\n\n[RULES]')
    assert.equal(body.contents[0].parts[0].text, 'first')
  })

  it('returns false / no-op when there is no user message', () => {
    assert.equal(anthropic.injectOutputHint({ messages: [{ role: 'assistant', content: 'hi' }] }, 'x'), false)
    assert.equal(openai.injectOutputHint({ messages: [{ role: 'system', content: 'sys' }] }, 'x'), false)
    assert.equal(openaiResponses.injectOutputHint({ input: [] }, 'x'), false)
    assert.equal(gemini.injectOutputHint({ contents: [] }, 'x'), false)
  })

  it('returns false on falsy text', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] }
    assert.equal(anthropic.injectOutputHint(body, ''), false)
    assert.equal(anthropic.injectOutputHint(body, null), false)
  })
})

describe('output-mode injection — getLastUserText contracts', () => {
  it('anthropic: returns last user string', () => {
    const body = { messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second' },
    ]}
    assert.equal(anthropic.getLastUserText(body), 'second')
  })

  it('anthropic: returns first text block from array content', () => {
    const body = { messages: [{
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't', content: 'output' },
        { type: 'text', text: 'real prompt' },
      ],
    }]}
    assert.equal(anthropic.getLastUserText(body), 'real prompt')
  })

  it('openai-responses: returns last user input_text', () => {
    const body = { input: [
      { role: 'user', content: [{ type: 'input_text', text: 'one' }] },
      { type: 'function_call_output', call_id: 'c', output: '...' },
      { role: 'user', content: [{ type: 'input_text', text: 'two' }] },
    ]}
    assert.equal(openaiResponses.getLastUserText(body), 'two')
  })

  it('gemini: returns last user text part', () => {
    const body = { contents: [
      { role: 'user', parts: [{ text: 'a' }] },
      { role: 'model', parts: [{ text: 'b' }] },
      { role: 'user', parts: [{ text: 'c' }] },
    ]}
    assert.equal(gemini.getLastUserText(body), 'c')
  })

  it('returns null when no user message', () => {
    assert.equal(anthropic.getLastUserText({ messages: [] }), null)
    assert.equal(openai.getLastUserText({}), null)
    assert.equal(openaiResponses.getLastUserText({ input: [] }), null)
    assert.equal(gemini.getLastUserText({ contents: [] }), null)
  })
})

describe('compressRequest — output-mode end-to-end', () => {
  it('does NOT inject when outputMode is off', async () => {
    const body = { messages: [{ role: 'user', content: 'fix typo in README' }] }
    const result = await compressRequest(body, { ...baseConfig, outputMode: 'off' }, anthropic)
    assert.equal(result.outputHint, null)
    assert.equal(body.messages[0].content, 'fix typo in README')
  })

  it('does NOT inject when outputMode is undefined (default)', async () => {
    const body = { messages: [{ role: 'user', content: 'fix typo in README' }] }
    const result = await compressRequest(body, baseConfig, anthropic)
    assert.equal(result.outputHint, null)
    assert.equal(body.messages[0].content, 'fix typo in README')
  })

  it('injects rules when outputMode=balanced and task is safe', async () => {
    const body = { messages: [{ role: 'user', content: 'fix typo in README' }] }
    const result = await compressRequest(body, { ...baseConfig, outputMode: 'balanced' }, anthropic)
    assert.ok(result.outputHint, 'should report injection')
    assert.equal(result.outputHint.mode, 'balanced')
    assert.equal(result.outputHint.taskType, 'safe')
    assert.match(body.messages[0].content, /fix typo in README/)
    assert.match(body.messages[0].content, /\[tamp output rules — balanced mode, safe task\]/)
    assert.match(body.messages[0].content, /Token-Efficient Output/)
  })

  it('injects different rules for dangerous tasks (full output preserved)', async () => {
    const body = { messages: [{ role: 'user', content: 'debug the auth security vulnerability' }] }
    const result = await compressRequest(body, { ...baseConfig, outputMode: 'balanced' }, anthropic)
    // balanced + dangerous = no compression rules (returns empty), so no injection
    assert.equal(result.outputHint, null, 'balanced mode preserves full output for dangerous tasks')
  })

  it('injects in conservative mode regardless of task type', async () => {
    const body = { messages: [{ role: 'user', content: 'random task description' }] }
    const result = await compressRequest(body, { ...baseConfig, outputMode: 'conservative' }, anthropic)
    assert.ok(result.outputHint)
    assert.equal(result.outputHint.mode, 'conservative')
  })

  it('respects autoDetectTaskType=false (forces complex)', async () => {
    const body = { messages: [{ role: 'user', content: 'fix typo in README' }] }
    const result = await compressRequest(body, {
      ...baseConfig,
      outputMode: 'balanced',
      autoDetectTaskType: false,
    }, anthropic)
    // complex + balanced → no rules generated for the safe-only branch → no injection
    assert.equal(result.outputHint, null)
    assert.equal(body.messages[0].content, 'fix typo in README')
  })

  it('does not break the regular tool_result compression pipeline', async () => {
    const bigPayload = JSON.stringify({
      file: 'package.json',
      contents: { name: 'tamp', version: '0.5.9', dependencies: { foo: '1.0', bar: '2.0', baz: '3.0', qux: '4.0' } },
    }, null, 2)
    const body = {
      messages: [
        { role: 'user', content: 'fix typo in README' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't1', content: bigPayload },
        ]},
      ],
    }
    const result = await compressRequest(body, {
      ...baseConfig,
      minSize: 50,
      stages: ['minify'],
      outputMode: 'balanced',
      cacheSafe: false,
    }, anthropic)
    // injection must have happened
    assert.ok(result.outputHint, 'outputHint should be set')
    // last user message has both the tool_result AND a new text block with the rules
    const lastMsg = body.messages[2]
    assert.ok(Array.isArray(lastMsg.content))
    const hasRules = lastMsg.content.some(b => b.type === 'text' && /tamp output rules/.test(b.text))
    assert.ok(hasRules, 'rules text block should be appended to user message content array')
    // tool_result was compressed by minify (no '\n  ' indentation left)
    const toolResultBlock = lastMsg.content.find(b => b.type === 'tool_result')
    assert.ok(!toolResultBlock.content.includes('\n  '), `tool_result should be minified, got: ${toolResultBlock.content.slice(0, 100)}`)
  })
})
