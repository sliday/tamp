import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatRequestLog, createSession } from '../stats.js'

describe('formatRequestLog', () => {
  it('produces expected multi-line output', () => {
    const stats = [
      { index: 2, method: 'toon', originalLen: 12847, compressedLen: 7708 },
      { index: 4, skipped: 'error' },
    ]
    const session = createSession()
    session.record(stats)
    const output = formatRequestLog(stats, session)
    assert.ok(output.includes('[toona] anthropic /v1/messages — 2 blocks, 1 compressed'))
    assert.ok(output.includes('block[2]: 12847->7708 chars (-40.0%)'))
    assert.ok(output.includes('[toon]'))
    assert.ok(output.includes('block[4]: skipped (error)'))
    assert.ok(output.includes('total: 12847->7708 chars (-40.0%)'))
    assert.ok(output.includes('session:'))
    assert.ok(output.includes('5139 chars'))
    assert.ok(output.includes('1 compressions'))
  })

  it('works without session', () => {
    const stats = [{ index: 0, method: 'minify', originalLen: 1000, compressedLen: 800 }]
    const output = formatRequestLog(stats, null)
    assert.ok(output.includes('1 blocks, 1 compressed'))
    assert.ok(!output.includes('session:'))
  })
})

describe('createSession', () => {
  it('tracks cumulative totals across multiple record calls', () => {
    const session = createSession()
    session.record([{ index: 0, method: 'minify', originalLen: 1000, compressedLen: 800 }])
    session.record([{ index: 1, method: 'toon', originalLen: 2000, compressedLen: 1200 }])
    const totals = session.getTotals()
    assert.equal(totals.totalSaved, 1000) // (200 + 800)
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
