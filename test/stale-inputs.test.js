import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compressRequest } from '../compress.js'
import { anthropic } from '../providers.js'

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
})
