import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ENSURE_TAMP = join(ROOT, 'plugin', 'hooks', 'ensure-tamp.sh')
const ENSURE_CLAUDE_MD = join(ROOT, 'plugin', 'hooks', 'ensure-claude-md.sh')

const BASE_TOOLS = [
  'bash',
  'sh',
  'curl',
  'awk',
  'sed',
  'grep',
  'sleep',
  'nohup',
  'cat',
  'rm',
  'mv',
  'cut',
  'tr',
  'env',
  'lsof',
]

const tempDirs = []
const servers = []
const childPids = []

function makeTempDir(prefix = 'tamp-hook-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function findSystemBin(name) {
  const dirs = [
    ...(process.env.PATH || '').split(delimiter).filter(Boolean),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/usr/local/bin',
  ]
  for (const dir of dirs) {
    const candidate = join(dir, name)
    try {
      if (existsSync(candidate) && (statSync(candidate).mode & 0o111) !== 0) {
        return candidate
      }
    } catch {
      // ignore inaccessible paths
    }
  }
  return null
}

function makeIsolatedBin(rootDir, { omit = [], shims = {} } = {}) {
  const binDir = join(rootDir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const omitSet = new Set(omit)
  for (const tool of BASE_TOOLS) {
    if (omitSet.has(tool) || Object.hasOwn(shims, tool)) continue
    const found = findSystemBin(tool)
    if (found) {
      symlinkSync(found, join(binDir, tool))
    }
  }
  for (const [name, content] of Object.entries(shims)) {
    const p = join(binDir, name)
    writeFileSync(p, content, { mode: 0o755 })
  }
  return binDir
}

async function runHook(scriptPath, { cwd, env = {}, args = [], timeout = 10000 } = {}) {
  const res = await new Promise((resolve) => {
    execFile(
      scriptPath,
      args,
      {
        cwd: cwd || ROOT,
        env,
        encoding: 'utf8',
        timeout,
      },
      (error, stdout, stderr) => {
        resolve({ error, stdout, stderr })
      },
    )
  })
  assert.equal(
    res.error,
    null,
    `expected exit 0, got error=${res.error?.message}; stderr=${res.stderr}; stdout=${res.stdout}`,
  )
  const parsed = JSON.parse(res.stdout)
  assert.equal(parsed?.hookSpecificOutput?.hookEventName, 'SessionStart')
  assert.equal(typeof parsed?.hookSpecificOutput?.additionalContext, 'string')
  return {
    stdout: res.stdout,
    stderr: res.stderr,
    parsed,
    context: parsed.hookSpecificOutput.additionalContext,
  }
}

async function startHealthServer(handler) {
  let hits = 0
  const paths = []
  const server = createHttpServer((req, res) => {
    hits += 1
    paths.push(req.url)
    handler(req, res)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(server)
  const { port } = server.address()
  return {
    server,
    port,
    getHits: () => hits,
    getPaths: () => [...paths],
  }
}

async function allocateFreePort() {
  const srv = createNetServer()
  await new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', resolve)
  })
  const { port } = srv.address()
  await new Promise((resolve) => srv.close(resolve))
  return port
}

function makeCurlCaptureShim(logFile, responseBody = '{"status":"ok","version":"1.0.0"}', exitCode = 0) {
  return [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${logFile}"`,
    exitCode === 0 ? `printf '%s' '${responseBody.replace(/'/g, "'\\''")}'` : '',
    `exit ${exitCode}`,
    '',
  ].join('\n')
}

afterEach(async () => {
  while (childPids.length > 0) {
    const pid = childPids.pop()
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already exited
    }
  }
  while (servers.length > 0) {
    const srv = servers.pop()
    await new Promise((resolve) => srv.close(() => resolve()))
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('ensure-tamp.sh permissions and syntax', () => {
  it('retains executable bit and passes bash -n syntax check', () => {
    const mode = statSync(ENSURE_TAMP).mode & 0o777
    assert.equal((mode & 0o111) !== 0, true, `expected executable mode, got 0${mode.toString(8)}`)
    const check = spawnSync('bash', ['-n', ENSURE_TAMP], { encoding: 'utf8' })
    assert.equal(check.status, 0, check.stderr)
  })
})

describe('ensure-tamp.sh port resolution & config parity', () => {
  it('parses TAMP_CONFIG with comments, whitespace, quotes, exact key, and last-value-wins', async () => {
    const dir = makeTempDir()
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const cfg = join(dir, 'custom.conf')
    writeFileSync(
      cfg,
      [
        '# leading comment',
        '   # TAMP_PORT=1111',
        '',
        'MY_TAMP_PORT=2222',
        'TAMP_PORT_EXTRA=3333',
        'TAMP_PORT = "9123"',
        "  TAMP_PORT = '9456'  ",
        'TAMP_PORT = "9876"\r',
      ].join('\n'),
    )
    const curlLog = join(dir, 'curl.log')
    const binDir = makeIsolatedBin(dir, {
      shims: { curl: makeCurlCaptureShim(curlLog) },
    })

    const { context } = await runHook(ENSURE_TAMP, {
      env: { HOME: home, TAMP_CONFIG: cfg, PATH: binDir },
    })

    const calls = readFileSync(curlLog, 'utf8').trim().split('\n')
    assert.equal(calls.length, 1)
    assert.match(calls[0], /--max-time 2/)
    assert.match(calls[0], /http:\/\/127\.0\.0\.1:9876\/health/)
    assert.match(context, /Tamp v1\.0\.0 running on :9876\./)
  })

  it('reads ${HOME}/.config/tamp/config when TAMP_CONFIG is unset or empty', async () => {
    for (const emptyEnv of [undefined, '']) {
      const dir = makeTempDir()
      const home = join(dir, 'home')
      const cfgDir = join(home, '.config', 'tamp')
      mkdirSync(cfgDir, { recursive: true })
      writeFileSync(join(cfgDir, 'config'), "TAMP_PORT = '8123'\n")

      const curlLog = join(dir, 'curl.log')
      const binDir = makeIsolatedBin(dir, {
        shims: { curl: makeCurlCaptureShim(curlLog) },
      })

      const env = { HOME: home, PATH: binDir }
      if (emptyEnv !== undefined) env.TAMP_CONFIG = emptyEnv

      const { context } = await runHook(ENSURE_TAMP, { env })
      const calls = readFileSync(curlLog, 'utf8').trim().split('\n')
      assert.equal(calls.length, 1)
      assert.match(calls[0], /http:\/\/127\.0\.0\.1:8123\/health/)
      assert.match(context, /:8123\./)
    }
  })

  it('gives TAMP_PORT env precedence over config file, and empty TAMP_PORT defers to config', async () => {
    const dir = makeTempDir()
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const cfg = join(dir, 'config')
    writeFileSync(cfg, 'TAMP_PORT=8222\n')

    const curlLog = join(dir, 'curl.log')
    const binDir = makeIsolatedBin(dir, {
      shims: { curl: makeCurlCaptureShim(curlLog) },
    })

    // Env overrides config
    const res1 = await runHook(ENSURE_TAMP, {
      env: { HOME: home, TAMP_CONFIG: cfg, TAMP_PORT: '8333', PATH: binDir },
    })
    assert.match(res1.context, /:8333\./)

    // Empty env defers to config
    const res2 = await runHook(ENSURE_TAMP, {
      env: { HOME: home, TAMP_CONFIG: cfg, TAMP_PORT: '', PATH: binDir },
    })
    assert.match(res2.context, /:8222\./)

    // Invalid non-empty env falls back directly to 7778 (not config)
    const res3 = await runHook(ENSURE_TAMP, {
      env: { HOME: home, TAMP_CONFIG: cfg, TAMP_PORT: 'not-a-port', PATH: binDir },
    })
    assert.match(res3.context, /:7778\./)

    const calls = readFileSync(curlLog, 'utf8').trim().split('\n')
    assert.equal(calls.length, 3)
    assert.match(calls[0], /127\.0\.0\.1:8333\/health/)
    assert.match(calls[1], /127\.0\.0\.1:8222\/health/)
    assert.match(calls[2], /127\.0\.0\.1:7778\/health/)
  })

  it('normalizes leading-zero base-10 ports and falls back to 7778 on invalid/missing configs', async () => {
    const cases = [
      { label: 'leading zero 08000', cfgBody: 'TAMP_PORT=08000\n', expected: 8000 },
      { label: 'zero', cfgBody: 'TAMP_PORT=0\n', expected: 7778 },
      { label: 'negative', cfgBody: 'TAMP_PORT=-5\n', expected: 7778 },
      { label: 'above 65535', cfgBody: 'TAMP_PORT=65536\n', expected: 7778 },
      { label: 'huge integer', cfgBody: 'TAMP_PORT=99999999999999999999\n', expected: 7778 },
      { label: 'non-numeric', cfgBody: 'TAMP_PORT=abc\n', expected: 7778 },
      { label: 'mismatched quotes', cfgBody: 'TAMP_PORT="8080\'\n', expected: 7778 },
      { label: 'empty value', cfgBody: 'TAMP_PORT=\n', expected: 7778 },
      { label: 'missing config file', cfgBody: null, expected: 7778 },
    ]

    for (const tc of cases) {
      const dir = makeTempDir()
      const home = join(dir, 'home')
      mkdirSync(home, { recursive: true })
      const cfg = join(dir, 'config')
      if (tc.cfgBody !== null) writeFileSync(cfg, tc.cfgBody)

      const curlLog = join(dir, 'curl.log')
      const binDir = makeIsolatedBin(dir, {
        shims: { curl: makeCurlCaptureShim(curlLog) },
      })

      const { context } = await runHook(ENSURE_TAMP, {
        env: { HOME: home, TAMP_CONFIG: cfg, PATH: binDir },
      })
      const calls = readFileSync(curlLog, 'utf8').trim().split('\n')
      assert.equal(calls.length, 1, tc.label)
      assert.match(calls[0], new RegExp(`http://127\\.0\\.0\\.1:${tc.expected}/health`), tc.label)
      assert.match(context, new RegExp(`:${tc.expected}\\.`), tc.label)
    }
  })

  it('silently ignores unreadable config file and falls back to 7778', async () => {
    const dir = makeTempDir()
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const cfg = join(dir, 'unreadable')
    writeFileSync(cfg, 'TAMP_PORT=9999\n')
    chmodSync(cfg, 0o000)

    const curlLog = join(dir, 'curl.log')
    const binDir = makeIsolatedBin(dir, {
      shims: { curl: makeCurlCaptureShim(curlLog) },
    })

    try {
      const { context } = await runHook(ENSURE_TAMP, {
        env: { HOME: home, TAMP_CONFIG: cfg, PATH: binDir },
      })
      if (process.getuid?.() !== 0) {
        assert.match(context, /:7778\./)
      }
    } finally {
      chmodSync(cfg, 0o600)
    }
  })
})

describe('ensure-tamp.sh health check & JSON escaping', () => {
  it('makes exactly 1 HTTP request to /health on custom config port and outputs valid JSON', async () => {
    const srv = await startHealthServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', version: '0.9.1', uptime: 42 }))
    })
    const dir = makeTempDir()
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const cfg = join(dir, 'config')
    writeFileSync(cfg, `TAMP_PORT=${srv.port}\n`)
    const binDir = makeIsolatedBin(dir, { omit: ['tamp'] })

    const { context } = await runHook(ENSURE_TAMP, {
      env: { HOME: home, TAMP_CONFIG: cfg, PATH: binDir },
    })

    assert.equal(srv.getHits(), 1, 'must fetch /health exactly once')
    assert.deepEqual(srv.getPaths(), ['/health'])
    assert.equal(context, `Tamp v0.9.1 running on :${srv.port}. Token compression active.`)
  })

  it('escapes backslashes, quotes, tabs, and newlines in health version cleanly', async () => {
    const trickyVersion = '0.9.1\\dev"q\tline1\nline2'
    const srv = await startHealthServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', version: trickyVersion }))
    })
    const dir = makeTempDir()
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const cfg = join(dir, 'config')
    writeFileSync(cfg, `TAMP_PORT=${srv.port}\n`)
    const binDir = makeIsolatedBin(dir, { omit: ['tamp'] })

    const { context } = await runHook(ENSURE_TAMP, {
      env: { HOME: home, TAMP_CONFIG: cfg, PATH: binDir },
    })

    assert.equal(srv.getHits(), 1)
    assert.equal(context, `Tamp v${trickyVersion} running on :${srv.port}. Token compression active.`)
  })

  it('handles missing or empty version in /health gracefully without broken formatting', async () => {
    for (const body of [{ status: 'ok' }, { status: 'ok', version: '' }]) {
      const srv = await startHealthServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
      const dir = makeTempDir()
      const home = join(dir, 'home')
      mkdirSync(home, { recursive: true })
      const cfg = join(dir, 'config')
      writeFileSync(cfg, `TAMP_PORT=${srv.port}\n`)
      const binDir = makeIsolatedBin(dir, { omit: ['tamp'] })

      const { context } = await runHook(ENSURE_TAMP, {
        env: { HOME: home, TAMP_CONFIG: cfg, PATH: binDir },
      })

      assert.equal(srv.getHits(), 1)
      assert.equal(context, `Tamp running on :${srv.port}. Token compression active.`)
    }
  })
})

describe('ensure-tamp.sh port-conflict & lsof handling', () => {
  it('detects a listening non-health TCP socket, emits port-in-use JSON, and does not spawn tamp', async () => {
    const blocker = createNetServer((socket) => socket.destroy())
    await new Promise((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', resolve)
    })
    servers.push(blocker)
    const { port } = blocker.address()

    const dir = makeTempDir()
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const cfg = join(dir, 'config')
    writeFileSync(cfg, `TAMP_PORT=${port}\n`)
    const tampCalled = join(dir, 'tamp-called')

    const lsofAvailable = findSystemBin('lsof') !== null
    const lsofArgsLog = join(dir, 'lsof-args.log')
    const shims = {
      tamp: `#!/bin/sh\ntouch "${tampCalled}"\nexit 0\n`,
    }
    if (!lsofAvailable) {
      shims.lsof = `#!/bin/sh\nprintf '%s\\n' "$*" > "${lsofArgsLog}"\nexit 0\n`
    }
    const binDir = makeIsolatedBin(dir, { shims })

    const { context } = await runHook(ENSURE_TAMP, {
      env: { HOME: home, TAMP_CONFIG: cfg, PATH: binDir },
    })

    assert.match(context, new RegExp(`Port ${port} in use`))
    assert.equal(existsSync(tampCalled), false, 'must not spawn tamp when port is occupied')
  })

  it('passes -nP -iTCP:<PORT> -sTCP:LISTEN to lsof and ignores non-listening (exit 1) sockets', async () => {
    const dir = makeTempDir()
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const cfg = join(dir, 'config')
    writeFileSync(cfg, 'TAMP_PORT=8456\n')
    const lsofArgsLog = join(dir, 'lsof-args.log')

    const binDir = makeIsolatedBin(dir, {
      omit: ['tamp'],
      shims: {
        curl: '#!/bin/sh\nexit 7\n',
        lsof: `#!/bin/sh\nprintf '%s\\n' "$*" > "${lsofArgsLog}"\nexit 1\n`,
      },
    })

    const { context } = await runHook(ENSURE_TAMP, {
      env: { HOME: home, TAMP_CONFIG: cfg, PATH: binDir },
    })

    const recorded = readFileSync(lsofArgsLog, 'utf8').trim()
    assert.equal(recorded, '-nP -iTCP:8456 -sTCP:LISTEN')
    assert.match(context, /@sliday\/tamp@latest/)
  })

  it('does not block startup when lsof is missing from PATH', async () => {
    const dir = makeTempDir()
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const cfg = join(dir, 'config')
    writeFileSync(cfg, 'TAMP_PORT=8567\n')

    const binDir = makeIsolatedBin(dir, {
      omit: ['lsof', 'tamp'],
      shims: {
        curl: '#!/bin/sh\nexit 7\n',
      },
    })

    const { context } = await runHook(ENSURE_TAMP, {
      env: { HOME: home, TAMP_CONFIG: cfg, PATH: binDir },
    })

    assert.match(context, /Tamp not installed/)
    assert.match(context, /npm i -g @sliday\/tamp@latest/)
  })
})

describe('ensure-tamp.sh missing binary & auto-start path', () => {
  it('recommends @sliday/tamp@latest when tamp is absent from PATH', async () => {
    const freePort = await allocateFreePort()
    const dir = makeTempDir()
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const cfg = join(dir, 'config')
    writeFileSync(cfg, `TAMP_PORT=${freePort}\n`)

    const binDir = makeIsolatedBin(dir, { omit: ['tamp'] })

    const { context } = await runHook(ENSURE_TAMP, {
      env: { HOME: home, TAMP_CONFIG: cfg, PATH: binDir },
    })

    assert.match(context, /Tamp not installed/)
    assert.match(context, /npm i -g @sliday\/tamp@latest/)
  })

  it('auto-starts tamp shim, detects readiness, returns without hanging, and leaves no nohup.out', async () => {
    const freePort = await allocateFreePort()
    const dir = makeTempDir()
    const home = join(dir, 'home')
    const workdir = join(dir, 'workdir')
    mkdirSync(home, { recursive: true })
    mkdirSync(workdir, { recursive: true })

    const cfg = join(dir, 'config')
    writeFileSync(cfg, `TAMP_PORT=${freePort}\n`)
    const pidFile = join(dir, 'shim.pid')
    const serverScript = join(dir, 'fake-tamp.mjs')

    writeFileSync(
      serverScript,
      [
        "import { createServer } from 'node:http'",
        "import { writeFileSync } from 'node:fs'",
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
        'const srv = createServer((req, res) => {',
        "  if (req.url === '/health') {",
        "    res.writeHead(200, { 'content-type': 'application/json' })",
        '    res.end(JSON.stringify({ status: "ok", version: "9.9.9" }))',
        '    return',
        '  }',
        '  res.writeHead(404)',
        '  res.end()',
        '})',
        `setTimeout(() => srv.listen(${freePort}, '127.0.0.1'), 150)`,
        "process.on('SIGTERM', () => { srv.close(); process.exit(0) })",
        'setTimeout(() => process.exit(0), 10000).unref()',
        '',
      ].join('\n'),
    )

    const binDir = makeIsolatedBin(dir, {
      shims: {
        tamp: `#!/bin/sh\nexec "${process.execPath}" "${serverScript}" "$@"\n`,
      },
    })

    const startedAt = Date.now()
    try {
      const { context } = await runHook(ENSURE_TAMP, {
        cwd: workdir,
        env: { HOME: home, TAMP_CONFIG: cfg, PATH: binDir },
        timeout: 8000,
      })
      const elapsedMs = Date.now() - startedAt
      assert.ok(elapsedMs < 6000, `hook should return promptly after readiness, took ${elapsedMs}ms`)
      assert.equal(context, `Tamp v9.9.9 auto-started on :${freePort}. Token compression active.`)
      assert.equal(existsSync(join(workdir, 'nohup.out')), false, 'must not create nohup.out')
    } finally {
      if (existsSync(pidFile)) {
        const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
        if (Number.isInteger(pid) && pid > 0) childPids.push(pid)
      }
    }
  })
})

describe('ensure-claude-md.sh idempotency, drift refresh, and uninstall', () => {
  it('creates CLAUDE.local.md, stays idempotent on re-run, and removes empty file on TAMP_RULES=off', async () => {
    const dir = makeTempDir()
    const target = join(dir, 'CLAUDE.local.md')

    // 1. Create
    const createRes = await runHook(ENSURE_CLAUDE_MD, { cwd: dir, env: { PATH: process.env.PATH } })
    assert.match(createRes.context, /created/)
    assert.equal(existsSync(target), true)
    const createdContent = readFileSync(target, 'utf8')
    assert.match(createdContent, /<!-- tamp:token-efficient:start -->/)
    assert.match(createdContent, /<!-- tamp:token-efficient:end -->/)

    // 2. Idempotent re-run
    const rerunRes = await runHook(ENSURE_CLAUDE_MD, { cwd: dir, env: { PATH: process.env.PATH } })
    assert.match(rerunRes.context, /already in/)
    assert.equal(readFileSync(target, 'utf8'), createdContent)

    // 3. TAMP_RULES=off deletes file completely when empty after stripping block
    const offRes = await runHook(ENSURE_CLAUDE_MD, {
      cwd: dir,
      env: { PATH: process.env.PATH, TAMP_RULES: 'off' },
    })
    assert.match(offRes.context, /removed/)
    assert.equal(existsSync(target), false, 'empty CLAUDE.local.md must be deleted')
  })

  it('appends to user content, refreshes drifted block in place, and preserves user content on --uninstall', async () => {
    const dir = makeTempDir()
    const target = join(dir, 'CLAUDE.local.md')
    const userTop = '# Project Notes\nKeep this intact.\n'
    writeFileSync(target, userTop)

    // 1. Append to existing file
    const appendRes = await runHook(ENSURE_CLAUDE_MD, { cwd: dir, env: { PATH: process.env.PATH } })
    assert.match(appendRes.context, /appended/)
    const appended = readFileSync(target, 'utf8')
    assert.ok(appended.startsWith(userTop))
    assert.match(appended, /<!-- tamp:token-efficient:start -->/)

    // 2. Simulate drift inside markers while preserving user text outside
    const drifted = [
      '# Project Notes',
      'Keep this intact.',
      '',
      '<!-- tamp:token-efficient:start -->',
      '## Outdated rules',
      '<!-- tamp:token-efficient:end -->',
      '',
      '## Footer note',
    ].join('\n')
    writeFileSync(target, drifted + '\n')

    const refreshRes = await runHook(ENSURE_CLAUDE_MD, { cwd: dir, env: { PATH: process.env.PATH } })
    assert.match(refreshRes.context, /refreshed/)
    const refreshed = readFileSync(target, 'utf8')
    assert.match(refreshed, /# Project Notes/)
    assert.match(refreshed, /Keep this intact\./)
    assert.match(refreshed, /## Footer note/)
    assert.doesNotMatch(refreshed, /## Outdated rules/)
    assert.match(refreshed, /## Token-Efficient Output \(via Tamp\)/)

    // 3. --uninstall strips block while keeping user content
    const uninstallRes = await runHook(ENSURE_CLAUDE_MD, {
      cwd: dir,
      args: ['--uninstall'],
      env: { PATH: process.env.PATH },
    })
    assert.match(uninstallRes.context, /removed/)
    assert.equal(existsSync(target), true)
    const afterUninstall = readFileSync(target, 'utf8')
    assert.match(afterUninstall, /# Project Notes/)
    assert.match(afterUninstall, /Keep this intact\./)
    assert.match(afterUninstall, /## Footer note/)
    assert.doesNotMatch(afterUninstall, /tamp:token-efficient/)

    // 4. Re-running --uninstall when absent is a clean no-op
    const uninstallAgain = await runHook(ENSURE_CLAUDE_MD, {
      cwd: dir,
      args: ['--uninstall'],
      env: { PATH: process.env.PATH },
    })
    assert.match(uninstallAgain.context, /not present/)
  })
})
