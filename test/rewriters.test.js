import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  PRIORITY,
  getRewriter,
  rewriteCommandOutput,
} from '../lib/rewriters/index.js'
import { detectCommandOutput } from '../detect.js'
import { compressText } from '../compress.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(__dirname, 'fixtures/rewriters')

const REWRITERS = [
  'npm',
  'pip',
  'cargo',
  'docker',
  'prisma',
  'terraform',
  'git',
  'pytest',
  'jest',
  'wget-curl',
]

function readFixture(name, kind) {
  return readFileSync(resolve(FIXTURES, `${name}.${kind}.txt`), 'utf8')
}

// rewriteCommandOutput reports savedBytes in UTF-8 bytes, which diverges from
// string .length when the fixture contains multi-byte glyphs (emoji, box chars).
function utf8Delta(a, b) {
  return Buffer.byteLength(a, 'utf8') - Buffer.byteLength(b, 'utf8')
}

describe('rewriteCommandOutput — fixture roundtrip', () => {
  for (const name of REWRITERS) {
    it(`rewrites ${name} output byte-for-byte`, () => {
      const input = readFixture(name, 'in')
      const expected = readFixture(name, 'out')
      const result = rewriteCommandOutput(input)
      assert.equal(result.rewriter, name, `rewriter should match fixture name for ${name}`)
      assert.equal(result.text, expected, `byte-for-byte output mismatch for ${name}`)
      assert.equal(
        result.savedBytes,
        utf8Delta(input, expected),
        `savedBytes should equal the UTF-8 byte delta for ${name}`
      )
      assert.ok(result.savedBytes > 0, `${name} rewriter should save bytes`)
    })
  }
})

describe('rewriteCommandOutput — no-op safety', () => {
  const NON_MATCHING = [
    {
      label: 'plain English paragraph',
      text: 'The quick brown fox jumps over the lazy dog. This is a perfectly ordinary sentence with no command output in it whatsoever.',
    },
    {
      label: 'JSON object',
      text: JSON.stringify({
        name: 'tamp',
        version: '0.6.0',
        dependencies: { diff: '^8.0.4', ink: '^5.2.0' },
      }, null, 2),
    },
    {
      label: 'JavaScript stack trace',
      text: [
        'TypeError: Cannot read properties of undefined (reading \'foo\')',
        '    at Object.<anonymous> (/tmp/app.js:12:34)',
        '    at Module._compile (node:internal/modules/cjs/loader:1256:14)',
        '    at Module._extensions..js (node:internal/modules/cjs/loader:1310:10)',
      ].join('\n'),
    },
    {
      label: 'ls -l listing',
      text: [
        'total 32',
        '-rw-r--r--  1 stas  staff   1234 Apr 20 10:00 README.md',
        '-rw-r--r--  1 stas  staff    512 Apr 20 10:01 package.json',
        'drwxr-xr-x  5 stas  staff    160 Apr 20 10:02 src',
      ].join('\n'),
    },
  ]

  for (const { label, text } of NON_MATCHING) {
    it(`returns null rewriter for ${label}`, () => {
      const result = rewriteCommandOutput(text)
      assert.equal(result.rewriter, null)
      assert.equal(result.text, text)
      assert.equal(result.savedBytes, 0)
    })
  }

  it('returns null rewriter for empty string', () => {
    const result = rewriteCommandOutput('')
    assert.equal(result.rewriter, null)
    assert.equal(result.savedBytes, 0)
  })
})

describe('PRIORITY ordering', () => {
  it('matches the frozen spec order', () => {
    assert.deepEqual([...PRIORITY], [
      'npm',
      'pip',
      'cargo',
      'docker',
      'prisma',
      'terraform',
      'git',
      'pytest',
      'jest',
      'wget-curl',
    ])
  })

  it('contains exactly the 10 known rewriters', () => {
    assert.equal(PRIORITY.length, REWRITERS.length)
  })
})

describe('getRewriter contract', () => {
  it('returns a rewriter with match/rewrite functions for known names', () => {
    for (const name of REWRITERS) {
      const mod = getRewriter(name)
      assert.ok(mod, `getRewriter('${name}') must return a module`)
      assert.equal(typeof mod.match, 'function', `${name}.match must be a function`)
      assert.equal(typeof mod.rewrite, 'function', `${name}.rewrite must be a function`)
    }
  })

  it('returns null for unknown name', () => {
    assert.equal(getRewriter('unknown'), null)
  })

  it('returns null for empty/undefined name', () => {
    assert.equal(getRewriter(''), null)
    assert.equal(getRewriter(null), null)
    assert.equal(getRewriter(undefined), null)
  })
})

describe('cmd-strip stage integration (compressText)', () => {
  it('surfaces cmd-strip:<rewriter> method on a git fixture', () => {
    const input = readFixture('git', 'in')
    const config = { minSize: 1, stages: ['cmd-strip'], log: false }
    const result = compressText(input, config)
    assert.ok(result, 'compressText should return a result for noisy git output')
    assert.ok(
      typeof result.method === 'string' && result.method.startsWith('cmd-strip:'),
      `expected method to start with "cmd-strip:", got "${result.method}"`
    )
    assert.equal(result.method, 'cmd-strip:git')
    assert.ok(result.compressedLen < result.originalLen, 'compressed output should be shorter than original')
  })
})

describe('detectCommandOutput', () => {
  it('identifies the git rewriter for the git fixture', () => {
    const input = readFixture('git', 'in')
    assert.equal(detectCommandOutput(input), 'git')
  })

  it('identifies each rewriter from its own fixture input', () => {
    for (const name of REWRITERS) {
      const input = readFixture(name, 'in')
      assert.equal(detectCommandOutput(input), name, `detectCommandOutput should return '${name}' for its own fixture`)
    }
  })

  it('returns null for plain text', () => {
    assert.equal(detectCommandOutput('just a regular English sentence with no command output'), null)
  })

  it('returns null for non-string input', () => {
    assert.equal(detectCommandOutput(null), null)
    assert.equal(detectCommandOutput(undefined), null)
    assert.equal(detectCommandOutput(42), null)
  })
})
