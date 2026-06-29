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
  // Truthy-but-non-array containers: have a .length but no .flatMap, so they
  // slip past a `!body?.messages?.length` guard and throw on .flatMap unless
  // the guard is an explicit Array.isArray check (openaiResponses already is).
  { messages: 'not-an-array' },
  { messages: { length: 2 } },
  { contents: 'not-an-array' },
  { contents: { length: 2 } },
  { input: 'not-an-array' },
  { input: { length: 2 } },
  // Null elements at the tail of an otherwise-valid trailing group. The
  // cacheSafe path walks backwards over the tail group and must tolerate a
  // null element instead of dereferencing it (msg.role / item.type).
  { messages: [null, { role: 'tool', content: 'x' }] },
  { messages: [{ role: 'tool', content: 'x' }, null] },
  { input: [null, { type: 'function_call_output', output: 'x' }] },
  { input: [{ type: 'function_call_output', output: 'x' }, null] },
]

// cacheSafe defaults to true in production (compress.js passes
// `cacheSafe: config.cacheSafe !== false`), so both paths must be fuzzed.
const CONFIGS = [{}, { cacheSafe: true }, { cacheSafe: false }]

describe('provider extract() robustness against malformed bodies', () => {
  for (const [name, provider] of Object.entries({ anthropic, openai, openaiResponses, gemini })) {
    it(`${name}.extract never throws on malformed input`, () => {
      for (let i = 0; i < MALFORMED.length; i++) {
        for (const config of CONFIGS) {
          assert.doesNotThrow(() => {
            const targets = provider.extract(MALFORMED[i], config)
            assert.ok(Array.isArray(targets), `${name}.extract must return an array (body[${i}])`)
          }, `${name}.extract threw on body[${i}] with config ${JSON.stringify(config)}`)
        }
      }
    })
  }
})
