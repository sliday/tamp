import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { gemini } from '../providers.js'

// Gemini's functionResponse.response must be a JSON object (Struct). When the
// original response was an object, a compressed form that is NOT valid JSON
// (e.g. TOON output) must NOT be written back as a string — that produces an
// invalid request the Gemini API rejects with 400. Keep the original object.
describe('gemini.apply — object functionResponse integrity', () => {
  function bodyWithObjectResponse() {
    return {
      contents: [{
        role: 'user',
        parts: [{ functionResponse: { name: 'get_rows', response: { rows: [{ id: 1 }, { id: 2 }] } } }],
      }],
    }
  }

  it('does not replace an object response with a non-JSON (TOON) string', () => {
    const body = bodyWithObjectResponse()
    const targets = [{
      path: ['contents', 0, 'parts', 0, 'functionResponse', 'response'],
      compressed: 'rows[2]{id}:\n  1\n  2', // TOON-ish, not valid JSON
      wasObject: true,
      index: 0,
    }]
    gemini.apply(body, targets)
    const resp = body.contents[0].parts[0].functionResponse.response
    assert.equal(typeof resp, 'object', 'response must stay an object, not become a string')
    assert.deepEqual(resp, { rows: [{ id: 1 }, { id: 2 }] }, 'original object preserved when compression is not JSON')
  })

  it('still applies a valid-JSON compressed object response', () => {
    const body = bodyWithObjectResponse()
    const targets = [{
      path: ['contents', 0, 'parts', 0, 'functionResponse', 'response'],
      compressed: '{"rows":[{"id":1},{"id":2}]}', // minified valid JSON
      wasObject: true,
      index: 0,
    }]
    gemini.apply(body, targets)
    const resp = body.contents[0].parts[0].functionResponse.response
    assert.deepEqual(resp, { rows: [{ id: 1 }, { id: 2 }] })
  })

  it('still compresses string responses to a string', () => {
    const body = {
      contents: [{ role: 'user', parts: [{ functionResponse: { name: 'f', response: 'plain string output' } }] }],
    }
    const targets = [{
      path: ['contents', 0, 'parts', 0, 'functionResponse', 'response'],
      compressed: 'shorter',
      wasObject: false,
      index: 0,
    }]
    gemini.apply(body, targets)
    assert.equal(body.contents[0].parts[0].functionResponse.response, 'shorter')
  })
})
