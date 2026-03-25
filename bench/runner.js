#!/usr/bin/env node
// A/B benchmark: control (raw) vs treatment (compressed) via OpenRouter

import { scenarios } from './fixtures.js'
import { compressMessages } from '../compress.js'
import { loadConfig } from '../config.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
if (!OPENROUTER_API_KEY) {
  console.error('Error: OPENROUTER_API_KEY env var required')
  process.exit(1)
}

const API_URL = 'https://openrouter.ai/api/v1/messages'
const RUNS = 5
const SLEEP_MS = 1000
const MAX_RETRIES = 3

const __dirname = dirname(fileURLToPath(import.meta.url))
const resultsDir = join(__dirname, 'results')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function callOpenRouter(body, retries = MAX_RETRIES) {
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
      return {
        input_tokens: data.usage?.input_tokens ?? null,
        output_tokens: data.usage?.output_tokens ?? null,
        latency_ms: Math.round(latency),
        body_bytes: Buffer.byteLength(JSON.stringify(body), 'utf8'),
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
  const config = loadConfig({
    TAMP_STAGES: 'minify,toon,strip-lines,whitespace,llmlingua',
    TAMP_LLMLINGUA_URL: 'http://localhost:8788',
    TAMP_MIN_SIZE: '50',
    TAMP_LOG: 'false',
  })

  const results = {
    meta: {
      timestamp: new Date().toISOString(),
      model: 'anthropic/claude-sonnet-4.6',
      pricing: { input_per_mtok: 3.00, output_per_mtok: 15.00 },
      runs: RUNS,
    },
    scenarios: [],
  }

  for (const scenario of scenarios) {
    const scenarioResult = { id: scenario.id, name: scenario.name, description: scenario.description, expectedCompression: scenario.expectedCompression, runs: [] }

    for (let run = 0; run < RUNS; run++) {
      // Control: raw body
      call++
      process.stderr.write(`[${call}/${total}] ${scenario.id} control run ${run + 1}...\n`)
      const controlBody = JSON.parse(JSON.stringify(scenario.body))
      const control = await callOpenRouter(controlBody)
      await sleep(SLEEP_MS)

      // Treatment: compressed body
      call++
      process.stderr.write(`[${call}/${total}] ${scenario.id} treatment run ${run + 1}...\n`)
      const treatmentBody = JSON.parse(JSON.stringify(scenario.body))
      const compressStart = performance.now()
      const { body: compressed, stats } = await compressMessages(treatmentBody, config)
      const compression_ms = Math.round(performance.now() - compressStart)
      const treatment = await callOpenRouter(compressed)
      treatment.compression_ms = compression_ms
      treatment.compress_stats = stats
      await sleep(SLEEP_MS)

      scenarioResult.runs.push({ control, treatment })
    }

    results.scenarios.push(scenarioResult)
    process.stderr.write(`  done: ${scenario.id}\n`)
  }

  mkdirSync(resultsDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(resultsDir, `raw-${ts}.json`)
  writeFileSync(outPath, JSON.stringify(results, null, 2))
  process.stderr.write(`\nResults written to ${outPath}\n`)
}

main().catch(err => { console.error(err); process.exit(1) })
