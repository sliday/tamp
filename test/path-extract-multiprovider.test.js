import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractTargetPaths, extractTargetToolNames } from '../lib/path-extract.js'
import { anthropic, openai, kimi, openaiResponses } from '../providers.js'

describe('extractTargetPaths & extractTargetToolNames — multi-provider', () => {
  describe('Anthropic (/v1/messages)', () => {
    it('extracts file_path, path, filePath, and filename plus tool names', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/src/a.js' } },
              { type: 'tool_use', id: 'tu_2', name: 'Read', input: { path: '/src/b.js' } },
              { type: 'tool_use', id: 'tu_3', name: 'Read', input: { filePath: '/src/c.js' } },
              { type: 'tool_use', id: 'tu_4', name: 'Read', input: { filename: '/src/d.js' } },
              { type: 'tool_use', id: 'tu_5', name: 'Bash', input: { command: 'ls' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu_1', content: 'a' },
              { type: 'tool_result', tool_use_id: 'tu_2', content: 'b' },
              { type: 'tool_result', tool_use_id: 'tu_3', content: [{ type: 'text', text: 'c' }] },
              { type: 'tool_result', tool_use_id: 'tu_4', content: 'd' },
              { type: 'tool_result', tool_use_id: 'tu_5', content: 'e' },
            ],
          },
        ],
      }
      const targets = anthropic.extract(body, { cacheSafe: false })
      assert.deepEqual(extractTargetPaths(body, targets), [
        '/src/a.js',
        '/src/b.js',
        '/src/c.js',
        '/src/d.js',
        null,
      ])
      assert.deepEqual(extractTargetToolNames(body, targets), [
        'Read',
        'Read',
        'Read',
        'Read',
        'Bash',
      ])
    })
  })

  describe('OpenAI Chat / Kimi / Moonshot (/v1/chat/completions)', () => {
    it('extracts paths and tool names from assistant tool_calls + tool messages', () => {
      const body = {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'inspect files' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/repo/index.js"}' } },
              { id: 'call_2', type: 'function', function: { name: 'open_file', arguments: '{"path":"/repo/config.js"}' } },
              { id: 'call_3', type: 'function', function: { name: 'view', arguments: '{"filePath":"/repo/stats.js"}' } },
              { id: 'call_4', type: 'function', function: { name: 'load', arguments: '{"filename":"/repo/README.md"}' } },
              { id: 'call_5', type: 'function', function: { name: 'shell', arguments: '{"cmd":"git status"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'index contents' },
          { role: 'tool', tool_call_id: 'call_2', content: 'config contents' },
          { role: 'tool', tool_call_id: 'call_3', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'stats contents' }] },
          { role: 'tool', tool_call_id: 'call_4', content: 'readme contents' },
          { role: 'tool', tool_call_id: 'call_5', content: 'clean' },
        ],
      }
      const targets = openai.extract(body, { cacheSafe: false })
      assert.equal(targets.length, 5)
      assert.deepEqual(extractTargetPaths(body, targets), [
        '/repo/index.js',
        '/repo/config.js',
        '/repo/stats.js',
        '/repo/README.md',
        null,
      ])
      assert.deepEqual(extractTargetToolNames(body, targets), [
        'read_file',
        'open_file',
        'view',
        'load',
        'shell',
      ])
      // Kimi shares the OpenAI chat extraction contract
      const kimiTargets = kimi.extract(body, { cacheSafe: false })
      assert.deepEqual(extractTargetPaths(body, kimiTargets), [
        '/repo/index.js',
        '/repo/config.js',
        '/repo/stats.js',
        '/repo/README.md',
        null,
      ])
    })

    it('handles malformed JSON tool arguments without throwing', () => {
      const body = {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_bad', type: 'function', function: { name: 'read_file', arguments: '{not valid json' } },
              { id: 'call_prim', type: 'function', function: { name: 'read_file', arguments: '"just-a-string"' } },
              { id: 'call_empty', type: 'function', function: { name: 'read_file', arguments: '{"file_path":""}' } },
              { id: 'call_ok', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/ok.js"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_bad', content: 'a' },
          { role: 'tool', tool_call_id: 'call_prim', content: 'b' },
          { role: 'tool', tool_call_id: 'call_empty', content: 'c' },
          { role: 'tool', tool_call_id: 'call_ok', content: 'd' },
        ],
      }
      const targets = openai.extract(body, { cacheSafe: false })
      assert.deepEqual(extractTargetPaths(body, targets), [null, null, null, '/ok.js'])
      assert.deepEqual(extractTargetToolNames(body, targets), [
        'read_file',
        'read_file',
        'read_file',
        'read_file',
      ])
    })
  })

  describe('OpenAI Responses / Codex CLI (/v1/responses)', () => {
    it('extracts paths and tool names for function_call and custom_tool_call items', () => {
      const body = {
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'check files' }] },
          { type: 'function_call', call_id: 'fc_1', name: 'read_file', arguments: '{"file_path":"/app/a.js"}' },
          { type: 'function_call', call_id: 'fc_2', name: 'read_file', arguments: { path: '/app/b.js' } },
          { type: 'custom_tool_call', call_id: 'ctc_1', name: 'edit_file', input: '{"filePath":"/app/c.js"}' },
          { type: 'custom_tool_call', call_id: 'ctc_2', name: 'apply_patch', input: { filename: '/app/d.js' } },
          { type: 'custom_tool_call', call_id: 'ctc_3', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' },
          { type: 'function_call_output', call_id: 'fc_1', output: 'contents a' },
          { type: 'function_call_output', call_id: 'fc_2', output: [{ type: 'input_text', text: 'contents b' }] },
          { type: 'custom_tool_call_output', call_id: 'ctc_1', output: 'ok c' },
          { type: 'custom_tool_call_output', call_id: 'ctc_2', output: [{ type: 'input_text', text: 'ok d' }] },
          { type: 'custom_tool_call_output', call_id: 'ctc_3', output: 'patched' },
        ],
      }
      const targets = openaiResponses.extract(body, { cacheSafe: false })
      assert.equal(targets.length, 5)
      assert.deepEqual(extractTargetPaths(body, targets), [
        '/app/a.js',
        '/app/b.js',
        '/app/c.js',
        '/app/d.js',
        null,
      ])
      assert.deepEqual(extractTargetToolNames(body, targets), [
        'read_file',
        'read_file',
        'edit_file',
        'apply_patch',
        'apply_patch',
      ])
    })

    it('handles malformed JSON arguments and orphan outputs cleanly', () => {
      const body = {
        input: [
          { type: 'function_call', call_id: 'fc_bad', name: 'shell', arguments: '{broken' },
          { type: 'function_call_output', call_id: 'fc_bad', output: 'err' },
          { type: 'function_call_output', call_id: 'fc_orphan', output: 'orphan' },
        ],
      }
      const targets = openaiResponses.extract(body, { cacheSafe: false })
      assert.deepEqual(extractTargetPaths(body, targets), [null, null])
      assert.deepEqual(extractTargetToolNames(body, targets), ['shell', null])
    })
  })

  describe('edge cases', () => {
    it('returns nulls for skipped targets and missing bodies', () => {
      const targets = [
        { skip: 'error', index: 0 },
        { path: ['messages', 0, 'content'], text: 'hi', index: 0 },
        { path: ['input', 0, 'output'], text: 'hi', index: 0 },
      ]
      assert.deepEqual(extractTargetPaths(null, targets), [null, null, null])
      assert.deepEqual(extractTargetToolNames(null, targets), [null, null, null])
      assert.deepEqual(extractTargetPaths({}, targets), [null, null, null])
      assert.deepEqual(extractTargetToolNames({}, targets), [null, null, null])
    })
  })
})
