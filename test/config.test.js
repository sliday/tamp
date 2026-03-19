import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../config.js'

describe('loadConfig', () => {
  it('returns defaults when no env vars set', () => {
    const cfg = loadConfig({})
    assert.equal(cfg.port, 7778)
    assert.equal(cfg.upstream, 'https://api.anthropic.com')
    assert.deepEqual(cfg.stages, ['minify'])
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
