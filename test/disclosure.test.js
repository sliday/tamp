import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { summarize, findReferenceQuotes, rehydrateReferences, REF_MARKER } from '../lib/disclosure.js'
import { anthropic } from '../providers.js'
import { createBrCache } from '../lib/br-cache.js'
import { compressRequest } from '../compress.js'

function freshDir(tag) {
  return mkdtempSync(join(tmpdir(), `tamp-disclosure-${tag}-`))
}

function bigBody(marker, bytes) {
  const chunk = `${marker} the quick brown fox jumps over the lazy dog 0123456789 `
  const repeats = Math.ceil(bytes / chunk.length)
  return chunk.repeat(repeats).slice(0, bytes)
}

function sha256hex(text) {
  return createHash('sha256').update(text).digest('hex')
}

function extractMarker(text) {
  const re = new RegExp(REF_MARKER.source, REF_MARKER.flags)
  return re.exec(text)
}

function buildAnthropicRequestWithToolResult(body) {
  return {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: 'Please compress this file.' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: '/tmp/huge.txt' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: body },
        ],
      },
    ],
  }
}

function buildAnthropicRequestQuotingRef(refMarker) {
  return {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: 'Please compress this file.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Can you expand ${refMarker} and show me the middle?` },
        ],
      },
    ],
  }
}

describe('summarize - size gate', () => {
  it('returns null for text below minSize', () => {
    const text = bigBody('x', 1024)
    assert.equal(summarize(text, { minSize: 32 * 1024 }), null)
  })

  it('returns a summary for text >= minSize', () => {
    const text = bigBody('y', 64 * 1024)
    const result = summarize(text, { minSize: 32 * 1024 })
    assert.ok(result, 'summary should be produced')
    assert.equal(result.originalBytes, Buffer.byteLength(text, 'utf8'))
    assert.ok(result.summaryBytes < result.originalBytes, 'summary must be smaller than original')
  })
})

describe('summarize - structure', () => {
  it('contains a well-formed <tamp-ref:v1:HASH:BYTES> marker with correct sha256 and byte count', () => {
    const text = bigBody('z', 100 * 1024)
    const bytes = Buffer.byteLength(text, 'utf8')
    const expectedHash = sha256hex(text)
    const result = summarize(text, { minSize: 32 * 1024 })
    assert.ok(result)
    const expectedMarker = `<tamp-ref:v1:${expectedHash}:${bytes}>`
    assert.ok(result.summary.includes(expectedMarker), 'summary must include the exact marker')
    assert.equal(result.hash, expectedHash)
    assert.equal(result.originalBytes, bytes)
  })

  it('contains the head excerpt verbatim (first 2 KB)', () => {
    const text = bigBody('HEAD', 80 * 1024)
    const head = Buffer.from(text, 'utf8').slice(0, 2048).toString('utf8')
    const result = summarize(text, { minSize: 32 * 1024, headBytes: 2048, tailBytes: 1024 })
    assert.ok(result.summary.includes(head), 'head excerpt missing')
  })

  it('contains the tail excerpt verbatim (last 1 KB)', () => {
    const text = bigBody('TAIL', 80 * 1024)
    const buf = Buffer.from(text, 'utf8')
    const tail = buf.slice(buf.length - 1024).toString('utf8')
    const result = summarize(text, { minSize: 32 * 1024, headBytes: 2048, tailBytes: 1024 })
    assert.ok(result.summary.includes(tail), 'tail excerpt missing')
  })
})

describe('findReferenceQuotes - marker extraction', () => {
  it('finds a <tamp-ref:v1:HASH:BYTES> quoted inside a user text block', () => {
    const hash = '0'.repeat(64)
    const bytes = 100000
    const marker = `<tamp-ref:v1:${hash}:${bytes}>`
    const body = buildAnthropicRequestQuotingRef(marker)
    const refs = findReferenceQuotes(body, anthropic)
    assert.equal(refs.length, 1)
    assert.equal(refs[0].hash, hash)
    assert.equal(refs[0].bytes, bytes)
    assert.deepEqual(refs[0].path, ['messages', 1, 'content', 0, 'text'])
  })

  it('finds markers inside tool_use.input objects (stringified JSON)', () => {
    const hash = 'a'.repeat(64)
    const marker = `<tamp-ref:v1:${hash}:1234>`
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_2', name: 'reference', input: { query: `expand ${marker}` } },
          ],
        },
      ],
    }
    const refs = findReferenceQuotes(body, anthropic)
    assert.equal(refs.length, 1)
    assert.equal(refs[0].hash, hash)
    assert.deepEqual(refs[0].path, ['messages', 0, 'content', 0, 'input'])
  })

  it('returns [] when no markers present', () => {
    const body = buildAnthropicRequestWithToolResult('plain small body, no markers here')
    assert.deepEqual(findReferenceQuotes(body, anthropic), [])
  })
})

describe('rehydrateReferences - cache miss is a graceful no-op', () => {
  const dir = freshDir('miss')
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('returns { rehydrated: 0, missed: 1 } and leaves the marker in place', () => {
    const cache = createBrCache({ cacheDir: dir, minSize: 1024 })
    const hash = 'b'.repeat(64)
    const marker = `<tamp-ref:v1:${hash}:50000>`
    const body = buildAnthropicRequestQuotingRef(marker)
    const result = rehydrateReferences(body, anthropic, cache)
    assert.equal(result.rehydrated, 0)
    assert.equal(result.missed, 1)
    assert.ok(body.messages[1].content[0].text.includes(marker))
  })
})

describe('rehydrateReferences - cache hit injects full body', () => {
  const dir = freshDir('hit')
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('replaces the marker with an expanded block containing the full body', () => {
    const cache = createBrCache({ cacheDir: dir, minSize: 1024 })
    const fullText = bigBody('FULL', 64 * 1024)
    const put = cache.put(fullText)
    assert.ok(put)
    const marker = `<tamp-ref:v1:${put.hash}:${Buffer.byteLength(fullText, 'utf8')}>`
    const body = buildAnthropicRequestQuotingRef(marker)

    const result = rehydrateReferences(body, anthropic, cache)
    assert.equal(result.rehydrated, 1)
    assert.equal(result.missed, 0)

    const updated = body.messages[1].content[0].text
    assert.ok(updated.includes('<tamp-ref:v1:' + put.hash + ' expanded -'), 'expansion header missing')
    assert.ok(updated.includes('</tamp-ref expanded>'), 'expansion footer missing')
    assert.ok(updated.includes(fullText), 'full body missing after rehydration')
  })
})

describe('compressRequest - two-turn disclosure + rehydration pipeline', () => {
  const dir = freshDir('pipeline')
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('turn 1 summarizes body >= 32 KB; turn 2 rehydrates it from br-cache', async () => {
    const brCache = createBrCache({ cacheDir: dir, minSize: 4 * 1024 })
    const config = {
      minSize: 50,
      stages: ['br-cache', 'disclosure'],
      llmLinguaUrl: null,
      brCache,
    }

    const fullText = bigBody('PIPE', 100 * 1024)
    const turn1 = buildAnthropicRequestWithToolResult(fullText)
    const originalBytes = Buffer.byteLength(fullText, 'utf8')

    const { body: out1, disclosure } = await compressRequest(turn1, config, anthropic)
    const summarized = out1.messages[2].content[0].content
    assert.ok(typeof summarized === 'string')
    assert.ok(summarized.length < fullText.length, 'summarized body must be smaller than original')
    assert.equal(disclosure?.disclosed, 1)

    const match = extractMarker(summarized)
    assert.ok(match, 'summary must contain a tamp-ref marker')
    const hash = match[1]
    const bytes = Number(match[2])
    assert.equal(bytes, originalBytes)
    assert.equal(hash, sha256hex(fullText))

    const turn2 = buildAnthropicRequestQuotingRef(match[0])
    const { body: out2, disclosure: d2 } = await compressRequest(turn2, config, anthropic)
    assert.equal(d2?.rehydrated, 1)
    const rehydratedText = out2.messages[1].content[0].text
    assert.ok(rehydratedText.includes(fullText), 'full body must be present after rehydration')
    assert.ok(rehydratedText.length > originalBytes, 'rehydrated text must be at least as big as original')
  })
})

describe('disclosure stage - dangerous task bypass', () => {
  const dir = freshDir('dangerous')
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('skips disclosure when the latest user message is a dangerous task', async () => {
    const brCache = createBrCache({ cacheDir: dir, minSize: 4 * 1024 })
    const config = {
      minSize: 50,
      stages: ['br-cache', 'disclosure'],
      llmLinguaUrl: null,
      brCache,
    }

    const dangerousText = 'debug and investigate this memory leak in the upload handler'
    const fullText = bigBody('DANGER', 80 * 1024)

    const body = {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: dangerousText },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_d', name: 'read_file', input: { path: '/a.txt' } }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_d', content: fullText },
          ],
        },
      ],
    }

    const { body: out, disclosure } = await compressRequest(body, config, anthropic)
    const after = out.messages[2].content[0].content
    assert.equal(after, fullText, 'tool_result must pass through untouched when task is dangerous')
    assert.ok(!disclosure || !disclosure.disclosed, 'no disclosure should be recorded')
  })
})

describe('disclosure stage - disabled by default', () => {
  const dir = freshDir('disabled')
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('does not summarize even 1 MB bodies when stage is not in config.stages', async () => {
    const brCache = createBrCache({ cacheDir: dir, minSize: 4 * 1024 })
    const config = {
      minSize: 50,
      stages: ['br-cache'],
      llmLinguaUrl: null,
      brCache,
    }
    const fullText = bigBody('BIG', 1024 * 1024)
    const body = buildAnthropicRequestWithToolResult(fullText)

    const { body: out, disclosure } = await compressRequest(body, config, anthropic)
    const after = out.messages[2].content[0].content
    assert.equal(after.length, fullText.length, 'body must pass through when disclosure disabled')
    assert.equal(disclosure, null)
  })
})
