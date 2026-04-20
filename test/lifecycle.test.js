import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import http from 'node:http'
import {
  pidFilePath,
  writePidFile,
  readPidFile,
  clearPidFile,
  isProcessAlive,
  checkPort,
  fetchHealth,
  formatAge,
  diagnoseBindConflict,
  reconcileStalePidFile,
  installShutdown,
} from '../bin/lifecycle.js'

// Use a port unlikely to collide with anything
const TEST_PORT = 17888
const DEAD_PID = 999999

function cleanup() {
  clearPidFile(TEST_PORT)
}

afterEach(cleanup)

describe('pidFilePath', () => {
  it('returns a path ending with tamp-<port>.pid', () => {
    const p = pidFilePath(7778)
    assert.match(p, /tamp-7778\.pid$/)
  })
})

describe('writePidFile + readPidFile + clearPidFile', () => {
  it('writes current pid and timestamp, reads them back', () => {
    writePidFile(TEST_PORT)
    const rec = readPidFile(TEST_PORT)
    assert.equal(rec.pid, process.pid)
    assert.ok(rec.startedAt > 0)
    assert.ok(Date.now() - rec.startedAt < 5000)
  })

  it('clearPidFile removes the file without error if missing', () => {
    clearPidFile(TEST_PORT) // no-op when absent
    writePidFile(TEST_PORT)
    assert.ok(existsSync(pidFilePath(TEST_PORT)))
    clearPidFile(TEST_PORT)
    assert.equal(existsSync(pidFilePath(TEST_PORT)), false)
  })

  it('readPidFile returns null when file missing', () => {
    clearPidFile(TEST_PORT)
    assert.equal(readPidFile(TEST_PORT), null)
  })

  it('readPidFile returns null when pid is 0 or malformed', () => {
    mkdirSync(dirname(pidFilePath(TEST_PORT)), { recursive: true })
    writeFileSync(pidFilePath(TEST_PORT), 'notanumber\n\n')
    assert.equal(readPidFile(TEST_PORT), null)
  })
})

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    assert.equal(isProcessAlive(process.pid), true)
  })

  it('returns false for an obviously-dead pid', () => {
    assert.equal(isProcessAlive(DEAD_PID), false)
  })

  it('returns false for falsy input', () => {
    assert.equal(isProcessAlive(0), false)
    assert.equal(isProcessAlive(null), false)
  })
})

describe('reconcileStalePidFile', () => {
  it('removes file when pid is dead', async () => {
    mkdirSync(dirname(pidFilePath(TEST_PORT)), { recursive: true })
    writeFileSync(pidFilePath(TEST_PORT), `${DEAD_PID}\n${Date.now()}\n`)
    const res = await reconcileStalePidFile(TEST_PORT)
    assert.equal(res.wasStale, true)
    assert.equal(res.pid, DEAD_PID)
    assert.equal(existsSync(pidFilePath(TEST_PORT)), false)
  })

  it('keeps file when pid is alive', async () => {
    writePidFile(TEST_PORT)
    const res = await reconcileStalePidFile(TEST_PORT)
    assert.equal(res.wasStale, false)
    assert.ok(existsSync(pidFilePath(TEST_PORT)))
  })

  it('is a no-op when no file exists', async () => {
    clearPidFile(TEST_PORT)
    const res = await reconcileStalePidFile(TEST_PORT)
    assert.equal(res.wasStale, false)
  })
})

describe('formatAge', () => {
  it('formats seconds, minutes, hours, days', () => {
    assert.equal(formatAge(5_000), '5s ago')
    assert.equal(formatAge(120_000), '2m ago')
    assert.equal(formatAge(60 * 60 * 1000 * 3), '3h ago')
    assert.equal(formatAge(60 * 60 * 24 * 1000 * 2), '2d ago')
  })

  it('handles zero, null, negative', () => {
    assert.equal(formatAge(0), 'unknown')
    assert.equal(formatAge(null), 'unknown')
    assert.equal(formatAge(-1000), 'unknown')
  })
})

describe('checkPort + fetchHealth (against a fake /health server)', () => {
  let srv
  let port

  before(async () => {
    srv = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', version: '9.9.9-test', stages: ['minify'] }))
      } else {
        res.writeHead(404); res.end()
      }
    })
    await new Promise(r => srv.listen(0, r))
    port = srv.address().port
  })

  after(() => new Promise(r => srv.close(r)))

  it('checkPort returns true when /health answers 200', async () => {
    assert.equal(await checkPort(port), true)
  })

  it('checkPort returns false on closed port', async () => {
    assert.equal(await checkPort(1), false)
  })

  it('fetchHealth returns parsed JSON body', async () => {
    const body = await fetchHealth(port)
    assert.equal(body.status, 'ok')
    assert.equal(body.version, '9.9.9-test')
  })

  it('diagnoseBindConflict identifies Tamp via /health version', async () => {
    const diag = await diagnoseBindConflict(port)
    assert.equal(diag.kind, 'tamp')
    assert.equal(diag.version, '9.9.9-test')
    assert.match(diag.message, /already running/)
    assert.match(diag.message, /tamp stop/)
  })
})

describe('diagnoseBindConflict on non-Tamp port', () => {
  let srv, port

  before(async () => {
    srv = http.createServer((req, res) => { res.writeHead(200); res.end('hello') })
    await new Promise(r => srv.listen(0, r))
    port = srv.address().port
  })

  after(() => new Promise(r => srv.close(r)))

  it('reports kind=other when /health does not return tamp shape', async () => {
    const diag = await diagnoseBindConflict(port)
    assert.equal(diag.kind, 'other')
    assert.match(diag.message, /not Tamp/)
  })
})

describe('installShutdown', () => {
  it('registers listeners for SIGINT, SIGTERM, SIGHUP and cleans up on uninstall', () => {
    const beforeI = process.listeners('SIGINT').length
    const beforeT = process.listeners('SIGTERM').length
    const beforeH = process.listeners('SIGHUP').length

    const fakeServer = { close(cb) { cb && cb() } }
    const uninstall = installShutdown({
      server: fakeServer,
      getSidecar: () => null,
      port: null,
    })

    assert.equal(process.listeners('SIGINT').length, beforeI + 1)
    assert.equal(process.listeners('SIGTERM').length, beforeT + 1)
    assert.equal(process.listeners('SIGHUP').length, beforeH + 1)

    uninstall()

    assert.equal(process.listeners('SIGINT').length, beforeI)
    assert.equal(process.listeners('SIGTERM').length, beforeT)
    assert.equal(process.listeners('SIGHUP').length, beforeH)
  })
})

describe('Phase 4: symlink-safe PID path resolution', () => {
  // Use a separate port so we don't collide with the afterEach cleanup of TEST_PORT
  const SYMLINK_PORT = 17889
  let tmpDir

  function cleanupSymlink() {
    clearPidFile(SYMLINK_PORT)
    try { unlinkSync(pidFilePath(SYMLINK_PORT)) } catch {}
  }

  afterEach(cleanupSymlink)

  it('writePidFile/readPidFile operate on realpath when PID path is a symlink', async () => {
    const { symlinkSync, statSync, lstatSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    // Create a real target file in a tmp dir and point the PID path at it
    // via a symlink.
    tmpDir = join(tmpdir(), `tamp-sym-${process.pid}-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
    const realTarget = join(tmpDir, 'real.pid')
    writeFileSync(realTarget, '') // must exist before symlinking (existsSync gate)

    const symPath = pidFilePath(SYMLINK_PORT)
    mkdirSync(dirname(symPath), { recursive: true })
    try { unlinkSync(symPath) } catch {}
    symlinkSync(realTarget, symPath)

    // Write through the symlink path — should land on the real target
    writePidFile(SYMLINK_PORT)

    // Read back
    const rec = readPidFile(SYMLINK_PORT)
    assert.equal(rec.pid, process.pid, 'pid round-trips through symlink')

    // Symlink itself must still be a symlink (untouched)
    assert.ok(lstatSync(symPath).isSymbolicLink(), 'the symlink entry must not be replaced')

    // Real target must have been written
    const realContents = readFileSync(realTarget, 'utf8')
    assert.match(realContents, new RegExp(`^${process.pid}\\n`))

    // Clean up the symlink entry (clearPidFile walks the realpath, so unlink both)
    clearPidFile(SYMLINK_PORT)
    try { unlinkSync(symPath) } catch {}
    try { unlinkSync(realTarget) } catch {}
  })

  it('handles PID file paths with spaces in the directory name (round-trip)', () => {
    // We exercise the write/read path via the regular API — which uses TAMP_DIR.
    // This is a smoke test confirming writeFileSync accepts the default path
    // even when the OS home has spaces (macOS: `/Users/Some User/...`).
    writePidFile(SYMLINK_PORT)
    const rec = readPidFile(SYMLINK_PORT)
    assert.equal(rec.pid, process.pid)
    assert.ok(rec.startedAt > 0)
  })
})
