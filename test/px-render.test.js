import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pxModelAllowed, extractFactsheetTokens, factsheetText, pxRenderTargets } from '../lib/px-render.js'
import { compressRequest, clearCache } from '../compress.js'
import { loadConfig } from '../config.js'
import { anthropic } from '../providers.js'

// Dense grep-like content: tokenizes at ~1-2 chars/token as text, which is
// exactly the profile px-render targets. ~20KB so it clears pxMinChars.
function denseContent(lines = 400) {
  return Array.from({ length: lines }, (_, i) =>
    `src/core/mod${i}/file${i}.ts:${i + 10}: const h${i} = 0x${((i * 2654435761) >>> 0).toString(16)}`
  ).join('\n')
}

// Prose: tokenizes efficiently (>3.5 chars/token) — the density gate must skip it.
function proseContent(paras = 60) {
  return Array.from({ length: paras }, () =>
    'The deployment finished without incident and the reviewers agreed that the rollout plan was reasonable overall. '
  ).join('\n\n')
}

function buildRequest(toolResultBody, model = 'claude-fable-5') {
  return {
    model,
    max_tokens: 1024,
    messages: [
      { role: 'user', content: 'Summarize the scan output' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_px', name: 'Bash', input: { command: 'grep -rn const src/' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_px', content: toolResultBody }],
      },
    ],
  }
}

function pxConfig(overrides = {}) {
  return loadConfig({
    TAMP_STAGES: 'px-render',
    TAMP_MIN_SIZE: '50',
    TAMP_LOG: 'false',
    ...overrides,
  })
}

describe('pxModelAllowed', () => {
  it('matches exact base and -suffix aliases, strips [variant] tags', () => {
    assert.equal(pxModelAllowed('claude-fable-5', 'claude-fable-5'), true)
    assert.equal(pxModelAllowed('claude-fable-5[1m]', 'claude-fable-5'), true)
    assert.equal(pxModelAllowed('claude-fable-5-20260115', 'claude-fable-5'), true)
    assert.equal(pxModelAllowed('claude-opus-5', 'claude-fable-5'), false)
    assert.equal(pxModelAllowed('claude-fable-50', 'claude-fable-5'), false)
    assert.equal(pxModelAllowed(null, 'claude-fable-5'), false)
    assert.equal(pxModelAllowed('claude-fable-5', ''), false)
  })
})

describe('factsheet', () => {
  it('extracts precision-critical tokens and prioritizes opaque ids over URLs', () => {
    const text = 'commit deadbeef1234 fixed src/auth/session.ts, see https://example.com/pr/9 — bumped to v2.4.1, MAX_RETRIES_LIMIT now 250,000'
    const tokens = extractFactsheetTokens(text)
    assert.ok(tokens.includes('deadbeef1234'), 'sha kept')
    assert.ok(tokens.includes('v2.4.1'), 'version kept')
    assert.ok(tokens.includes('MAX_RETRIES_LIMIT'), 'const id kept')
    assert.ok(tokens.some(t => t.includes('src/auth/session.ts')), 'path kept')
  })

  it('is deterministic across calls', () => {
    const text = denseContent(50)
    assert.deepEqual(extractFactsheetTokens(text), extractFactsheetTokens(text))
  })

  it('returns empty sheet for token-free text', () => {
    assert.equal(factsheetText('nothing notable here at all'), '')
  })
})

describe('px-render stage', () => {
  it('renders dense tool_results into image blocks with a factsheet', async () => {
    clearCache()
    const body = buildRequest(denseContent())
    const { stats } = await compressRequest(body, pxConfig(), anthropic)
    const px = stats.find(s => s.method === 'px-render')
    assert.ok(px, 'px-render stat recorded')
    assert.ok(px.compressedTokens < px.originalTokens * 0.8, 'profitable by margin')

    const content = body.messages[2].content[0].content
    assert.ok(Array.isArray(content), 'tool_result content became a block array')
    const images = content.filter(b => b.type === 'image')
    assert.ok(images.length >= 1, 'has image blocks')
    assert.equal(images[0].source.type, 'base64')
    assert.equal(images[0].source.media_type, 'image/png')
    const sheet = content.find(b => b.type === 'text')
    assert.ok(sheet && sheet.text.includes('quote these verbatim'), 'factsheet rides along')
  })

  it('skips prose via the density gate', async () => {
    clearCache()
    const body = buildRequest(proseContent())
    await compressRequest(body, pxConfig(), anthropic)
    assert.equal(typeof body.messages[2].content[0].content, 'string', 'prose left as text')
  })

  it('no-ops for models outside the allowlist', async () => {
    clearCache()
    const body = buildRequest(denseContent(), 'claude-opus-5')
    await compressRequest(body, pxConfig(), anthropic)
    assert.equal(typeof body.messages[2].content[0].content, 'string')
  })

  it('respects prior claims by other stages', async () => {
    const targets = [{ path: ['messages', 2, 'content', 0, 'content'], text: denseContent(), index: 0, bm25Trimmed: true, compressed: 'already trimmed' }]
    const n = await pxRenderTargets(targets, buildRequest(denseContent()), anthropic, { pxModels: 'claude-fable-5', pxMinChars: 4096, pxMaxImages: 6 })
    assert.equal(n, 0)
    assert.equal(targets[0].compressed, 'already trimmed')
  })

  it('only claims string-content tool_result targets, never sub-text paths', async () => {
    const targets = [{ path: ['messages', 2, 'content', 0, 'content', 0, 'text'], text: denseContent(), index: 0 }]
    const n = await pxRenderTargets(targets, buildRequest(denseContent()), anthropic, { pxModels: 'claude-fable-5', pxMinChars: 4096, pxMaxImages: 6 })
    assert.equal(n, 0)
  })

  it('bypasses dangerous tasks', async () => {
    const body = buildRequest(denseContent())
    body.messages[0].content = 'Fix the payment authorization security vulnerability'
    const targets = [{ path: ['messages', 2, 'content', 0, 'content'], text: denseContent(), index: 0 }]
    const n = await pxRenderTargets(targets, body, anthropic, {
      pxModels: 'claude-fable-5', pxMinChars: 4096, pxMaxImages: 6,
      isDangerousTask: () => true,
    })
    assert.equal(n, 0)
  })

  it('skips blocks below pxMinChars', async () => {
    const targets = [{ path: ['messages', 2, 'content', 0, 'content'], text: denseContent(10), index: 0 }]
    const n = await pxRenderTargets(targets, buildRequest(denseContent(10)), anthropic, { pxModels: 'claude-fable-5', pxMinChars: 4096, pxMaxImages: 6 })
    assert.equal(n, 0)
  })
})
