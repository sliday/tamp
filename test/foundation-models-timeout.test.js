import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compressRequest } from '../compress.js'
import { anthropic } from '../providers.js'

// config.foundationModelsTimeout (TAMP_FOUNDATION_MODELS_TIMEOUT) must actually
// bound the apfel subprocess. Without it, a hung apfel hangs the request
// forever. Here a fake apfel sleeps far longer than the timeout; compressRequest
// must give up quickly and fall back (block left uncompressed).
describe('foundation-models subprocess timeout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tamp-fm-timeout-'))
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('aborts a hung apfel within the configured timeout', async () => {
    const fakeApfel = join(dir, 'apfel-sleep.sh')
    writeFileSync(fakeApfel, '#!/bin/sh\nsleep 8\n')
    chmodSync(fakeApfel, 0o755)

    // Incompressible text so it bypasses earlier stages and reaches the
    // foundation-models async branch.
    const text = Array.from({ length: 40 }, (_, i) => `tok${i}_${(i * 7919) % 9973}`).join(' ')
    const body = {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] }],
    }
    const config = {
      stages: ['foundation-models'],
      minSize: 50,
      foundationModelsPath: fakeApfel,
      foundationModelsTimeout: 300,
      foundationModelsSystemPrompt: 'compress',
      log: false,
    }

    const start = Date.now()
    const { body: out } = await compressRequest(body, config, anthropic)
    const elapsed = Date.now() - start

    assert.ok(elapsed < 3000, `compressRequest took ${elapsed}ms — timeout not enforced`)
    // Fallback: the block is left as the original text (not compressed).
    assert.equal(out.messages[0].content[0].content, text)
  })
})
