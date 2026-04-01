#!/usr/bin/env node
// A/B benchmark: output token savings with vs without token-efficient system prompt
// Control: no efficiency rules. Treatment: token-efficient CLAUDE.md rules injected.

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
if (!OPENROUTER_API_KEY) {
  console.error('Error: OPENROUTER_API_KEY env var required')
  process.exit(1)
}

const API_URL = 'https://openrouter.ai/api/v1/messages'
const MODEL = 'anthropic/claude-sonnet-4.6'
const RUNS = 5
const MAX_TOKENS = 1024
const SLEEP_MS = 1500
const MAX_RETRIES = 3

const __dirname = dirname(fileURLToPath(import.meta.url))
const resultsDir = join(__dirname, 'results')

const sleep = ms => new Promise(r => setTimeout(r, ms))

const TOKEN_EFFICIENT_SYSTEM = `Be concise in output. No sycophantic openers or closing fluff.
Return code first. Explanation after, only if non-obvious.
No "Sure!", "Great question!", "I hope this helps!" or similar.
Simplest working solution. No over-engineering or speculative features.
No docstrings/type annotations on unchanged code.
Keep solutions simple and direct.`

const scenarios = [
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Review a code snippet for bugs — tests verbose preamble elimination',
    messages: [
      { role: 'user', content: `Review this JavaScript code for bugs:\n\nfunction getItems(arr) {\n  const results = [];\n  for (let i = 0; i <= arr.length; i++) {\n    if (arr[i].active) {\n      results.push(arr[i].name);\n    }\n  }\n  return results;\n}` },
    ],
  },
  {
    id: 'concept-explanation',
    name: 'Concept Explanation',
    description: 'Explain async/await — tests verbose tutorial-style reduction',
    messages: [
      { role: 'user', content: 'Explain async/await in JavaScript with a short example.' },
    ],
  },
  {
    id: 'factual-correction',
    name: 'Factual Correction',
    description: 'Correct a wrong fact — tests sycophantic agreement elimination',
    messages: [
      { role: 'user', content: 'Python was created in 2005, right?' },
    ],
  },
  {
    id: 'refactor-suggestion',
    name: 'Refactor Suggestion',
    description: 'Suggest a refactor — tests unsolicited advice elimination',
    messages: [
      { role: 'user', content: `How would you simplify this?\n\nfunction isEven(n) {\n  if (n % 2 === 0) {\n    return true;\n  } else {\n    return false;\n  }\n}` },
    ],
  },
  {
    id: 'debug-help',
    name: 'Debug Assistance',
    description: 'Help debug an error — tests over-explanation reduction',
    messages: [
      { role: 'user', content: 'I get "TypeError: Cannot read properties of undefined (reading \'map\')" on this line:\n\nconst names = data.users.map(u => u.name);' },
    ],
  },
  {
    id: 'api-usage',
    name: 'API Usage Question',
    description: 'How to use an API — tests boilerplate reduction',
    messages: [
      { role: 'user', content: 'How do I make a POST request with fetch in JavaScript with a JSON body?' },
    ],
  },
  {
    id: 'git-command',
    name: 'Git Command',
    description: 'Simple git question — tests conciseness for short answers',
    messages: [
      { role: 'user', content: 'How do I undo the last commit but keep the changes?' },
    ],
  },
  {
    id: 'code-generation',
    name: 'Code Generation',
    description: 'Generate a function — tests unnecessary commentary elimination',
    messages: [
      { role: 'user', content: 'Write a debounce function in TypeScript.' },
    ],
  },
]

async function callAPI(system, messages, retries = MAX_RETRIES) {
  const body = { model: MODEL, max_tokens: MAX_TOKENS, system, messages }
  for (let attempt = 1; attempt <= retries; attempt++) {
    const start = performance.now()
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': OPENROUTER_API_KEY,
        },
        body: JSON.stringify(body),
      })
      const latency = performance.now() - start
      if (!res.ok) {
        const text = await res.text()
        if (attempt < retries && (res.status === 429 || res.status >= 500)) {
          const backoff = 1000 * Math.pow(2, attempt)
          process.stderr.write(`  retry ${attempt}/${retries} (${res.status}), waiting ${backoff}ms...\n`)
          await sleep(backoff)
          continue
        }
        throw new Error(`HTTP ${res.status}: ${text}`)
      }
      const data = await res.json()
      const responseText = data.content?.map(b => b.text || '').join('') || ''
      return {
        input_tokens: data.usage?.input_tokens ?? null,
        output_tokens: data.usage?.output_tokens ?? null,
        latency_ms: Math.round(latency),
        response_chars: responseText.length,
        stop_reason: data.stop_reason ?? null,
      }
    } catch (err) {
      if (attempt === retries) throw err
      const backoff = 1000 * Math.pow(2, attempt)
      process.stderr.write(`  retry ${attempt}/${retries} (${err.message}), waiting ${backoff}ms...\n`)
      await sleep(backoff)
    }
  }
}

async function main() {
  const total = scenarios.length * RUNS * 2
  let call = 0

  const results = {
    meta: {
      timestamp: new Date().toISOString(),
      model: MODEL,
      type: 'output-token-savings',
      pricing: { input_per_mtok: 3.00, output_per_mtok: 15.00 },
      runs: RUNS,
      max_tokens: MAX_TOKENS,
      system_prompt_treatment: TOKEN_EFFICIENT_SYSTEM,
    },
    scenarios: [],
  }

  for (const scenario of scenarios) {
    const scenarioResult = {
      id: scenario.id,
      name: scenario.name,
      description: scenario.description,
      runs: [],
    }

    for (let run = 0; run < RUNS; run++) {
      // Control: neutral system prompt
      call++
      process.stderr.write(`[${call}/${total}] ${scenario.id} control run ${run + 1}...\n`)
      const control = await callAPI('You are a helpful assistant.', scenario.messages)
      await sleep(SLEEP_MS)

      // Treatment: token-efficient system prompt
      call++
      process.stderr.write(`[${call}/${total}] ${scenario.id} treatment run ${run + 1}...\n`)
      const treatment = await callAPI(TOKEN_EFFICIENT_SYSTEM, scenario.messages)
      await sleep(SLEEP_MS)

      scenarioResult.runs.push({ control, treatment })
    }

    // Quick stats
    const avgControl = scenarioResult.runs.reduce((a, r) => a + r.control.output_tokens, 0) / RUNS
    const avgTreatment = scenarioResult.runs.reduce((a, r) => a + r.treatment.output_tokens, 0) / RUNS
    const pct = ((1 - avgTreatment / avgControl) * 100).toFixed(1)
    process.stderr.write(`  ${scenario.id}: ${Math.round(avgControl)} → ${Math.round(avgTreatment)} output tokens (${pct}% reduction)\n`)

    results.scenarios.push(scenarioResult)
  }

  // Aggregate
  const allControl = results.scenarios.flatMap(s => s.runs.map(r => r.control.output_tokens))
  const allTreatment = results.scenarios.flatMap(s => s.runs.map(r => r.treatment.output_tokens))
  const totalControl = allControl.reduce((a, b) => a + b, 0)
  const totalTreatment = allTreatment.reduce((a, b) => a + b, 0)
  results.aggregate = {
    total_control_output_tokens: totalControl,
    total_treatment_output_tokens: totalTreatment,
    weighted_pct_reduction: ((1 - totalTreatment / totalControl) * 100).toFixed(1),
    per_scenario: results.scenarios.map(s => {
      const ctrl = s.runs.map(r => r.control.output_tokens)
      const treat = s.runs.map(r => r.treatment.output_tokens)
      const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length
      const std = arr => { const m = mean(arr); return Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / (arr.length - 1)) }
      const mc = mean(ctrl), mt = mean(treat)
      return {
        id: s.id,
        control_mean: Math.round(mc),
        treatment_mean: Math.round(mt),
        control_std: Math.round(std(ctrl)),
        treatment_std: Math.round(std(treat)),
        pct_reduction: ((1 - mt / mc) * 100).toFixed(1),
        output_tokens_saved: Math.round(mc - mt),
        output_dollars_saved_per_call: ((mc - mt) / 1_000_000 * 15).toFixed(6),
      }
    }),
  }

  mkdirSync(resultsDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(resultsDir, `output-eval-${ts}.json`)
  writeFileSync(outPath, JSON.stringify(results, null, 2))
  process.stderr.write(`\nResults written to ${outPath}\n`)

  // Summary table
  process.stderr.write('\n=== Output Token Savings Summary ===\n')
  process.stderr.write('Scenario               | Control | Treatment | Saved | Reduction\n')
  process.stderr.write('-'.repeat(72) + '\n')
  for (const s of results.aggregate.per_scenario) {
    const name = s.id.padEnd(22)
    process.stderr.write(`${name} | ${String(s.control_mean).padStart(7)} | ${String(s.treatment_mean).padStart(9)} | ${String(s.output_tokens_saved).padStart(5)} | ${s.pct_reduction.padStart(5)}%\n`)
  }
  process.stderr.write('-'.repeat(72) + '\n')
  process.stderr.write(`WEIGHTED AVERAGE: ${results.aggregate.weighted_pct_reduction}% output token reduction\n`)
}

main().catch(err => { console.error(err); process.exit(1) })
