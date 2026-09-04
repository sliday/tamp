import { readFileSync, writeFileSync, unlinkSync, mkdirSync, realpathSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { CONFIG_PATH } from '../config.js'

const TAMP_DIR = dirname(CONFIG_PATH)

export function pidFilePath(port) {
  return join(TAMP_DIR, `tamp-${port}.pid`)
}

// Symlink-safe resolver. Returns the real filesystem path for an existing
// PID file, or the original path when the file doesn't exist yet (so write
// operations land on the expected path). This prevents a symlink-swap
// attacker from redirecting our read/write to a privileged file.
function resolvePidPath(port) {
  const p = pidFilePath(port)
  try {
    if (existsSync(p)) return realpathSync(p)
  } catch { /* fall through to raw path */ }
  return p
}

export function writePidFile(port) {
  mkdirSync(TAMP_DIR, { recursive: true })
  const file = resolvePidPath(port)
  writeFileSync(file, `${process.pid}\n${Date.now()}\n`)
  return file
}

export function readPidFile(port) {
  try {
    const [pidStr, startedStr] = readFileSync(resolvePidPath(port), 'utf8').split('\n')
    const pid = Number(pidStr)
    if (!pid) return null
    return { pid, startedAt: Number(startedStr) || null }
  } catch { return null }
}

export function clearPidFile(port) {
  try { unlinkSync(resolvePidPath(port)) } catch {}
}

export function isProcessAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export function checkPort(port, timeoutMs = 1000) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false) })
  })
}

export function fetchHealth(port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
  })
}

export function formatAge(ms) {
  if (!ms || ms < 0) return 'unknown'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export async function diagnoseBindConflict(port) {
  const health = await fetchHealth(port)
  if (health && health.status === 'ok' && health.version) {
    const rec = readPidFile(port)
    const pidInfo = rec && rec.startedAt
      ? ` (pid ${rec.pid}, started ${formatAge(Date.now() - rec.startedAt)})`
      : rec ? ` (pid ${rec.pid})` : ''
    return {
      kind: 'tamp',
      version: health.version,
      pid: rec?.pid || null,
      message: `Tamp v${health.version} already running on :${port}${pidInfo}.\n  Run 'tamp stop' to replace it, or set TAMP_PORT=${Number(port) + 1} to run alongside it.`,
    }
  }
  return {
    kind: 'other',
    message: `Port ${port} is in use by another process (not Tamp).\n  Free it with: lsof -ti:${port} | xargs kill\n  Or set TAMP_PORT=${Number(port) + 1}.`,
  }
}

// The PID file names the instance we started; it is not proof of who holds the
// port. A second tamp — auto-started by a session hook, or launched under a
// different node — can outlive the pid we signalled, so `stop` must verify the
// port was released instead of trusting the kill. Returns [] when lsof is
// unavailable, which callers treat as "unknown owner", never as "port is free".
export function findPortOwners(port, excludePid = null) {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })
    return out.split('\n')
      .map(line => Number(line.trim()))
      .filter(pid => pid && pid !== excludePid)
  } catch { return [] }
}

// Pure decision for what `tamp stop` prints and exits with, given what we
// observed after signalling. Kept out of the CLI block so every outcome is
// testable without spawning processes or calling process.exit.
export function describeStopResult({ pid, port, pidAlive, portBusy, owners = [] }) {
  const survivors = owners.filter(p => p && p !== pid)

  if (portBusy) {
    const who = survivors.length
      ? `Another Tamp is still listening (pid ${survivors.join(', ')}).`
      : 'Another process is still listening.'
    return {
      level: 'error',
      exitCode: 1,
      survivors,
      message: `Signalled pid ${pid}, but :${port} is still in use. ${who}\n`
        + `  Free it with: lsof -ti:${port} | xargs kill`,
    }
  }

  if (pidAlive) {
    return {
      level: 'warn',
      exitCode: 0,
      survivors,
      message: `Tamp (pid ${pid}) did not respond to SIGTERM within 2s — sent SIGKILL.`,
    }
  }

  return {
    level: 'log',
    exitCode: 0,
    survivors,
    message: `Stopped Tamp (pid ${pid}) on :${port}.`,
  }
}

export async function reconcileStalePidFile(port) {
  const rec = readPidFile(port)
  if (rec && !isProcessAlive(rec.pid)) {
    clearPidFile(port)
    return { wasStale: true, pid: rec.pid }
  }
  return { wasStale: false }
}

export function installShutdown({ server, getSidecar, port, onBeforeExit }) {
  let shuttingDown = false
  const handlers = {}

  function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true

    if (port != null) clearPidFile(port)

    const sidecar = getSidecar?.()
    if (sidecar && !sidecar.killed) {
      try { sidecar.kill('SIGTERM') } catch {}
      const killTimer = setTimeout(() => {
        try { if (sidecar && !sidecar.killed) sidecar.kill('SIGKILL') } catch {}
      }, 500)
      killTimer.unref?.()
    }

    const forceExit = setTimeout(() => {
      try { server?.closeAllConnections?.() } catch {}
      process.exit(0)
    }, 2000)
    forceExit.unref?.()

    try {
      if (server && typeof server.close === 'function') {
        server.close(() => {
          clearTimeout(forceExit)
          onBeforeExit?.(signal)
          process.exit(0)
        })
      } else {
        clearTimeout(forceExit)
        onBeforeExit?.(signal)
        process.exit(0)
      }
    } catch {
      process.exit(0)
    }
  }

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    handlers[sig] = () => shutdown(sig)
    process.on(sig, handlers[sig])
  }

  const exitHandler = () => {
    if (port != null) clearPidFile(port)
    const sidecar = getSidecar?.()
    try { sidecar?.kill('SIGKILL') } catch {}
  }
  process.on('exit', exitHandler)
  handlers.exit = exitHandler

  return function uninstall() {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      if (handlers[sig]) process.off(sig, handlers[sig])
    }
    if (handlers.exit) process.off('exit', handlers.exit)
  }
}
