import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LogEntry } from '../bin/ui/Dashboard.js'
import { resolveInteractiveSeed } from '../bin/ui/App.js'
import {
  resolveNonInteractiveConfig,
  formatStatusLines,
  parsePresetArgv,
  parseCliFlags,
} from '../bin/tamp.js'
import { createProxy } from '../index.js'
import { COMPRESSION_PRESETS, COMPRESSION_LEVELS } from '../metadata.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function getAllText(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getAllText).filter(Boolean).join(' ')
  if (typeof node === 'object' && node.props) return getAllText(node.props.children)
  return ''
}

describe('App.js host binding hardening', () => {
  it('passes proxyConfig.host to server.listen so interactive TUI binds loopback by default', () => {
    const src = readFileSync(join(ROOT, 'bin', 'ui', 'App.js'), 'utf8')
    assert.match(src, /server\.listen\(\s*proxyConfig\.port\s*,\s*proxyConfig\.host\s*,/)
  })
})

describe('Dashboard.js URL redaction', () => {
  const secretUrl = '/v1beta/models/gemini-2.5-pro:generateContent?key=AIzaSuperSecretKey99&alt=sse'

  it('redacts query-string API keys in compressed log entries', () => {
    const tree = LogEntry({
      event: {
        id: 1,
        meta: { provider: 'gemini', url: secretUrl, bodySize: 2048 },
        stats: [{ method: 'minify', originalLen: 1000, compressedLen: 600, originalTokens: 250, compressedTokens: 150 }],
      },
    })
    const text = getAllText(tree)
    assert.doesNotMatch(text, /AIzaSuperSecretKey99/)
    assert.match(text, /key=REDACTED/)
    assert.match(text, /alt=sse/)
  })

  it('redacts query-string API keys in passthrough/skipped log entries', () => {
    const tree = LogEntry({
      event: {
        id: 2,
        meta: { provider: 'gemini', url: secretUrl, bodySize: 128 },
        stats: [{ skipped: 'too-small' }],
      },
    })
    const text = getAllText(tree)
    assert.doesNotMatch(text, /AIzaSuperSecretKey99/)
    assert.match(text, /key=REDACTED/)
    assert.match(text, /alt=sse/)
  })
})

describe('bin/tamp.js non-interactive stage resolution', () => {
  const savedEnv = {}
  const tempDirs = []
  const envKeys = ['TAMP_STAGES', 'TAMP_LEVEL', 'TAMP_COMPRESSION_PRESET', 'TAMP_CONFIG', 'TAMP_LLMLINGUA_URL']

  function snapshotEnv() {
    for (const k of envKeys) savedEnv[k] = process.env[k]
  }

  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    while (tempDirs.length) {
      try { rmSync(tempDirs.pop(), { recursive: true, force: true }) } catch {}
    }
  })

  it('respects TAMP_COMPRESSION_PRESET without mutating process.env.TAMP_STAGES', async () => {
    snapshotEnv()
    delete process.env.TAMP_STAGES
    const res = await resolveNonInteractiveConfig({
      env: { TAMP_COMPRESSION_PRESET: 'conservative' },
      startSidecarFn: async () => null,
    })
    assert.deepEqual(res.selectedStages, [...COMPRESSION_PRESETS.conservative.stages])
    assert.equal(res.probe.levelSource, 'preset-env')
    assert.equal(process.env.TAMP_STAGES, undefined)
  })

  it('respects TAMP_LEVEL without mutating process.env.TAMP_STAGES', async () => {
    snapshotEnv()
    delete process.env.TAMP_STAGES
    const res = await resolveNonInteractiveConfig({
      env: { TAMP_LEVEL: '3' },
      startSidecarFn: async () => null,
    })
    assert.deepEqual(res.selectedStages, [...COMPRESSION_LEVELS[3].stages])
    assert.equal(res.probe.level, 3)
    assert.equal(res.probe.levelSource, 'level-env')
    assert.equal(process.env.TAMP_STAGES, undefined)
  })

  it('respects level= in config file without clobbering with DEFAULT_STAGES', async () => {
    snapshotEnv()
    for (const k of ['TAMP_STAGES', 'TAMP_LEVEL', 'TAMP_COMPRESSION_PRESET']) delete process.env[k]

    const dir = mkdtempSync(join(tmpdir(), 'tamp-cfg-'))
    tempDirs.push(dir)
    const cfgPath = join(dir, 'config')
    writeFileSync(cfgPath, 'level=7\n')
    process.env.TAMP_CONFIG = cfgPath

    const res = await resolveNonInteractiveConfig({
      env: process.env,
      startSidecarFn: async () => 'http://localhost:8788',
    })
    assert.deepEqual(res.probe.stages, [...COMPRESSION_LEVELS[7].stages])
    assert.deepEqual(res.selectedStages, [...COMPRESSION_LEVELS[7].stages])
    assert.equal(res.probe.level, 7)
    assert.equal(res.probe.levelSource, 'config-file')
    assert.equal(process.env.TAMP_STAGES, undefined)
  })

  it('strips llmlingua via overrides instead of mutating TAMP_STAGES when sidecar fails', async () => {
    snapshotEnv()
    for (const k of ['TAMP_STAGES', 'TAMP_LEVEL', 'TAMP_COMPRESSION_PRESET', 'TAMP_LLMLINGUA_URL']) {
      delete process.env[k]
    }
    const dir = mkdtempSync(join(tmpdir(), 'tamp-cfg-'))
    tempDirs.push(dir)
    process.env.TAMP_CONFIG = join(dir, 'missing-config')

    let unavailableCalled = false
    const res = await resolveNonInteractiveConfig({
      env: process.env,
      argvLevel: 9,
      startSidecarFn: async () => null,
      onSidecarUnavailable: () => { unavailableCalled = true },
    })

    assert.equal(unavailableCalled, true)
    assert.equal(process.env.TAMP_STAGES, undefined)
    assert.ok(Array.isArray(res.overrides.stages))
    assert.equal(res.overrides.stages.includes('llmlingua'), false)

    const { config } = createProxy(res.overrides, res.loadOpts)
    assert.equal(config.level, 9)
    assert.equal(config.levelSource, 'level-flag')
    assert.equal(config.stages.includes('llmlingua'), false)
  })

  it('passes llmLinguaUrl via overrides when sidecar starts', async () => {
    snapshotEnv()
    delete process.env.TAMP_LLMLINGUA_URL
    delete process.env.TAMP_STAGES
    let readyUrl = null
    const res = await resolveNonInteractiveConfig({
      env: { TAMP_STAGES: 'minify,llmlingua' },
      startSidecarFn: async () => 'http://localhost:8788',
      onSidecarReady: (url) => { readyUrl = url },
    })
    assert.equal(readyUrl, 'http://localhost:8788')
    assert.equal(res.overrides.llmLinguaUrl, 'http://localhost:8788')
    assert.equal(process.env.TAMP_LLMLINGUA_URL, undefined)
    assert.equal(process.env.TAMP_STAGES, undefined)
  })

  it('resolves --preset recommended non-interactively without starting sidecar or mutating process.env', async () => {
    snapshotEnv()
    for (const k of ['TAMP_STAGES', 'TAMP_LEVEL', 'TAMP_COMPRESSION_PRESET', 'TAMP_LLMLINGUA_URL']) {
      delete process.env[k]
    }
    const dir = mkdtempSync(join(tmpdir(), 'tamp-cfg-'))
    tempDirs.push(dir)
    process.env.TAMP_CONFIG = join(dir, 'missing-config')

    let sidecarCalled = false
    const res = await resolveNonInteractiveConfig({
      env: process.env,
      argvPreset: 'recommended',
      startSidecarFn: async () => { sidecarCalled = true; return 'http://localhost:8788' },
    })

    assert.equal(res.probe.preset, 'recommended')
    assert.equal(res.probe.level, null)
    assert.equal(res.probe.levelSource, 'preset-flag')
    assert.equal(res.selectedStages.length, 14)
    assert.deepEqual(res.selectedStages, [...COMPRESSION_PRESETS.recommended.stages])
    assert.equal(res.selectedStages.includes('llmlingua'), false)
    assert.equal(sidecarCalled, false, 'recommended excludes llmlingua so sidecar must not start')
    assert.deepEqual(res.loadOpts, { presetOverride: 'recommended' })

    const { config } = createProxy(res.overrides, res.loadOpts)
    assert.equal(config.preset, 'recommended')
    assert.equal(config.level, null)
    assert.equal(config.levelSource, 'preset-flag')
    assert.deepEqual(config.stages, [...COMPRESSION_PRESETS.recommended.stages])

    assert.equal(process.env.TAMP_STAGES, undefined)
    assert.equal(process.env.TAMP_COMPRESSION_PRESET, undefined)
    assert.equal(process.env.TAMP_LEVEL, undefined)
    assert.equal(process.env.TAMP_LLMLINGUA_URL, undefined)
  })
})

describe('bin/tamp.js --preset flag parsing, validation, and subprocess CLI checks', () => {
  const cliPath = join(ROOT, 'bin', 'tamp.js')

  it('parsePresetArgv accepts --preset NAME and --preset=NAME for all COMPRESSION_PRESETS keys', () => {
    for (const name of Object.keys(COMPRESSION_PRESETS)) {
      assert.deepEqual(parsePresetArgv(['--preset', name]), { preset: name, error: null })
      assert.deepEqual(parsePresetArgv([`--preset=${name}`]), { preset: name, error: null })
      assert.deepEqual(parseCliFlags(['-y', '--preset', name]), { level: null, preset: name, error: null })
    }
    assert.deepEqual(parsePresetArgv([]), { preset: null, error: null })
    assert.deepEqual(parseCliFlags(['-y']), { level: null, preset: null, error: null })
  })

  it('parsePresetArgv rejects missing, empty, unknown, and prototype-chain keys', () => {
    for (const argv of [
      ['--preset'],
      ['-y', '--preset'],
      ['--preset='],
      ['--preset', 'bogus'],
      ['--preset', '-y'],
      ['--preset', 'toString'],
      ['--preset=constructor'],
      ['--preset', 'valueOf'],
      ['--preset', 'hasOwnProperty'],
      ['--preset', '__proto__'],
    ]) {
      const res = parsePresetArgv(argv)
      assert.equal(res.preset, null, `expected null preset for ${JSON.stringify(argv)}`)
      assert.ok(typeof res.error === 'string' && res.error.length > 0, `expected error for ${JSON.stringify(argv)}`)
      assert.match(res.error, /--preset/)
      assert.match(res.error, /recommended/)
    }
  })

  it('parseCliFlags rejects mutually exclusive --level and --preset in any order/form', () => {
    for (const argv of [
      ['--level', '5', '--preset', 'recommended'],
      ['--preset=balanced', '--level=5'],
      ['--preset', 'conservative', '--level', '3'],
      ['--level=8', '--preset=aggressive'],
    ]) {
      const res = parseCliFlags(argv)
      assert.equal(res.level, null)
      assert.equal(res.preset, null)
      assert.match(res.error, /--level/)
      assert.match(res.error, /--preset/)
    }
  })

  it('resolveInteractiveSeed maps anchored presets to envLevel and recommended to envStages Set', () => {
    assert.deepEqual(
      resolveInteractiveSeed({ argvLevel: null, argvPreset: 'conservative', envStages: null }),
      { envLevel: 4, envStages: null },
    )
    assert.deepEqual(
      resolveInteractiveSeed({ argvLevel: null, argvPreset: 'balanced', envStages: null }),
      { envLevel: 5, envStages: null },
    )
    assert.deepEqual(
      resolveInteractiveSeed({ argvLevel: null, argvPreset: 'aggressive', envStages: null }),
      { envLevel: 8, envStages: null },
    )
    // Explicit argvLevel wins over preset level if both passed programmatically
    assert.deepEqual(
      resolveInteractiveSeed({ argvLevel: 2, argvPreset: 'aggressive', envStages: null }),
      { envLevel: 2, envStages: null },
    )

    // recommended seeds envStages as a Set when unset
    const recSeed = resolveInteractiveSeed({ argvLevel: null, argvPreset: 'recommended', envStages: null })
    assert.equal(recSeed.envLevel, null)
    assert.ok(recSeed.envStages instanceof Set)
    assert.equal(recSeed.envStages.size, 14)
    assert.deepEqual([...recSeed.envStages], COMPRESSION_PRESETS.recommended.stages)

    // existing envStages (TAMP_STAGES) beats --preset recommended
    const custom = new Set(['minify', 'dedup'])
    const kept = resolveInteractiveSeed({ argvLevel: null, argvPreset: 'recommended', envStages: custom })
    assert.equal(kept.envLevel, null)
    assert.equal(kept.envStages, custom)

    // absent / invalid / prototype key passes through unchanged
    for (const bad of [null, undefined, '', 'bogus', 'toString', '__proto__']) {
      assert.deepEqual(
        resolveInteractiveSeed({ argvLevel: null, argvPreset: bad, envStages: null }),
        { envLevel: null, envStages: null },
      )
    }
  })

  it('subprocess: tamp help / --help / -h exits 0 and documents --preset NAME', () => {
    for (const args of [['help'], ['--help'], ['-h']]) {
      const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
      assert.equal(r.status, 0, `${args.join(' ')} must exit 0`)
      assert.match(r.stdout, /--preset NAME/)
      assert.match(r.stdout, /conservative, balanced, aggressive, recommended/)
    }
  })

  it('subprocess: invalid/missing/prototype-key --preset and --level + --preset conflict exit 2 with stderr', () => {
    const invalidCases = [
      ['--preset'],
      ['-y', '--preset'],
      ['--preset='],
      ['--preset', 'bogus'],
      ['--preset', 'toString'],
      ['--preset=constructor'],
      ['--preset', '__proto__'],
    ]
    for (const args of invalidCases) {
      const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
      assert.equal(r.status, 2, `expected exit 2 for ${JSON.stringify(args)}, got ${r.status}`)
      assert.match(r.stderr, /--preset/)
      assert.match(r.stderr, /recommended/)
    }

    const conflictCases = [
      ['--level', '5', '--preset', 'recommended'],
      ['--preset=balanced', '--level=5'],
    ]
    for (const args of conflictCases) {
      const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
      assert.equal(r.status, 2, `expected exit 2 for ${JSON.stringify(args)}, got ${r.status}`)
      assert.match(r.stderr, /--level/)
      assert.match(r.stderr, /--preset/)
    }
  })
})

describe('bin/tamp.js status formatting and lifecycle guards', () => {
  it('formats live health stats including cache hit rate when present', () => {
    const lines = formatStatusLines({
      status: 'ok',
      version: '0.9.0',
      stages: ['minify', 'toon', 'dedup'],
      sidecar: false,
      session: { requests: 12, tokensSaved: 4520 },
      usage: { cacheHitRate: 0.825 },
    }, 7778, '0.9.0')
    const out = lines.join('\n')
    assert.match(out, /Health: running \(port 7778\)/)
    assert.match(out, /Stages: 3 active \(minify, toon, dedup\)/)
    assert.match(out, /Session: 12 requests, 4520 tokens saved/)
    assert.match(out, /Sidecar: n\/a/)
    assert.match(out, /Cache hit rate: 82\.5%/)
  })

  it('omits cache hit rate when usage.cacheHitRate is null', () => {
    const lines = formatStatusLines({
      status: 'ok',
      version: '0.9.0',
      stages: ['minify', 'llmlingua'],
      sidecar: true,
      session: { requests: 1, tokensSaved: 100 },
      usage: { cacheHitRate: null },
    }, 7778, '0.9.0')
    const out = lines.join('\n')
    assert.match(out, /Session: 1 request, 100 tokens saved/)
    assert.match(out, /Sidecar: ok/)
    assert.doesNotMatch(out, /Cache hit rate/)
  })

  it('uses loadConfig().port in status and stop, and guards kill calls with isTampProcess', () => {
    const src = readFileSync(join(ROOT, 'bin', 'tamp.js'), 'utf8')
    assert.match(src, /subcommand === 'status'[\s\S]{0,120}loadConfig\(\)\.port/)
    assert.match(src, /subcommand === 'stop'[\s\S]{0,120}loadConfig\(\)\.port/)
    assert.match(src, /isTampProcess\(rec\.pid\)/)
  })
})

describe('sidecar/server.py hardening', () => {
  it('uses FastAPI lifespan, sync compress endpoint, and 503 guard before model loads', () => {
    const py = readFileSync(join(ROOT, 'sidecar', 'server.py'), 'utf8')
    assert.doesNotMatch(py, /@app\.on_event/)
    assert.match(py, /@asynccontextmanager[\s\S]*async def lifespan\(/)
    assert.match(py, /FastAPI\(lifespan=lifespan\)/)
    assert.doesNotMatch(py, /async def compress\(/)
    assert.match(py, /\ndef compress\(payload: CompressRequest\):/)
    assert.match(py, /if compressor is None:[\s\S]*HTTPException\(status_code=503/)
  })
})
