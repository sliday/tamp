import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_EVENTS,
  appendBoundedEvent,
  buildInteractiveProxyArgs,
  handleServerError,
  resolveInteractiveSeed,
} from '../bin/ui/App.js'
import { initialLevel } from '../bin/ui/LevelPicker.js'
import { Dashboard, StatsBar, LogEntry, MAX_VISIBLE_EVENTS } from '../bin/ui/Dashboard.js'
import { Banner } from '../bin/ui/Banner.js'
import { createProxy } from '../index.js'
import { COMPRESSION_LEVELS, COMPRESSION_PRESETS, LEVEL_ALIASES } from '../metadata.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function getAllText(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getAllText).filter(Boolean).join(' ')
  if (typeof node === 'object' && node.props) return getAllText(node.props.children)
  return ''
}

function collectElements(node, out = []) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collectElements(item, out)
    return out
  }
  out.push(node)
  if (node.props?.children !== undefined) collectElements(node.props.children, out)
  return out
}

function makeEvent(id, url = `/v1/messages?req=${id}`) {
  return {
    id,
    meta: { provider: 'anthropic', url, bodySize: 1024 },
    stats: [{ method: 'minify', originalLen: 500, compressedLen: 300, originalTokens: 120, compressedTokens: 70 }],
  }
}

describe('AC1: App.js proxy arg building and zero process.env mutation', () => {
  const envKeys = ['TAMP_STAGES', 'TAMP_LEVEL', 'TAMP_COMPRESSION_PRESET', 'TAMP_CONFIG', 'TAMP_LLMLINGUA_URL']
  const savedEnv = {}
  const tempDirs = []

  function snapshotCleanEnv() {
    for (const k of envKeys) savedEnv[k] = process.env[k]
    for (const k of envKeys) delete process.env[k]
    const dir = mkdtempSync(join(tmpdir(), 'tamp-tui-'))
    tempDirs.push(dir)
    process.env.TAMP_CONFIG = join(dir, 'nonexistent-config')
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

  it('App.js source does not assign to process.env.TAMP_*', () => {
    const src = readFileSync(join(ROOT, 'bin', 'ui', 'App.js'), 'utf8')
    assert.doesNotMatch(src, /process\.env\.TAMP_STAGES\s*=/)
    assert.doesNotMatch(src, /process\.env\.TAMP_LEVEL\s*=/)
    assert.doesNotMatch(src, /process\.env\.TAMP_LLMLINGUA_URL\s*=/)
  })

  it('level selection passes levelOverride without overrides.stages so config.level and levelSource stay accurate', () => {
    snapshotCleanEnv()
    const onCompress = () => {}
    const onUsage = () => {}
    const { overrides, loadOpts } = buildInteractiveProxyArgs(
      { kind: 'level', level: 3, stages: [...COMPRESSION_LEVELS[3].stages] },
      { onCompress, onUsage },
    )

    assert.deepEqual(loadOpts, { levelOverride: 3 })
    assert.equal(Object.hasOwn(overrides, 'stages'), false)
    assert.equal(overrides.log, false)
    assert.equal(overrides.onCompress, onCompress)
    assert.equal(overrides.onUsage, onUsage)

    const { config } = createProxy(overrides, loadOpts)
    assert.equal(config.level, 3)
    assert.equal(config.levelSource, 'level-flag')
    assert.deepEqual(config.stages, [...COMPRESSION_LEVELS[3].stages])
    assert.equal(process.env.TAMP_STAGES, undefined)
    assert.equal(process.env.TAMP_LEVEL, undefined)
    assert.equal(process.env.TAMP_LLMLINGUA_URL, undefined)
  })

  it('level selection with llmlingua fallback filters llmlingua via overrides.stages while preserving level', () => {
    snapshotCleanEnv()
    const { overrides, loadOpts } = buildInteractiveProxyArgs(
      { kind: 'level', level: 9, stages: [...COMPRESSION_LEVELS[9].stages] },
      { sidecarFailed: true },
    )

    assert.deepEqual(loadOpts, { levelOverride: 9 })
    assert.ok(Array.isArray(overrides.stages))
    assert.equal(overrides.stages.includes('llmlingua'), false)

    const { config } = createProxy(overrides, loadOpts)
    assert.equal(config.level, 9)
    assert.equal(config.levelSource, 'level-flag')
    assert.equal(config.stages.includes('llmlingua'), false)
    assert.equal(process.env.TAMP_STAGES, undefined)
    assert.equal(process.env.TAMP_LEVEL, undefined)
  })

  it('level selection with sidecar URL passes overrides.llmLinguaUrl without mutating env', () => {
    snapshotCleanEnv()
    const { overrides, loadOpts } = buildInteractiveProxyArgs(
      { kind: 'level', level: 8, stages: [...COMPRESSION_LEVELS[8].stages] },
      { sidecarUrl: 'http://localhost:8788' },
    )

    assert.deepEqual(loadOpts, { levelOverride: 8 })
    assert.equal(overrides.llmLinguaUrl, 'http://localhost:8788')
    assert.equal(Object.hasOwn(overrides, 'stages'), false)

    const { config } = createProxy({ ...overrides, _deferSidecarProbe: true }, loadOpts)
    assert.equal(config.level, 8)
    assert.equal(config.levelSource, 'level-flag')
    assert.equal(config.llmLinguaUrl, 'http://localhost:8788')
    assert.equal(process.env.TAMP_LLMLINGUA_URL, undefined)
  })

  it('custom stages selection sets overrides.stages and overrides.level = null with empty loadOpts', () => {
    snapshotCleanEnv()
    const { overrides, loadOpts } = buildInteractiveProxyArgs(
      { kind: 'stages', stages: ['minify', 'dedup'] },
      {},
    )

    assert.deepEqual(loadOpts, {})
    assert.deepEqual(overrides.stages, ['minify', 'dedup'])
    assert.equal(overrides.level, null)

    const { config } = createProxy(overrides, loadOpts)
    assert.equal(config.level, null)
    assert.deepEqual(config.stages, ['minify', 'dedup'])
    assert.equal(process.env.TAMP_STAGES, undefined)
  })

  it('custom stages selection with llmlingua fallback strips llmlingua and keeps level null', () => {
    snapshotCleanEnv()
    const { overrides, loadOpts } = buildInteractiveProxyArgs(
      { kind: 'stages', stages: ['minify', 'llmlingua', 'dedup'] },
      { sidecarFailed: true },
    )

    assert.deepEqual(loadOpts, {})
    assert.deepEqual(overrides.stages, ['minify', 'dedup'])
    assert.equal(overrides.level, null)

    const { config } = createProxy(overrides, loadOpts)
    assert.equal(config.level, null)
    assert.deepEqual(config.stages, ['minify', 'dedup'])
  })
})

describe('AC2: Sidecar cleanup on server bind error', () => {
  it('kills sidecar before exiting on EADDRINUSE', async () => {
    const order = []
    let stderrOut = ''
    await handleServerError(
      { code: 'EADDRINUSE', message: 'listen EADDRINUSE' },
      {
        port: 7778,
        getSidecarProc: () => ({ kill: () => order.push('kill') }),
        diagnose: async () => { order.push('diagnose'); return { message: 'Port 7778 busy' } },
        exit: () => order.push('ink-exit'),
        stderr: { write: (s) => { stderrOut += s; order.push('stderr') } },
        exitProcess: (code) => order.push(`exit:${code}`),
      },
    )

    assert.deepEqual(order, ['diagnose', 'kill', 'ink-exit', 'stderr', 'exit:1'])
    assert.match(stderrOut, /Port 7778 busy/)
  })

  it('kills sidecar before exiting on non-EADDRINUSE errors', async () => {
    const order = []
    let stderrOut = ''
    await handleServerError(
      { code: 'EACCES', message: 'permission denied' },
      {
        port: 80,
        getSidecarProc: () => ({ kill: () => order.push('kill') }),
        exit: () => order.push('ink-exit'),
        stderr: { write: (s) => { stderrOut += s; order.push('stderr') } },
        exitProcess: (code) => order.push(`exit:${code}`),
      },
    )

    assert.deepEqual(order, ['kill', 'ink-exit', 'stderr', 'exit:1'])
    assert.match(stderrOut, /Failed to start: permission denied/)
  })

  it('runs safely when getSidecarProc is undefined, returns null, kill throws, or diagnose throws', async () => {
    for (const variant of [
      { getSidecarProc: undefined },
      { getSidecarProc: () => null },
      { getSidecarProc: () => ({ kill: () => { throw new Error('ESRCH') } }) },
    ]) {
      let exitCode = null
      let stderrOut = ''
      await handleServerError(
        { code: 'EADDRINUSE', message: 'busy' },
        {
          port: 7778,
          ...variant,
          diagnose: async () => { throw new Error('diag failed') },
          exit: () => {},
          stderr: { write: (s) => { stderrOut += s } },
          exitProcess: (code) => { exitCode = code },
        },
      )
      assert.equal(exitCode, 1)
      assert.match(stderrOut, /7778/)
    }
  })
})

describe('AC3: Bounded events array and Dashboard rendering past MAX_EVENTS', () => {
  it('caps events at MAX_EVENTS (200), dropping oldest entries and preserving order', () => {
    assert.equal(MAX_EVENTS, 200)
    let list = []
    for (let i = 0; i < MAX_EVENTS + 15; i++) {
      list = appendBoundedEvent(list, makeEvent(i))
    }
    assert.equal(list.length, MAX_EVENTS)
    assert.equal(list[0].id, 15)
    assert.equal(list[list.length - 1].id, MAX_EVENTS + 14)
  })

  it('Dashboard does not use Ink <Static> and renders newly appended events beyond MAX_EVENTS', () => {
    const src = readFileSync(join(ROOT, 'bin', 'ui', 'Dashboard.js'), 'utf8')
    assert.doesNotMatch(src, /\bStatic\b/)

    let events = []
    for (let i = 0; i < MAX_EVENTS + 5; i++) {
      events = appendBoundedEvent(events, makeEvent(i, `/v1/messages?seq=${i}`))
    }

    const tree = Dashboard({
      version: '0.9.0',
      config: { port: 7778, stages: ['minify'], level: 5, outputMode: 'off', tokenCost: 3 },
      events,
      totals: { totalSaved: 1000, totalOriginal: 2000, totalTokensSaved: 250, compressionCount: 205 },
      usage: null,
    })

    const logEls = collectElements(tree).filter(el => el.type === LogEntry)
    assert.equal(logEls.length, Math.min(MAX_EVENTS, MAX_VISIBLE_EVENTS))
    const renderedIds = logEls.map(el => el.props.event.id)
    assert.equal(renderedIds[renderedIds.length - 1], MAX_EVENTS + 4)
    assert.equal(new Set(renderedIds).size, renderedIds.length)

    const lastLogText = getAllText(LogEntry(logEls[logEls.length - 1].props))
    assert.match(lastLogText, new RegExp(`seq=${MAX_EVENTS + 4}`))
  })
})

describe('AC5: Dashboard Banner level propagation and StatsBar live cache hit rate', () => {
  const baseConfig = { port: 7778, stages: ['minify', 'dedup'], outputMode: 'off', tokenCost: 3 }
  const emptyTotals = { totalSaved: 0, totalOriginal: 0, totalTokensSaved: 0, compressionCount: 0 }
  const activeTotals = { totalSaved: 2048, totalOriginal: 4096, totalTokensSaved: 512, compressionCount: 4 }

  it('forwards integer config.level to Banner and renders Level line', () => {
    const tree = Dashboard({
      version: '0.9.0',
      config: { ...baseConfig, level: 5 },
      events: [],
      totals: emptyTotals,
      usage: null,
    })
    const bannerEl = collectElements(tree).find(el => el.type === Banner)
    assert.ok(bannerEl)
    assert.equal(bannerEl.props.level, 5)
    const bannerText = getAllText(Banner(bannerEl.props))
    assert.match(bannerText, /Level\s+5/)
  })

  it('forwards null config.level to Banner and shows per-stage breakdown', () => {
    const tree = Dashboard({
      version: '0.9.0',
      config: { ...baseConfig, level: null },
      events: [],
      totals: emptyTotals,
      usage: null,
    })
    const bannerEl = collectElements(tree).find(el => el.type === Banner)
    assert.ok(bannerEl)
    assert.equal(bannerEl.props.level, null)
    const bannerText = getAllText(Banner(bannerEl.props))
    assert.doesNotMatch(bannerText, /Level\s+\d/)
    assert.match(bannerText, /2 of \d+ active/)
  })

  it('forwards usage to StatsBar and renders cache hit rate when finite', () => {
    const tree = Dashboard({
      version: '0.9.0',
      config: { ...baseConfig, level: 5 },
      events: [],
      totals: activeTotals,
      usage: { cacheHitRate: 0.914 },
    })
    const statsEl = collectElements(tree).find(el => el.type === StatsBar)
    assert.ok(statsEl)
    assert.deepEqual(statsEl.props.usage, { cacheHitRate: 0.914 })
    const text = getAllText(StatsBar(statsEl.props))
    assert.match(text, /cache\s+91\.4%/)
    assert.match(text, /Session\s+4/)
  })

  it('omits cache hit segment when usage is null, undefined, or cacheHitRate is null/non-finite', () => {
    for (const usage of [null, undefined, { cacheHitRate: null }, { cacheHitRate: Number.NaN }, { cacheHitRate: Infinity }]) {
      const text = getAllText(StatsBar({ totals: activeTotals, tokenCost: 3, usage }))
      assert.doesNotMatch(text, /cache/)
    }
  })

  it('preserves Waiting for requests when compressionCount === 0 and usage is absent', () => {
    const text = getAllText(StatsBar({ totals: emptyTotals, tokenCost: 3, usage: null }))
    assert.match(text, /Waiting for requests\.\.\./)
    assert.doesNotMatch(text, /cache/)
  })

  it('surfaces live cache hit rate alongside waiting indicator when compressionCount === 0 and usage.cacheHitRate is set', () => {
    const text = getAllText(StatsBar({ totals: emptyTotals, tokenCost: 3, usage: { cacheHitRate: 0.875 } }))
    assert.match(text, /Waiting for requests\.\.\./)
    assert.match(text, /cache\s+87\.5%/)
  })

  it('renders 0.0% when cacheHitRate is 0', () => {
    const text = getAllText(StatsBar({ totals: activeTotals, tokenCost: 3, usage: { cacheHitRate: 0 } }))
    assert.match(text, /cache\s+0\.0%/)
  })
})

describe('resolveInteractiveSeed: level alias normalization and preset interactions', () => {
  it('normalizes all LEVEL_ALIASES strings to canonical integer levels when argvPreset is null', () => {
    assert.deepEqual(
      resolveInteractiveSeed({ argvLevel: 'conservative', argvPreset: null, envStages: null }),
      { envLevel: 4, envStages: null },
    )
    assert.deepEqual(
      resolveInteractiveSeed({ argvLevel: 'balanced', argvPreset: null, envStages: null }),
      { envLevel: 5, envStages: null },
    )
    assert.deepEqual(
      resolveInteractiveSeed({ argvLevel: 'aggressive', argvPreset: null, envStages: null }),
      { envLevel: 8, envStages: null },
    )
    assert.deepEqual(
      resolveInteractiveSeed({ argvLevel: 'max', argvPreset: null, envStages: null }),
      { envLevel: 9, envStages: null },
    )
    for (const [alias, expected] of Object.entries(LEVEL_ALIASES)) {
      assert.deepEqual(
        resolveInteractiveSeed({ argvLevel: alias, argvPreset: null, envStages: null }),
        { envLevel: expected, envStages: null },
      )
    }
  })

  it('normalizes prototype-chain keys, numeric strings, out-of-range integers, NaN, and unknown strings to null', () => {
    const invalidLevels = [
      null,
      undefined,
      'toString',
      'constructor',
      'valueOf',
      'hasOwnProperty',
      '__proto__',
      '1',
      '5',
      '9',
      '',
      'bogus',
      'Aggressive',
      ' aggressive ',
      ' max ',
      0,
      10,
      -1,
      4.5,
      NaN,
      Infinity,
      -Infinity,
    ]
    for (const bad of invalidLevels) {
      assert.deepEqual(
        resolveInteractiveSeed({ argvLevel: bad, argvPreset: null, envStages: null }),
        { envLevel: null, envStages: null },
        `expected envLevel: null for ${String(bad)}`,
      )
    }
  })

  it('does not let invalid, prototype-chain, numeric-string, or out-of-range argvLevel mask anchored presets', () => {
    const invalidLevels = [
      'toString',
      'constructor',
      'valueOf',
      'hasOwnProperty',
      '__proto__',
      '5',
      'bogus',
      'Aggressive',
      0,
      10,
      -1,
      4.5,
      NaN,
    ]
    for (const [presetName, expectedLevel] of [['conservative', 4], ['balanced', 5], ['aggressive', 8]]) {
      for (const bad of invalidLevels) {
        assert.deepEqual(
          resolveInteractiveSeed({ argvLevel: bad, argvPreset: presetName, envStages: null }),
          { envLevel: expectedLevel, envStages: null },
          `expected preset ${presetName} level ${expectedLevel} for invalid argvLevel ${String(bad)}`,
        )
      }
    }
  })

  it('lets valid alias or integer argvLevel take precedence over anchored preset level', () => {
    assert.deepEqual(
      resolveInteractiveSeed({ argvLevel: 'max', argvPreset: 'conservative', envStages: null }),
      { envLevel: 9, envStages: null },
    )
    assert.deepEqual(
      resolveInteractiveSeed({ argvLevel: 'conservative', argvPreset: 'aggressive', envStages: null }),
      { envLevel: 4, envStages: null },
    )
    assert.deepEqual(
      resolveInteractiveSeed({ argvLevel: 2, argvPreset: 'balanced', envStages: null }),
      { envLevel: 2, envStages: null },
    )
  })

  it('handles recommended preset with normalized argvLevel and envStages precedence', () => {
    const withAlias = resolveInteractiveSeed({ argvLevel: 'aggressive', argvPreset: 'recommended', envStages: null })
    assert.equal(withAlias.envLevel, 8)
    assert.ok(withAlias.envStages instanceof Set)
    assert.deepEqual([...withAlias.envStages], COMPRESSION_PRESETS.recommended.stages)

    const withInvalid = resolveInteractiveSeed({ argvLevel: '__proto__', argvPreset: 'recommended', envStages: null })
    assert.equal(withInvalid.envLevel, null)
    assert.ok(withInvalid.envStages instanceof Set)
    assert.deepEqual([...withInvalid.envStages], COMPRESSION_PRESETS.recommended.stages)

    const callerStages = new Set(['minify', 'dedup'])
    const withCallerStages = resolveInteractiveSeed({
      argvLevel: 'max',
      argvPreset: 'recommended',
      envStages: callerStages,
    })
    assert.equal(withCallerStages.envLevel, 9)
    assert.equal(withCallerStages.envStages, callerStages)

    const withCallerStagesAndInvalid = resolveInteractiveSeed({
      argvLevel: '5',
      argvPreset: 'recommended',
      envStages: callerStages,
    })
    assert.equal(withCallerStagesAndInvalid.envLevel, null)
    assert.equal(withCallerStagesAndInvalid.envStages, callerStages)
  })

  it('maintains parity between resolveInteractiveSeed and initialLevel for every alias in LEVEL_ALIASES', () => {
    for (const [alias, expected] of Object.entries(LEVEL_ALIASES)) {
      const seed = resolveInteractiveSeed({ argvLevel: alias })
      assert.equal(seed.envLevel, expected)
      assert.equal(initialLevel(seed.envLevel), expected)
      assert.equal(initialLevel(alias), expected)
    }
  })
})
