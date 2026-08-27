import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractTargetToolNames } from '../lib/path-extract.js'
import { compressRequest } from '../compress.js'
import { anthropic } from '../providers.js'

// Tamp's target extractor collects tool_result blocks but has never recorded
// WHICH tool produced each one. Every per-tool rule needs that signal, so it
// is the enabler for the rest of this file. Mirrors extractTargetPaths, which
// already walks tool_use blocks for file_path.

function body(...messages) {
  return { messages }
}

function assistantToolUse(id, name, input = {}) {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
}

function userToolResult(toolUseId, content, extra = {}) {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...extra }] }
}

describe('extractTargetToolNames — attribute each tool_result to its tool', () => {
  it('names the tool that produced a tool_result', () => {
    const b = body(
      assistantToolUse('tu_1', 'Read', { file_path: '/a.js' }),
      userToolResult('tu_1', 'file contents here')
    )
    const targets = anthropic.extract(b, { cacheSafe: false })
    assert.equal(targets.length, 1, 'expected one target for one tool_result')
    assert.deepEqual(extractTargetToolNames(b, targets), ['Read'])
  })

  it('attributes each target independently across several tools', () => {
    const b = body(
      assistantToolUse('tu_1', 'Read', { file_path: '/a.js' }),
      userToolResult('tu_1', 'aaa'),
      assistantToolUse('tu_2', 'Bash', { command: 'ls' }),
      userToolResult('tu_2', 'bbb'),
      assistantToolUse('tu_3', 'AskUserQuestion', {}),
      userToolResult('tu_3', 'ccc')
    )
    const targets = anthropic.extract(b, { cacheSafe: false })
    assert.deepEqual(extractTargetToolNames(b, targets), ['Read', 'Bash', 'AskUserQuestion'])
  })

  it('returns null for a target with no resolvable tool_use', () => {
    const b = body(userToolResult('tu_missing', 'orphan result'))
    const targets = anthropic.extract(b, { cacheSafe: false })
    assert.deepEqual(extractTargetToolNames(b, targets), [null])
  })

  it('returns null for skipped targets rather than shifting the array', () => {
    const b = body(
      assistantToolUse('tu_1', 'Bash', { command: 'false' }),
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'boom', is_error: true },
        { type: 'tool_result', tool_use_id: 'tu_2', content: 'fine' },
      ] },
      assistantToolUse('tu_2', 'Read', { file_path: '/b.js' })
    )
    const targets = anthropic.extract(b, { cacheSafe: false })
    const names = extractTargetToolNames(b, targets)
    assert.equal(names.length, targets.length, 'names must stay parallel to targets')
    assert.equal(names[0], null, 'the skipped error target gets no name')
    assert.equal(names[1], 'Read')
  })
})

// A recorded user decision is the one thing in a transcript that cannot be
// regenerated: re-running the tool would re-prompt the human. Tamp already
// refuses to touch errored results; AskUserQuestion deserves the same
// exemption, and it costs almost nothing (these bodies are tiny).
describe('AskUserQuestion results are exempt from compression', () => {
  // Blank-line padded so the whitespace stage clears its 10% savings floor
  // (compress.js:421) and actually rewrites the body when not exempt.
  const spaced = header =>
    header + '\n' + `${'detail line xxxxxxxxxx'}\n${'\n'.repeat(8)}`.repeat(40)

  function twoResults() {
    return {
      messages: [
        { role: 'user', content: 'do the thing' },
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: '/a.js' } },
          { type: 'tool_use', id: 'tu_ask', name: 'AskUserQuestion', input: {} },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu_read', content: spaced('READ BODY') },
          { type: 'tool_result', tool_use_id: 'tu_ask', content: spaced('USER CHOSE OPTION B') },
        ] },
      ],
    }
  }

  const config = { minSize: 10, stages: ['whitespace'], llmLinguaUrl: null, log: false }

  it('leaves the AskUserQuestion body byte-identical', async () => {
    const request = twoResults()
    const original = request.messages[2].content[1].content
    const { body: out } = await compressRequest(request, config, anthropic)
    assert.equal(out.messages[2].content[1].content, original,
      'AskUserQuestion result must not be rewritten')
  })

  it('still compresses a sibling Read result in the same message', async () => {
    const request = twoResults()
    const original = request.messages[2].content[0].content
    const { body: out } = await compressRequest(request, config, anthropic)
    assert.notEqual(out.messages[2].content[0].content, original,
      'the exemption must be scoped to AskUserQuestion, not the whole message')
  })

  it('reports the exemption as a skip reason rather than a silent pass', async () => {
    const { stats } = await compressRequest(twoResults(), config, anthropic)
    const skipped = stats.filter(s => s.skipped === 'user-decision')
    assert.equal(skipped.length, 1, `expected one user-decision skip, got ${JSON.stringify(stats)}`)
  })
})
