import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, unlinkSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, loadConfigFile, CONFIG_TEMPLATE } from '../config.js'
import { DEFAULT_STAGES, VERSION, COMPRESSION_LEVELS, COMPRESSION_PRESETS, DEFAULT_LEVEL } from '../metadata.js'

describe('loadConfig', () => {
  it('returns defaults when no env vars set', () => {
    const cfg = loadConfig({})
    assert.equal(cfg.version, VERSION)
    assert.equal(cfg.port, 7778)
    assert.equal(cfg.upstream, 'https://api.anthropic.com')
    assert.deepEqual(cfg.stages, DEFAULT_STAGES)
    assert.equal(cfg.minSize, 200)
    assert.equal(cfg.log, true)
    assert.equal(cfg.maxBody, 10_485_760)
    assert.equal(cfg.cacheSafe, true)
    assert.equal(cfg.llmLinguaUrl, null)
    assert.equal(cfg.logFile, null)
    assert.equal(cfg.redact, true)
    assert.equal(cfg.redactMode, 'mask')
  })

  it('disables redaction with TAMP_REDACT=false and switches mode', () => {
    assert.equal(loadConfig({ TAMP_REDACT: 'false' }).redact, false)
    assert.equal(loadConfig({ TAMP_REDACT_MODE: 'remove' }).redactMode, 'remove')
  })

  it('overrides port from TAMP_PORT', () => {
    const cfg = loadConfig({ TAMP_PORT: '9999' })
    assert.equal(cfg.port, 9999)
  })

  it('overrides upstream from TAMP_UPSTREAM', () => {
    const cfg = loadConfig({ TAMP_UPSTREAM: 'http://localhost:3000' })
    assert.equal(cfg.upstream, 'http://localhost:3000')
  })

  it('parses TAMP_STAGES as comma-separated array', () => {
    const cfg = loadConfig({ TAMP_STAGES: 'minify,toon,llmlingua' })
    assert.deepEqual(cfg.stages, ['minify', 'toon', 'llmlingua'])
  })

  it('trims whitespace in TAMP_STAGES', () => {
    const cfg = loadConfig({ TAMP_STAGES: ' minify , toon ' })
    assert.deepEqual(cfg.stages, ['minify', 'toon'])
  })

  it('drops unknown stage names from TAMP_STAGES (with a warning) and keeps valid ones', () => {
    const orig = process.stderr.write
    let warned = ''
    process.stderr.write = (s) => { warned += s; return true }
    try {
      const cfg = loadConfig({ TAMP_STAGES: 'minify,bogus,toon' })
      assert.deepEqual(cfg.stages, ['minify', 'toon'], 'unknown stage must be dropped')
      assert.match(warned, /bogus/, 'must warn about the unknown stage')
    } finally {
      process.stderr.write = orig
    }
  })

  it('warns on an unknown TAMP_COMPRESSION_PRESET and falls back to balanced', () => {
    const orig = process.stderr.write
    let warned = ''
    process.stderr.write = (s) => { warned += s; return true }
    try {
      const cfg = loadConfig({ TAMP_COMPRESSION_PRESET: 'baalanced' })
      assert.match(warned, /baalanced/, 'must warn about the unknown preset')
      // Behaviour unchanged: still the balanced preset's stages.
      assert.ok(Array.isArray(cfg.stages) && cfg.stages.length > 0)
    } finally {
      process.stderr.write = orig
    }
  })

  it('overrides minSize from TAMP_MIN_SIZE', () => {
    const cfg = loadConfig({ TAMP_MIN_SIZE: '500' })
    assert.equal(cfg.minSize, 500)
  })

  it('sets log to false when TAMP_LOG=false', () => {
    const cfg = loadConfig({ TAMP_LOG: 'false' })
    assert.equal(cfg.log, false)
  })

  it('overrides maxBody from TAMP_MAX_BODY', () => {
    const cfg = loadConfig({ TAMP_MAX_BODY: '2097152' })
    assert.equal(cfg.maxBody, 2_097_152)
  })

  it('sets llmLinguaUrl from TAMP_LLMLINGUA_URL', () => {
    const cfg = loadConfig({ TAMP_LLMLINGUA_URL: 'http://localhost:8788' })
    assert.equal(cfg.llmLinguaUrl, 'http://localhost:8788')
  })

  it('sets logFile from TAMP_LOG_FILE', () => {
    const cfg = loadConfig({ TAMP_LOG_FILE: '/tmp/tamp.log' })
    assert.equal(cfg.logFile, '/tmp/tamp.log')
  })

  it('sets cacheSafe from TAMP_CACHE_SAFE', () => {
    const cfg = loadConfig({ TAMP_CACHE_SAFE: 'false' })
    assert.equal(cfg.cacheSafe, false)
  })

  it('sets tokenCost from TAMP_TOKEN_COST', () => {
    const cfg = loadConfig({ TAMP_TOKEN_COST: '15' })
    assert.equal(cfg.tokenCost, 15)
  })

  it('defaults tokenCost to 3', () => {
    const cfg = loadConfig({})
    assert.equal(cfg.tokenCost, 3)
  })

  it('falls back to defaults for invalid numeric env vars', () => {
    const cfg = loadConfig({ TAMP_PORT: 'abc', TAMP_MIN_SIZE: '', TAMP_MAX_BODY: 'xyz' })
    assert.equal(cfg.port, 7778)
    assert.equal(cfg.minSize, 200)
    assert.equal(cfg.maxBody, 10_485_760)
  })

  it('returns frozen object', () => {
    const cfg = loadConfig({})
    assert.throws(() => { cfg.port = 1234 }, TypeError)
  })

  it('binds loopback by default and honors TAMP_HOST', () => {
    assert.equal(loadConfig({}).host, '127.0.0.1')
    assert.equal(loadConfig({ TAMP_HOST: '0.0.0.0' }).host, '0.0.0.0')
  })
})

describe('loadConfigFile', () => {
  const tmpDir = join(tmpdir(), 'tamp-test-' + Date.now())
  const tmpFile = join(tmpDir, 'config')

  it('returns empty object for missing file', () => {
    const result = loadConfigFile('/nonexistent/path/config')
    assert.deepEqual(result, {})
  })

  it('parses key=value lines', () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(tmpFile, 'TAMP_PORT=9999\nTAMP_UPSTREAM=http://example.com\n')
    const result = loadConfigFile(tmpFile)
    assert.equal(result.TAMP_PORT, '9999')
    assert.equal(result.TAMP_UPSTREAM, 'http://example.com')
  })

  it('skips comments and blank lines', () => {
    writeFileSync(tmpFile, '# comment\n\nTAMP_PORT=8080\n  # another\n')
    const result = loadConfigFile(tmpFile)
    assert.equal(result.TAMP_PORT, '8080')
    assert.equal(Object.keys(result).length, 1)
  })

  it('handles quoted values', () => {
    writeFileSync(tmpFile, 'TAMP_UPSTREAM="http://example.com"\nTAMP_LOG=\'false\'\n')
    const result = loadConfigFile(tmpFile)
    assert.equal(result.TAMP_UPSTREAM, 'http://example.com')
    assert.equal(result.TAMP_LOG, 'false')
  })

  it('config file values used by loadConfig when TAMP_CONFIG set', () => {
    writeFileSync(tmpFile, 'TAMP_PORT=4444\nTAMP_STAGES=minify,dedup\n')
    const origConfig = process.env.TAMP_CONFIG
    const origStages = process.env.TAMP_STAGES
    const origPreset = process.env.TAMP_COMPRESSION_PRESET
    process.env.TAMP_CONFIG = tmpFile
    delete process.env.TAMP_STAGES
    delete process.env.TAMP_COMPRESSION_PRESET
    try {
      const cfg = loadConfig(process.env)
      assert.equal(cfg.port, 4444)
      assert.deepEqual(cfg.stages, ['minify', 'dedup'])
    } finally {
      if (origConfig !== undefined) process.env.TAMP_CONFIG = origConfig
      else delete process.env.TAMP_CONFIG
      if (origStages !== undefined) process.env.TAMP_STAGES = origStages
      if (origPreset !== undefined) process.env.TAMP_COMPRESSION_PRESET = origPreset
    }
  })

  it('env vars override config file values', () => {
    writeFileSync(tmpFile, 'TAMP_PORT=4444\n')
    const origConfig = process.env.TAMP_CONFIG
    const origPort = process.env.TAMP_PORT
    process.env.TAMP_CONFIG = tmpFile
    process.env.TAMP_PORT = '5555'
    try {
      const cfg = loadConfig(process.env)
      assert.equal(cfg.port, 5555)
    } finally {
      if (origConfig !== undefined) process.env.TAMP_CONFIG = origConfig
      else delete process.env.TAMP_CONFIG
      if (origPort !== undefined) process.env.TAMP_PORT = origPort
      else delete process.env.TAMP_PORT
    }
  })

  // Cleanup
  it('cleanup temp files', () => {
    try { unlinkSync(tmpFile) } catch {}
    try { rmdirSync(tmpDir) } catch {}
  })
})

// ---------------------------------------------------------------------------
// Phase C — TAMP_LEVEL / --level precedence matrix
// ---------------------------------------------------------------------------

describe('loadConfig — level precedence matrix (Phase C)', () => {
  // Swallow stderr writes from loadConfig's invalid-input warnings so the test
  // runner output stays clean. Restored after each case via the helper.
  function withSilencedStderr(fn) {
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = () => true
    try { return fn() } finally { process.stderr.write = orig }
  }

  // Build a clean env with all level-related TAMP_* keys stripped, so no
  // ambient shell state can leak into the matrix.
  function cleanEnv(extra = {}) {
    const env = {}
    return { ...env, ...extra }
  }

  const cases = [
    {
      name: 'TAMP_STAGES beats everything',
      env: { TAMP_STAGES: 'minify' },
      opts: {},
      expectedSource: 'stages-env',
      expectedLevel: null,
      expectedStages: ['minify'],
    },
    {
      name: '--level flag beats TAMP_LEVEL env',
      env: { TAMP_LEVEL: '7' },
      opts: { levelOverride: 3 },
      expectedSource: 'level-flag',
      expectedLevel: 3,
    },
    {
      name: 'TAMP_LEVEL beats TAMP_COMPRESSION_PRESET',
      env: { TAMP_LEVEL: '7', TAMP_COMPRESSION_PRESET: 'aggressive' },
      opts: {},
      expectedSource: 'level-env',
      expectedLevel: 7,
    },
    {
      name: 'TAMP_COMPRESSION_PRESET resolves to preset level (conservative = L4)',
      env: { TAMP_COMPRESSION_PRESET: 'conservative' },
      opts: {},
      expectedSource: 'preset-env',
      expectedLevel: 4,
    },
    {
      name: 'no inputs → default level 5',
      env: {},
      opts: {},
      expectedSource: 'default',
      expectedLevel: DEFAULT_LEVEL,
    },
    {
      name: 'TAMP_STAGES still wins even when --level also set',
      env: { TAMP_STAGES: 'minify' },
      opts: { levelOverride: 9 },
      expectedSource: 'stages-env',
      expectedLevel: null,
      expectedStages: ['minify'],
    },
    {
      name: "--level accepts alias string ('aggressive' = L8)",
      env: {},
      opts: { levelOverride: 'aggressive' },
      expectedSource: 'level-flag',
      expectedLevel: 8,
    },
    {
      name: '--level=99 rejected, falls back to default',
      env: {},
      opts: { levelOverride: 99 },
      expectedSource: 'default',
      expectedLevel: DEFAULT_LEVEL,
    },
    {
      name: 'TAMP_LEVEL=0 rejected, falls back to default',
      env: { TAMP_LEVEL: '0' },
      opts: {},
      expectedSource: 'default',
      expectedLevel: DEFAULT_LEVEL,
    },
  ]

  let pass = 0
  for (const c of cases) {
    it(c.name, () => {
      withSilencedStderr(() => {
        const cfg = loadConfig(cleanEnv(c.env), c.opts)
        assert.equal(cfg.levelSource, c.expectedSource,
          `levelSource mismatch for "${c.name}" — got ${cfg.levelSource}`)
        assert.equal(cfg.level, c.expectedLevel,
          `level mismatch for "${c.name}" — got ${cfg.level}`)
        if (c.expectedStages) {
          assert.deepEqual(cfg.stages, c.expectedStages,
            `stages mismatch for "${c.name}"`)
        } else if (typeof cfg.level === 'number') {
          // Sanity: stages must be non-empty and aligned with the ladder OR
          // with the preset's stage list (since L4/L5/L8 are preset-anchored).
          assert.ok(Array.isArray(cfg.stages) && cfg.stages.length > 0,
            `stages empty for "${c.name}"`)
        }
        pass++
      })
    })
  }

  it(`precedence matrix coverage: ${cases.length} cases executed`, () => {
    assert.equal(pass, cases.length,
      `only ${pass}/${cases.length} precedence cases ran — check for early exits`)
  })

  it('does not leak env state between invocations', () => {
    // Two calls with different envs must not see each other's state.
    const a = loadConfig({ TAMP_LEVEL: '3' })
    const b = loadConfig({})
    assert.equal(a.level, 3)
    assert.equal(a.levelSource, 'level-env')
    assert.equal(b.level, DEFAULT_LEVEL)
    assert.equal(b.levelSource, 'default')
  })

  it('resolves level to a valid stages array for every ladder rung', () => {
    for (let n = 1; n <= 9; n++) {
      const cfg = loadConfig({}, { levelOverride: n })
      assert.equal(cfg.level, n, `level ${n} mismatch`)
      assert.equal(cfg.levelSource, 'level-flag')
      assert.ok(Array.isArray(cfg.stages) && cfg.stages.length > 0,
        `level ${n} produced empty stages`)
      // Set-equality with COMPRESSION_LEVELS[n] (order may differ for
      // preset-anchored levels L4/L5/L8 — use Set compare).
      const expectedSet = new Set(COMPRESSION_LEVELS[n].stages)
      const actualSet = new Set(cfg.stages)
      assert.equal(actualSet.size, expectedSet.size,
        `level ${n} stage count mismatch`)
      for (const s of expectedSet) {
        assert.ok(actualSet.has(s), `level ${n} missing stage ${s}`)
      }
    }
  })

  it('does not crash on prototype-chain keys in TAMP_LEVEL / TAMP_COMPRESSION_PRESET', () => {
    for (const bad of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const a = loadConfig({ TAMP_LEVEL: bad })
      assert.ok(Array.isArray(a.stages) && a.stages.length > 0, `TAMP_LEVEL=${bad} must fall back cleanly`)
      const b = loadConfig({ TAMP_COMPRESSION_PRESET: bad })
      assert.ok(Array.isArray(b.stages) && b.stages.length > 0, `TAMP_COMPRESSION_PRESET=${bad} must fall back cleanly`)
    }
  })

  it('lowercases TAMP_AGENT so per-agent overrides resolve', () => {
    assert.equal(loadConfig({ TAMP_AGENT: 'Codex' }).agent, 'codex')
  })
})

describe('loadConfig — stale eviction & upstreamTimeout non-negative int parsing', () => {
  it('defaults stale eviction and upstreamTimeout settings', () => {
    const cfg = loadConfig({})
    assert.equal(cfg.staleImageKeepRecent, 2)
    assert.equal(cfg.staleInputKeepRecent, 2)
    assert.equal(cfg.staleBatchSize, 1)
    assert.equal(cfg.upstreamTimeout, 0)
  })

  it('honors 0 for TAMP_STALE_IMAGE_KEEP_RECENT and TAMP_STALE_INPUT_KEEP_RECENT', () => {
    const cfg = loadConfig({
      TAMP_STALE_IMAGE_KEEP_RECENT: '0',
      TAMP_STALE_INPUT_KEEP_RECENT: '0',
    })
    assert.equal(cfg.staleImageKeepRecent, 0)
    assert.equal(cfg.staleInputKeepRecent, 0)
  })

  it('parses positive integers and clamps staleBatchSize to >= 1', () => {
    const cfg = loadConfig({
      TAMP_STALE_IMAGE_KEEP_RECENT: '5',
      TAMP_STALE_INPUT_KEEP_RECENT: '3',
      TAMP_STALE_BATCH_SIZE: '4',
      TAMP_UPSTREAM_TIMEOUT: '30000',
    })
    assert.equal(cfg.staleImageKeepRecent, 5)
    assert.equal(cfg.staleInputKeepRecent, 3)
    assert.equal(cfg.staleBatchSize, 4)
    assert.equal(cfg.upstreamTimeout, 30000)

    assert.equal(loadConfig({ TAMP_STALE_BATCH_SIZE: '0' }).staleBatchSize, 1)
  })

  it('falls back to defaults on negative or non-integer values', () => {
    const cfg = loadConfig({
      TAMP_STALE_IMAGE_KEEP_RECENT: '-1',
      TAMP_STALE_INPUT_KEEP_RECENT: 'abc',
      TAMP_STALE_BATCH_SIZE: '2.5',
      TAMP_UPSTREAM_TIMEOUT: '-500',
    })
    assert.equal(cfg.staleImageKeepRecent, 2)
    assert.equal(cfg.staleInputKeepRecent, 2)
    assert.equal(cfg.staleBatchSize, 1)
    assert.equal(cfg.upstreamTimeout, 0)
  })

  it('documents stale eviction env vars in CONFIG_TEMPLATE', () => {
    assert.ok(CONFIG_TEMPLATE.includes('TAMP_STALE_IMAGE_KEEP_RECENT'))
    assert.ok(CONFIG_TEMPLATE.includes('TAMP_STALE_INPUT_KEEP_RECENT'))
    assert.ok(CONFIG_TEMPLATE.includes('TAMP_STALE_BATCH_SIZE'))
  })
})

describe('loadConfig — options.presetOverride precedence & safety', () => {
  function captureStderr(fn) {
    const orig = process.stderr.write
    let out = ''
    process.stderr.write = (s) => { out += s; return true }
    try { return { result: fn(), stderr: out } } finally { process.stderr.write = orig }
  }

  it('resolves every valid presetOverride with accurate preset, level, levelSource, and fresh stages copy', () => {
    const expectedLevels = {
      conservative: 4,
      balanced: 5,
      aggressive: 8,
      recommended: null,
    }
    for (const [name, expectedLevel] of Object.entries(expectedLevels)) {
      const { result: cfg, stderr } = captureStderr(() => loadConfig({}, { presetOverride: name }))
      assert.equal(stderr, '', `no stderr warning expected for valid preset ${name}`)
      assert.equal(cfg.levelSource, 'preset-flag')
      assert.equal(cfg.preset, name)
      assert.equal(cfg.level, expectedLevel)
      assert.deepEqual(cfg.stages, COMPRESSION_PRESETS[name].stages)
      assert.notEqual(cfg.stages, COMPRESSION_PRESETS[name].stages, 'cfg.stages must be a fresh copy')
    }
    const rec = loadConfig({}, { presetOverride: 'recommended' })
    assert.equal(rec.stages.length, 14)
    assert.equal(rec.stages.includes('llmlingua'), false)
  })

  it('enforces full 7-tier precedence: TAMP_STAGES > levelOverride > presetOverride > TAMP_LEVEL > TAMP_COMPRESSION_PRESET > config-file > default', () => {
    // 1. TAMP_STAGES beats presetOverride
    const s1 = loadConfig({ TAMP_STAGES: 'minify' }, { presetOverride: 'recommended' })
    assert.equal(s1.levelSource, 'stages-env')
    assert.equal(s1.level, null)
    assert.deepEqual(s1.stages, ['minify'])

    // 2. levelOverride beats presetOverride
    const s2 = loadConfig({}, { levelOverride: 3, presetOverride: 'recommended' })
    assert.equal(s2.levelSource, 'level-flag')
    assert.equal(s2.level, 3)

    // 3. presetOverride beats TAMP_LEVEL and TAMP_COMPRESSION_PRESET (and overrides cfg.preset)
    const s3 = loadConfig(
      { TAMP_LEVEL: '7', TAMP_COMPRESSION_PRESET: 'conservative' },
      { presetOverride: 'recommended' },
    )
    assert.equal(s3.levelSource, 'preset-flag')
    assert.equal(s3.preset, 'recommended')
    assert.equal(s3.level, null)
    assert.deepEqual(s3.stages, COMPRESSION_PRESETS.recommended.stages)

    // 3b. presetOverride beats config-file `level`
    const tmpDir = join(tmpdir(), 'tamp-preset-cfg-' + Date.now())
    const tmpFile = join(tmpDir, 'config')
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(tmpFile, 'level=7\n')
    const saved = {
      TAMP_CONFIG: process.env.TAMP_CONFIG,
      TAMP_STAGES: process.env.TAMP_STAGES,
      TAMP_LEVEL: process.env.TAMP_LEVEL,
      TAMP_COMPRESSION_PRESET: process.env.TAMP_COMPRESSION_PRESET,
    }
    process.env.TAMP_CONFIG = tmpFile
    delete process.env.TAMP_STAGES
    delete process.env.TAMP_LEVEL
    delete process.env.TAMP_COMPRESSION_PRESET
    try {
      const fromPreset = loadConfig(process.env, { presetOverride: 'conservative' })
      assert.equal(fromPreset.levelSource, 'preset-flag')
      assert.equal(fromPreset.preset, 'conservative')
      assert.equal(fromPreset.level, 4)

      const { result: fallbackToFile, stderr } = captureStderr(() =>
        loadConfig(process.env, { presetOverride: 'bogus' }),
      )
      assert.match(stderr, /--preset/)
      assert.match(stderr, /bogus/)
      assert.equal(fallbackToFile.levelSource, 'config-file')
      assert.equal(fallbackToFile.level, 7)
      assert.equal(fallbackToFile.preset, 'balanced')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      try { unlinkSync(tmpFile) } catch {}
      try { rmdirSync(tmpDir) } catch {}
    }
  })

  it('treats undefined, null, and empty string presetOverride as unset without warning', () => {
    for (const unset of [undefined, null, '']) {
      const { result: cfg, stderr } = captureStderr(() =>
        loadConfig({ TAMP_COMPRESSION_PRESET: 'conservative' }, { presetOverride: unset }),
      )
      assert.equal(stderr, '', `unset presetOverride=${JSON.stringify(unset)} must not warn`)
      assert.equal(cfg.levelSource, 'preset-env')
      assert.equal(cfg.preset, 'conservative')
      assert.equal(cfg.level, 4)
    }
  })

  it('warns and falls through cleanly on invalid, non-string, and prototype-chain presetOverride values', () => {
    const badValues = [
      'bogus',
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      '__proto__',
      123,
      true,
      {},
    ]
    for (const bad of badValues) {
      // Falls through to TAMP_LEVEL
      const r1 = captureStderr(() => loadConfig({ TAMP_LEVEL: '6' }, { presetOverride: bad }))
      assert.match(r1.stderr, /--preset/)
      assert.equal(r1.result.levelSource, 'level-env')
      assert.equal(r1.result.level, 6)
      assert.equal(r1.result.preset, 'balanced')

      // Falls through to TAMP_COMPRESSION_PRESET without clobbering cfg.preset
      const r2 = captureStderr(() =>
        loadConfig({ TAMP_COMPRESSION_PRESET: 'conservative' }, { presetOverride: bad }),
      )
      assert.match(r2.stderr, /--preset/)
      assert.equal(r2.result.levelSource, 'preset-env')
      assert.equal(r2.result.preset, 'conservative')
      assert.equal(r2.result.level, 4)

      // Falls through to default
      const r3 = captureStderr(() => loadConfig({}, { presetOverride: bad }))
      assert.match(r3.stderr, /--preset/)
      assert.equal(r3.result.levelSource, 'default')
      assert.equal(r3.result.level, DEFAULT_LEVEL)
      assert.equal(r3.result.preset, 'balanced')
    }
  })
})
