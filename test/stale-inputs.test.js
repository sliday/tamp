import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compressRequest } from '../compress.js'
import { pruneStaleInputs } from '../lib/stale-inputs.js'
import { anthropic, openai, openaiResponses, kimi, moonshot, gemini } from '../providers.js'

// tool_use.input is 26% of billed tokens across 60 large sessions — the largest
// mass tamp has never touched. (An earlier pass put it at 5%; that estimate was
// diluted by counting base64 image bytes as tokens, which overstates image cost
// ~112x since Anthropic bills images by pixel area.)
//
// What an old tool_use.input still has to carry is the SHAPE of the call: which
// tool ran, against which file. The payload is recoverable — the written file is
// on disk, the edit already landed. So old payloads go, headers stay.

const long = n => 'x'.repeat(n)

function session(turns, buildInput) {
  const messages = [{ role: 'user', content: 'go' }]
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'assistant', content: [
      { type: 'tool_use', id: `tu_${i}`, ...buildInput(i) },
    ] })
    messages.push({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: `tu_${i}`, content: 'ok' },
    ] })
  }
  return { messages }
}

const config = { minSize: 10, stages: ['stale-inputs'], llmLinguaUrl: null, log: false, cacheSafe: false }
const off = { ...config, stages: ['whitespace'] }

const inputAt = (out, turn) => out.messages[1 + turn * 2].content[0].input

describe('stale-inputs — prune payloads from old tool calls', () => {
  it('omits the body of an old Write but keeps the path', async () => {
    const s = session(5, i => ({ name: 'Write', input: { file_path: `/f${i}.js`, content: long(4000) } }))
    const { body: out } = await compressRequest(s, config, anthropic)
    const input = inputAt(out, 0)
    assert.equal(input.file_path, '/f0.js', 'the path is the part worth keeping')
    assert.ok(!input.content.includes(long(100)), 'the written body should be gone')
    assert.match(JSON.stringify(input), /re-?read/i, 'should say how to recover it')
  })

  it('keeps the newest Write intact', async () => {
    const s = session(5, i => ({ name: 'Write', input: { file_path: `/f${i}.js`, content: long(4000) } }))
    const { body: out } = await compressRequest(s, config, anthropic)
    assert.equal(inputAt(out, 4).content.length, 4000, 'the newest call must survive untouched')
  })

  it('truncates a long old Bash command but leaves its head readable', async () => {
    const cmd = 'echo START && ' + long(3000) + ' && echo END'
    const s = session(5, i => ({ name: 'Bash', input: { command: i === 0 ? cmd : 'ls' } }))
    const { body: out } = await compressRequest(s, config, anthropic)
    const command = inputAt(out, 0).command
    assert.ok(command.startsWith('echo START'), 'the head of the command identifies what ran')
    assert.ok(command.length < cmd.length / 2, `expected heavy truncation, got ${command.length} of ${cmd.length}`)
  })

  it('leaves a short Bash command alone', async () => {
    const s = session(5, () => ({ name: 'Bash', input: { command: 'npm test' } }))
    const { body: out } = await compressRequest(s, config, anthropic)
    assert.equal(inputAt(out, 0).command, 'npm test')
  })

  it('omits both sides of an old Edit', async () => {
    const s = session(5, i => ({ name: 'Edit', input: { file_path: `/f${i}.js`, old_string: long(2000), new_string: long(2000) } }))
    const { body: out } = await compressRequest(s, config, anthropic)
    const input = inputAt(out, 0)
    assert.ok(!input.old_string.includes(long(100)), 'old_string should be gone')
    assert.ok(!input.new_string.includes(long(100)), 'new_string should be gone')
    assert.equal(input.file_path, '/f0.js')
  })

  it('never touches AskUserQuestion input', async () => {
    const s = session(5, () => ({ name: 'AskUserQuestion', input: { question: long(4000) } }))
    const { body: out } = await compressRequest(s, config, anthropic)
    assert.equal(inputAt(out, 0).question.length, 4000, 'a recorded question cannot be regenerated')
  })

  it('does nothing when the stage is off', async () => {
    const s = session(5, i => ({ name: 'Write', input: { file_path: `/f${i}.js`, content: long(4000) } }))
    const { body: out } = await compressRequest(s, off, anthropic)
    assert.equal(inputAt(out, 0).content.length, 4000)
  })

  it('reports how many inputs it pruned', async () => {
    const s = session(5, i => ({ name: 'Write', input: { file_path: `/f${i}.js`, content: long(4000) } }))
    const { staleInputs } = await compressRequest(s, config, anthropic)
    assert.equal(staleInputs?.pruned, 3, 'five calls minus the two newest = three pruned')
  })

  it('is a recognised opt-in lossy stage', async () => {
    const { ALL_STAGES, DEFAULT_STAGES, isLossy } = await import('../metadata.js')
    assert.ok(ALL_STAGES.includes('stale-inputs'))
    assert.ok(!DEFAULT_STAGES.includes('stale-inputs'), 'rewrites old turns, so opt-in')
    assert.ok(isLossy('stale-inputs'))
  })

  it('uses per-tool recovery notices (file tools vs Agent/Workflow/SendMessage)', async () => {
    for (const [name, field] of [['Write', 'content'], ['NotebookEdit', 'new_source']]) {
      const s = session(5, () => ({ name, input: { file_path: '/f.js', [field]: long(2000) } }))
      const { body: out } = await compressRequest(s, config, anthropic)
      assert.match(inputAt(out, 0)[field], /Re-read the file if you need the current contents\./)
    }

    const editSess = session(5, () => ({ name: 'Edit', input: { file_path: '/f.js', old_string: long(1500), new_string: long(1500) } }))
    const { body: editOut } = await compressRequest(editSess, config, anthropic)
    assert.match(inputAt(editOut, 0).old_string, /Re-read the file if you need the current contents\./)

    for (const [name, field] of [['Agent', 'prompt'], ['Workflow', 'script'], ['SendMessage', 'message']]) {
      const s = session(5, () => ({ name, input: { [field]: long(2000) } }))
      const { body: out } = await compressRequest(s, config, anthropic)
      const val = inputAt(out, 0)[field]
      assert.match(val, /Summary retained in tool header; payload omitted from older turn\./)
      assert.doesNotMatch(val, /Re-read the file/i)
    }
  })
})

describe('stale-inputs — epoch batching (batchSize)', () => {
  it('quantizes pruning to multiples of batchSize to preserve prompt cache prefix', async () => {
    const batched = { ...config, staleInputKeepRecent: 2, staleBatchSize: 3 }
    const makeWrites = n => session(n, i => ({ name: 'Write', input: { file_path: `/f${i}.js`, content: long(2000) } }))

    assert.equal((await compressRequest(makeWrites(3), batched, anthropic)).staleInputs, null)
    assert.equal((await compressRequest(makeWrites(4), batched, anthropic)).staleInputs, null)

    const r5 = await compressRequest(makeWrites(5), batched, anthropic)
    assert.equal(r5.staleInputs?.pruned, 3)

    const r6 = await compressRequest(makeWrites(6), batched, anthropic)
    assert.equal(r6.staleInputs?.pruned, 3)
    assert.deepEqual(r6.body.messages.slice(0, 7), r5.body.messages.slice(0, 7))
    assert.equal(inputAt(r6.body, 3).content.length, 2000, 'turn 3 stays intact until next epoch')

    const r8 = await compressRequest(makeWrites(8), batched, anthropic)
    assert.equal(r8.staleInputs?.pruned, 6)
  })
})


// ---- Multi-provider helpers & test suites ----

function openaiSession(turns, buildCalls) {
  const messages = [{ role: 'user', content: 'go' }]
  for (let i = 0; i < turns; i++) {
    const rawCalls = buildCalls(i)
    const calls = Array.isArray(rawCalls) ? rawCalls : [rawCalls]
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: calls.map((c, j) => ({
        id: `call_${i}_${j}`,
        type: 'function',
        function: {
          name: c.name,
          arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments),
        },
      })),
    })
    for (let j = 0; j < calls.length; j++) {
      messages.push({ role: 'tool', tool_call_id: `call_${i}_${j}`, content: 'ok' })
    }
  }
  return { messages }
}

function responsesSession(turns, buildTurnItems, separator = 'output') {
  const input = [{ role: 'user', content: [{ type: 'input_text', text: 'go' }] }]
  for (let i = 0; i < turns; i++) {
    const rawItems = buildTurnItems(i)
    const items = Array.isArray(rawItems) ? rawItems : [rawItems]
    for (let j = 0; j < items.length; j++) {
      const item = items[j]
      input.push({ call_id: `rc_${i}_${j}`, ...item })
    }
    if (separator === 'output') {
      for (let j = 0; j < items.length; j++) {
        const outType = items[j].type === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output'
        input.push({ type: outType, call_id: `rc_${i}_${j}`, output: 'ok' })
      }
    } else if (separator === 'reasoning') {
      input.push({ type: 'reasoning', id: `rs_${i}`, summary: [] })
    } else if (separator === 'message') {
      input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'noted' }] })
    }
  }
  return { input }
}

function makePatch(headers, bodyLen = 2000) {
  const lines = ['*** Begin Patch']
  for (let i = 0; i < headers.length; i++) {
    lines.push(headers[i])
    if (i === 0) {
      lines.push('@@ -1,2 +1,2 @@')
      lines.push('-old')
      lines.push('+' + long(bodyLen))
    }
  }
  lines.push('*** End Patch')
  return lines.join('\n')
}

describe('stale-inputs — OpenAI Chat / Kimi / Moonshot (messages[].tool_calls[])', () => {
  it('prunes older tool_calls across openai, kimi, and moonshot while preserving headers and newest turns', async () => {
    for (const provider of [openai, kimi, moonshot]) {
      const s = openaiSession(5, i => ({
        name: 'write_file',
        arguments: { file_path: `/src/f${i}.js`, mode: 'overwrite', content: long(2500) },
      }))
      const { body: out, staleInputs } = await compressRequest(s, config, provider)
      assert.equal(staleInputs?.pruned, 3, `${provider.name}: 5 turns - 2 kept = 3 pruned`)

      const oldArgs = JSON.parse(out.messages[1].tool_calls[0].function.arguments)
      assert.equal(oldArgs.file_path, '/src/f0.js')
      assert.equal(oldArgs.mode, 'overwrite')
      assert.match(oldArgs.content, /^\[tamp: file contents omitted from this older turn \(2500 chars\)\. Re-read the file if you need the current contents\.\]$/)

      const newestArgs = JSON.parse(out.messages[9].tool_calls[0].function.arguments)
      assert.equal(newestArgs.content.length, 2500, `${provider.name}: newest turn intact`)
    }
  })

  it('safely skips malformed JSON, non-object JSON, non-string arguments, and preserves unpruned strings byte-for-byte', () => {
    const prettyUnpruned = '{\n  "file_path": "/small.js",\n  "content": "tiny"\n}'
    const unknownPretty = '{  "foo":   "' + long(2000) + '" }'
    const malformed = '{"file_path": "/broken.js", "content": "' + long(2000)
    const body = {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c0', type: 'function', function: { name: 'write_file', arguments: malformed } },
            { id: 'c1', type: 'function', function: { name: 'write_file', arguments: 'null' } },
            { id: 'c2', type: 'function', function: { name: 'write_file', arguments: '123' } },
            { id: 'c3', type: 'function', function: { name: 'write_file', arguments: '"just a string"' } },
            { id: 'c4', type: 'function', function: { name: 'write_file', arguments: '["a","b"]' } },
            { id: 'c5', type: 'function', function: { name: 'write_file', arguments: 42 } },
            { id: 'c6', type: 'function', function: { name: 'write_file', arguments: prettyUnpruned } },
            { id: 'c7', type: 'function', function: { name: 'custom_read', arguments: unknownPretty } },
          ],
        },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c8', type: 'function', function: { name: 'write_file', arguments: '{"content":"ok"}' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c9', type: 'function', function: { name: 'write_file', arguments: '{"content":"ok"}' } }] },
      ],
    }

    const res = pruneStaleInputs(body, { keepRecent: 2 })
    assert.equal(res.pruned, 0)
    const tcs = body.messages[1].tool_calls
    assert.equal(tcs[0].function.arguments, malformed)
    assert.equal(tcs[1].function.arguments, 'null')
    assert.equal(tcs[2].function.arguments, '123')
    assert.equal(tcs[3].function.arguments, '"just a string"')
    assert.equal(tcs[4].function.arguments, '["a","b"]')
    assert.equal(tcs[5].function.arguments, 42)
    assert.equal(tcs[6].function.arguments, prettyUnpruned, 'small payload keeps exact formatting byte-for-byte')
    assert.equal(tcs[7].function.arguments, unknownPretty, 'unknown tool keeps exact formatting byte-for-byte')
  })

  it('never touches AskUserQuestion in OpenAI Chat tool_calls (case-insensitive)', async () => {
    const rawAsk = '{\n  "question": "' + long(2000) + '"\n}'
    const s = openaiSession(4, i => ({
      name: i === 0 ? 'AskUserQuestion' : 'askuserquestion',
      arguments: rawAsk,
    }))
    const { body: out, staleInputs } = await compressRequest(s, config, openai)
    assert.equal(staleInputs, null)
    assert.equal(out.messages[1].tool_calls[0].function.arguments, rawAsk)
    assert.equal(out.messages[3].tool_calls[0].function.arguments, rawAsk)
  })

  it('handles mixed assistant messages with both content[] tool_use and tool_calls[] as one turn', () => {
    const body = {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_0', name: 'Write', input: { file_path: '/a.js', content: long(2000) } }],
          tool_calls: [{ id: 'tc_0', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: '/b.js', content: long(2000) }) } }],
        },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Write', input: { file_path: '/c.js', content: long(2000) } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'tc_2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: '/d.js', content: long(2000) }) } }] },
      ],
    }

    const res = pruneStaleInputs(body, { keepRecent: 2 })
    assert.equal(res.pruned, 2, 'mixed turn counts once so both calls in turn 0 are pruned')
    assert.match(body.messages[1].content[0].input.content, /\[tamp: file contents omitted/)
    assert.match(JSON.parse(body.messages[1].tool_calls[0].function.arguments).content, /\[tamp: file contents omitted/)
    assert.equal(body.messages[2].content[0].input.content.length, 2000, 'turn 1 kept intact')
  })

  it('enforces epoch batching (keepRecent + batchSize) prefix stability on OpenAI Chat', async () => {
    const batched = { ...config, staleInputKeepRecent: 2, staleBatchSize: 3 }
    const make = n => openaiSession(n, i => ({ name: 'write_file', arguments: { path: `/f${i}.js`, content: long(2000) } }))

    assert.equal((await compressRequest(make(4), batched, openai)).staleInputs, null)

    const r5 = await compressRequest(make(5), batched, openai)
    assert.equal(r5.staleInputs?.pruned, 3)

    const r6 = await compressRequest(make(6), batched, openai)
    assert.equal(r6.staleInputs?.pruned, 3)
    assert.deepEqual(r6.body.messages.slice(0, 7), r5.body.messages.slice(0, 7), 'pruned prefix stays byte-identical within epoch')
    assert.equal(JSON.parse(r6.body.messages[7].tool_calls[0].function.arguments).content.length, 2000)

    const r8 = await compressRequest(make(8), batched, openai)
    assert.equal(r8.staleInputs?.pruned, 6)
  })
})

describe('stale-inputs — OpenAI Responses / Codex CLI (input[])', () => {
  it('prunes older function_call and custom_tool_call items via compressRequest', async () => {
    const patch = makePatch(['*** Update File: src/app.js'])
    const s = responsesSession(4, i => {
      if (i === 0) return { type: 'custom_tool_call', name: 'apply_patch', input: patch }
      if (i === 1) return { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'git diff ' + long(2000) }) }
      return { type: 'function_call', name: 'write_file', arguments: JSON.stringify({ file_path: `/f${i}.js`, content: long(2000) }) }
    })

    const { body: out, staleInputs } = await compressRequest(s, config, openaiResponses)
    assert.equal(staleInputs?.pruned, 2)
    assert.equal(
      out.input[1].input,
      `*** Update File: src/app.js\n[tamp: patch body omitted from this older turn (${patch.length} chars). Re-read the file if you need the current contents.]`,
    )
    const cmdArgs = JSON.parse(out.input[3].arguments)
    assert.ok(cmdArgs.cmd.startsWith('git diff '))
    assert.match(cmdArgs.cmd, /\[tamp: command truncated, \d+ chars total\]$/)
    assert.equal(JSON.parse(out.input[5].arguments).content.length, 2000, 'turn 2 kept')
    assert.equal(JSON.parse(out.input[7].arguments).content.length, 2000, 'turn 3 kept')
  })

  it('groups contiguous parallel function_call / custom_tool_call runs into single turns and never splits them', () => {
    const patch = makePatch(['*** Add File: new.js'])
    // 3 turns, separated by output / reasoning / message; turn 0 has 2 parallel calls, turn 2 has 2 parallel calls
    const body = {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'go' }] },
        // Turn 0 (2 parallel calls)
        { type: 'function_call', call_id: 'c0a', name: 'write_file', arguments: JSON.stringify({ path: '/a.js', content: long(2000) }) },
        { type: 'custom_tool_call', call_id: 'c0b', name: 'apply_patch', input: patch },
        { type: 'function_call_output', call_id: 'c0a', output: 'ok' },
        { type: 'custom_tool_call_output', call_id: 'c0b', output: 'ok' },
        // Turn 1 (1 call, followed by reasoning separator)
        { type: 'function_call', call_id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: '/b.js', content: long(2000) }) },
        { type: 'reasoning', id: 'r1', summary: [] },
        // Turn 2 (2 parallel calls)
        { type: 'function_call', call_id: 'c2a', name: 'write_file', arguments: JSON.stringify({ path: '/c.js', content: long(2000) }) },
        { type: 'function_call', call_id: 'c2b', name: 'write_file', arguments: JSON.stringify({ path: '/d.js', content: long(2000) }) },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      ],
    }

    const res = pruneStaleInputs(body, { keepRecent: 2 })
    assert.equal(res.pruned, 2, 'only turn 0 (both parallel calls) evicted')
    assert.match(JSON.parse(body.input[1].arguments).content, /\[tamp: file contents omitted/)
    assert.match(body.input[2].input, /^\*\*\* Add File: new\.js\n\[tamp: patch body omitted/)
    assert.equal(JSON.parse(body.input[5].arguments).content.length, 2000, 'turn 1 intact')
    assert.equal(JSON.parse(body.input[7].arguments).content.length, 2000, 'turn 2a intact')
    assert.equal(JSON.parse(body.input[8].arguments).content.length, 2000, 'turn 2b intact')
  })

  it('supports custom_tool_call with plain JSON object, JSON string, raw string, malformed JSON, and unknown tools', () => {
    const rawShellBrace = '{ echo START; ' + long(1500) + '; }'
    const prettySmallJson = '{\n  "path": "/s.js",\n  "content": "tiny"\n}'
    const malformedWrite = '{"path": "/bad.js", "content": "' + long(2000)
    const unknownFreeform = 'RAW_FREEFORM_' + long(2000)
    const body = {
      input: [
        { type: 'custom_tool_call', name: 'write_file', input: { file_path: '/obj.js', content: long(2000) } },
        { type: 'custom_tool_call', name: 'write_file', input: JSON.stringify({ file_path: '/str.js', content: long(2000) }) },
        { type: 'custom_tool_call', name: 'write_file', input: prettySmallJson },
        { type: 'custom_tool_call', name: 'write_file', input: malformedWrite },
        { type: 'custom_tool_call', name: 'shell', input: rawShellBrace },
        { type: 'custom_tool_call', name: 'unknown_custom', input: unknownFreeform },
        { type: 'custom_tool_call_output', call_id: 'x', output: 'ok' },
        { type: 'function_call', name: 'write_file', arguments: '{"content":"keep1"}' },
        { type: 'function_call_output', call_id: 'y', output: 'ok' },
        { type: 'function_call', name: 'write_file', arguments: '{"content":"keep2"}' },
      ],
    }

    const res = pruneStaleInputs(body, { keepRecent: 2 })
    assert.equal(res.pruned, 3, 'object write, json-string write, and raw brace shell pruned')
    assert.equal(body.input[0].input.file_path, '/obj.js')
    assert.match(body.input[0].input.content, /\[tamp: file contents omitted/)
    assert.match(JSON.parse(body.input[1].input).content, /\[tamp: file contents omitted/)
    assert.equal(body.input[2].input, prettySmallJson, 'unpruned JSON string untouched byte-for-byte')
    assert.equal(body.input[3].input, malformedWrite, 'malformed JSON untouched')
    assert.ok(body.input[4].input.startsWith('{ echo START; '))
    assert.match(body.input[4].input, /\[tamp: command truncated, \d+ chars total\]$/)
    assert.equal(body.input[5].input, unknownFreeform, 'unknown freeform string untouched')
  })

  it('safely skips malformed function_call arguments and never touches AskUserQuestion in Responses', () => {
    const badArgs = '{broken' + long(2000)
    const askJson = '{\n  "question": "' + long(2000) + '"\n}'
    const askRaw = 'Please confirm: ' + long(2000)
    const askObj = { question: long(2000) }
    const body = {
      input: [
        { type: 'function_call', name: 'write_file', arguments: badArgs },
        { type: 'function_call', name: 'AskUserQuestion', arguments: askJson },
        { type: 'custom_tool_call', name: 'AskUserQuestion', input: askRaw },
        { type: 'custom_tool_call', name: 'askuserquestion', input: askJson },
        { type: 'custom_tool_call', name: 'AskUserQuestion', input: askObj },
        { type: 'function_call_output', call_id: 'o1', output: 'ok' },
        { type: 'function_call', name: 'write_file', arguments: '{"content":"k1"}' },
        { type: 'function_call_output', call_id: 'o2', output: 'ok' },
        { type: 'function_call', name: 'write_file', arguments: '{"content":"k2"}' },
      ],
    }

    const res = pruneStaleInputs(body, { keepRecent: 2 })
    assert.equal(res.pruned, 0)
    assert.equal(body.input[0].arguments, badArgs)
    assert.equal(body.input[1].arguments, askJson)
    assert.equal(body.input[2].input, askRaw)
    assert.equal(body.input[3].input, askJson)
    assert.equal(body.input[4].input.question.length, 2000)
  })

  it('enforces epoch batching (keepRecent + batchSize) prefix stability on OpenAI Responses', async () => {
    const batched = { ...config, staleInputKeepRecent: 2, staleBatchSize: 3 }
    const make = n => responsesSession(n, i => ({
      type: 'function_call',
      name: 'write_file',
      arguments: JSON.stringify({ path: `/r${i}.js`, content: long(2000) }),
    }))

    assert.equal((await compressRequest(make(4), batched, openaiResponses)).staleInputs, null)

    const r5 = await compressRequest(make(5), batched, openaiResponses)
    assert.equal(r5.staleInputs?.pruned, 3)

    const r6 = await compressRequest(make(6), batched, openaiResponses)
    assert.equal(r6.staleInputs?.pruned, 3)
    assert.deepEqual(r6.body.input.slice(0, 7), r5.body.input.slice(0, 7), 'pruned prefix stays byte-identical within epoch')
    assert.equal(JSON.parse(r6.body.input[7].arguments).content.length, 2000)

    const r8 = await compressRequest(make(8), batched, openaiResponses)
    assert.equal(r8.staleInputs?.pruned, 6)
  })
})

describe('stale-inputs — Codex apply_patch header retention & tool alias families', () => {
  it('retains Update/Add/Delete/Move headers in original order, omits notice-only when headerless, and skips small patches', () => {
    const multiFile = makePatch([
      '*** Update File: src/a.js',
      '*** Move to: src/a-renamed.js',
      '*** Add File: src/b.js',
      '*** Delete File: src/c.js',
    ], 2000)
    const noHeaders = 'diff --git a/x b/x\n' + long(2000)
    const smallPatch = '*** Begin Patch\n*** Update File: src/tiny.js\n@@ -1 +1 @@\n-a\n+b\n*** End Patch'

    const body = {
      input: [
        { type: 'custom_tool_call', name: 'apply_patch', input: multiFile },
        { type: 'custom_tool_call', name: 'apply_patch', input: noHeaders },
        { type: 'custom_tool_call', name: 'apply_patch', input: smallPatch },
        { type: 'custom_tool_call', name: 'apply_patch', input: JSON.stringify({ patch: multiFile }) },
        { type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ input: multiFile }) },
        { type: 'function_call_output', call_id: 'o1', output: 'ok' },
        { type: 'function_call', name: 'write_file', arguments: '{"content":"k1"}' },
        { type: 'function_call_output', call_id: 'o2', output: 'ok' },
        { type: 'function_call', name: 'write_file', arguments: '{"content":"k2"}' },
      ],
    }

    const res = pruneStaleInputs(body, { keepRecent: 2 })
    assert.equal(res.pruned, 4, 'small patch skipped; other 4 pruned')

    const expectedMulti = [
      '*** Update File: src/a.js',
      '*** Move to: src/a-renamed.js',
      '*** Add File: src/b.js',
      '*** Delete File: src/c.js',
      `[tamp: patch body omitted from this older turn (${multiFile.length} chars). Re-read the file if you need the current contents.]`,
    ].join('\n')

    assert.equal(body.input[0].input, expectedMulti)
    assert.equal(
      body.input[1].input,
      `[tamp: patch body omitted from this older turn (${noHeaders.length} chars). Re-read the file if you need the current contents.]`,
    )
    assert.equal(body.input[2].input, smallPatch, 'small patch untouched')
    assert.equal(JSON.parse(body.input[3].input).patch, expectedMulti)
    assert.equal(JSON.parse(body.input[4].arguments).input, expectedMulti)
  })

  it('prunes all Write, Edit, Shell, Patch, and Anthropic tool aliases case-insensitively and ignores unknown tools', () => {
    const big = long(1500)
    const calls = [
      // Write family
      { name: 'WRITE_FILE', arguments: { path: '/w1.js', content: big } },
      { name: 'write_to_file', arguments: { filePath: '/w2.js', file_text: big } },
      { name: 'create_file', arguments: { filename: '/w3.js', content: big, file_text: big } },
      // Edit family
      { name: 'edit_file', arguments: { path: '/e1.js', old_string: big, new_string: big } },
      { name: 'Edit', arguments: { path: '/e2.js', old_str: big, new_str: big } },
      { name: 'replace_file_content', arguments: { path: '/e3.js', target_content: big, replacement_content: big } },
      { name: 'replace_file_content', arguments: { path: '/e4.js', replacement_content: big } },
      { name: 'edit_file', arguments: { path: '/e5.js', old_string: big } }, // single-sided -> skip
      // Shell family
      { name: 'shell', arguments: { command: 'ls ' + big } },
      { name: 'exec_command', arguments: { cmd: 'cat ' + big } },
      { name: 'run_command', arguments: { command: 'echo ok', cmd: 'echo ' + big } }, // command wins, short -> skip
      { name: 'execute_command', arguments: { command: 'rg ' + big } },
      { name: 'local_shell', arguments: { cmd: 'node ' + big } },
      // Patch via OpenAI tool_calls
      { name: 'apply_patch', arguments: { patch: makePatch(['*** Update File: p.js']) } },
      // Other Anthropic tools (lowercase / mixed)
      { name: 'notebookedit', arguments: { notebook_path: '/n.ipynb', new_source: big } },
      { name: 'agent', arguments: { description: 'run', prompt: big } },
      { name: 'workflow', arguments: { name: 'wf', script: big } },
      { name: 'sendmessage', arguments: { to: 'peer', message: big } },
      // Unknown & Object.prototype keys -> never modified
      { name: 'read_file', arguments: { path: '/r.js', content: big } },
      { name: 'constructor', arguments: { content: big } },
      { name: 'toString', arguments: { content: big } },
    ]

    const body = {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((c, idx) => ({
            id: `tc_${idx}`,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        },
        { role: 'assistant', content: null, tool_calls: [{ id: 'k1', type: 'function', function: { name: 'write_file', arguments: '{"content":"k"}' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'k2', type: 'function', function: { name: 'write_file', arguments: '{"content":"k"}' } }] },
      ],
    }

    const res = pruneStaleInputs(body, { keepRecent: 2 })
    // 21 calls total minus 5 skipped (e5 single-sided, run_command short command, read_file, constructor, toString) = 16
    assert.equal(res.pruned, 16)

    const argAt = idx => JSON.parse(body.messages[1].tool_calls[idx].function.arguments)
    // Write family
    assert.match(argAt(0).content, /file contents omitted/)
    assert.equal(argAt(0).path, '/w1.js')
    assert.match(argAt(1).file_text, /file contents omitted/)
    assert.equal(argAt(1).filePath, '/w2.js')
    assert.match(argAt(2).content, /file contents omitted/)
    assert.match(argAt(2).file_text, /file contents omitted/)
    // Edit family
    assert.match(argAt(3).old_string, /edit old_string omitted/)
    assert.match(argAt(3).new_string, /edit new_string omitted/)
    assert.match(argAt(4).old_str, /edit old_str omitted/)
    assert.match(argAt(4).new_str, /edit new_str omitted/)
    assert.match(argAt(5).target_content, /edit target_content omitted/)
    assert.match(argAt(5).replacement_content, /edit replacement_content omitted/)
    assert.match(argAt(6).replacement_content, /edit replacement_content omitted/)
    assert.equal(argAt(7).old_string.length, 1500, 'single-sided old_string skipped')
    // Shell family
    assert.match(argAt(8).command, /command truncated/)
    assert.match(argAt(9).cmd, /command truncated/)
    assert.equal(argAt(10).command, 'echo ok', 'short command does not fall through to cmd')
    assert.equal(argAt(10).cmd.length, 5 + 1500)
    assert.match(argAt(11).command, /command truncated/)
    assert.match(argAt(12).cmd, /command truncated/)
    // Patch
    assert.match(argAt(13).patch, /^\*\*\* Update File: p\.js\n\[tamp: patch body omitted/)
    // Other tools
    assert.match(argAt(14).new_source, /notebook source omitted.*Re-read the file/)
    assert.match(argAt(15).prompt, /agent prompt omitted.*Summary retained/)
    assert.match(argAt(16).script, /workflow script omitted.*Summary retained/)
    assert.match(argAt(17).message, /inter-agent message omitted.*Summary retained/)
    // Unknown / prototype keys untouched
    assert.equal(argAt(18).content.length, 1500)
    assert.equal(argAt(19).content.length, 1500)
    assert.equal(argAt(20).content.length, 1500)
  })
})

describe('stale-inputs — Gemini & unknown body shapes safe no-op', () => {
  it('leaves Gemini requests untouched and returns staleInputs: null', async () => {
    const geminiBody = {
      contents: [
        { role: 'user', parts: [{ text: 'go' }] },
        { role: 'model', parts: [{ functionCall: { name: 'write_file', args: { path: '/a.js', content: long(2500) } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'write_file', response: { result: 'ok' } } }] },
        { role: 'model', parts: [{ functionCall: { name: 'write_file', args: { path: '/b.js', content: long(2500) } } }] },
        { role: 'model', parts: [{ functionCall: { name: 'write_file', args: { path: '/c.js', content: long(2500) } } }] },
      ],
    }
    const snapshot = JSON.stringify(geminiBody)
    const { body: out, staleInputs } = await compressRequest(geminiBody, config, gemini)
    assert.equal(staleInputs, null)
    assert.equal(JSON.stringify(out), snapshot)
  })

  it('returns { pruned: 0 } without throwing for unknown or empty body shapes', () => {
    const unknown = { contents: [{ role: 'model', parts: [{ text: long(2000) }] }] }
    const before = JSON.stringify(unknown)
    assert.deepEqual(pruneStaleInputs(unknown), { pruned: 0 })
    assert.equal(JSON.stringify(unknown), before)
    assert.deepEqual(pruneStaleInputs({}), { pruned: 0 })
    assert.deepEqual(pruneStaleInputs(null), { pruned: 0 })
    assert.deepEqual(pruneStaleInputs(undefined), { pruned: 0 })
  })
})
