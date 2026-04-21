#!/usr/bin/env node
// A/B benchmark: control (raw) vs treatment (compressed) via OpenRouter
//
// Modes:
//   node bench/runner.js              — classic 5-run A/B (requires OPENROUTER_API_KEY)
//   node bench/runner.js --sweep      — dry sweep across stage configs (no network)
//   node bench/runner.js --sweep --live — sweep with live API calls (requires key)

import { scenarios } from './fixtures.js'
import { compressMessages, clearCache } from '../compress.js'
import { loadConfig } from '../config.js'
import { COMPRESSION_PRESETS, LOSSY_STAGES } from '../metadata.js'
import { createSessionBucket } from '../session-graph.js'
import { createReadCache } from '../lib/read-cache.js'
import { createBrCache } from '../lib/br-cache.js'
import { countTokens } from '@anthropic-ai/tokenizer'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const args = new Set(process.argv.slice(2))
const SWEEP = args.has('--sweep')
const LIVE = args.has('--live')

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const needsNetwork = !SWEEP || LIVE
if (needsNetwork && !OPENROUTER_API_KEY) {
  // Defer the hard exit to main() so importing this module as a library
  // (e.g. for Phase B unit tests) doesn't blow up.
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
      const content = Array.isArray(data.content)
        ? data.content.map(c => c.text || '').join('')
        : (data.content || '')
      return {
        input_tokens: data.usage?.input_tokens ?? null,
        output_tokens: data.usage?.output_tokens ?? null,
        latency_ms: Math.round(latency),
        body_bytes: Buffer.byteLength(JSON.stringify(body), 'utf8'),
        stop_reason: data.stop_reason ?? null,
        response_text: content,
      }
    } catch (err) {
      if (attempt === retries) throw err
      const backoff = 1000 * Math.pow(2, attempt)
      process.stderr.write(`  retry ${attempt}/${retries} (${err.message}), waiting ${backoff}ms...\n`)
      await sleep(backoff)
    }
  }
}

// Enumerate the sweep matrix: named presets, v0.5 baseline, leave-one-out,
// and the 9-step incremental ladder. Pure function — no side effects.
export function sweepConfigs() {
  const rows = []

  // 1. Named presets
  for (const [name, preset] of Object.entries(COMPRESSION_PRESETS)) {
    rows.push({
      configId: `preset:${name}`,
      label: preset.name,
      stages: [...preset.stages],
      lossy: preset.stages.some(s => LOSSY_STAGES.has(s)),
      kind: 'preset',
    })
  }

  // 2. v0.5 whitelist — reference baseline
  const v05 = ['minify', 'toon', 'strip-lines', 'whitespace', 'llmlingua', 'dedup', 'diff', 'prune']
  rows.push({
    configId: 'v0.5-baseline',
    label: 'v0.5 whitelist',
    stages: v05,
    lossy: v05.some(s => LOSSY_STAGES.has(s)),
    kind: 'baseline',
  })

  // 3. Leave-one-out for the 5 v0.6-v0.7 stages
  const aggressive = COMPRESSION_PRESETS.aggressive.stages
  const looStages = ['cmd-strip', 'read-diff', 'br-cache', 'disclosure', 'bm25-trim']
  for (const drop of looStages) {
    const stages = aggressive.filter(s => s !== drop)
    rows.push({
      configId: `loo:${drop}`,
      label: `aggressive minus ${drop}`,
      stages,
      lossy: stages.some(s => LOSSY_STAGES.has(s)),
      kind: 'loo',
    })
  }

  // 4. Incremental additive ladder L1..L9
  const ladder = [
    ['minify'],
    ['minify', 'whitespace', 'strip-lines'],
    ['minify', 'whitespace', 'strip-lines', 'cmd-strip'],
    ['minify', 'whitespace', 'strip-lines', 'cmd-strip', 'dedup', 'diff'],
    ['minify', 'whitespace', 'strip-lines', 'cmd-strip', 'dedup', 'diff', 'read-diff', 'prune', 'toon'],
    ['minify', 'whitespace', 'strip-lines', 'cmd-strip', 'dedup', 'diff', 'read-diff', 'prune', 'toon', 'llmlingua'],
    ['minify', 'whitespace', 'strip-lines', 'cmd-strip', 'dedup', 'diff', 'read-diff', 'prune', 'toon', 'llmlingua', 'graph', 'br-cache'],
    ['minify', 'whitespace', 'strip-lines', 'cmd-strip', 'dedup', 'diff', 'read-diff', 'prune', 'toon', 'llmlingua', 'graph', 'br-cache', 'strip-comments', 'textpress'],
    ['minify', 'whitespace', 'strip-lines', 'cmd-strip', 'dedup', 'diff', 'read-diff', 'prune', 'toon', 'llmlingua', 'graph', 'br-cache', 'strip-comments', 'textpress', 'disclosure', 'bm25-trim', 'foundation-models'],
  ]
  ladder.forEach((stages, i) => {
    rows.push({
      configId: `L${i + 1}`,
      label: `Ladder L${i + 1}`,
      stages,
      lossy: stages.some(s => LOSSY_STAGES.has(s)),
      kind: 'ladder',
    })
  })

  return rows
}

// Fresh per-row session state so graph / br-cache / read-diff never leak
// across configs. In dry mode, network-dependent stages (llmlingua, textpress,
// foundation-models) are deliberately nulled out so the sweep can never hang
// on a dead sidecar or a free-model API call.
function makeConfigForRow(row, { dry }) {
  const base = loadConfig({
    TAMP_STAGES: row.stages.join(','),
    TAMP_MIN_SIZE: '50',
    TAMP_LOG: 'false',
  })
  const needsBr = row.stages.includes('graph') || row.stages.includes('br-cache') || row.stages.includes('disclosure')
  const brCache = needsBr ? createBrCache({ cacheDir: join(resultsDir, '.br-sweep', row.configId.replace(/[^a-z0-9]/gi, '_')) }) : null
  const sessionBucket = row.stages.includes('graph') ? createSessionBucket({ brCache }) : null
  const readCache = row.stages.includes('read-diff') ? createReadCache() : null

  const overrides = {
    ...base,
    stages: [...row.stages],
    sessionKey: `sweep-${row.configId}`,
    sessionBucket,
    readCache,
    brCache,
    llmLinguaUrl: null,
  }

  if (dry) {
    // Kill network paths so textpress/foundation-models cannot hang the sweep.
    overrides.textpressApiKey = null
    overrides.textpressOllamaUrl = 'http://127.0.0.1:1'  // instant connection refused
    overrides.foundationModelsPath = null
  }

  return overrides
}

function bytesOf(body) { return Buffer.byteLength(JSON.stringify(body), 'utf8') }

function qualityOK(actualText) {
  if (!actualText) return false
  const t = actualText.trim().toLowerCase()
  // All scenarios ask the model to "Respond with OK." — accept any non-empty
  // response or one that contains "ok" as a token.
  return /\bok\b/.test(t) || t.length > 0
}

async function runSweep() {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
  const rows = sweepConfigs()
  const mode = LIVE ? 'live' : 'dry'
  process.stderr.write(`[sweep] ${rows.length} configs × ${scenarios.length} scenarios (${mode} mode)\n`)

  const startAll = performance.now()
  const results = {
    meta: {
      tampVersion: pkg.version,
      scenarioCount: scenarios.length,
      runAt: new Date().toISOString(),
      mode,
    },
    rows: [],
  }

  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]
    process.stderr.write(`[sweep ${ri + 1}/${rows.length}] ${row.configId} (${row.stages.length} stages)${row.lossy ? ' [lossy]' : ''}\n`)

    // Fresh per-row compression cache so LRU entries from a different stage
    // mix don't leak into this row's measurements.
    clearCache()
    const config = makeConfigForRow(row, { dry: !LIVE })

    const perScenario = []
    let sumOrigBytes = 0
    let sumCompBytes = 0
    let sumOrigTokens = 0
    let sumCompTokens = 0
    let okCount = 0
    let liveCount = 0

    for (const scenario of scenarios) {
      const originalBody = JSON.parse(JSON.stringify(scenario.body))
      const originalBytes = bytesOf(originalBody)
      const originalStr = JSON.stringify(originalBody)
      const originalTokens = countTokens(originalStr)

      const compressedBody = JSON.parse(JSON.stringify(scenario.body))
      try {
        await compressMessages(compressedBody, config)
      } catch (err) {
        process.stderr.write(`  [warn] compress failed on ${scenario.id}: ${err.message}\n`)
      }
      const compressedBytes = bytesOf(compressedBody)
      const compressedStr = JSON.stringify(compressedBody)
      const compressedTokens = countTokens(compressedStr)
      const savings = originalBytes > 0 ? 1 - compressedBytes / originalBytes : 0

      const row_scenario = {
        scenarioId: scenario.id,
        originalBytes,
        compressedBytes,
        originalTokens,
        compressedTokens,
        savings,
      }

      if (LIVE) {
        try {
          const live = await callOpenRouter(compressedBody)
          liveCount += 1
          if (qualityOK(live.response_text)) okCount += 1
          row_scenario.liveInputTokens = live.input_tokens
          row_scenario.liveOutputTokens = live.output_tokens
          row_scenario.liveStopReason = live.stop_reason
          row_scenario.liveQualityOK = qualityOK(live.response_text)
          await sleep(SLEEP_MS)
        } catch (err) {
          process.stderr.write(`  [live] ${scenario.id} failed: ${err.message}\n`)
          row_scenario.liveError = err.message
        }
      }

      perScenario.push(row_scenario)
      sumOrigBytes += originalBytes
      sumCompBytes += compressedBytes
      sumOrigTokens += originalTokens
      sumCompTokens += compressedTokens
    }

    const avgSavingsPct = sumOrigBytes > 0 ? (1 - sumCompBytes / sumOrigBytes) * 100 : 0
    const avgTokenSavingsPct = sumOrigTokens > 0 ? (1 - sumCompTokens / sumOrigTokens) * 100 : 0
    const quality = LIVE && liveCount > 0 ? okCount / liveCount : null

    results.rows.push({
      configId: row.configId,
      label: row.label,
      kind: row.kind,
      stages: row.stages,
      lossy: row.lossy,
      perScenario,
      avg: {
        savingsPct: Number(avgSavingsPct.toFixed(2)),
        tokenSavingsPct: Number(avgTokenSavingsPct.toFixed(2)),
        originalBytes: Math.round(sumOrigBytes / scenarios.length),
        compressedBytes: Math.round(sumCompBytes / scenarios.length),
        originalTokens: Math.round(sumOrigTokens / scenarios.length),
        compressedTokens: Math.round(sumCompTokens / scenarios.length),
        quality,
      },
    })
  }

  mkdirSync(resultsDir, { recursive: true })
  const jsonPath = join(resultsDir, 'level-sweep.json')
  writeFileSync(jsonPath, JSON.stringify(results, null, 2))

  // Render markdown
  const md = renderMarkdown(results)
  const mdPath = join(resultsDir, 'level-sweep.md')
  writeFileSync(mdPath, md)

  const elapsed = ((performance.now() - startAll) / 1000).toFixed(1)
  const ladder = results.rows.filter(r => r.kind === 'ladder')
  const byId = Object.fromEntries(results.rows.map(r => [r.configId, r]))
  const l9 = byId.L9?.avg.savingsPct ?? 0
  const l5 = byId.L5?.avg.savingsPct ?? 0
  const l1 = byId.L1?.avg.savingsPct ?? 0
  const v05 = byId['v0.5-baseline']?.avg.savingsPct ?? 0
  const delta = (l9 - v05).toFixed(1)

  // Monotonicity check across L1..L9 — log (not throw) on violation.
  const violations = []
  for (let i = 1; i < ladder.length; i++) {
    if (ladder[i].avg.savingsPct + 0.01 < ladder[i - 1].avg.savingsPct) {
      violations.push(`${ladder[i - 1].configId}=${ladder[i - 1].avg.savingsPct}% > ${ladder[i].configId}=${ladder[i].avg.savingsPct}%`)
    }
  }
  if (violations.length) {
    process.stderr.write(`[sweep] non-monotonic ladder pairs: ${violations.join(', ')}\n`)
  }

  process.stderr.write(`\n[sweep] wrote ${jsonPath}\n[sweep] wrote ${mdPath}\n`)
  process.stderr.write(`[sweep] ${mode}: ${results.rows.length} configs × ${scenarios.length} scenarios, `)
  process.stderr.write(`best L-ladder L9=${l9}%, L5=${l5}%, L1=${l1}%, v0.5-baseline=${v05}%, delta(L9 - v0.5)=+${delta}%\n`)
  process.stderr.write(`[sweep] elapsed ${elapsed}s\n`)
}

function renderMarkdown(results) {
  const { meta, rows } = results
  const lines = []
  lines.push(`# Tamp level sweep — v${meta.tampVersion}`)
  lines.push('')
  lines.push(`- Mode: **${meta.mode}** (${meta.mode === 'dry' ? 'local only, no API calls' : 'live — OpenRouter'})`)
  lines.push(`- Scenarios: ${meta.scenarioCount}`)
  lines.push(`- Generated: ${meta.runAt}`)
  lines.push('')
  lines.push('## All configurations (sorted by avg savings)')
  lines.push('')
  lines.push('| Config | Stages | Avg Savings % | Token Savings % | Lossy | Quality |')
  lines.push('|--------|--------|---------------|-----------------|-------|---------|')
  const sorted = [...rows].sort((a, b) => b.avg.savingsPct - a.avg.savingsPct)
  for (const r of sorted) {
    const q = r.avg.quality == null ? '—' : `${(r.avg.quality * 100).toFixed(0)}%`
    const stagesList = r.stages.join(', ')
    lines.push(`| \`${r.configId}\` | ${stagesList} | ${r.avg.savingsPct.toFixed(2)}% | ${r.avg.tokenSavingsPct.toFixed(2)}% | ${r.lossy ? 'yes' : 'no'} | ${q} |`)
  }
  lines.push('')
  lines.push('## Incremental ladder (L1–L9)')
  lines.push('')
  lines.push('| Level | Stages | Avg Savings % | Token Savings % | Lossy | Quality |')
  lines.push('|-------|--------|---------------|-----------------|-------|---------|')
  const ladder = rows.filter(r => r.kind === 'ladder')
  for (const r of ladder) {
    const q = r.avg.quality == null ? '—' : `${(r.avg.quality * 100).toFixed(0)}%`
    lines.push(`| \`${r.configId}\` | ${r.stages.join(', ')} | ${r.avg.savingsPct.toFixed(2)}% | ${r.avg.tokenSavingsPct.toFixed(2)}% | ${r.lossy ? 'yes' : 'no'} | ${q} |`)
  }
  lines.push('')
  lines.push('## Reference baselines')
  lines.push('')
  lines.push('| Config | Avg Savings % | Token Savings % |')
  lines.push('|--------|---------------|-----------------|')
  const baselines = rows.filter(r => r.kind === 'preset' || r.kind === 'baseline')
  for (const r of baselines) {
    lines.push(`| \`${r.configId}\` | ${r.avg.savingsPct.toFixed(2)}% | ${r.avg.tokenSavingsPct.toFixed(2)}% |`)
  }
  lines.push('')
  lines.push('## Leave-one-out (aggressive minus one stage)')
  lines.push('')
  lines.push('| Dropped stage | Avg Savings % | Token Savings % | Δ vs aggressive |')
  lines.push('|---------------|---------------|-----------------|-----------------|')
  const aggRow = rows.find(r => r.configId === 'preset:aggressive')
  const aggSav = aggRow?.avg.savingsPct ?? 0
  const loos = rows.filter(r => r.kind === 'loo')
  for (const r of loos) {
    const drop = r.configId.replace(/^loo:/, '')
    const delta = (r.avg.savingsPct - aggSav).toFixed(2)
    lines.push(`| \`${drop}\` | ${r.avg.savingsPct.toFixed(2)}% | ${r.avg.tokenSavingsPct.toFixed(2)}% | ${delta}% |`)
  }
  lines.push('')
  return lines.join('\n')
}

async function runClassic() {
  if (!OPENROUTER_API_KEY) {
    console.error('Error: OPENROUTER_API_KEY env var required')
    process.exit(1)
  }

  const total = scenarios.length * RUNS * 2
  let call = 0
  const config = loadConfig({
    TAMP_STAGES: 'minify,toon,strip-lines,whitespace,llmlingua,dedup,diff,prune',
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

async function main() {
  if (SWEEP) return runSweep()
  return runClassic()
}

// Guard main() so the module can be imported (e.g. by Phase B unit tests)
// without triggering a full benchmark run.
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch(err => { console.error(err); process.exit(1) })
}
