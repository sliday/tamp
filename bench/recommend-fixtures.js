// QA fixtures for the recommended-defaults sweep (bench/recommend-eval.js).
// Each scenario plants facts a compression stage could destroy, then asks
// mechanically gradable questions about them. Unlike bench/fixtures.js, the
// large bodies here exceed the 32KB gate so disclosure/bm25-trim really fire.

function toolFlow(id, content, name = 'Read', input = { path: '/tmp/file' }) {
  return [
    { role: 'user', content: 'Read the file' },
    { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id, name, input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  ]
}

// --- Large fixture generators (deterministic, no RNG) ---

// ~46KB fake grep output: 700 noise lines + 3 planted needles (start/middle/end).
function bigGrep() {
  const lines = []
  for (let i = 1; i <= 700; i++) {
    lines.push(`src/modules/mod${i % 40}/handler${i}.ts:${20 + (i % 60)}:  const result${i} = await pipeline.process(batch${i % 9}, { retries: ${i % 5}, timeoutMs: ${1000 + (i % 7) * 250} })`)
  }
  lines[3] = 'src/core/auth/session.ts:41:  const SESSION_TTL_SECONDS = 86400 // planted-needle-alpha'
  lines[349] = 'src/core/billing/invoice.ts:118:  const LATE_FEE_PERCENT = 4.5 // planted-needle-beta'
  lines[696] = 'src/core/export/csv.ts:77:  const MAX_EXPORT_ROWS = 250000 // planted-needle-gamma'
  return lines.join('\n')
}

// ~40KB fake TypeScript module: repetitive CRUD handlers + planted facts,
// one of them ONLY present in a comment (strip-comments stress).
function bigSource() {
  const parts = []
  parts.push('// Service layer for the reporting subsystem.')
  parts.push('// NOTE: all timeouts in this module are expressed in MILLISECONDS, not seconds.')
  parts.push("import { db } from '../db'")
  parts.push("import { metrics } from '../metrics'")
  parts.push('')
  parts.push('export const REPORT_BATCH_SIZE = 512')
  parts.push('')
  for (let i = 1; i <= 90; i++) {
    parts.push(`export async function fetchReportPage${i}(cursor: string) {`)
    parts.push(`  const rows = await db.reports.page({ cursor, limit: REPORT_BATCH_SIZE, shard: ${i % 8} })`)
    parts.push(`  metrics.count('report.page${i}', rows.length)`)
    parts.push(`  if (rows.length === 0) return { rows: [], next: null }`)
    parts.push(`  return { rows, next: rows[rows.length - 1].id }`)
    parts.push('}')
    parts.push('')
  }
  parts.push('export async function purgeStaleReports() {')
  parts.push('  // retention window below is 45 days per legal requirement LGL-2209')
  parts.push('  const cutoff = Date.now() - 45 * 24 * 3600 * 1000')
  parts.push("  return db.reports.deleteWhere('created_at < ?', cutoff)")
  parts.push('}')
  return parts.join('\n')
}

// Parallel double-read: both tool_results arrive in ONE user turn (agent
// issued two Read calls in parallel), so dedup/diff can see both under
// cache-safe extraction. Second copy has one changed line; the question is
// answerable only from the SECOND result.
const configV1 = JSON.stringify({
  service: 'checkout', replicas: 3, region: 'us-east-1',
  limits: { rps: 400, burst: 900, queueDepth: 128 },
  flags: { newTaxEngine: false, asyncReceipts: true },
}, null, 2)
const configV2 = configV1.replace('"rps": 400', '"rps": 950')

export const scenarios = [
  {
    id: 'pkg-version',
    body: toolFlow('tu_r1', JSON.stringify({
      name: '@example/my-app', version: '2.4.1', type: 'module',
      scripts: { dev: 'vite dev', build: 'vite build', test: 'vitest run' },
      dependencies: { react: '^18.2.0', 'react-router-dom': '^6.20.0', zod: '^3.22.4' },
    }, null, 2)),
    questions: [
      { q: 'What is the version of @example/my-app? Reply with just the version number.', expected: '2.4.1', match: 'exact' },
      { q: 'What version of zod is declared? Reply with just the version specifier.', expected: '3.22.4', match: 'exact' },
    ],
  },
  {
    id: 'noisy-tests',
    body: toolFlow('tu_r2', 'Running tests...   \n\n\n⠋ collecting\n⠙ collecting\n⠹ collecting\n\n  PASS  src/utils/format.test.ts    \n    ✓ formats currency correctly (3ms)   \n    ✓ handles negative values    \n    ✓ respects locale settings   \n\n  PASS  src/utils/validate.test.ts    \n    ✓ validates email format (1ms)    \n    ✓ rejects invalid emails    \n    ✓ validates phone numbers    \n    ✓ handles edge cases    \n\n  PASS  src/components/UserList.test.tsx    \n    ✓ renders user list (12ms)   \n    ✓ handles empty state    \n    ✓ pagination works    \n    ✓ search filters correctly (5ms)    \n    ✓ sort toggles direction    \n\nTest Suites: 3 passed, 3 total    \nTests:       12 passed, 12 total    \nTime:        2.847s    \n\n\n', 'Bash', { command: 'npm test' }),
    questions: [
      { q: 'How many tests passed in total? Reply with just the number.', expected: '12', match: 'exact' },
      { q: 'How long did the test run take in seconds? Reply with just the number.', expected: '2.847', match: 'exact' },
    ],
  },
  {
    id: 'line-numbered',
    body: toolFlow('tu_r3', [
      "  1→import express from 'express';",
      "  2→import cors from 'cors';",
      "  3→import helmet from 'helmet';",
      '  4→',
      '  5→const app = express();',
      '  6→app.use(cors());',
      '  7→app.use(helmet());',
      '  8→app.use(express.json());',
      '  9→',
      " 10→app.get('/api/health', (req, res) => {",
      " 11→  res.json({ status: 'ok' });",
      ' 12→});',
    ].join('\n')),
    questions: [
      { q: 'What web framework is imported first in this file? Reply with just the package name.', expected: 'express', match: 'exact' },
      { q: 'What HTTP path does the health endpoint use? Reply with just the path.', expected: '/api/health', match: 'exact' },
    ],
  },
  {
    id: 'logic-guard',
    body: toolFlow('tu_r4', 'const loadMore = useCallback(() => {\n  if (!loading && hasMore) {\n    setPage(p => p + 1);\n  }\n}, [loading, hasMore]);\n\nconst canLoadMore = !loading && hasMore && items.length > 0;'),
    questions: [
      { q: 'If loading is true and hasMore is true, will loadMore() increment the page? Answer Yes or No.', expected: 'no', match: 'exact' },
    ],
  },
  {
    id: 'lockfile',
    body: toolFlow('tu_r5', JSON.stringify({
      name: 'my-app', lockfileVersion: 3, requires: true,
      packages: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [
        `node_modules/dep-${i}`,
        {
          version: `${1 + (i % 4)}.${i % 10}.${(i * 3) % 10}`,
          resolved: `https://registry.npmjs.org/dep-${i}/-/dep-${i}-1.0.0.tgz`,
          integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
          _from: `dep-${i}@latest`,
        },
      ]).concat([['node_modules/left-pad', { version: '9.9.9', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-9.9.9.tgz', integrity: 'sha512-BBBB==' }]])),
    }, null, 2)),
    questions: [
      { q: 'What version of left-pad is in this lockfile? Reply with just the version.', expected: '9.9.9', match: 'exact' },
    ],
  },
  {
    id: 'duplicate-read',
    body: [
      { role: 'user', content: 'Compare the config before and after my edit' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Reading both versions.' },
        { type: 'tool_use', id: 'tu_r6a', name: 'Read', input: { path: '/etc/checkout.json.bak' } },
        { type: 'tool_use', id: 'tu_r6b', name: 'Read', input: { path: '/etc/checkout.json' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_r6a', content: configV1 },
        { type: 'tool_result', tool_use_id: 'tu_r6b', content: configV2 },
      ] },
    ],
    questions: [
      { q: 'In the current (non-backup) version of the file, what is the rps limit? Reply with just the number.', expected: '950', match: 'exact' },
      { q: 'How many replicas does the checkout service run? Reply with just the number.', expected: '3', match: 'exact' },
    ],
  },
  {
    id: 'comment-fact',
    body: toolFlow('tu_r7', "// Cache layer for session tokens.\n// IMPORTANT: TTL below is in MINUTES (legacy quirk), not seconds.\nexport const TOKEN_CACHE_TTL = 30\n\nexport function cacheToken(token: string) {\n  return redis.setex(keyFor(token), TOKEN_CACHE_TTL * 60, token)\n}\n"),
    questions: [
      { q: 'According to this file, what unit is TOKEN_CACHE_TTL expressed in? Reply with just the unit.', expected: 'minute', match: 'exact' },
    ],
  },
  {
    id: 'prose-numbers',
    body: toolFlow('tu_r8', 'Deployment report, build 4821.\n\nThe rollout reached 37% of the fleet before the error budget alarm fired. Median latency rose from 112ms to 189ms, and p99 went from 480ms to 1,240ms. We rolled back at 14:42 UTC. Root cause: the new connection pool capped at 16 connections per instance instead of the intended 64, which starved the checkout service under load. The fix bumps the pool to 64 and adds a regression test.\n\nAction items: raise pool size (done), add alert on pool saturation above 80%, backfill the 214 failed orders.', 'Bash', { command: 'cat report.txt' }),
    questions: [
      { q: 'What was the p99 latency after the regression, in ms? Reply with just the number.', expected: '1,240', match: 'regex', pattern: /1,?240/ },
      { q: 'How many failed orders need backfilling? Reply with just the number.', expected: '214', match: 'exact' },
      { q: 'What was the intended connection pool size? Reply with just the number.', expected: '64', match: 'exact' },
    ],
  },
  {
    id: 'big-grep',
    body: toolFlow('tu_r9', bigGrep(), 'Bash', { command: 'grep -rn "const" src/' }),
    questions: [
      { q: 'What is the value of SESSION_TTL_SECONDS? Reply with just the number.', expected: '86400', match: 'exact' },
      { q: 'What is the value of LATE_FEE_PERCENT? Reply with just the number.', expected: '4.5', match: 'exact' },
      { q: 'What is the value of MAX_EXPORT_ROWS? Reply with just the number.', expected: '250000', match: 'regex', pattern: /250,?000/ },
    ],
  },
  {
    id: 'big-source',
    body: toolFlow('tu_r10', bigSource(), 'Read', { path: 'src/reporting/service.ts' }),
    questions: [
      { q: 'What is the value of REPORT_BATCH_SIZE? Reply with just the number.', expected: '512', match: 'exact' },
      { q: 'How many days is the report retention window? Reply with just the number.', expected: '45', match: 'exact' },
      { q: 'According to this module, are timeouts expressed in seconds or milliseconds? Reply with one word.', expected: 'millisecond', match: 'exact' },
    ],
  },
]

export { toolFlow }
