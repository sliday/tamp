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

  it('overrides port from TOONA_PORT', () => {
    const cfg = loadConfig({ TOONA_PORT: '9999' })
    assert.equal(cfg.port, 9999)
  })

  it('overrides upstream from TOONA_UPSTREAM', () => {
    const cfg = loadConfig({ TOONA_UPSTREAM: 'http://localhost:3000' })
    assert.equal(cfg.upstream, 'http://localhost:3000')
  })

  it('parses TOONA_STAGES as comma-separated array', () => {
    const cfg = loadConfig({ TOONA_STAGES: 'minify,toon,llmlingua' })
    assert.deepEqual(cfg.stages, ['minify', 'toon', 'llmlingua'])
  })

  it('trims whitespace in TOONA_STAGES', () => {
    const cfg = loadConfig({ TOONA_STAGES: ' minify , toon ' })
    assert.deepEqual(cfg.stages, ['minify', 'toon'])
  })

  it('overrides minSize from TOONA_MIN_SIZE', () => {
    const cfg = loadConfig({ TOONA_MIN_SIZE: '500' })
    assert.equal(cfg.minSize, 500)
  })

  it('sets log to false when TOONA_LOG=false', () => {
    const cfg = loadConfig({ TOONA_LOG: 'false' })
    assert.equal(cfg.log, false)
  })

  it('overrides maxBody from TOONA_MAX_BODY', () => {
    const cfg = loadConfig({ TOONA_MAX_BODY: '2097152' })
    assert.equal(cfg.maxBody, 2_097_152)
  })

  it('sets llmLinguaUrl from TOONA_LLMLINGUA_URL', () => {
    const cfg = loadConfig({ TOONA_LLMLINGUA_URL: 'http://localhost:8788' })
    assert.equal(cfg.llmLinguaUrl, 'http://localhost:8788')
  })

  it('sets logFile from TOONA_LOG_FILE', () => {
    const cfg = loadConfig({ TOONA_LOG_FILE: '/tmp/toona.log' })
    assert.equal(cfg.logFile, '/tmp/toona.log')
  })

  it('falls back to defaults for invalid numeric env vars', () => {
    const cfg = loadConfig({ TOONA_PORT: 'abc', TOONA_MIN_SIZE: '', TOONA_MAX_BODY: 'xyz' })
    assert.equal(cfg.port, 7778)
    assert.equal(cfg.minSize, 200)
    assert.equal(cfg.maxBody, 10_485_760)
  })

  it('returns frozen object', () => {
    const cfg = loadConfig({})
    assert.throws(() => { cfg.port = 1234 }, TypeError)
  })
})
