import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decode } from '@toon-format/toon'
import { compressText } from '../compress.js'

// Tamp's `toon` stage is marked LOSSLESS and runs by default (balanced preset).
// The proxy emits TOON straight to the model without a round-trip check, so if
// encode() ever mangled a value (delimiter collisions, type coercion of
// numeric/boolean-looking strings, special keys, nesting), tamp would silently
// corrupt tool-result content — a core-promise violation.
//
// This guardrail asserts that whatever compressText emits for JSON input is
// FAITHFUL: a `toon` result must decode back to the original; a `minify`
// result must JSON.parse back to the original. Adversarial shapes included.
const config = { minSize: 10, stages: ['minify', 'toon'], llmLinguaUrl: null, log: false }

const CASES = {
  'comma in strings': [
    { id: 1, note: 'hello, world', tag: 'a,b,c' },
    { id: 2, note: 'plain', tag: 'x' },
    { id: 3, note: 'one, two, three', tag: 'y,z' },
  ],
  'newline + quote in strings': [
    { id: 1, s: 'line1\nline2', q: 'she said "hi"' },
    { id: 2, s: 'single', q: 'none' },
  ],
  'numeric-looking strings stay strings': [
    { id: 1, code: '007', zip: '01234' },
    { id: 2, code: '42', zip: '99999' },
  ],
  'boolean-looking strings stay strings': [
    { id: 1, flag: 'true', other: 'false' },
    { id: 2, flag: 'maybe', other: 'no' },
  ],
  'null and boolean values': [
    { id: 1, x: null, y: true },
    { id: 2, x: 5, y: false },
  ],
  'nested objects': [
    { id: 1, meta: { k: 'v', n: 3 } },
    { id: 2, meta: { k: 'w', n: 4 } },
  ],
  'arrays of arrays': [
    { id: 1, xs: [1, 2, 3] },
    { id: 2, xs: [] },
  ],
  'unicode and emoji': [
    { id: 1, s: 'héllo 🚀 日本語' },
    { id: 2, s: 'café' },
  ],
  'string that looks like TOON syntax': [
    { id: 1, s: 'a[2]{x,y}:' },
    { id: 2, s: 'normal value' },
  ],
  'ragged keys across rows': [
    { id: 1, a: 1 },
    { id: 2, b: 2 },
  ],
}

describe('toon stage — emitted output is always faithful to the original', () => {
  for (const [name, value] of Object.entries(CASES)) {
    it(`${name}: round-trips losslessly`, () => {
      // Pretty-print so minify shrinks the body and the toon stage actually
      // competes (compressText returns null for already-minified input).
      const original = JSON.stringify(value, null, 2)
      const result = compressText(original, config)
      assert.ok(result, `compressText should compress pretty-printed JSON for "${name}"`)

      let recovered
      if (result.method === 'toon') {
        recovered = decode(result.text)
      } else {
        // minify (or any JSON-preserving method) must parse back exactly
        recovered = JSON.parse(result.text)
      }
      assert.deepStrictEqual(
        recovered,
        value,
        `${result.method} output for "${name}" lost or altered data`
      )
    })
  }
})
