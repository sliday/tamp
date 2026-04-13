#!/usr/bin/env node
import { createProxy } from '../index.js'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULT_STAGES, EXTRA_STAGES, STAGE_DESCRIPTIONS, VERSION, isLossy } from '../metadata.js'
import { CONFIG_PATH, CONFIG_TEMPLATE } from '../config.js'
import {
  checkPort,
  diagnoseBindConflict,
  installShutdown,
  reconcileStalePidFile,
  readPidFile,
  clearPidFile,
  writePidFile,
  isProcessAlive,
} from './lifecycle.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// --- Sidecar helpers (shared by both modes) ---

let sidecarProc = null
export function getSidecarProc() { return sidecarProc }

function hasCommand(cmd) {
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true } catch { return false }
}

function waitForSidecar(proc, port, timeout = 30000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeout)
    proc.stderr.on('data', (d) => {
      if (d.toString().includes('Uvicorn running')) {
        clearTimeout(timer)
        resolve(`http://localhost:${port}`)
      }
    })
    proc.on('exit', () => { clearTimeout(timer); resolve(null) })
  })
}

export async function startSidecar() {
  const sidecarPort = 8788
  const sidecarDir = join(root, 'sidecar')
  const serverPy = join(sidecarDir, 'server.py')

  if (await checkPort(sidecarPort)) {
    return `http://localhost:${sidecarPort}`
  }
  if (!existsSync(serverPy)) return null

  if (hasCommand('uv')) {
    try {
      const proc = spawn('uv', [
        'run', '--with', 'fastapi', '--with', 'uvicorn', '--with', 'llmlingua', '--with', 'mlx',
        'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', String(sidecarPort),
      ], { cwd: sidecarDir, stdio: ['ignore', 'pipe', 'pipe'] })
      const url = await waitForSidecar(proc, sidecarPort)
      if (url) { sidecarProc = proc; return url }
      proc.kill()
    } catch { /* try next */ }
  }

  const venvPython = join(sidecarDir, '.venv', 'bin', 'python')
  if (existsSync(venvPython)) {
    try {
      const proc = spawn(venvPython, [
        '-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', String(sidecarPort),
      ], { cwd: sidecarDir, stdio: ['ignore', 'pipe', 'pipe'] })
      const url = await waitForSidecar(proc, sidecarPort)
      if (url) { sidecarProc = proc; return url }
      proc.kill()
    } catch { /* fall through */ }
  }
  return null
}

// --- Subcommands ---
const subcommand = process.argv[2]

if (subcommand === 'init') {
  const dir = dirname(CONFIG_PATH)
  if (existsSync(CONFIG_PATH)) {
    console.log(`Config file exists: ${CONFIG_PATH}\n`)
    console.log(readFileSync(CONFIG_PATH, 'utf8'))
  } else {
    mkdirSync(dir, { recursive: true })
    writeFileSync(CONFIG_PATH, CONFIG_TEMPLATE)
    console.log(`Created config file: ${CONFIG_PATH}`)
    console.log('Edit it to set your defaults. Environment variables still override.\n')
    console.log(CONFIG_TEMPLATE)
  }
  process.exit(0)
}

if (subcommand === 'install-service') {
  if (process.platform !== 'linux') {
    console.error('Service installation requires Linux (systemd).')
    process.exit(1)
  }
  const nodeBin = process.execPath
  const tampBin = join(__dirname, 'tamp.js')
  const unitDir = join(homedir(), '.config', 'systemd', 'user')
  const unitPath = join(unitDir, 'tamp.service')
  const unit = `[Unit]
Description=Tamp token compression proxy
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${tampBin} -y
Restart=always
RestartSec=5
EnvironmentFile=-${CONFIG_PATH}

[Install]
WantedBy=default.target
`
  mkdirSync(unitDir, { recursive: true })
  writeFileSync(unitPath, unit)
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' })
    execFileSync('systemctl', ['--user', 'enable', '--now', 'tamp.service'], { stdio: 'inherit' })
    console.log(`\nService installed: ${unitPath}`)
    console.log('  Status:  systemctl --user status tamp')
    console.log('  Logs:    journalctl --user -u tamp -f')
    console.log('  Stop:    systemctl --user stop tamp')
    console.log('  Remove:  tamp uninstall-service')
  } catch (e) {
    console.error('systemctl failed:', e.message)
    process.exit(1)
  }
  process.exit(0)
}

if (subcommand === 'uninstall-service') {
  if (process.platform !== 'linux') {
    console.error('Service management requires Linux (systemd).')
    process.exit(1)
  }
  const unitPath = join(homedir(), '.config', 'systemd', 'user', 'tamp.service')
  try { execFileSync('systemctl', ['--user', 'stop', 'tamp.service'], { stdio: 'inherit' }) } catch {}
  try { execFileSync('systemctl', ['--user', 'disable', 'tamp.service'], { stdio: 'inherit' }) } catch {}
  try { unlinkSync(unitPath) } catch {}
  try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' }) } catch {}
  console.log('Service removed.')
  process.exit(0)
}

if (subcommand === 'status') {
  const port = process.env.TAMP_PORT || 7778
  const healthy = await checkPort(port)
  console.log(`Tamp v${VERSION}`)
  console.log(`  Health: ${healthy ? 'running' : 'not running'} (port ${port})`)
  if (process.platform === 'linux') {
    try { execFileSync('systemctl', ['--user', 'status', 'tamp.service', '--no-pager'], { stdio: 'inherit' }) } catch {}
  }
  process.exit(healthy ? 0 : 1)
}

if (subcommand === 'stop') {
  const port = Number(process.env.TAMP_PORT) || 7778
  await reconcileStalePidFile(port)
  const rec = readPidFile(port)

  if (!rec) {
    const healthy = await checkPort(port)
    if (healthy) {
      console.error(`Tamp appears to be running on :${port} but no PID file was found.`)
      console.error(`  Kill manually: lsof -ti:${port} | xargs kill`)
      process.exit(1)
    }
    console.log(`No Tamp running on :${port}.`)
    process.exit(0)
  }

  try {
    process.kill(rec.pid, 'SIGTERM')
  } catch (err) {
    if (err.code === 'ESRCH') {
      clearPidFile(port)
      console.log(`Tamp (pid ${rec.pid}) was already dead — cleaned up stale PID file.`)
      process.exit(0)
    }
    throw err
  }

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100))
    if (!(await checkPort(port)) && !isProcessAlive(rec.pid)) break
  }

  if (await checkPort(port) || isProcessAlive(rec.pid)) {
    try { process.kill(rec.pid, 'SIGKILL') } catch {}
    console.warn(`Tamp (pid ${rec.pid}) did not respond to SIGTERM within 2s — sent SIGKILL.`)
  } else {
    console.log(`Stopped Tamp (pid ${rec.pid}) on :${port}.`)
  }
  clearPidFile(port)
  process.exit(0)
}

if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
  console.log(`Tamp v${VERSION} — Token compression proxy for coding agents\n`)
  console.log('Usage: tamp [command] [options]\n')
  console.log('Commands:')
  console.log('  (default)           Start proxy (interactive stage picker)')
  console.log('  -y                  Start proxy (non-interactive, use defaults)')
  console.log('  -y --force          Replace any existing Tamp on the same port')
  console.log('  stop                Stop a running Tamp on TAMP_PORT (default 7778)')
  console.log('  init                Create config file (~/.config/tamp/config)')
  console.log('  status              Check if proxy is running')
  console.log('  install-service     Install systemd user service (Linux)')
  console.log('  uninstall-service   Remove systemd service')
  console.log('  help                Show this help')
  console.log(`\nConfig: ${CONFIG_PATH}`)
  process.exit(0)
}

// --- Mode detection ---
const skipPrompt = process.argv.includes('-y') || process.argv.includes('--no-interactive') || !process.stdin.isTTY
const forceReplace = process.argv.includes('--force')

const envStages = process.env.TAMP_STAGES
  ? new Set(process.env.TAMP_STAGES.split(',').map(s => s.trim()).filter(Boolean))
  : null

async function ensurePortFree(port) {
  await reconcileStalePidFile(port)
  if (!(await checkPort(port))) return

  if (forceReplace) {
    const rec = readPidFile(port)
    if (rec) {
      try { process.kill(rec.pid, 'SIGTERM') } catch {}
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 100))
        if (!(await checkPort(port))) break
      }
      if (await checkPort(port)) {
        try { process.kill(rec.pid, 'SIGKILL') } catch {}
        await new Promise(r => setTimeout(r, 300))
      }
      clearPidFile(port)
      if (!(await checkPort(port))) return
    }
    console.error(`[tamp] --force requested but port ${port} could not be freed.`)
    process.exit(1)
  }

  const diag = await diagnoseBindConflict(port)
  console.error(`[tamp] ${diag.message}`)
  process.exit(1)
}

if (skipPrompt) {
  // --- Non-interactive mode (plain text, no Ink) ---
  const { ANSI: c } = await import('./ui/theme.js')

  let selectedStages = envStages ? [...envStages] : [...DEFAULT_STAGES]
  process.env.TAMP_STAGES = selectedStages.join(',')

  if (selectedStages.includes('llmlingua')) {
    const sidecarUrl = await startSidecar()
    if (sidecarUrl) {
      process.env.TAMP_LLMLINGUA_URL = sidecarUrl
      console.error(`  ${c.green}\u2713${c.reset} LLMLingua-2 ready on :${c.bold}8788${c.reset}`)
    } else {
      console.error(`  ${c.yellow}!${c.reset} LLMLingua-2 not available`)
      if (!hasCommand('uv')) console.error(`    ${c.dim}Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh${c.reset}`)
      console.error(`    ${c.dim}Continuing without neural compression.${c.reset}`)
      selectedStages = selectedStages.filter(s => s !== 'llmlingua')
      process.env.TAMP_STAGES = selectedStages.join(',')
    }
  }

  const { config, server } = createProxy()

  await ensurePortFree(config.port)

  function printBanner() {
    const url = `http://localhost:${config.port}`
    const active = config.stages
    const defaultActive = active.filter(s => DEFAULT_STAGES.includes(s))
    const extraActive = active.filter(s => EXTRA_STAGES.includes(s))

    console.error('')
    console.error(`  ${c.cyan}${c.bold}Tamp${c.reset} ${c.dim}v${VERSION}${c.reset}  ${c.bgGreen}${c.bold} READY ${c.reset}  ${c.green}${url}${c.reset}`)
    console.error('')
    console.error(`  ${c.bold}Setup:${c.reset}`)
    console.error(`    ${c.dim}Claude Code:${c.reset}  ANTHROPIC_BASE_URL=${c.yellow}${url}${c.reset}`)
    console.error(`    ${c.dim}Aider/Cursor:${c.reset} OPENAI_API_BASE=${c.yellow}${url}${c.reset}`)
    console.error('')
    console.error(`  ${c.bold}Stages${c.reset} ${c.dim}(${active.length} active)${c.reset}`)
    for (const s of defaultActive) {
      const extra = s === 'llmlingua' && config.llmLinguaUrl ? ` ${c.dim}(${config.llmLinguaUrl})${c.reset}` : ''
      console.error(`    ${c.green}\u2713${c.reset} ${c.cyan}${s}${c.reset}${extra}`)
    }
    for (const s of extraActive) {
      const tag = isLossy(s) ? '(lossy)' : '(opt-in)'
      console.error(`    ${c.yellow}\u2713${c.reset} ${c.yellow}${s}${c.reset} ${c.dim}${tag}${c.reset}`)
    }
    const disabled = [...DEFAULT_STAGES, ...EXTRA_STAGES].filter(s => !active.includes(s))
    if (disabled.length && disabled.length <= 4) {
      console.error(`    ${c.dim}\u2717 ${disabled.join(', ')}${c.reset}`)
    }
    console.error('')
  }

  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      const diag = await diagnoseBindConflict(config.port)
      console.error(`[tamp] ${diag.message}`)
    } else {
      console.error(`[tamp] Failed to start: ${err.message}`)
    }
    try { sidecarProc?.kill() } catch {}
    process.exit(1)
  })

  server.listen(config.port, () => {
    try { writePidFile(config.port) } catch (err) {
      console.error(`[tamp] Warning: could not write PID file: ${err.message}`)
    }
    printBanner()
  })

  installShutdown({ server, getSidecar: getSidecarProc, port: config.port })

} else {
  // --- Interactive mode (Ink TUI) ---
  const { render } = await import('ink')
  const React = await import('react')
  const { App } = await import('./ui/App.js')

  const h = React.createElement

  render(h(App, {
    version: VERSION,
    envStages,
    startSidecar,
    createProxy,
    getSidecarProc,
    ensurePortFree,
  }))
}
