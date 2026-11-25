import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compressText } from '../compress.js'
import { summarize, rehydrateReferences, REF_MARKER } from '../lib/disclosure.js'
import { createBrCache } from '../lib/br-cache.js'
import { anthropic } from '../providers.js'
import { redactText } from '../lib/redact.js'
import { stripAnsi, rewriteCommandOutput } from '../lib/rewriters/index.js'

// Offline quality gates closing the offline P2 items in TODOS.md:
//   1. `prune` structural invariant — every removed key is provably npm-internal
//      and legitimate user fields never get dropped.
//   2. `disclosure` byte-identical round-trip — diverse >32KB UTF-8 payloads
//      summarize, cache, and rehydrate byte-for-byte identically.
//   3. Adversarial ReDoS timing — hot-path regex scanners stay < 25ms on 64KB
//      pathological inputs.

const NPM_INTERNAL_KEYS = new Set([
  '_from',
  '_resolved',
  '_integrity',
  '_nodeVersion',
  '_npmVersion',
  '_phantomChildren',
  '_requiredBy',
])
const NPM_INTEGRITY_RE = /^sha\d{1,3}-[A-Za-z0-9+/]+={0,2}$/
const NPM_SHASUM_RE = /^[a-f0-9]{40}$/i
const NPM_PKG_ID_RE = /^(@[\w.-]+\/)?[\w.-]+@\d[\w.\-+]*$/

function isProvablyNpmInternal(key, val) {
  if (NPM_INTERNAL_KEYS.has(key)) return true
  if (typeof val !== 'string') return false
  if (key === '_id' && NPM_PKG_ID_RE.test(val)) return true
  if (key === 'resolved' && val.startsWith('https://registry.')) return true
  if (key === 'integrity' && NPM_INTEGRITY_RE.test(val)) return true
  if (key === 'shasum' && NPM_SHASUM_RE.test(val)) return true
  return false
}

function collectRemovedEntries(orig, pruned, path = [], out = []) {
  if (Array.isArray(orig)) {
    assert.ok(Array.isArray(pruned), `expected array at ${path.join('.')}`)
    assert.equal(pruned.length, orig.length, `array length changed at ${path.join('.')}`)
    for (let i = 0; i < orig.length; i++) {
      collectRemovedEntries(orig[i], pruned[i], [...path, String(i)], out)
    }
    return out
  }
  if (orig !== null && typeof orig === 'object') {
    assert.ok(pruned !== null && typeof pruned === 'object', `expected object at ${path.join('.')}`)
    for (const [k, v] of Object.entries(orig)) {
      if (!(k in pruned)) {
        out.push({ path: [...path, k].join('.'), key: k, val: v })
      } else {
        collectRemovedEntries(v, pruned[k], [...path, k], out)
      }
    }
    for (const k of Object.keys(pruned)) {
      assert.ok(k in orig, `prune invented unexpected key ${[...path, k].join('.')}`)
    }
    return out
  }
  assert.deepEqual(pruned, orig, `leaf value mutated at ${path.join('.')}`)
  return out
}

describe('quality gate — prune structural invariant', () => {
  const config = { minSize: 10, stages: ['prune'], llmLinguaUrl: null, log: false }

  it('removes ONLY provably npm-internal metadata and preserves every legitimate user field', () => {
    const payload = {
      // Provably npm-internal metadata (must be stripped)
      packages: {
        'node_modules/lodash': {
          version: '4.17.21',
          _id: 'lodash@4.17.21',
          _from: 'lodash@^4.17.0',
          _resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
          _integrity: 'sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==',
          _nodeVersion: '20.11.0',
          _npmVersion: '10.2.4',
          _phantomChildren: {},
          _requiredBy: ['#USER', '/'],
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
          integrity: 'sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==',
          shasum: '679591c564c3bffaae8454cf0b3df370c3d6911c',
        },
        'node_modules/@scope/pkg': {
          version: '1.2.3-beta.1',
          _id: '@scope/pkg@1.2.3-beta.1',
          resolved: 'https://registry.yarnpkg.com/@scope/pkg/-/pkg-1.2.3-beta.1.tgz',
          integrity: 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=',
        },
      },
      // Legitimate application / database / domain records (must NEVER be stripped)
      records: [
        {
          _id: '507f1f77bcf86cd799439011',
          integrity: 'high',
          resolved: true,
          shasum: 'verified',
          title: 'MongoDB document with colliding field names',
        },
        {
          _id: '550e8400-e29b-41d4-a716-446655440000',
          integrity: 'medium',
          resolved: '2026-11-25T10:00:00Z',
          shasum: 'deadbeef',
        },
        {
          _id: 'alice@example.com',
          integrity: 100,
          resolved: 'https://github.com/org/repo.git',
        },
        {
          _id: 987654,
          resolved: 'git+https://github.com/me/pkg.git',
          integrity: 'sha512-not valid base64!',
        },
      ],
    }

    const res = compressText(JSON.stringify(payload, null, 2), config)
    assert.ok(res, 'prune should compress payload containing npm lockfile metadata')
    const pruned = JSON.parse(res.text)

    // 1. Every removed key-value pair MUST satisfy the provably-npm-internal invariant.
    const removed = collectRemovedEntries(payload, pruned)
    assert.ok(removed.length >= 14, `expected npm metadata keys to be removed, got ${removed.length}`)
    for (const entry of removed) {
      assert.ok(
        isProvablyNpmInternal(entry.key, entry.val),
        `prune dropped non-npm field ${entry.path} = ${JSON.stringify(entry.val)}`
      )
    }

    // 2. Every legitimate user record survives intact.
    assert.deepEqual(pruned.records, payload.records)
    assert.equal(pruned.packages['node_modules/lodash'].version, '4.17.21')
    assert.equal(pruned.packages['node_modules/@scope/pkg'].version, '1.2.3-beta.1')
  })
})

describe('quality gate — disclosure byte-identical round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tamp-quality-disclosure-'))
  after(() => rmSync(dir, { recursive: true, force: true }))

  function makePayload(seed, targetBytes) {
    const chunkBytes = Buffer.byteLength(seed, 'utf8')
    return seed.repeat(Math.ceil(targetBytes / chunkBytes) + 1)
  }

  const PAYLOADS = [
    {
      name: 'UTF-8 multi-byte code (CJK comments + box drawing)',
      body: makePayload(
        '// 処理ループ — résumé café naïve │ ┌──┐\nexport function compute(α, β) { return α * β + "日本語テスト"; }\n',
        40 * 1024
      ),
    },
    {
      name: 'large structured JSON with Unicode',
      body: JSON.stringify(
        Array.from({ length: 450 }, (_, i) => ({
          id: i,
          city: ['München', 'Zürich', '東京', 'São Paulo', 'Łódź'][i % 5],
          notes: `Record #${i} — price: $99.99, ratio: 100%, symbols: <>&"'\\`,
        })),
        null,
        2
      ),
    },
    {
      name: 'server logs with special replacement tokens ($&, $$, backslashes)',
      body: makePayload(
        '2026-11-25T10:00:00.123Z WARN [worker] path=C:\\srv\\app query="$& $$ $1 $`" payload=<xml>&amp;</xml>\n',
        42 * 1024
      ),
    },
    {
      name: 'emoji and surrogate-pair heavy payload',
      body: makePayload('🚀🔥🧪👨‍👩‍👧‍👦✨🎉🤖📦🌊⚡ — multi-byte boundary stress line!\n', 38 * 1024),
    },
  ]

  for (const { name, body } of PAYLOADS) {
    it(`round-trips ${name} byte-for-byte identically`, () => {
      const originalBuf = Buffer.from(body, 'utf8')
      assert.ok(originalBuf.length >= 32 * 1024, `${name} must exceed 32KB disclosure gate`)

      const cache = createBrCache({ cacheDir: dir, minSize: 1024 })
      const put = cache.put(body)
      assert.ok(put, 'brCache.put must store >32KB payload')

      const summaryRes = summarize(body, { hash: put.hash })
      assert.ok(summaryRes, 'summarize must produce a summary')
      assert.equal(summaryRes.originalBytes, originalBuf.length)
      assert.equal(summaryRes.hash, createHash('sha256').update(body).digest('hex'))
      assert.ok(
        !summaryRes.summary.includes('\uFFFD'),
        `summary for ${name} must not introduce UTF-8 replacement characters when slicing head/tail`
      )

      const markerMatch = new RegExp(REF_MARKER.source, REF_MARKER.flags).exec(summaryRes.summary)
      assert.ok(markerMatch, 'summary must contain a valid <tamp-ref:v1:...> marker')

      // Assistant turn quotes the marker back in a follow-up request.
      const request = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Inspect the full file.' },
          {
            role: 'assistant',
            content: [{ type: 'text', text: `Expanding ${markerMatch[0]} now.` }],
          },
        ],
      }

      const rehydrated = rehydrateReferences(request, anthropic, cache)
      assert.equal(rehydrated.rehydrated, 1)
      assert.equal(rehydrated.missed, 0)

      const text = request.messages[1].content[0].text
      const header = `<tamp-ref:v1:${summaryRes.hash} expanded - ${originalBuf.length} bytes follow>\n`
      const footer = '\n</tamp-ref expanded>'
      const start = text.indexOf(header)
      const end = text.lastIndexOf(footer)
      assert.ok(start !== -1 && end > start, 'expanded block delimiters must be present')

      const restored = text.slice(start + header.length, end)
      assert.equal(
        Buffer.compare(Buffer.from(restored, 'utf8'), originalBuf),
        0,
        `rehydrated body for ${name} must be byte-for-byte identical to original`
      )
    })
  }
})

describe('quality gate — adversarial ReDoS timing (< 25ms on 64KB inputs)', () => {
  const SIZE = 64 * 1024

  // Warm up JIT / regex compilation so first-call overhead doesn't distort measurements.
  redactText('API_KEY=warm123456')
  stripAnsi('\x1b[31mwarm\x1b[0m')
  rewriteCommandOutput('warm')

  function assertFast(label, fn) {
    const start = process.hrtime.bigint()
    fn()
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    assert.ok(ms < 25, `${label} took ${ms.toFixed(2)}ms — expected < 25ms`)
  }

  it('redactText stays < 25ms on 64KB pathological inputs', () => {
    const cases = [
      ['64KB uppercase run', 'A'.repeat(SIZE)],
      ['64KB repeated SECRET_ words', 'SECRET_'.repeat(Math.ceil(SIZE / 7)).slice(0, SIZE)],
      ['64KB unclosed PEM header + body', '-----BEGIN PRIVATE KEY-----' + 'A'.repeat(SIZE - 27)],
      ['64KB long sk-or-v1 prefix run', 'sk-or-v1-' + 'a'.repeat(SIZE - 9)],
      ['64KB long JWT-like prefix', 'eyJ' + 'a'.repeat(SIZE - 3)],
    ]
    for (const [label, input] of cases) {
      assertFast(`redactText(${label})`, () => redactText(input))
    }
  })

  it('stripAnsi stays < 25ms on 64KB pathological inputs', () => {
    const cases = [
      ['64KB unterminated CSI params', '\x1b[' + '0;'.repeat((SIZE - 2) / 2)],
      ['64KB repeated CSI openers', '\x1b['.repeat(SIZE / 2)],
      ['64KB dense SGR codes', '\x1b[38;5;196mx\x1b[0m'.repeat(Math.ceil(SIZE / 16)).slice(0, SIZE)],
    ]
    for (const [label, input] of cases) {
      assertFast(`stripAnsi(${label})`, () => stripAnsi(input))
    }
  })

  it('rewriteCommandOutput stays < 25ms on 64KB pathological inputs', () => {
    const cases = [
      ['64KB unterminated CSI', '\x1b[' + '0;'.repeat((SIZE - 2) / 2)],
      ['64KB vitest long summary line', 'Test Files  ' + ' '.repeat(SIZE - 12)],
      ['64KB jest long PASS line', 'PASS ' + 'a'.repeat(SIZE - 5)],
      ['64KB pnpm progress flood', 'Progress: resolved 1, reused 0, downloaded 0, added 0\n'.repeat(1250)],
      ['64KB go-test long RUN line', '=== RUN   ' + 'T'.repeat(SIZE - 10)],
    ]
    for (const [label, input] of cases) {
      assertFast(`rewriteCommandOutput(${label})`, () => rewriteCommandOutput(input))
    }
  })
})
