#!/usr/bin/env node
import { createProxy } from '../index.js'
import { existsSync, readFileSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { checkbox } from '@inquirer/prompts'
import http from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bgGreen: '\x1b[42m',
}

function log(msg = '') { console.error(msg) }

const STAGE_INFO = {
  minify:       'Strip JSON whitespace (lossless)',
  toon:         'Columnar array encoding (lossless)',
  'strip-lines':'Remove line-number prefixes from Read output',
  whitespace:   'Collapse blank lines, trim trailing spaces',
  llmlingua:    'Neural text compression via LLMLingua-2',
  dedup:        'Replace duplicate tool_results with references',
  diff:         'Replace similar re-reads with unified diffs',
  prune:        'Strip lockfile hashes, registry URLs, npm metadata',
  'strip-comments': 'Remove code comments (lossy, opt-in)',
}

// --- Determine stages ---
const skipPrompt = process.argv.includes('-y') || process.argv.includes('--no-interactive') || !process.stdin.isTTY
let selectedStages

if (process.env.TAMP_STAGES) {
  selectedStages = process.env.TAMP_STAGES.split(',').map(s => s.trim()).filter(Boolean)
} else if (skipPrompt) {
  selectedStages = Object.keys(STAGE_INFO).filter(s => s !== 'strip-comments')
} else {
  log('')
  log(`  ${c.bold}${c.cyan}Tamp${c.reset} ${c.dim}v${pkg.version}${c.reset} — Token compression proxy`)
  log('')
  selectedStages = await checkbox({
    message: 'Compression methods (space to toggle, enter to confirm):',
    choices: Object.entries(STAGE_INFO).map(([value, desc]) => ({
      name: `${value.padEnd(12)} ${c.dim}— ${desc}${c.reset}`,
      value,
      checked: value !== 'strip-comments',
    })),
  })
  if (selectedStages.length === 0) {
    log(`  ${c.yellow}No methods selected — running as passthrough proxy.${c.reset}`)
  }
}

process.env.TAMP_STAGES = selectedStages.join(',')

// --- Sidecar startup ---
let sidecarProc = null

async function checkPort(port) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1000, () => { req.destroy(); resolve(false) })
  })
}

function hasCommand(cmd) {
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true } catch { return false }
}

async function startSidecar() {
  const sidecarPort = 8788
  const sidecarDir = join(root, 'sidecar')
  const serverPy = join(sidecarDir, 'server.py')

  // 1. Already running?
  if (await checkPort(sidecarPort)) {
    log(`  ${c.green}✓${c.reset} LLMLingua-2 sidecar already running on port ${sidecarPort}`)
    return `http://localhost:${sidecarPort}`
  }

  if (!existsSync(serverPy)) {
    return null
  }

  log(`  ${c.yellow}→${c.reset} Starting LLMLingua-2 sidecar ...`)

  // 2. Try uv run (no venv needed)
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

  // 3. Try existing venv
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

function waitForSidecar(proc, port, timeout = 30000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeout)
    proc.stderr.on('data', (d) => {
      if (d.toString().includes('Uvicorn running')) {
        clearTimeout(timer)
        log(`  ${c.green}✓${c.reset} LLMLingua-2 sidecar ready on port ${c.bold}${port}${c.reset}`)
        resolve(`http://localhost:${port}`)
      }
    })
    proc.on('exit', () => { clearTimeout(timer); resolve(null) })
  })
}

// Start sidecar if llmlingua is in selected stages
if (selectedStages.includes('llmlingua')) {
  const sidecarUrl = await startSidecar()
  if (sidecarUrl) {
    process.env.TAMP_LLMLINGUA_URL = sidecarUrl
  } else {
    log(`  ${c.yellow}!${c.reset} LLMLingua-2 sidecar not available`)
    if (!hasCommand('uv')) {
      log(`    Install uv: ${c.cyan}curl -LsSf https://astral.sh/uv/install.sh | sh${c.reset}`)
    }
    log(`    Continuing without neural compression.`)
    log('')
    selectedStages = selectedStages.filter(s => s !== 'llmlingua')
    process.env.TAMP_STAGES = selectedStages.join(',')
  }
}

// --- Start proxy ---
const { config, server } = createProxy()

function printBanner() {
  const url = `http://localhost:${config.port}`

  log('')
  log(`  ${c.bold}${c.cyan}┌─ Tamp ${c.dim}v${pkg.version}${c.reset}${c.bold}${c.cyan} ───────────────────────────────┐${c.reset}`)
  log(`  ${c.cyan}│${c.reset}  Proxy: ${c.bold}${c.green}${url}${c.reset}${c.cyan}              │${c.reset}`)
  log(`  ${c.cyan}│${c.reset}  Status: ${c.bgGreen}${c.bold} ● READY ${c.reset}${c.cyan}                    │${c.reset}`)
  log(`  ${c.cyan}│${c.reset}                                        ${c.cyan}│${c.reset}`)
  log(`  ${c.cyan}│${c.reset}  ${c.bold}Claude Code:${c.reset}                          ${c.cyan}│${c.reset}`)
  log(`  ${c.cyan}│${c.reset}    ${c.dim}ANTHROPIC_BASE_URL=${c.reset}${c.yellow}${url}${c.reset}  ${c.cyan}│${c.reset}`)
  log(`  ${c.cyan}│${c.reset}                                        ${c.cyan}│${c.reset}`)
  log(`  ${c.cyan}│${c.reset}  ${c.bold}Aider / Cursor / Cline:${c.reset}               ${c.cyan}│${c.reset}`)
  log(`  ${c.cyan}│${c.reset}    ${c.dim}OPENAI_BASE_URL=${c.reset}${c.yellow}${url}${c.reset}     ${c.cyan}│${c.reset}`)
  log(`  ${c.cyan}└────────────────────────────────────────┘${c.reset}`)
  log('')

  log(`  ${c.bold}Upstreams:${c.reset}`)
  log(`    ${c.magenta}anthropic${c.reset} → ${c.dim}${config.upstreams.anthropic}${c.reset}`)
  log(`    ${c.magenta}openai${c.reset}    → ${c.dim}${config.upstreams.openai}${c.reset}`)
  log(`    ${c.magenta}gemini${c.reset}    → ${c.dim}${config.upstreams.gemini}${c.reset}`)
  log('')

  log(`  ${c.bold}Compression:${c.reset}`)
  for (const [stage, desc] of Object.entries(STAGE_INFO)) {
    const active = config.stages.includes(stage)
    const icon = active ? `${c.green}✓${c.reset}` : `${c.dim}✗${c.reset}`
    const extra = stage === 'llmlingua' && active && config.llmLinguaUrl ? ` ${c.dim}(${config.llmLinguaUrl})${c.reset}` : ''
    log(`    ${icon} ${active ? c.cyan : c.dim}${stage}${c.reset} — ${active ? desc : c.dim + desc + c.reset}${extra}`)
  }
  log('')
}

server.listen(config.port, () => {
  printBanner()
})

process.on('exit', () => sidecarProc?.kill())
process.on('SIGINT', () => { sidecarProc?.kill(); process.exit() })
process.on('SIGTERM', () => { sidecarProc?.kill(); process.exit() })
