import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function read(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

describe('docs and helper scripts', () => {
  it('uses OPENAI_API_BASE consistently in user-facing shell guidance', () => {
    assert.ok(read('./../README.md').includes('OPENAI_API_BASE='))
    assert.ok(read('./../bin/tamp.js').includes('OPENAI_API_BASE='))
    assert.ok(read('./../bin/ui/Banner.js').includes('OPENAI_API_BASE='))
    assert.ok(!read('./../README.md').includes('OPENAI_BASE_URL='))
  })

  it('suggests binding the llmlingua sidecar to localhost, not all interfaces', () => {
    // The sidecar is a local-only helper (tamp's SSRF guard only connects to
    // localhost). Suggesting --host 0.0.0.0 would expose it to the LAN.
    const sources = ['./../index.js', './../README.md', './../bin/tamp.js']
    for (const src of sources) {
      const text = read(src)
      if (text.includes('uvicorn')) {
        assert.ok(
          !text.includes('--host 0.0.0.0') && !text.includes("'0.0.0.0'"),
          `${src} must not bind the sidecar to 0.0.0.0`
        )
      }
    }
  })

  it('keeps test-live.sh on current TAMP naming and repo-relative paths', () => {
    const script = read('./../test-live.sh')
    assert.ok(!script.includes('TOONA_'))
    assert.ok(!script.includes('/Users/stas/Playground/tamp'))
    assert.ok(script.includes('ROOT_DIR='))
  })
})
