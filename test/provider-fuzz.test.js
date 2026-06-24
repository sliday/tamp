import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { anthropic, openai, openaiResponses, gemini } from '../providers.js'

// Malformed bodies (null array elements, missing fields) must not throw in
// extract(). A throw there bubbles to compressRequest and forces the WHOLE
// request to passthrough uncompressed; graceful skipping preserves compression
// for the valid blocks.
const MALFORMED = [
  null, undefined, {}, { messages: null }, { messages: [] },
  { messages: [null, { role: 'user' }, { role: 'user', content: null }] },
  { messages: [{ role: 'user', content: [null, { type: 'text' }, { type: 'tool_result', content: null }] }] },
  { messages: [{ role: 'user', content: [{ type: 'tool_result', content: [null, {}, { type: 'text', text: null }] }] }] },
  { input: null },
  { input: [null, { type: 'function_call_output' }, { type: 'function_call_output', output: null }] },
  { contents: null },
  { contents: [null, { parts: null }, { parts: [null, { functionResponse: null }] }] },
  { contents: [{ parts: [{ functionResponse: { response: null } }] }] },
]

describe('provider extract() robustness against malformed bodies', () => {
  for (const [name, provider] of Object.entries({ anthropic, openai, openaiResponses, gemini })) {
    it(`${name}.extract never throws on malformed input`, () => {
      for (let i = 0; i < MALFORMED.length; i++) {
        assert.doesNotThrow(() => {
          const targets = provider.extract(MALFORMED[i])
          assert.ok(Array.isArray(targets), `${name}.extract must return an array (body[${i}])`)
        }, `${name}.extract threw on body[${i}]`)
      }
    })
  }
})
