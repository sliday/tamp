#!/usr/bin/env node
import { createProxy } from '../index.js'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, realpathSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULT_STAGES, EXTRA_STAGES, STAGE_DESCRIPTIONS, STAGE_HINTS, VERSION, isLossy, DEFAULT_LEVEL, COMPRESSION_PRESETS, LEVEL_ALIASES } from '../metadata.js'
import { CONFIG_PATH, CONFIG_TEMPLATE, loadConfig, loadConfigFile } from '../config.js'
import { isLoopbackUrl } from '../compress.js'
import {
  checkPort,
  fetchHealth,
  diagnoseBindConflict,
  installShutdown,
  reconcileStalePidFile,
  readPidFile,
  clearPidFile,
  writePidFile,
  isProcessAlive,
  isTampProcess,
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

export function buildSidecarUvArgs(port = 8788, { platform = process.platform, arch = process.arch } = {}) {
  const args = ['run', '--with', 'fastapi', '--with', 'uvicorn', '--with', 'llmlingua']
  if (platform === 'darwin' && arch === 'arm64') {
    args.push('--with', 'mlx')
  }
  args.push('uvicorn', 'server:app', '--host', '127.0.0.1', '--port', String(port))
  return args
}

export async function startSidecar({ env = process.env, configPath } = {}) {
  const filePath = configPath ?? (env === process.env ? process.env.TAMP_CONFIG : env.TAMP_CONFIG)
  const fileVars = (env === process.env || configPath || env.TAMP_CONFIG)
    ? loadConfigFile(filePath)
    : {}
  const rawConfiguredUrl = env.TAMP_LLMLINGUA_URL !== undefined
    ? env.TAMP_LLMLINGUA_URL
    : fileVars.TAMP_LLMLINGUA_URL
  const configuredUrl = typeof rawConfiguredUrl === 'string' ? rawConfiguredUrl.trim() : ''
  if (configuredUrl) {
    if (!isLoopbackUrl(configuredUrl)) return null
    return configuredUrl.replace(/\/+$/, '')
  }

  const sidecarPort = 8788
  const sidecarDir = join(root, 'sidecar')
  const serverPy = join(sidecarDir, 'server.py')

  if (await checkPort(sidecarPort)) {
    return `http://localhost:${sidecarPort}`
  }
  if (!existsSync(serverPy)) return null

  if (hasCommand('uv')) {
    try {
      const proc = spawn('uv', buildSidecarUvArgs(sidecarPort), { cwd: sidecarDir, stdio: ['ignore', 'pipe', 'pipe'] })
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

// Write (or update) a single scalar field in the config file. Preserves
// unrelated lines verbatim. Creates the file (seeded from CONFIG_TEMPLATE)
// if missing. Shared by `init` and `settings` — the single writer.
function writeConfigField(field, value) {
  const dir = dirname(CONFIG_PATH)
  mkdirSync(dir, { recursive: true })
  const stringified = String(value)
  let body
  if (existsSync(CONFIG_PATH)) {
    body = readFileSync(CONFIG_PATH, 'utf8')
  } else {
    body = CONFIG_TEMPLATE
  }
  const lines = body.split('\n')
  const activeRe = new RegExp(`^\\s*${field}\\s*=`)
  const commentedRe = new RegExp(`^\\s*#\\s*${field}\\s*=`)
  let replaced = false
  for (let i = 0; i < lines.length; i++) {
    if (activeRe.test(lines[i])) {
      lines[i] = `${field}=${stringified}`
      replaced = true
      break
    }
  }
  if (!replaced) {
    for (let i = 0; i < lines.length; i++) {
      if (commentedRe.test(lines[i])) {
        lines[i] = `${field}=${stringified}`
        replaced = true
        break
      }
    }
  }
  if (!replaced) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('')
    lines.push(`${field}=${stringified}`)
  }
  writeFileSync(CONFIG_PATH, lines.join('\n'))
}

export function formatStatusLines(health, port, version = VERSION, healthy = health !== null) {
  const lines = [
    `Tamp v${version}`,
    `  Health: ${healthy ? 'running' : 'not running'} (port ${port})`,
  ]
  if (health && typeof health === 'object') {
    if (Array.isArray(health.stages)) {
      lines.push(`  Stages: ${health.stages.length} active (${health.stages.join(', ')})`)
    }
    if (health.session && typeof health.session === 'object') {
      const reqs = health.session.requests ?? 0
      const saved = health.session.tokensSaved ?? 0
      lines.push(`  Session: ${reqs} request${reqs !== 1 ? 's' : ''}, ${saved} tokens saved`)
    }
    if (typeof health.sidecar === 'boolean') {
      const hasLlmLingua = Array.isArray(health.stages) && health.stages.includes('llmlingua')
      const sidecarLabel = health.sidecar ? 'ok' : (hasLlmLingua ? 'not running' : 'n/a')
      lines.push(`  Sidecar: ${sidecarLabel}`)
    }
    if (health.usage?.cacheHitRate != null) {
      lines.push(`  Cache hit rate: ${(health.usage.cacheHitRate * 100).toFixed(1)}%`)
    }
  }
  return lines
}

export async function resolveNonInteractiveConfig({
  env = process.env,
  argvLevel = null,
  argvPreset = null,
  startSidecarFn = startSidecar,
  onSidecarReady,
  onSidecarUnavailable,
} = {}) {
  const loadOpts = {}
  if (argvLevel !== null) loadOpts.levelOverride = argvLevel
  if (argvPreset !== null) loadOpts.presetOverride = argvPreset
  const probe = loadConfig(env, loadOpts)
  let selectedStages = [...probe.stages]
  const overrides = {}

  if (selectedStages.includes('llmlingua')) {
    const sidecarUrl = await startSidecarFn({ env })
    if (sidecarUrl) {
      overrides.llmLinguaUrl = sidecarUrl
      onSidecarReady?.(sidecarUrl)
    } else {
      onSidecarUnavailable?.()
      selectedStages = selectedStages.filter(s => s !== 'llmlingua')
      overrides.stages = selectedStages
    }
  }

  return { probe, selectedStages, overrides, loadOpts }
}

function isEntrypoint() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url)
  }
}

// --- Global --level / --preset flag parsing ---
// Pure helpers return structured { level/preset, error } without calling
// process.exit so unit tests can exercise every path deterministically.
// Threaded into loadConfig via options.levelOverride / options.presetOverride
// so the precedence rules live entirely in config.js.
export function parsePresetArgv(argv = []) {
  const validPresets = Object.keys(COMPRESSION_PRESETS).join(', ')
  let found = false
  let raw
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--preset') {
      found = true
      raw = i + 1 < argv.length ? argv[i + 1] : undefined
      break
    }
    if (a.startsWith('--preset=')) {
      found = true
      raw = a.slice('--preset='.length)
      break
    }
  }
  if (!found) return { preset: null, error: null }
  if (raw === undefined || raw === '') {
    return { preset: null, error: `[tamp] --preset requires a value (one of: ${validPresets})` }
  }
  if (typeof raw === 'string' && Object.hasOwn(COMPRESSION_PRESETS, raw)) {
    return { preset: raw, error: null }
  }
  return { preset: null, error: `[tamp] invalid --preset=${raw} — expected one of: ${validPresets}` }
}

function parseLevelFlag(argv = []) {
  const validAliases = Object.keys(LEVEL_ALIASES).join(', ')
  let found = false
  let raw
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--level') {
      found = true
      raw = i + 1 < argv.length ? argv[i + 1] : undefined
      break
    }
    if (a.startsWith('--level=')) {
      found = true
      raw = a.slice('--level='.length)
      break
    }
  }
  if (!found || raw === undefined) return { level: null, error: null }
  if (raw === '') {
    return { level: null, error: `[tamp] --level requires a value (1..9 or one of: ${validAliases})` }
  }
  if (/^-?\d+$/.test(raw)) {
    const n = parseInt(raw, 10)
    if (n < 1 || n > 9) {
      return { level: null, error: `[tamp] --level must be 1..9 (got ${raw})` }
    }
    return { level: n, error: null }
  }
  if (Object.hasOwn(LEVEL_ALIASES, raw)) return { level: raw, error: null }
  return { level: null, error: `[tamp] invalid --level=${raw} — expected 1..9 or one of: ${validAliases}` }
}

export function parseCliFlags(argv = []) {
  const hasLevel = argv.some(a => a === '--level' || a.startsWith('--level='))
  const hasPreset = argv.some(a => a === '--preset' || a.startsWith('--preset='))
  if (hasLevel && hasPreset) {
    return {
      level: null,
      preset: null,
      error: '[tamp] --level and --preset cannot be used together — choose one',
    }
  }
  const levelRes = parseLevelFlag(argv)
  if (levelRes.error) {
    return { level: null, preset: null, error: levelRes.error }
  }
  const presetRes = parsePresetArgv(argv)
  if (presetRes.error) {
    return { level: null, preset: null, error: presetRes.error }
  }
  return { level: levelRes.level, preset: presetRes.preset, error: null }
}

async function main() {
// --- Subcommands ---
const subcommand = process.argv[2]
const parsedFlags = parseCliFlags(process.argv.slice(2))
if (parsedFlags.error) {
  console.error(parsedFlags.error)
  process.exit(2)
}
const argvLevel = parsedFlags.level
const argvPreset = parsedFlags.preset

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

if (subcommand === 'settings' || subcommand === 'config') {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`Usage: tamp settings\n`)
    console.log('Interactive editor for compression level (1..9) and stages.')
    console.log('Writes to: ' + CONFIG_PATH)
    process.exit(0)
  }

  const current = loadConfig()
  const envLevel = Number.isInteger(current.level) ? current.level : DEFAULT_LEVEL

  if (!process.stdin.isTTY) {
    console.error('[tamp] settings requires an interactive terminal (TTY). Edit ' + CONFIG_PATH + ' directly.')
    process.exit(1)
  }

  const { render } = await import('ink')
  const React = await import('react')
  const { LevelPicker } = await import('./ui/LevelPicker.js')
  const h = React.createElement

  let instance = null
  const onSelect = (payload) => {
    try {
      if (payload.kind === 'level') {
        writeConfigField('level', payload.level)
        if (instance) instance.unmount()
        console.log(`Saved level=${payload.level} to ${CONFIG_PATH}`)
        process.exit(0)
      } else if (payload.kind === 'stages') {
        writeConfigField('TAMP_STAGES', payload.stages.join(','))
        if (instance) instance.unmount()
        console.log(`Saved TAMP_STAGES=${payload.stages.join(',')} to ${CONFIG_PATH}`)
        process.exit(0)
      }
    } catch (err) {
      if (instance) instance.unmount()
      console.error(`[tamp] failed to write config: ${err.message}`)
      process.exit(1)
    }
  }
  const onCancel = () => {
    if (instance) instance.unmount()
    process.exit(0)
  }

  instance = render(h(LevelPicker, { version: VERSION, envLevel, onSelect, onCancel }))
  return
}

// macOS LaunchAgent. Pointing an agent's base URL at Tamp makes that agent
// depend on Tamp being up, so "run it by hand in a terminal" is not a real
// answer once you route Claude Code or Codex through it.
const LAUNCH_AGENT_LABEL = 'dev.tamp.proxy'
const LAUNCH_AGENT_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)

if (subcommand === 'install-service' && process.platform === 'darwin') {
  const nodeBin = process.execPath
  const tampBin = join(__dirname, 'tamp.js')
  const logDir = join(homedir(), '.config', 'tamp')
  mkdirSync(logDir, { recursive: true })
  mkdirSync(dirname(LAUNCH_AGENT_PATH), { recursive: true })
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${tampBin}</string>
    <string>-y</string>
    <string>--force</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(logDir, 'tamp.out.log')}</string>
  <key>StandardErrorPath</key><string>${join(logDir, 'tamp.err.log')}</string>
</dict>
</plist>
`
  writeFileSync(LAUNCH_AGENT_PATH, plist)
  const uid = process.getuid()
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], { stdio: 'ignore' }) } catch {}
  try {
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, LAUNCH_AGENT_PATH], { stdio: 'inherit' })
    execFileSync('launchctl', ['enable', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], { stdio: 'ignore' })
    console.log(`\nLaunchAgent installed: ${LAUNCH_AGENT_PATH}`)
    console.log('  Status:  tamp status')
    console.log(`  Logs:    tail -f ${join(logDir, 'tamp.err.log')}`)
    console.log(`  Stop:    launchctl bootout gui/${uid}/${LAUNCH_AGENT_LABEL}`)
    console.log('  Remove:  tamp uninstall-service')
  } catch (e) {
    console.error('launchctl failed:', e.message)
    process.exit(1)
  }
  process.exit(0)
}

if (subcommand === 'uninstall-service' && process.platform === 'darwin') {
  const uid = process.getuid()
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], { stdio: 'ignore' }) } catch {}
  try { unlinkSync(LAUNCH_AGENT_PATH) } catch {}
  console.log('LaunchAgent removed.')
  process.exit(0)
}

if (subcommand === 'install-service') {
  if (process.platform !== 'linux') {
    console.error('Service installation requires Linux (systemd) or macOS (launchd).')
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
    console.error('Service management requires Linux (systemd) or macOS (launchd).')
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

if (subcommand === 'version' || subcommand === '--version' || subcommand === '-v' || process.argv.includes('--version')) {
  console.log(`Tamp v${VERSION}`)
  process.exit(0)
}

if (subcommand === 'status') {
  const port = loadConfig().port
  const health = await fetchHealth(port)
  const healthy = health !== null ? true : await checkPort(port)
  for (const line of formatStatusLines(health, port, VERSION, healthy)) {
    console.log(line)
  }
  if (process.platform === 'linux') {
    try { execFileSync('systemctl', ['--user', 'status', 'tamp.service', '--no-pager'], { stdio: 'inherit' }) } catch {}
  }
  process.exit(healthy ? 0 : 1)
}

if (subcommand === 'compress-config') {
  const { compressFiles, formatResult } = await import('../lib/compress-file.js')
  const args = process.argv.slice(3)
  const flags = new Set(args.filter(a => a.startsWith('--')))
  const files = args.filter(a => !a.startsWith('--'))

  if (!files.length) {
    console.error('Usage: tamp compress-config [--dry-run] [--no-backup] <file> [file...]')
    console.error('')
    console.error('Compress CLAUDE.md, config, or markdown files using lossy strategies')
    console.error('inspired by JuliusBrussee/caveman-compress.')
    console.error('')
    console.error('Examples:')
    console.error('  tamp compress-config --dry-run ~/.claude/CLAUDE.md')
    console.error('  tamp compress-config ~/.claude/CLAUDE.md ~/.config/tamp/config')
    process.exit(1)
  }

  const opts = {
    dryRun: flags.has('--dry-run'),
    noBackup: flags.has('--no-backup'),
  }

  const results = await compressFiles(files, opts)
  let failures = 0
  for (const result of results) {
    console.log(formatResult(result))
    console.log('')
    if (!result.success && !result.skipped && !result.dryRun) failures++
  }

  const totalOrig = results.reduce((a, r) => a + (r.originalLen || 0), 0)
  const totalComp = results.reduce((a, r) => a + (r.compressedLen || r.originalLen || 0), 0)
  if (totalOrig > 0) {
    const pct = ((totalOrig - totalComp) / totalOrig * 100).toFixed(1)
    console.log(`Total: ${totalOrig} → ${totalComp} chars (${pct}% saved across ${results.length} file${results.length !== 1 ? 's' : ''})`)
  }

  process.exit(failures > 0 ? 1 : 0)
}

if (subcommand === 'stop') {
  const port = loadConfig().port
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

  if (isTampProcess(rec.pid) === false) {
    clearPidFile(port)
    console.error(`Refusing to signal pid ${rec.pid} — process does not appear to be Tamp. Cleared stale PID file.`)
    process.exit(1)
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
    if (isTampProcess(rec.pid) !== false) {
      try { process.kill(rec.pid, 'SIGKILL') } catch {}
      console.warn(`Tamp (pid ${rec.pid}) did not respond to SIGTERM within 2s — sent SIGKILL.`)
    } else {
      console.warn(`PID ${rec.pid} no longer appears to be Tamp — skipping SIGKILL.`)
    }
  } else {
    console.log(`Stopped Tamp (pid ${rec.pid}) on :${port}.`)
  }
  clearPidFile(port)
  process.exit(0)
}

if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h' || process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Tamp v${VERSION} — Token compression proxy for coding agents\n`)
  console.log('Usage: tamp [command] [options]\n')
  console.log('Commands:')
  console.log('  (default)           Start proxy (interactive stage picker)')
  console.log('  -y                  Start proxy (non-interactive, use defaults)')
  console.log('  -y --force          Replace any existing Tamp on the same port')
  console.log('  stop                Stop a running Tamp on TAMP_PORT (default 7778)')
  console.log('  compress-config     Compress CLAUDE.md or config files (caveman mode)')
  console.log('  init                Create config file (~/.config/tamp/config)')
  console.log('  settings            Edit compression level and stages')
  console.log('  status              Check if proxy is running')
  console.log('  install-service     Keep Tamp running (launchd on macOS, systemd on Linux)')
  console.log('  uninstall-service   Remove the service')
  console.log('  help                Show this help')
  console.log('')
  console.log('Options:')
  console.log('  --level N        Compression level 1..9 (or: conservative, balanced, aggressive, max)')
  console.log('  --preset NAME    Compression preset (conservative, balanced, aggressive, recommended)')
  console.log(`\nConfig: ${CONFIG_PATH}`)
  process.exit(0)
}

// --- Mode detection ---
const skipPrompt = process.argv.includes('-y') || process.argv.includes('--no-interactive') || !process.stdin.isTTY
const forceReplace = process.argv.includes('--force')

// TAMP_STAGES may come from the environment or from ~/.config/tamp/config.
// Reading only process.env meant a stage list written to the config file was
// silently overwritten by DEFAULT_STAGES on every `tamp -y`, so the documented
// knob did nothing on the non-interactive path most people use.
function readStagesSetting() {
  if (process.env.TAMP_STAGES) return process.env.TAMP_STAGES
  try {
    const line = readFileSync(CONFIG_PATH, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .find(l => l.startsWith('TAMP_STAGES='))
    return line ? line.slice('TAMP_STAGES='.length).trim() : null
  } catch { return null }
}

const stagesSetting = readStagesSetting()
const envStages = stagesSetting
  ? new Set(stagesSetting.split(',').map(s => s.trim()).filter(Boolean))
  : null

async function ensurePortFree(port) {
  await reconcileStalePidFile(port)
  if (!(await checkPort(port))) return

  if (forceReplace) {
    const rec = readPidFile(port)
    if (rec && isTampProcess(rec.pid) !== false) {
      try { process.kill(rec.pid, 'SIGTERM') } catch {}
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 100))
        if (!(await checkPort(port))) break
      }
      if (await checkPort(port) && isTampProcess(rec.pid) !== false) {
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

  const { overrides, loadOpts } = await resolveNonInteractiveConfig({
    env: process.env,
    argvLevel,
    argvPreset,
    startSidecarFn: startSidecar,
    onSidecarReady: (url) => {
      console.error(`  ${c.green}\u2713${c.reset} LLMLingua-2 ready on ${c.bold}${url}${c.reset}`)
    },
    onSidecarUnavailable: () => {
      console.error(`  ${c.yellow}!${c.reset} LLMLingua-2 not available`)
      if (!hasCommand('uv')) console.error(`    ${c.dim}Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh${c.reset}`)
      console.error(`    ${c.dim}Continuing without neural compression.${c.reset}`)
    },
  })

  const { config, server } = createProxy(overrides, loadOpts)

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
    const total = DEFAULT_STAGES.length + EXTRA_STAGES.length
    if (config.outputMode && config.outputMode !== 'off') {
      console.error(`  ${c.bold}Output mode${c.reset} ${c.yellow}${config.outputMode}${c.reset} ${c.dim}(caveman, task-aware)${c.reset}`)
      console.error('')
    }
    console.error(`  ${c.bold}Stages${c.reset} ${c.dim}(${active.length} of ${total} active)${c.reset}`)
    for (const s of defaultActive) {
      const extra = s === 'llmlingua' && config.llmLinguaUrl ? ` ${c.dim}(${config.llmLinguaUrl})${c.reset}` : ''
      console.error(`    ${c.green}\u2713${c.reset} ${c.cyan}${s}${c.reset}${extra}`)
    }
    for (const s of extraActive) {
      const tag = isLossy(s) ? '(lossy)' : '(opt-in)'
      console.error(`    ${c.yellow}\u2713${c.reset} ${c.yellow}${s}${c.reset} ${c.dim}${tag}${c.reset}`)
    }

    const disabled = [...DEFAULT_STAGES, ...EXTRA_STAGES].filter(s => !active.includes(s))
    if (disabled.length) {
      console.error('')
      console.error(`  ${c.bold}Available${c.reset} ${c.dim}(not active — opt in for more savings)${c.reset}`)
      for (const s of disabled) {
        const hint = STAGE_HINTS[s]
        if (hint) {
          console.error(`    ${c.dim}\u25EF${c.reset} ${c.cyan}${s}${c.reset} ${c.dim}— ${hint.summary}${c.reset}`)
          if (hint.setup) {
            console.error(`        ${c.dim}\u2192 ${hint.setup}${c.reset}`)
          }
        } else {
          console.error(`    ${c.dim}\u25EF ${s}${c.reset}`)
        }
      }
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

  server.listen(config.port, config.host, () => {
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
    argvLevel,
    argvPreset,
    startSidecar,
    createProxy,
    getSidecarProc,
    ensurePortFree,
  }))
}
}

if (isEntrypoint()) {
  await main()
}
