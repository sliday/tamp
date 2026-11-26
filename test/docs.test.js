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

  it('keeps setup.sh and site/setup.sh byte-identical with accurate install and env guidance', () => {
    const rootSetup = read('./../setup.sh')
    const siteSetup = read('./../site/setup.sh')
    assert.equal(rootSetup, siteSetup)
    assert.ok(rootSetup.includes('add_var "ANTHROPIC_BASE_URL" "http://localhost:$PORT"'))
    assert.ok(rootSetup.includes('add_var "OPENAI_API_BASE" "http://localhost:$PORT/v1"'))
    assert.ok(rootSetup.includes('npm install -g @sliday/tamp@latest'))
    assert.ok(!rootSetup.includes('npm update -g'))
    assert.ok(rootSetup.includes('~/.claude/settings.json'))
    assert.ok(!rootSetup.includes('skip all this'))
  })

  it('documents valid CLI invocation and /v1 OPENAI_API_BASE in site/index.md', () => {
    const md = read('./../site/index.md')
    assert.ok(!md.includes('tamp start'))
    assert.ok(md.includes('OPENAI_API_BASE="http://localhost:7778/v1"'))
  })

  it('keeps site/index.html WebMCP preset enum and Compression Presets synced', () => {
    const html = read('./../site/index.html')
    const toolMatch = html.match(/name:\s*'get_config_example'[\s\S]*?enum:\s*\[([^\]]+)\]/)
    assert.ok(toolMatch, 'get_config_example WebMCP schema enum not found')
    assert.ok(toolMatch[1].includes("'recommended'"))
    assert.ok(html.includes('20 stage names'))
    assert.ok(!html.includes('10 stage names'))
    const presetsIdx = html.indexOf('Compression Presets')
    assert.ok(presetsIdx !== -1, 'Compression Presets section not found')
    const presetsSection = html.slice(presetsIdx, presetsIdx + 4000)
    assert.ok(presetsSection.includes('TAMP_COMPRESSION_PRESET=recommended'))
    assert.ok(presetsSection.includes('TAMP_MIN_SIZE=1024'))
    assert.ok(presetsSection.includes('63–80%'))
  })
})
