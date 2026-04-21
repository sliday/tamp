import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, unlinkSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, loadConfigFile } from '../config.js'
import { DEFAULT_STAGES, VERSION, COMPRESSION_LEVELS, DEFAULT_LEVEL } from '../metadata.js'

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
})
