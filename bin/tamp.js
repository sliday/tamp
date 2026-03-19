#!/usr/bin/env node
import { createProxy } from '../index.js'
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))

// ANSI colors
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
  bgYellow: '\x1b[43m',
}

function log(msg = '') { console.error(msg) }

function printBanner(config) {
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
  for (const stage of config.stages) {
    const icon = stage === 'llmlingua' ? `${c.green}▸${c.reset}` : `${c.green}▸${c.reset}`
    const label = stage === 'minify' ? 'JSON whitespace removal'
      : stage === 'toon' ? 'TOON columnar encoding'
      : stage === 'llmlingua' ? `LLMLingua-2 neural compression ${c.dim}(${config.llmLinguaUrl})${c.reset}`
      : stage
    log(`    ${icon} ${c.cyan}${stage}${c.reset} — ${label}`)
  }
  log('')
}

// --- Auto-start LLMLingua-2 sidecar if needed ---
let { config: finalConfig, server: finalServer } = createProxy()

const needsSidecar = finalConfig.stages.includes('llmlingua') && !finalConfig.llmLinguaUrl
const venvPython = join(root, 'sidecar', '.venv', 'bin', 'python')
const serverPy = join(root, 'sidecar', 'server.py')
const hasSidecar = existsSync(venvPython) && existsSync(serverPy)

if (needsSidecar && hasSidecar) {
  const sidecarPort = 8788
  process.env.TAMP_LLMLINGUA_URL = `http://localhost:${sidecarPort}`
  const refreshed = createProxy()
  finalConfig = refreshed.config
  finalServer = refreshed.server

  log('')
  log(`  ${c.yellow}→${c.reset} Starting LLMLingua-2 sidecar ...`)

  const sidecar = spawn(venvPython, ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', String(sidecarPort)], {
    cwd: join(root, 'sidecar'),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let ready = false
  sidecar.stderr.on('data', (d) => {
    const line = d.toString()
    if (!ready && line.includes('Uvicorn running')) {
      ready = true
      log(`  ${c.green}✓${c.reset} LLMLingua-2 sidecar ready on ${c.bold}port ${sidecarPort}${c.reset}`)
    }
  })

  sidecar.on('exit', (code) => {
    if (code !== null && code !== 0) {
      log(`  ${c.yellow}✗${c.reset} LLMLingua-2 sidecar exited (code ${code})`)
    }
  })

  process.on('exit', () => { sidecar?.kill() })
  process.on('SIGINT', () => { sidecar?.kill(); process.exit() })
  process.on('SIGTERM', () => { sidecar?.kill(); process.exit() })
} else if (needsSidecar && !hasSidecar) {
  log('')
  log(`  ${c.yellow}✗${c.reset} LLMLingua-2 sidecar not installed`)
  log(`    Run: ${c.cyan}curl -fsSL tamp.dev/setup.sh | bash${c.reset}`)
}

const { config: cfg, server: srv } = { config: finalConfig, server: finalServer }

srv.listen(cfg.port, () => {
  printBanner(cfg)
})
