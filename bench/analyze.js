#!/usr/bin/env node
// Statistical analysis of benchmark results

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const resultsDir = join(__dirname, 'results')

function findLatestRaw() {
  const files = readdirSync(resultsDir).filter(f => f.startsWith('raw-') && f.endsWith('.json')).sort()
  if (!files.length) { console.error('No raw results found. Run bench/runner.js first.'); process.exit(1) }
  return join(resultsDir, files[files.length - 1])
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length }
function stddev(arr) { const m = mean(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1)) }

// t-distribution critical value for 95% CI, df=4 (5 runs - 1)
const T_CRIT = 2.776

function analyzeScenario(scenario, pricing) {
  const n = scenario.runs.length
  const controlTokens = scenario.runs.map(r => r.control.input_tokens)
  const treatmentTokens = scenario.runs.map(r => r.treatment.input_tokens)
  const savings = scenario.runs.map(r => r.control.input_tokens - r.treatment.input_tokens)
  const pctReductions = scenario.runs.map(r => r.control.input_tokens > 0 ? (1 - r.treatment.input_tokens / r.control.input_tokens) * 100 : 0)

  const controlBytes = scenario.runs.map(r => r.control.body_bytes)
  const treatmentBytes = scenario.runs.map(r => r.treatment.body_bytes)
  const charCompressions = scenario.runs.map(r => r.control.body_bytes > 0 ? r.treatment.body_bytes / r.control.body_bytes : 1)

  const compressionTimes = scenario.runs.map(r => r.treatment.compression_ms)

  const controlOutput = scenario.runs.map(r => r.control.output_tokens)
  const treatmentOutput = scenario.runs.map(r => r.treatment.output_tokens)

  const savingsMean = mean(savings)
  const savingsStd = n > 1 ? stddev(savings) : 0
  const ci = T_CRIT * (savingsStd / Math.sqrt(n))

  const pctMean = mean(pctReductions)
  const pctStd = n > 1 ? stddev(pctReductions) : 0
  const pctCi = T_CRIT * (pctStd / Math.sqrt(n))

  const costPerToken = pricing.input_per_mtok / 1_000_000
  const dollarSaved = savingsMean * costPerToken

  return {
    id: scenario.id,
    name: scenario.name,
    expectedCompression: scenario.expectedCompression,
    n,
    control: {
      input_tokens: { mean: mean(controlTokens), std: n > 1 ? stddev(controlTokens) : 0 },
      output_tokens: { mean: mean(controlOutput), std: n > 1 ? stddev(controlOutput) : 0 },
      body_bytes: { mean: mean(controlBytes) },
    },
    treatment: {
      input_tokens: { mean: mean(treatmentTokens), std: n > 1 ? stddev(treatmentTokens) : 0 },
      output_tokens: { mean: mean(treatmentOutput), std: n > 1 ? stddev(treatmentOutput) : 0 },
      body_bytes: { mean: mean(treatmentBytes) },
    },
    savings: {
      tokens: { mean: savingsMean, std: savingsStd, ci_95: [savingsMean - ci, savingsMean + ci] },
      pct: { mean: pctMean, std: pctStd, ci_95: [pctMean - pctCi, pctMean + pctCi] },
    },
    char_compression_ratio: mean(charCompressions),
    dollar_saved_per_request: dollarSaved,
    compression_ms: { mean: mean(compressionTimes), std: n > 1 ? stddev(compressionTimes) : 0 },
    semantic_check: controlOutput.every((v, i) => v === treatmentOutput[i]) ? 'PASS' : 'WARN',
  }
}

function main() {
  const rawPath = process.argv[2] || findLatestRaw()
  const raw = JSON.parse(readFileSync(rawPath, 'utf8'))
  const pricing = raw.meta.pricing

  const scenarioAnalyses = raw.scenarios.map(s => analyzeScenario(s, pricing))

  // Weighted average by control tokens
  const totalControlTokens = scenarioAnalyses.reduce((s, a) => s + a.control.input_tokens.mean * a.n, 0)
  const totalSavings = scenarioAnalyses.reduce((s, a) => s + a.savings.tokens.mean * a.n, 0)
  const weightedPct = totalControlTokens > 0 ? (totalSavings / totalControlTokens) * 100 : 0

  // Session projection: 200 req/session, 60% compressible
  const sessionReqs = 200
  const compressibleRate = 0.6
  const avgSavingsPerReq = totalSavings / scenarioAnalyses.reduce((s, a) => s + a.n, 0)
  const sessionTokensSaved = sessionReqs * compressibleRate * avgSavingsPerReq
  const sessionDollarsSaved = sessionTokensSaved * (pricing.input_per_mtok / 1_000_000)

  const analysis = {
    meta: { ...raw.meta, analysis_timestamp: new Date().toISOString(), source_file: rawPath },
    scenarios: scenarioAnalyses,
    aggregate: {
      weighted_pct_reduction: weightedPct,
      session_projection: {
        requests_per_session: sessionReqs,
        compressible_rate: compressibleRate,
        tokens_saved_per_session: Math.round(sessionTokensSaved),
        dollars_saved_per_session: sessionDollarsSaved,
      },
    },
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(resultsDir, `analysis-${ts}.json`)
  writeFileSync(outPath, JSON.stringify(analysis, null, 2))

  // Print summary table
  console.log('\n=== Tamp Compression Benchmark Results ===\n')
  console.log('Scenario                   | Control  | Treatment | Savings  | %Reduc    | 95% CI          | $/req     | Semantic')
  console.log('---------------------------|----------|-----------|----------|-----------|-----------------|-----------|--------')
  for (const s of scenarioAnalyses) {
    const name = s.name.padEnd(26).slice(0, 26)
    const ctrl = String(Math.round(s.control.input_tokens.mean)).padStart(7)
    const treat = String(Math.round(s.treatment.input_tokens.mean)).padStart(8)
    const sav = String(Math.round(s.savings.tokens.mean)).padStart(7)
    const pct = `${s.savings.pct.mean.toFixed(1)}%`.padStart(8)
    const ci = `[${s.savings.pct.ci_95[0].toFixed(1)}, ${s.savings.pct.ci_95[1].toFixed(1)}]`.padStart(16)
    const dollar = `$${s.dollar_saved_per_request.toFixed(5)}`.padStart(9)
    const sem = s.semantic_check.padStart(7)
    console.log(`${name} | ${ctrl} | ${treat} | ${sav} | ${pct} | ${ci} | ${dollar} | ${sem}`)
  }
  console.log(`\nWeighted avg reduction: ${weightedPct.toFixed(1)}%`)
  console.log(`Session projection (${sessionReqs} req, ${compressibleRate * 100}% compressible): ${Math.round(sessionTokensSaved)} tokens, $${sessionDollarsSaved.toFixed(4)} saved`)
  console.log(`\nAnalysis written to ${outPath}`)
}

main()
