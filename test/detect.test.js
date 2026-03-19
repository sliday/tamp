import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tryParseJSON, isTOON, classifyContent, stripLineNumbers } from '../detect.js'

describe('tryParseJSON', () => {
  it('parses valid JSON object', () => {
    const r = tryParseJSON('{"a":1}')
    assert.equal(r.ok, true)
    assert.deepEqual(r.value, { a: 1 })
  })

  it('parses valid JSON array', () => {
    const r = tryParseJSON('[1,2,3]')
    assert.equal(r.ok, true)
    assert.deepEqual(r.value, [1, 2, 3])
  })

  it('parses pretty-printed JSON', () => {
    const r = tryParseJSON('{\n  "key": "val"\n}')
    assert.equal(r.ok, true)
  })

  it('rejects Python dict repr', () => {
    assert.equal(tryParseJSON("{'key': 'val'}").ok, false)
  })

  it('rejects truncated JSON', () => {
    assert.equal(tryParseJSON('{"key": "val"').ok, false)
  })

  it('rejects empty string', () => {
    assert.equal(tryParseJSON('').ok, false)
  })

  it('rejects non-string input', () => {
    assert.equal(tryParseJSON(42).ok, false)
    assert.equal(tryParseJSON(null).ok, false)
    assert.equal(tryParseJSON(undefined).ok, false)
  })
})

describe('isTOON', () => {
  it('detects header pattern with braces', () => {
    assert.equal(isTOON('items[3]{sku,qty,price}:\nA1,5,9.99'), true)
  })

  it('detects header pattern with colon', () => {
    assert.equal(isTOON('rows[10]:\nfoo,bar'), true)
  })

  it('detects [TOON] prefix', () => {
    assert.equal(isTOON('[TOON] some data'), true)
  })

  it('rejects regular JSON', () => {
    assert.equal(isTOON('{"a":1}'), false)
  })

  it('rejects plain text', () => {
    assert.equal(isTOON('hello world'), false)
  })

  it('rejects non-string', () => {
    assert.equal(isTOON(123), false)
  })
})

describe('classifyContent', () => {
  it('classifies valid JSON as json', () => {
    assert.equal(classifyContent('{"a":1}'), 'json')
  })

  it('classifies TOON as toon', () => {
    assert.equal(classifyContent('items[3]{sku,qty}:\nA,1'), 'toon')
  })

  it('classifies markdown as text', () => {
    assert.equal(classifyContent('# Hello\nThis is markdown'), 'text')
  })

  it('classifies code as text', () => {
    assert.equal(classifyContent('function foo() { return 1 }'), 'text')
  })

  it('classifies non-string as unknown', () => {
    assert.equal(classifyContent(null), 'unknown')
  })

  it('classifies line-numbered JSON as json-lined', () => {
    const input = '     1\t{\n     2\t  "name": "tamp",\n     3\t  "version": "0.1.0"\n     4\t}'
    assert.equal(classifyContent(input), 'json-lined')
  })

  it('classifies line-numbered JSON with arrow separator as json-lined', () => {
    const input = '     1→{\n     2→  "name": "tamp",\n     3→  "version": "0.1.0"\n     4→}'
    assert.equal(classifyContent(input), 'json-lined')
  })

  it('does not misclassify numbered list as json-lined', () => {
    const input = '1. First item\n2. Second item\n3. Third item'
    assert.equal(classifyContent(input), 'text')
  })
})

describe('stripLineNumbers', () => {
  it('strips tab-separated line numbers', () => {
    const input = '     1\t{\n     2\t  "a": 1\n     3\t}'
    assert.equal(stripLineNumbers(input), '{\n  "a": 1\n}')
  })

  it('strips arrow-separated line numbers', () => {
    const input = '     1→{\n     2→  "a": 1\n     3→}'
    assert.equal(stripLineNumbers(input), '{\n  "a": 1\n}')
  })

  it('returns original if no line numbers detected', () => {
    const input = 'just regular text\nwith newlines'
    assert.equal(stripLineNumbers(input), input)
  })

  it('returns non-string input unchanged', () => {
    assert.equal(stripLineNumbers(42), 42)
  })
})
