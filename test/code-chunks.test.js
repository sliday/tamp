import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { languageForPath, sniffLanguage, detectBlocks, buildStructure, indentWidth } from '../lib/code-chunks.js'

const JS_BODY = `import fs from 'node:fs'

export function parseConfig(opts) {
  const merged = { ...defaults, ...opts }
  if (merged.strict) {
    validate(merged)
  }
  return merged
}

class ConfigStore {
  read(key) {
    return this.map.get(key)
  }
}
`

const PY_BODY = `import os

def parse_config(opts):
    merged = dict(opts)
    if merged.get("strict"):
        validate(merged)
    return merged

class ConfigStore:
    def read(self, key):
        return self.map[key]
`

describe('code-chunks — language selection', () => {
  it('maps extensions to detectors', () => {
    assert.equal(languageForPath('/src/a.ts'), 'brace')
    assert.equal(languageForPath('/src/a.go'), 'brace')
    assert.equal(languageForPath('/src/a.py'), 'indent')
    assert.equal(languageForPath('/src/a.yaml'), 'indent')
    assert.equal(languageForPath('/var/log/app.log'), null)
    assert.equal(languageForPath('Makefile'), null)
    assert.equal(languageForPath(null), null)
  })

  it('sniffs braces and indentation when no path is available', () => {
    // Padded past the 10-line floor sniffLanguage requires.
    const js = (JS_BODY + '\nconst pad = 1\n'.repeat(10)).split('\n')
    assert.equal(sniffLanguage(js), 'brace')

    const py = (PY_BODY + '\nPAD = 1\n'.repeat(10)).split('\n')
    assert.equal(sniffLanguage(py), 'indent')
  })

  it('returns null on prose and short bodies', () => {
    const log = Array.from({ length: 40 }, (_, i) => `INFO heartbeat ${i} status=200`)
    assert.equal(sniffLanguage(log), null)
    assert.equal(sniffLanguage(['a', 'b']), null)
    assert.equal(sniffLanguage(null), null)
  })
})

describe('code-chunks — brace detector', () => {
  it('finds nested block ranges with header and closer', () => {
    const lines = JS_BODY.split('\n')
    const blocks = detectBlocks(lines, { path: 'x.js' })
    assert.ok(Array.isArray(blocks), 'expected blocks')

    // `export function parseConfig(opts) {` is line index 2, closing `}` at 8.
    const fn = blocks.find(b => b.headerLine === 2)
    assert.ok(fn, `no block for parseConfig: ${JSON.stringify(blocks)}`)
    assert.equal(fn.closeLine, 8)
    assert.equal(fn.startLine, 3)
    assert.equal(fn.endLine, 7)

    // The nested `if (merged.strict) {` block is also found.
    assert.ok(blocks.some(b => b.headerLine === 4 && b.closeLine === 6), 'nested if block missing')
  })

  it('ignores braces inside strings and comments', () => {
    const lines = [
      'function f() {',
      '  const s = "} not a real close {"',
      "  const t = '{'",
      '  // } neither is this',
      '  /* nor',
      '     } this */',
      '  return s + t',
      '}',
    ]
    const blocks = detectBlocks(lines, { path: 'x.js' })
    assert.ok(blocks, 'braces should balance after noise stripping')
    assert.ok(blocks.some(b => b.headerLine === 0 && b.closeLine === 7), `got ${JSON.stringify(blocks)}`)
  })

  it('returns null when braces do not balance', () => {
    assert.equal(detectBlocks(['function f() {', '  return 1'], { path: 'x.js' }), null)
    assert.equal(detectBlocks(['}', 'const x = 1'], { path: 'x.js' }), null)
  })

  it('skips same-line and empty-body braces', () => {
    const lines = ['const o = { a: 1 }', 'call({ b: 2 })', 'function g() {', '}']
    const blocks = detectBlocks(lines, { path: 'x.js' })
    assert.deepEqual(blocks, [], `expected no blocks, got ${JSON.stringify(blocks)}`)
  })
})

describe('code-chunks — indent detector', () => {
  it('finds def and class bodies by indentation', () => {
    const lines = PY_BODY.split('\n')
    const blocks = detectBlocks(lines, { path: 'x.py' })
    assert.ok(blocks, 'expected blocks')

    const fn = blocks.find(b => b.headerLine === 2) // def parse_config(opts):
    assert.ok(fn, `no block for parse_config: ${JSON.stringify(blocks)}`)
    assert.equal(fn.startLine, 3)
    assert.equal(fn.endLine, 6) // through `return merged`
    assert.equal(fn.closeLine, null) // indent blocks have no closing token
  })

  it('does not let blank lines close a block', () => {
    const lines = ['def f():', '    a = 1', '', '    b = 2', 'x = 3']
    const blocks = detectBlocks(lines, { path: 'x.py' })
    const fn = blocks.find(b => b.headerLine === 0)
    assert.equal(fn.endLine, 3, 'blank line should not terminate the body')
  })
})

describe('code-chunks — buildStructure', () => {
  it('maps each line to its innermost enclosing header', () => {
    const lines = JS_BODY.split('\n')
    const { parent, closer } = buildStructure(lines, detectBlocks(lines, { path: 'x.js' }))

    // `validate(merged)` (line 5) sits inside the `if` (4), not the function (2).
    assert.equal(parent[5], 4)
    // `return merged` (line 7) sits directly inside the function.
    assert.equal(parent[7], 2)
    // The `if` header itself is parented by the function.
    assert.equal(parent[4], 2)
    // Top-level import has no parent.
    assert.equal(parent[0], -1)

    assert.equal(closer[2], 8)
    assert.equal(closer[4], 6)
  })

  it('returns empty maps when there are no blocks', () => {
    const lines = ['a', 'b', 'c']
    const { parent, closer } = buildStructure(lines, null)
    assert.equal(parent.length, 3)
    for (let i = 0; i < 3; i++) {
      assert.equal(parent[i], -1)
      assert.equal(closer[i], -1)
    }
  })
})

describe('code-chunks — indentWidth', () => {
  it('counts leading spaces and tabs', () => {
    assert.equal(indentWidth('    x'), 4)
    assert.equal(indentWidth('\t\tx'), 2)
    assert.equal(indentWidth('x'), 0)
    assert.equal(indentWidth(''), 0)
    assert.equal(indentWidth(null), 0)
  })
})
