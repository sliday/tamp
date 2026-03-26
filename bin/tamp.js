#!/usr/bin/env node
import { createProxy } from '../index.js'
import { existsSync, readFileSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import http from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))

const DEFAULT_STAGES = ['minify', 'toon', 'strip-lines', 'whitespace', 'llmlingua', 'dedup', 'diff', 'prune']
const EXTRA_STAGES = ['strip-comments', 'textpress']

const STAGE_DESC = {
  minify:           'Strip JSON whitespace (lossless)',
  toon:             'Columnar array encoding (lossless)',
  'strip-lines':    'Remove line-number prefixes',
  whitespace:       'Collapse blank lines, trim trailing',
  llmlingua:        'Neural compression via LLMLingua-2',
  dedup:            'Deduplicate identical tool_results',
  diff:             'Replace similar re-reads with diffs',
  prune:            'Strip lockfile hashes & npm metadata',
  'strip-comments': 'Remove code comments (lossy)',
  textpress:        'LLM semantic compression (Ollama/OpenRouter)',
}

// --- Sidecar helpers (shared by both modes) ---

let sidecarProc = null

function checkPort(port) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      res.resume(); resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1000, () => { req.destroy(); resolve(false) })
  })
}

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

// --- Mode detection ---
const skipPrompt = process.argv.includes('-y') || process.argv.includes('--no-interactive') || !process.stdin.isTTY

const envStages = process.env.TAMP_STAGES
  ? new Set(process.env.TAMP_STAGES.split(',').map(s => s.trim()).filter(Boolean))
  : null

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

  function printBanner() {
    const url = `http://localhost:${config.port}`
    const active = config.stages
    const defaultActive = active.filter(s => DEFAULT_STAGES.includes(s))
    const extraActive = active.filter(s => EXTRA_STAGES.includes(s))

    console.error('')
    console.error(`  ${c.cyan}${c.bold}Tamp${c.reset} ${c.dim}v${pkg.version}${c.reset}  ${c.bgGreen}${c.bold} READY ${c.reset}  ${c.green}${url}${c.reset}`)
    console.error('')
    console.error(`  ${c.bold}Setup:${c.reset}`)
    console.error(`    ${c.dim}Claude Code:${c.reset}  ANTHROPIC_BASE_URL=${c.yellow}${url}${c.reset}`)
    console.error(`    ${c.dim}Aider/Cursor:${c.reset} OPENAI_BASE_URL=${c.yellow}${url}${c.reset}`)
    console.error('')
    console.error(`  ${c.bold}Stages${c.reset} ${c.dim}(${active.length} active)${c.reset}`)
    for (const s of defaultActive) {
      const extra = s === 'llmlingua' && config.llmLinguaUrl ? ` ${c.dim}(${config.llmLinguaUrl})${c.reset}` : ''
      console.error(`    ${c.green}\u2713${c.reset} ${c.cyan}${s}${c.reset}${extra}`)
    }
    for (const s of extraActive) {
      console.error(`    ${c.yellow}\u2713${c.reset} ${c.yellow}${s}${c.reset} ${c.dim}(lossy)${c.reset}`)
    }
    const disabled = [...DEFAULT_STAGES, ...EXTRA_STAGES].filter(s => !active.includes(s))
    if (disabled.length && disabled.length <= 4) {
      console.error(`    ${c.dim}\u2717 ${disabled.join(', ')}${c.reset}`)
    }
    console.error('')
  }

  server.listen(config.port, () => { printBanner() })

  process.on('exit', () => sidecarProc?.kill())
  process.on('SIGINT', () => { sidecarProc?.kill(); process.exit() })
  process.on('SIGTERM', () => { sidecarProc?.kill(); process.exit() })

} else {
  // --- Interactive mode (Ink TUI) ---
  const { render } = await import('ink')
  const React = await import('react')
  const { App } = await import('./ui/App.js')

  const h = React.createElement

  const cleanup = () => { sidecarProc?.kill() }
  process.on('exit', cleanup)

  render(h(App, {
    version: pkg.version,
    envStages,
    startSidecar,
    createProxy,
  }))
}
