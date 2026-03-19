import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatRequestLog, createSession } from '../stats.js'

describe('formatRequestLog', () => {
  it('shows compression details for compressed blocks', () => {
    const stats = [
      { index: 2, method: 'toon', originalLen: 12847, compressedLen: 7708 },
      { index: 4, skipped: 'error' },
    ]
    const session = createSession()
    session.record(stats)
    const output = formatRequestLog(stats, session)
    assert.ok(output.includes('anthropic'))
    assert.ok(output.includes('1 compressed'))
    assert.ok(output.includes('-40.0%'))
    assert.ok(output.includes('block[2]'))
    assert.ok(output.includes('toon'))
    assert.ok(output.includes('block[4]'))
    assert.ok(output.includes('skipped'))
    assert.ok(output.includes('session'))
  })

  it('shows no tool blocks when stats empty', () => {
    const output = formatRequestLog([], null)
    assert.ok(output.includes('no tool blocks'))
  })

  it('shows nothing to compress when all skipped', () => {
    const stats = [{ index: 0, skipped: 'error' }]
    const output = formatRequestLog(stats, null)
    assert.ok(output.includes('1 blocks'))
    assert.ok(output.includes('skipped'))
  })

  it('works without session', () => {
    const stats = [{ index: 0, method: 'minify', originalLen: 1000, compressedLen: 800 }]
    const output = formatRequestLog(stats, null)
    assert.ok(output.includes('1 compressed'))
    assert.ok(!output.includes('session'))
  })

  it('includes body size when provided', () => {
    const stats = [{ index: 0, method: 'minify', originalLen: 1000, compressedLen: 800 }]
    const output = formatRequestLog(stats, null, 'anthropic', '/v1/messages', 2048)
    assert.ok(output.includes('2.0k'))
  })

  it('formats sizes in k for large values', () => {
    const stats = [{ index: 0, method: 'minify', originalLen: 5120, compressedLen: 3072 }]
    const output = formatRequestLog(stats, null)
    assert.ok(output.includes('5.0k'))
    assert.ok(output.includes('3.0k'))
  })

  it('shows session avg percentage', () => {
    const session = createSession()
    session.record([{ index: 0, method: 'minify', originalLen: 1000, compressedLen: 600 }])
    session.record([{ index: 1, method: 'toon', originalLen: 2000, compressedLen: 1000 }])
    const stats = [{ index: 2, method: 'minify', originalLen: 500, compressedLen: 300 }]
    session.record(stats)
    const output = formatRequestLog(stats, session)
    assert.ok(output.includes('session'))
    assert.ok(output.includes('avg'))
  })

  it('shows dollar savings when tokens are saved', () => {
    const session = createSession()
    session.record([{ index: 0, method: 'minify', originalLen: 1000, compressedLen: 600, originalTokens: 500, compressedTokens: 300 }])
    const stats = [{ index: 1, method: 'minify', originalLen: 500, compressedLen: 300, originalTokens: 250, compressedTokens: 150 }]
    session.record(stats)
    const output = formatRequestLog(stats, session, 'anthropic', '/v1/messages', 1500, 3)
    assert.ok(output.includes('$'))
    assert.ok(output.includes('saved'))
    assert.ok(output.includes('$3/Mtok'))
  })

  it('uses custom token cost', () => {
    const session = createSession()
    const stats = [{ index: 0, method: 'minify', originalLen: 1000, compressedLen: 600, originalTokens: 100000, compressedTokens: 60000 }]
    session.record(stats)
    const output = formatRequestLog(stats, session, 'openai', '/v1/chat/completions', 1000, 15)
    assert.ok(output.includes('$15/Mtok'))
  })
})

describe('createSession', () => {
  it('tracks cumulative totals across multiple record calls', () => {
    const session = createSession()
    session.record([{ index: 0, method: 'minify', originalLen: 1000, compressedLen: 800 }])
    session.record([{ index: 1, method: 'toon', originalLen: 2000, compressedLen: 1200 }])
    const totals = session.getTotals()
    assert.equal(totals.totalSaved, 1000)
    assert.equal(totals.totalOriginal, 3000)
    assert.equal(totals.compressionCount, 2)
  })

  it('ignores skipped entries', () => {
    const session = createSession()
    session.record([{ index: 0, skipped: 'error' }])
    const totals = session.getTotals()
    assert.equal(totals.totalSaved, 0)
    assert.equal(totals.compressionCount, 0)
  })
})
