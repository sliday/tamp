import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import http from 'node:http'
import { CONFIG_PATH } from '../config.js'

const TAMP_DIR = dirname(CONFIG_PATH)

export function pidFilePath(port) {
  return join(TAMP_DIR, `tamp-${port}.pid`)
}

export function writePidFile(port) {
  mkdirSync(TAMP_DIR, { recursive: true })
  const file = pidFilePath(port)
  writeFileSync(file, `${process.pid}\n${Date.now()}\n`)
  return file
}

export function readPidFile(port) {
  try {
    const [pidStr, startedStr] = readFileSync(pidFilePath(port), 'utf8').split('\n')
    const pid = Number(pidStr)
    if (!pid) return null
    return { pid, startedAt: Number(startedStr) || null }
  } catch { return null }
}

export function clearPidFile(port) {
  try { unlinkSync(pidFilePath(port)) } catch {}
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
