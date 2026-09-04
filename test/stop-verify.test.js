import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { describeStopResult, findPortOwners } from '../bin/lifecycle.js'

const PORT = 7778
const PID = 4242

describe('describeStopResult — clean stop', () => {
  it('reports success when the pid died and the port was released', () => {
    const r = describeStopResult({ pid: PID, port: PORT, pidAlive: false, portBusy: false })
    assert.equal(r.exitCode, 0)
    assert.equal(r.level, 'log')
    assert.match(r.message, /Stopped Tamp \(pid 4242\) on :7778/)
  })

  it('warns about SIGKILL but still succeeds when the port was released', () => {
    const r = describeStopResult({ pid: PID, port: PORT, pidAlive: true, portBusy: false })
    assert.equal(r.exitCode, 0)
    assert.equal(r.level, 'warn')
    assert.match(r.message, /did not respond to SIGTERM/)
  })
})

describe('describeStopResult — another process still owns the port', () => {
  it('does not claim success when the port is still busy', () => {
    const r = describeStopResult({ pid: PID, port: PORT, pidAlive: false, portBusy: true, owners: [16911] })
    assert.equal(r.exitCode, 1)
    assert.equal(r.level, 'error')
    assert.doesNotMatch(r.message, /Stopped Tamp/)
  })

  it('names the surviving owner pid so the user can act', () => {
    const r = describeStopResult({ pid: PID, port: PORT, pidAlive: false, portBusy: true, owners: [16911] })
    assert.match(r.message, /16911/)
    assert.match(r.message, /still/i)
  })

  it('lists every surviving owner when several hold the port', () => {
    const r = describeStopResult({ pid: PID, port: PORT, pidAlive: false, portBusy: true, owners: [101, 202] })
    assert.match(r.message, /101/)
    assert.match(r.message, /202/)
  })

  it('falls back to lsof guidance when owners cannot be determined', () => {
    const r = describeStopResult({ pid: PID, port: PORT, pidAlive: false, portBusy: true, owners: [] })
    assert.equal(r.exitCode, 1)
    assert.match(r.message, /lsof -ti:7778/)
  })

  it('never reports the stopped pid as a surviving owner', () => {
    const r = describeStopResult({ pid: PID, port: PORT, pidAlive: false, portBusy: true, owners: [PID, 777] })
    assert.deepEqual(r.survivors, [777])
    assert.match(r.message, /777/)
  })
})

describe('findPortOwners', () => {
  it('returns an array and never throws on a free port', () => {
    const owners = findPortOwners(1)
    assert.ok(Array.isArray(owners))
  })

  it('excludes the pid we just stopped', async () => {
    const http = await import('node:http')
    const srv = http.default.createServer((req, res) => { res.writeHead(200); res.end() })
    await new Promise(r => srv.listen(0, '127.0.0.1', r))
    const port = srv.address().port
    try {
      const all = findPortOwners(port)
      if (all.length === 0) return // lsof unavailable in this environment
      assert.ok(all.includes(process.pid), 'own listener should be found')
      const excluded = findPortOwners(port, process.pid)
      assert.ok(!excluded.includes(process.pid), 'excluded pid must be filtered out')
    } finally {
      await new Promise(r => srv.close(r))
    }
  })
})
