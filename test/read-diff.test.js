import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyPatch } from 'diff'
import { compressMessages } from '../compress.js'
import { createReadCache } from '../lib/read-cache.js'

// Build a message body with a Read tool_use in an assistant turn followed by a
// user turn containing the resolved tool_result. The body is shaped like
// Anthropic's /v1/messages request format.
function makeBody({ toolUseId, filePath, content }) {
  return {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: `Read ${filePath}` }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: filePath } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content },
        ],
      },
    ],
  }
}

// Large synthetic file body — needs to be big enough for the diff to be
// meaningfully smaller than the full text (> 50% threshold check).
function bigFile(seed) {
  const lines = []
  for (let i = 0; i < 120; i++) {
    lines.push(`line ${i}: ${seed} — some representative source code content here for size`)
  }
  return lines.join('\n')
}

const filePath = '/tmp/tamp-read-diff-test.js'
const baseStages = ['read-diff']

describe('read-diff stage', () => {
  it('replaces re-read of same path with a unified diff (lossless)', async () => {
    const readCache = createReadCache()
    const sessionKey = 'session-A'

    const original = bigFile('v1')
    const firstBody = makeBody({ toolUseId: 'tu_1', filePath, content: original })
    const firstResult = await compressMessages(firstBody, {
      minSize: 50,
      stages: baseStages,
      readCache,
      sessionKey,
      cacheSafe: true,
      log: false,
    })
    // First request: no prior cache, pass-through from this stage.
    const firstTarget = firstResult.stats[0]
    assert.notEqual(firstTarget?.method, 'read-diff', 'first read should not be read-diffed')

    // Tweak a few lines — the rest of the body is unchanged so the diff
    // should be much smaller than the full file.
    const edited = original
      .replace('line 5: v1', 'line 5: v2-EDITED')
      .replace('line 50: v1', 'line 50: v2-ALSO')
    const secondBody = makeBody({ toolUseId: 'tu_2', filePath, content: edited })
    const secondResult = await compressMessages(secondBody, {
      minSize: 50,
      stages: baseStages,
      readCache,
      sessionKey,
      cacheSafe: true,
      log: false,
    })

    const secondTarget = secondResult.stats[0]
    assert.equal(secondTarget.method, 'read-diff', 'second read should be read-diffed')
    assert.ok(secondTarget.compressedLen < secondTarget.originalLen,
      `diff body (${secondTarget.compressedLen}) must be shorter than original (${secondTarget.originalLen})`)

    // Pull the compressed block out of the resulting body and reconstruct
    // the new text by applying the patch to the prior text.
    const compressed = secondResult.body.messages[2].content[0].content
    assert.match(compressed, /^\[read-diff from prior read of/, 'marker missing')
    const patchStart = compressed.indexOf(']:\n')
    assert.ok(patchStart !== -1, 'patch delimiter missing')
    const patch = compressed.slice(patchStart + 3)
    const reconstructed = applyPatch(original, patch)
    assert.equal(reconstructed, edited, 'applying patch must reconstruct the new text byte-for-byte')
  })

  it('first occurrence of a path passes through untouched from this stage', async () => {
    const readCache = createReadCache()
    const sessionKey = 'session-B'

    const body = makeBody({ toolUseId: 'tu_1', filePath, content: bigFile('fresh') })
    const { stats, body: out } = await compressMessages(body, {
      minSize: 50,
      stages: baseStages,
      readCache,
      sessionKey,
      cacheSafe: true,
      log: false,
    })
    // read-diff must not touch a first occurrence; any compression that
    // happens here comes from another stage (there are none here).
    assert.ok(!stats.some(s => s.method === 'read-diff'))
    // The tool_result content should be unchanged.
    assert.equal(out.messages[2].content[0].content, bigFile('fresh'))
  })

  it('does not cross-match the same path across distinct sessionKeys', async () => {
    const readCache = createReadCache()
    const original = bigFile('v1')

    // Session A seeds the cache.
    await compressMessages(
      makeBody({ toolUseId: 'tu_1', filePath, content: original }),
      { minSize: 50, stages: baseStages, readCache, sessionKey: 'session-A', cacheSafe: true, log: false },
    )

    // Session B re-reads the same path — must NOT see session A's content.
    const edited = original.replace('line 5: v1', 'line 5: v2')
    const { stats } = await compressMessages(
      makeBody({ toolUseId: 'tu_2', filePath, content: edited }),
      { minSize: 50, stages: baseStages, readCache, sessionKey: 'session-B', cacheSafe: true, log: false },
    )
    assert.ok(!stats.some(s => s.method === 'read-diff'),
      'session-B must not diff against session-A content')
  })

  it('does nothing when "read-diff" stage is not enabled', async () => {
    const readCache = createReadCache()
    const sessionKey = 'session-C'
    const original = bigFile('v1')

    // First request with stage enabled — primes the cache.
    await compressMessages(
      makeBody({ toolUseId: 'tu_1', filePath, content: original }),
      { minSize: 50, stages: ['read-diff'], readCache, sessionKey, cacheSafe: true, log: false },
    )

    // Second request with stage DISABLED — should not diff even though
    // the cache has prior content for this (session, path).
    const edited = original.replace('line 5: v1', 'line 5: v2')
    const { stats, body } = await compressMessages(
      makeBody({ toolUseId: 'tu_2', filePath, content: edited }),
      { minSize: 50, stages: ['minify'], readCache, sessionKey, cacheSafe: true, log: false },
    )
    assert.ok(!stats.some(s => s.method === 'read-diff'))
    assert.equal(body.messages[2].content[0].content, edited,
      'content should pass through unchanged when read-diff is disabled')
  })
})
