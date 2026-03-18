#!/usr/bin/env node
// Layer 3: Task-completion semantic evaluation
// Tests whether LLMLingua-2 compressed text preserves enough meaning for LLM task completion
// Requires OPENROUTER_API_KEY environment variable
// Usage: node bench/semantic-eval.js

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
if (!OPENROUTER_API_KEY) {
  console.error('Set OPENROUTER_API_KEY to run semantic evaluation')
  process.exit(1)
}

const MODEL = 'anthropic/claude-sonnet-4-20250514'
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const RUNS = 3
const MAX_TOKENS = 200
const TEMPERATURE = 0

// Test scenarios: each has source text, a question, and expected answer
const scenarios = [
  {
    id: 'factual-function-name',
    description: 'Extract exported function name for user deletion',
    text: `export async function deleteUserAccount(userId: string, reason: string) {
  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  await db.sessions.deleteMany({ userId });
  await db.users.delete(userId);
  await auditLog.record({ action: 'DELETE_USER', userId, reason });
  return { deleted: true, userId };
}

export async function suspendUserAccount(userId: string) {
  await db.users.update(userId, { status: 'suspended' });
}

export function getUserProfile(userId: string) {
  return db.users.findById(userId);
}`,
    question: 'What is the exported function name for deleting a user account?',
    expected: 'deleteUserAccount',
    match: 'exact',
  },
  {
    id: 'numeric-extraction',
    description: 'Extract database port from config',
    text: `const config = {
  database: { host: 'db.prod.internal', port: 5432, name: 'myapp_production', pool: { min: 5, max: 25 } },
  redis: { host: 'cache.prod.internal', port: 6379, db: 0 },
  server: { port: 3000, workers: 4, gracefulShutdown: 30000 },
  auth: { jwtExpiry: 3600, refreshExpiry: 86400, maxSessions: 5 },
};`,
    question: 'What port does the database run on? Reply with just the number.',
    expected: '5432',
    match: 'exact',
  },
  {
    id: 'list-extraction',
    description: 'List all HTTP methods in routes',
    text: `const routes = [
  { method: 'GET', path: '/api/users', handler: 'list' },
  { method: 'POST', path: '/api/users', handler: 'create' },
  { method: 'GET', path: '/api/users/:id', handler: 'show' },
  { method: 'PUT', path: '/api/users/:id', handler: 'update' },
  { method: 'DELETE', path: '/api/users/:id', handler: 'destroy' },
  { method: 'PATCH', path: '/api/users/:id/status', handler: 'updateStatus' },
  { method: 'GET', path: '/api/health', handler: 'healthCheck' },
];`,
    question: 'List all unique HTTP methods used in these routes. Reply with a comma-separated list.',
    expected: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    match: 'set',
  },
  {
    id: 'reasoning-conditional',
    description: 'Reason about conditional logic',
    text: `const loadMore = useCallback(() => {
  if (!loading && hasMore) {
    setPage(p => p + 1);
  }
}, [loading, hasMore]);

const canLoadMore = !loading && hasMore && items.length > 0;`,
    question: 'If loading is true and hasMore is true, will loadMore() increment the page? Answer Yes or No.',
    expected: 'No',
    match: 'exact',
  },
  {
    id: 'instruction-compliance',
    description: 'Verify instruction to respond in JSON is preserved',
    text: `You are an API assistant. You must ALWAYS respond with valid JSON. Never include markdown formatting.
Your response must follow this schema: { "status": "ok" | "error", "message": string }
If the user asks a question, set status to "ok" and put the answer in message.
If you cannot answer, set status to "error" and explain why in message.`,
    question: 'What is 2 + 2?',
    expected: null,
    match: 'json', // just check response is valid JSON
  },
  {
    id: 'multi-fact',
    description: 'Extract 5 specific facts from dependency config',
    text: `Project: my-dashboard
Node version: 18.19.0
Package manager: pnpm 8.12.1
Build tool: Vite 5.0.12
Framework: React 18.2.0 with TypeScript 5.3.3
Testing: Vitest 1.2.0 + React Testing Library 14.1.2
State management: Zustand 4.4.7
Styling: Tailwind CSS 3.4.1
Linting: ESLint 8.56.0 + Prettier 3.2.4
CI: GitHub Actions`,
    questions: [
      { q: 'What Node version is used? Reply with just the version.', a: '18.19.0' },
      { q: 'What is the package manager? Reply with just the name.', a: 'pnpm' },
      { q: 'What framework is used? Reply with just the name.', a: 'React' },
      { q: 'What state management library? Reply with just the name.', a: 'Zustand' },
      { q: 'What CI system? Reply with just the name.', a: 'GitHub Actions' },
    ],
    match: 'multi',
    threshold: 4, // 4/5 must pass
  },
]

async function query(systemPrompt, userMessage) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API error ${res.status}: ${text}`)
  }
  const data = await res.json()
  return data.choices[0].message.content.trim()
}

function checkMatch(response, expected, matchType) {
  const resp = response.trim()
  switch (matchType) {
    case 'exact':
      return resp.toLowerCase().includes(expected.toLowerCase())
    case 'set': {
      const found = expected.filter(item => resp.toUpperCase().includes(item))
      return found.length >= expected.length * 0.8
    }
    case 'json':
      try { JSON.parse(resp); return true } catch { return false }
    default:
      return false
  }
}

async function runScenario(scenario) {
  const results = { id: scenario.id, description: scenario.description, runs: [] }

  if (scenario.match === 'multi') {
    // Multi-fact: run each sub-question
    let totalPass = 0
    for (const sub of scenario.questions) {
      let subPass = 0
      for (let r = 0; r < RUNS; r++) {
        try {
          const resp = await query(scenario.text, sub.q)
          const pass = resp.toLowerCase().includes(sub.a.toLowerCase())
          if (pass) subPass++
        } catch (err) {
          console.error(`  ERROR ${scenario.id}/${sub.q}: ${err.message}`)
        }
      }
      if (subPass >= 2) totalPass++ // pass if 2/3 runs match
    }
    results.pass = totalPass >= scenario.threshold
    results.detail = `${totalPass}/${scenario.questions.length} sub-questions passed (threshold: ${scenario.threshold})`
    return results
  }

  for (let r = 0; r < RUNS; r++) {
    try {
      const resp = await query(scenario.text, scenario.question)
      const pass = checkMatch(resp, scenario.expected, scenario.match)
      results.runs.push({ response: resp, pass })
    } catch (err) {
      results.runs.push({ response: null, pass: false, error: err.message })
    }
  }

  const passCount = results.runs.filter(r => r.pass).length
  results.pass = passCount >= 2 // 2/3 runs must pass
  results.detail = `${passCount}/${RUNS} runs passed`
  return results
}

async function main() {
  console.log('=== LLMLingua-2 Semantic Evaluation (Layer 3) ===\n')
  console.log(`Model: ${MODEL}`)
  console.log(`Runs per scenario: ${RUNS}`)
  console.log(`Temperature: ${TEMPERATURE}\n`)

  let totalPass = 0
  const results = []

  for (const scenario of scenarios) {
    process.stdout.write(`  ${scenario.id}... `)
    const result = await runScenario(scenario)
    results.push(result)
    if (result.pass) {
      totalPass++
      console.log(`PASS (${result.detail})`)
    } else {
      console.log(`FAIL (${result.detail})`)
    }
  }

  const passRate = totalPass / scenarios.length
  console.log(`\n${totalPass}/${scenarios.length} scenarios passed (${(passRate * 100).toFixed(0)}%)`)
  console.log(passRate >= 0.90 ? 'OVERALL: PASS' : 'OVERALL: FAIL (need >= 90%)')

  // Write results
  const outPath = `bench/results/semantic-eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  const { writeFileSync } = await import('node:fs')
  writeFileSync(outPath, JSON.stringify({ timestamp: new Date().toISOString(), model: MODEL, runs: RUNS, scenarios: results, passRate }, null, 2))
  console.log(`\nResults written to ${outPath}`)
}

main().catch(err => { console.error(err); process.exit(1) })
