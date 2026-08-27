import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compressRequest } from '../compress.js'
import { anthropic } from '../providers.js'

// Image blocks inside tool_results are invisible to tamp's target extractor,
// which only collects `type: 'text'` sub-blocks. Measured across 403 code-only
// sessions they carry 79% of all tokens — the single largest untouched mass.
//
// They are also the safest thing to drop, for the reason magic-compact gives:
// an image is reloadable. The agent can re-Read the file or re-screenshot.
// What is NOT safe is dropping the image the agent just asked for, so eviction
// is scoped by age: the newest turns keep their pixels.

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function imageResult(toolUseId, bytes = 4000) {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.repeat(Math.ceil(bytes / PNG.length)) } }],
  }
}

// `turns` screenshot turns, oldest first. Each is an assistant Read + a user
// tool_result carrying one image.
function session(turns, { paths = [] } = {}) {
  const messages = [{ role: 'user', content: 'look at these' }]
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'assistant', content: [
      { type: 'tool_use', id: `tu_${i}`, name: 'Read', input: { file_path: paths[i] || `/shot-${i}.png` } },
    ] })
    messages.push({ role: 'user', content: [imageResult(`tu_${i}`)] })
  }
  return { messages }
}

const config = { minSize: 10, stages: ['stale-images'], llmLinguaUrl: null, log: false, cacheSafe: false }
const off = { ...config, stages: ['whitespace'] }

const imageBlocks = msg => (Array.isArray(msg.content) ? msg.content : [])
  .flatMap(b => (Array.isArray(b.content) ? b.content : []))
  .filter(b => b?.type === 'image')

describe('stale-images — evict old screenshots, keep recent ones', () => {
  it('drops the image from an old turn', async () => {
    const { body: out } = await compressRequest(session(5), config, anthropic)
    assert.equal(imageBlocks(out.messages[2]).length, 0, 'oldest turn should have lost its image')
  })

  it('keeps images in the two most recent turns', async () => {
    const { body: out } = await compressRequest(session(5), config, anthropic)
    const last = out.messages[out.messages.length - 1]
    const secondLast = out.messages[out.messages.length - 3]
    assert.equal(imageBlocks(last).length, 1, 'newest image must survive — the agent just asked for it')
    assert.equal(imageBlocks(secondLast).length, 1, 'second-newest image must survive')
  })

  it('leaves a notice naming the file so the agent can reload it', async () => {
    const { body: out } = await compressRequest(session(5, { paths: ['/sprites/hero.png'] }), config, anthropic)
    const text = JSON.stringify(out.messages[2])
    assert.match(text, /\/sprites\/hero\.png/, 'notice should name the source path')
    assert.match(text, /re-?read/i, 'notice should tell the agent how to recover the image')
  })

  it('does nothing when the stage is off', async () => {
    const { body: out } = await compressRequest(session(5), off, anthropic)
    for (let i = 2; i < out.messages.length; i += 2) {
      assert.equal(imageBlocks(out.messages[i]).length, 1, `turn ${i} must be untouched when stage is off`)
    }
  })

  it('reports how many images it evicted', async () => {
    const { staleImages } = await compressRequest(session(5), config, anthropic)
    assert.equal(staleImages?.evicted, 3, 'five turns minus two kept = three evicted')
  })

  it('never evicts when the session is shorter than the keep window', async () => {
    const { body: out } = await compressRequest(session(2), config, anthropic)
    assert.equal(imageBlocks(out.messages[2]).length, 1)
    assert.equal(imageBlocks(out.messages[4]).length, 1)
  })

  it('leaves text tool_results alone', async () => {
    const s = session(4)
    s.messages[2].content.push({ type: 'tool_result', tool_use_id: 'tu_x', content: 'plain text body' })
    const { body: out } = await compressRequest(s, config, anthropic)
    const survived = out.messages[2].content.some(b => b.content === 'plain text body')
    assert.ok(survived, 'stale-images must not touch text results')
  })
})

// The stage is only reachable if config.js accepts the name: TAMP_STAGES is
// validated against ALL_STAGES and unknown entries are dropped with a warning.
describe('stale-images — registration', () => {
  it('is a recognised opt-in stage', async () => {
    const { ALL_STAGES, DEFAULT_STAGES } = await import('../metadata.js')
    assert.ok(ALL_STAGES.includes('stale-images'), 'must be accepted by TAMP_STAGES')
    assert.ok(!DEFAULT_STAGES.includes('stale-images'), 'must stay opt-in — it invalidates the prompt cache')
  })

  it('is declared lossy', async () => {
    const { isLossy } = await import('../metadata.js')
    assert.ok(isLossy('stale-images'), 'dropped pixels are not recoverable from tamp itself')
  })
})
