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
  stripAnsi,
} from '../lib/rewriters/index.js'
import { detectCommandOutput } from '../detect.js'
import { compressText } from '../compress.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(__dirname, 'fixtures/rewriters')

const FIXTURE_REWRITERS = [
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

const ALL_REWRITERS = [
  'npm',
  'pnpm-bun',
  'pip',
  'cargo',
  'docker',
  'prisma',
  'terraform',
  'git',
  'pytest',
  'vitest',
  'go-test',
  'node-test',
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
  for (const name of FIXTURE_REWRITERS) {
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

  it('npm rewriter keeps child-tool lines with a non-leading braille glyph', () => {
    // A leading-spinner line is still dropped (that's real progress noise); the
    // bug was dropping lines where a glyph appears mid-line, e.g. child output.
    const npm = getRewriter('npm')
    const input = 'npm run build\n[vite] build ⠋ 2 warnings and 1 error found\nadded 3 packages in 1s'
    assert.equal(npm.match(input), true)
    const out = npm.rewrite(input)
    assert.ok(out.includes('2 warnings and 1 error found'), 'must not drop the warn/error line')
  })
})

describe('PRIORITY ordering', () => {
  it('matches the frozen spec order', () => {
    assert.deepEqual([...PRIORITY], ALL_REWRITERS)
  })

  it('contains exactly the 14 known rewriters', () => {
    assert.equal(PRIORITY.length, ALL_REWRITERS.length)
  })
})

describe('getRewriter contract', () => {
  it('returns a rewriter with match/rewrite functions for known names', () => {
    for (const name of ALL_REWRITERS) {
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
    for (const name of FIXTURE_REWRITERS) {
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

describe('rewriters — never strip failure/error context', () => {
  it('docker: keeps a RUN-step error line that ends in a duration', () => {
    const input = [
      '#5 [2/7] RUN apt-get update 0.3s',          // benign in-progress heading — should be stripped
      '#8 [5/7] RUN make',
      '#8 45.2 make: *** [all] build failed in 2.3s', // real error ending in a duration — must be kept
      '#8 DONE 50.1s',
    ].join('\n')
    const { text, rewriter } = rewriteCommandOutput(input)
    assert.equal(rewriter, 'docker')
    assert.ok(text.includes('build failed in 2.3s'), 'error line ending in a duration must be preserved')
    assert.ok(!text.includes('apt-get update 0.3s'), 'benign in-progress heading should still be stripped')
  })

  it('docker: keeps a RUN-step success stdout line that ends in a duration', () => {
    const input = [
      '#5 [2/7] RUN apt-get update 0.3s',     // BuildKit step frame ([x/y]) — should be stripped
      '#8 [5/7] RUN yarn build',
      '#8 2.456 webpack compiled in 2.5s',    // RUN stdout (timestamp prefix, no [x/y]) — must be kept
      '#8 DONE 12.3s',
    ].join('\n')
    const { text, rewriter } = rewriteCommandOutput(input)
    assert.equal(rewriter, 'docker')
    assert.ok(text.includes('webpack compiled in 2.5s'), 'RUN stdout ending in a duration must be preserved')
    assert.ok(!text.includes('apt-get update 0.3s'), 'BuildKit [x/y] step frame should still be stripped')
  })

  it('jest: does not strip PASS lines when a non-first FAIL line is present', () => {
    const input = [
      'PASS src/a.test.ts',
      'FAIL src/b.test.ts',
      '  ● Test suite failed to run',
      '    Cannot find module \'./missing\'',
      'Test Suites: 1 failed, 1 passed, 2 total',
      'Tests:       3 passed, 3 total',
    ].join('\n')
    const { text, rewriter } = rewriteCommandOutput(input)
    assert.equal(rewriter, 'jest')
    // The run failed (a suite failed to compile), so the all-pass gate must not
    // fire — PASS lines stay, preserving full context.
    assert.equal(text, input, 'a failing run must pass through untouched')
  })

  it('pytest: keeps traceback/assertion lines that end in an ellipsis', () => {
    const input = [
      '============================= test session starts ==============================',
      'collected 1 item',
      'tests/foo.py F                                                          [100%]',
      '=================================== FAILURES ===================================',
      '    def test_compute():',
      '>       assert compute(huge_input) == expected_value, got something instead ...',
      'E       assert 3 == 4, comparing the truncated values ...',
      '=========================== 1 failed in 0.05s ============================',
    ].join('\n')
    const { text, rewriter } = rewriteCommandOutput(input)
    assert.equal(rewriter, 'pytest')
    // Real failure detail must survive — a line ending in "..." is not a
    // per-test dot-progress line (those carry a "[ NN% ]" or a path prefix).
    assert.ok(text.includes('got something instead'), 'assertion failure line must be preserved')
    assert.ok(text.includes('comparing the truncated values'), 'E-prefixed traceback line must be preserved')
  })
})

describe('stripAnsi and ANSI-aware command rewriting', () => {
  it('strips SGR color codes and CSI cursor sequences cleanly', () => {
    const colored = '\x1b[32mPASS\x1b[0m \x1b[1;34msrc/app.test.ts\x1b[0m\x1b[2K\x1b[?25h'
    assert.equal(stripAnsi(colored), 'PASS src/app.test.ts')
  })

  it('returns plain strings unchanged by reference', () => {
    const plain = 'no escape codes here'
    assert.equal(stripAnsi(plain), plain)
    assert.equal(stripAnsi(''), '')
  })

  it('returns rewriter "ansi" when ANSI codes are stripped from unmatched output', () => {
    const input = '\x1b[36minfo\x1b[0m: server listening on \x1b[1mhttp://localhost:3000\x1b[0m'
    const res = rewriteCommandOutput(input)
    assert.equal(res.rewriter, 'ansi')
    assert.equal(res.text, 'info: server listening on http://localhost:3000')
    assert.equal(res.savedBytes, utf8Delta(input, res.text))
    assert.ok(res.savedBytes > 0)
  })

  it('strips ANSI before matching command rewriters so colored output still matches', () => {
    const input = [
      '\x1b[1;36m RUN \x1b[0m v2.1.4 /app',
      ' \x1b[32m✓\x1b[0m src/a.test.ts (4) 12ms',
      ' \x1b[32m✓\x1b[0m src/b.test.ts (6) 18ms',
      ' Test Files  \x1b[32m2 passed\x1b[0m (2)',
      '      Tests  \x1b[32m10 passed\x1b[0m (10)',
    ].join('\n')
    const res = rewriteCommandOutput(input)
    assert.equal(res.rewriter, 'vitest')
    assert.ok(!res.text.includes('\x1b['), 'ANSI codes should be stripped')
    assert.ok(!res.text.includes('src/a.test.ts'), 'passing vitest lines should be stripped')
    assert.ok(res.text.includes('Test Files  2 passed (2)'), 'summary should be preserved')
    assert.equal(res.savedBytes, utf8Delta(input, res.text))
  })
})

describe('new command rewriters — vitest, node-test, go-test, pnpm-bun', () => {
  it('vitest: strips passing lines on all-pass runs and keeps summary verbatim', () => {
    const input = [
      ' RUN  v2.1.4 /work/app',
      '',
      ' ✓ src/utils.test.ts (12) 45ms',
      ' ✓ src/api.test.ts (8 tests) 112ms',
      ' ✓ src/math.test.js (3) 9ms',
      '',
      ' Test Files  3 passed (3)',
      '      Tests  23 passed (23)',
      '   Duration  520ms',
    ].join('\n')
    const res = rewriteCommandOutput(input)
    assert.equal(res.rewriter, 'vitest')
    assert.ok(!res.text.includes('src/utils.test.ts'))
    assert.ok(!res.text.includes('src/api.test.ts'))
    assert.ok(res.text.includes('Test Files  3 passed (3)'))
    assert.ok(res.text.includes('Tests  23 passed (23)'))
    assert.ok(res.savedBytes > 0)
  })

  it('vitest: leaves failing runs completely untouched', () => {
    const input = [
      ' RUN  v2.1.4 /work/app',
      ' ✓ src/utils.test.ts (12) 45ms',
      ' ❯ src/api.test.ts (2 tests | 1 failed) 112ms',
      '   × fetches user',
      ' FAIL  src/api.test.ts > fetches user',
      'AssertionError: expected 200 to be 500',
      ' Test Files  1 failed | 1 passed (2)',
      '      Tests  1 failed | 13 passed (14)',
    ].join('\n')
    const res = rewriteCommandOutput(input)
    assert.equal(res.rewriter, 'vitest')
    assert.equal(res.text, input)
  })

  it('node-test: strips passing ✔ and ok N - lines when fail is 0', () => {
    const tap = [
      'TAP version 13',
      'ok 1 - adds numbers',
      'ok 2 - subtracts numbers',
      '1..2',
      '# tests 2',
      '# pass 2',
      '# fail 0',
      '# duration_ms 14.5',
    ].join('\n')
    const r1 = rewriteCommandOutput(tap)
    assert.equal(r1.rewriter, 'node-test')
    assert.ok(!r1.text.includes('ok 1 - adds numbers'))
    assert.ok(r1.text.includes('# tests 2'))
    assert.ok(r1.text.includes('# pass 2'))
    assert.ok(r1.text.includes('# fail 0'))
    assert.ok(r1.text.includes('# duration_ms 14.5'))
    assert.ok(r1.savedBytes > 0)

    const spec = [
      '▶ math suite',
      '  ✔ adds numbers (1.2ms)',
      '  ✔ subtracts numbers (0.8ms)',
      '✔ math suite (3.1ms)',
      'ℹ tests 2',
      'ℹ pass 2',
      'ℹ fail 0',
      'ℹ duration_ms 12.1',
    ].join('\n')
    const r2 = rewriteCommandOutput(spec)
    assert.equal(r2.rewriter, 'node-test')
    assert.ok(!r2.text.includes('✔ adds numbers'))
    assert.ok(r2.text.includes('ℹ tests 2'))
    assert.ok(r2.text.includes('ℹ fail 0'))
    assert.ok(r2.savedBytes > 0)
  })

  it('node-test: leaves failing runs untouched', () => {
    const input = [
      'TAP version 13',
      'ok 1 - adds numbers',
      'not ok 2 - divides by zero',
      '  ---',
      '  error: AssertionError [ERR_ASSERTION]: 1 !== 2',
      '  ...',
      '# tests 2',
      '# pass 1',
      '# fail 1',
      '# duration_ms 18.2',
    ].join('\n')
    const res = rewriteCommandOutput(input)
    assert.equal(res.rewriter, 'node-test')
    assert.equal(res.text, input)
  })

  it('go-test: strips === RUN and --- PASS: lines on all-pass runs and keeps ok summary', () => {
    const input = [
      '=== RUN   TestAdd',
      '--- PASS: TestAdd (0.00s)',
      '=== RUN   TestSub',
      '=== RUN   TestSub/positive',
      '--- PASS: TestSub (0.00s)',
      '    --- PASS: TestSub/positive (0.00s)',
      'PASS',
      'ok  \tgithub.com/user/repo/pkg/math\t0.012s',
    ].join('\n')
    const res = rewriteCommandOutput(input)
    assert.equal(res.rewriter, 'go-test')
    assert.ok(!res.text.includes('=== RUN'))
    assert.ok(!res.text.includes('--- PASS:'))
    assert.ok(res.text.includes('ok  \tgithub.com/user/repo/pkg/math\t0.012s'))
    assert.ok(res.savedBytes > 0)
  })

  it('go-test: leaves failing runs untouched', () => {
    const input = [
      '=== RUN   TestAdd',
      '--- PASS: TestAdd (0.00s)',
      '=== RUN   TestDiv',
      '    math_test.go:18: expected 2, got 3',
      '--- FAIL: TestDiv (0.00s)',
      'FAIL',
      'FAIL\tgithub.com/user/repo/pkg/math\t0.015s',
    ].join('\n')
    const res = rewriteCommandOutput(input)
    assert.equal(res.rewriter, 'go-test')
    assert.equal(res.text, input)
  })

  it('pnpm-bun: strips progress bars/frames while keeping summary and warnings', () => {
    const pnpm = [
      'Progress: resolved 1, reused 0, downloaded 0, added 0',
      'Progress: resolved 120, reused 110, downloaded 10, added 120, done',
      'Packages: +120',
      '++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++',
      'WARN deprecated rimraf@3.0.2: no longer supported',
      'Done in 2.4s',
    ].join('\n')
    const r1 = rewriteCommandOutput(pnpm)
    assert.equal(r1.rewriter, 'pnpm-bun')
    assert.ok(!r1.text.includes('Progress: resolved'))
    assert.ok(!r1.text.includes('++++++++++'))
    assert.ok(r1.text.includes('WARN deprecated rimraf@3.0.2'))
    assert.ok(r1.text.includes('Done in 2.4s'))
    assert.ok(r1.savedBytes > 0)

    const bun = [
      'bun install v1.1.20 (ae194892)',
      'Resolving dependencies',
      '⠋ Resolving dependencies',
      '[=================>        ] 45/100',
      'Saved lockfile',
      'Installed 100 packages in 1.2s',
    ].join('\n')
    const r2 = rewriteCommandOutput(bun)
    assert.equal(r2.rewriter, 'pnpm-bun')
    assert.ok(!r2.text.includes('Resolving dependencies'))
    assert.ok(!r2.text.includes('45/100'))
    assert.ok(!r2.text.includes('Saved lockfile'))
    assert.ok(r2.text.includes('Installed 100 packages in 1.2s'))
    assert.ok(r2.savedBytes > 0)
  })
})
