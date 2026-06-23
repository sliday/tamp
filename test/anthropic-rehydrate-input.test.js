import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rehydrateReferences } from '../lib/disclosure.js'
import { anthropic } from '../providers.js'
import { createBrCache } from '../lib/br-cache.js'

// A tool_use.input must stay a JSON object. When a disclosure marker sits in an
// input field and its expansion contains newlines/quotes, naive string-level
// rehydration produces invalid JSON. The apply step must not then write the
// whole input back as a string (Anthropic rejects a non-object tool_use.input).
describe('anthropic rehydration — tool_use.input stays an object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tamp-rehydrate-input-'))
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('does not corrupt input to a string when the expansion breaks JSON', () => {
    const cache = createBrCache({ cacheDir: dir, minSize: 1024 })
    // Full text with a quote + plenty of bytes so the expansion (which also adds
    // newlines around it) is not valid inside a JSON string value.
    const fullText = 'line one "quoted"\n' + 'x'.repeat(2048) + '\nlast line'
    const put = cache.put(fullText)
    assert.ok(put)
    const marker = `<tamp-ref:v1:${put.hash}:${Buffer.byteLength(fullText, 'utf8')}>`

    const body = {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'edit', input: { note: `prior output: ${marker}` } },
          ],
        },
      ],
    }

    rehydrateReferences(body, anthropic, cache)

    const input = body.messages[1].content[0].input
    assert.equal(typeof input, 'object', 'tool_use.input must remain an object, not a string')
    assert.notEqual(input, null)
    // Whatever happened, the request must still serialize to a valid object input.
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(body)))
  })
})
