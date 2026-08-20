#!/usr/bin/env node
// Recommended-defaults eval: for one candidate config, measure (a) real input
// token savings on the eval model and (b) QA accuracy on the compressed
// context vs an uncompressed control. Control answers are cached on disk so
// sweeping N configs costs N treatment runs, not 2N.
//
// Usage:
//   OPENROUTER_API_KEY=... node bench/recommend-eval.js --id L5 --level 5
//   node bench/recommend-eval.js --id ms50 --level 5 --min-size 50
//   node bench/recommend-eval.js --id out-bal --level 5 --output-mode balanced
//
// Last stdout line is machine-readable:  RESULT {...json...}

import { compressMessages, clearCache } from '../compress.js'
import { loadConfig } from '../config.js'
import { scenarios } from './recommend-fixtures.js'
import { countTokens } from '@anthropic-ai/tokenizer'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const KEY = process.env.OPENROUTER_API_KEY
if (!KEY) { console.error('Set OPENROUTER_API_KEY'); process.exit(1) }

const MODEL = process.env.RECOMMEND_MODEL || '~deepseek/deepseek-v4-flash-latest'
const ENDPOINT = 'https://openrouter.ai/api/v1/messages'
const CONTROL_CACHE = 'bench/results/.recommend-control.json'
const SIDECAR_URL = process.env.TAMP_LLMLINGUA_URL || 'http://127.0.0.1:8788'

// --- args ---
const argv = process.argv.slice(2)
function arg(name, dflt = null) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}
const ID = arg('id', 'candidate')
const LEVEL = arg('level')
const STAGES = arg('stages')
const MIN_SIZE = arg('min-size', '200')
const OUTPUT_MODE = arg('output-mode', 'off')

async function sidecarUp() {
  try {
    const r = await fetch(`${SIDECAR_URL}/health`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch { return false }
}

async function buildConfig() {
  const env = {
    TAMP_MIN_SIZE: MIN_SIZE,
    TAMP_LOG: 'false',
    TAMP_OUTPUT_MODE: OUTPUT_MODE,
    TAMP_TEXTPRESS_API_KEY: KEY,
  }
  if (STAGES) env.TAMP_STAGES = STAGES
  else if (LEVEL) env.TAMP_LEVEL = LEVEL
  let cfg = loadConfig(env)
  if (cfg.stages.includes('llmlingua')) {
    if (await sidecarUp()) {
      cfg = loadConfig({ ...env, TAMP_LLMLINGUA_URL: SIDECAR_URL })
    } else {
      // Mirror bin/tamp.js: drop the stage when the sidecar is unavailable.
      console.error(`[recommend-eval] llmlingua sidecar down at ${SIDECAR_URL} — dropping stage`)
      env.TAMP_STAGES = cfg.stages.filter(s => s !== 'llmlingua').join(',')
      cfg = loadConfig(env)
    }
  }
  return cfg
}

// The question rides as a text block inside the SAME user message as the
// tool_result. Under cache-safe extraction tamp compresses only the latest
// eligible message group — in the real proxy that group is the request where
// the tool_result arrives, which is exactly what this shape simulates.
function makeBody(scenario, question) {
  const messages = JSON.parse(JSON.stringify(scenario.body))
  const last = messages[messages.length - 1]
  if (last.role !== 'user' || !Array.isArray(last.content)) throw new Error(`scenario must end with a user tool_result message`)
  last.content.push({ type: 'text', text: question })
  return {
    model: MODEL,
    max_tokens: 512,
    temperature: 0,
    thinking: { type: 'disabled' },
    system: 'You are a precise assistant. Answer questions about the provided tool output concisely.',
    messages,
  }
}

async function callAPI(body, retries = 3) {
  for (let a = 0; a <= retries; a++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      })
      if (res.status === 429 || res.status >= 500) {
        await new Promise(r => setTimeout(r, 1500 * (a + 1)))
        continue
      }
      if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const data = await res.json()
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim()
      // Provider-side context caching means input_tokens only counts uncached
      // tokens — sum all input buckets for the true prompt size.
      const u = data.usage || {}
      return {
        text,
        in: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        out: u.output_tokens ?? 0,
      }
    } catch (e) {
      if (a === retries) throw e
      await new Promise(r => setTimeout(r, 1500 * (a + 1)))
    }
  }
}

function grade(answer, q) {
  const t = (answer || '').toLowerCase()
  if (q.match === 'exact') return t.includes(String(q.expected).toLowerCase())
  if (q.match === 'regex') return q.pattern.test(answer || '')
  if (q.match === 'set') return q.expected.filter(k => t.includes(k.toLowerCase())).length >= q.threshold
  return false
}

function loadControlCache() {
  try { return JSON.parse(readFileSync(CONTROL_CACHE, 'utf8')) } catch { return {} }
}

function keyFor(scenario, qIdx, question) {
  return createHash('sha256').update(MODEL + '|' + scenario.id + '|' + qIdx + '|' + question + '|' + JSON.stringify(scenario.body)).digest('hex').slice(0, 16)
}

async function main() {
  const config = await buildConfig()
  console.error(`[recommend-eval] id=${ID} stages=${config.stages.join(',')} minSize=${config.minSize} outputMode=${config.outputMode}`)

  mkdirSync('bench/results', { recursive: true })
  const controlCache = loadControlCache()
  let cacheDirty = false

  const rows = []
  let tokBefore = 0, tokAfter = 0, ctrlOut = 0, treatOut = 0
  let ctrlPass = 0, treatPass = 0, total = 0

  for (const scenario of scenarios) {
    for (let qi = 0; qi < scenario.questions.length; qi++) {
      const q = scenario.questions[qi]
      const ck = keyFor(scenario, qi, q.q)

      // Control (uncompressed) — cached across sweep runs.
      let ctrl = controlCache[ck]
      if (!ctrl) {
        ctrl = await callAPI(makeBody(scenario, q.q))
        ctrl.pass = grade(ctrl.text, q)
        controlCache[ck] = ctrl
        cacheDirty = true
        await new Promise(r => setTimeout(r, 300))
      }

      // Treatment (compressed). Savings measured client-side with the Claude
      // tokenizer — provider-side context caching makes API usage numbers
      // unusable for prompt-size comparison.
      clearCache()
      const body = makeBody(scenario, q.q)
      const tb = countTokens(JSON.stringify(body.messages))
      const { body: compressed } = await compressMessages(body, config)
      const ta = countTokens(JSON.stringify(compressed.messages))
      const treat = await callAPI(compressed)
      let tPass = grade(treat.text, q)
      await new Promise(r => setTimeout(r, 300))

      // DeepSeek is not perfectly deterministic at temperature 0. When the
      // arms disagree, revote the treatment arm (majority of 3) so a single
      // flaky sample can't decide the gate. Control entries revote once too,
      // then stay cached.
      if (tPass !== ctrl.pass) {
        if (!ctrl.revoted) {
          const votes = [ctrl.pass]
          for (let v = 0; v < 2; v++) {
            const c2 = await callAPI(makeBody(scenario, q.q))
            votes.push(grade(c2.text, q))
            await new Promise(r => setTimeout(r, 300))
          }
          ctrl.pass = votes.filter(Boolean).length >= 2
          ctrl.revoted = true
          controlCache[ck] = ctrl
          cacheDirty = true
        }
        if (tPass !== ctrl.pass) {
          const votes = [tPass]
          for (let v = 0; v < 2; v++) {
            const t2 = await callAPI(compressed)
            votes.push(grade(t2.text, q))
            await new Promise(r => setTimeout(r, 300))
          }
          tPass = votes.filter(Boolean).length >= 2
        }
      }

      total++
      if (ctrl.pass) ctrlPass++
      if (tPass) treatPass++
      tokBefore += tb; tokAfter += ta
      ctrlOut += ctrl.out; treatOut += treat.out

      const mark = (a, b) => a === b ? (a ? '=pass' : '=fail') : (b ? 'GAIN' : 'LOSS')
      console.error(`  ${scenario.id}#${qi} ctrl:${ctrl.pass ? 'P' : 'F'} treat:${tPass ? 'P' : 'F'} [${mark(ctrl.pass, tPass)}] tok ${tb}→${ta} (${((1 - ta / tb) * 100).toFixed(0)}%) | "${(treat.text || '').slice(0, 60).replace(/\n/g, ' ')}"`)
      rows.push({ scenario: scenario.id, q: qi, ctrlPass: ctrl.pass, treatPass: tPass, tokBefore: tb, tokAfter: ta, ctrlText: ctrl.text?.slice(0, 200), treatText: treat.text?.slice(0, 200) })
    }
  }

  if (cacheDirty) writeFileSync(CONTROL_CACHE, JSON.stringify(controlCache, null, 1))

  const savings = tokBefore > 0 ? (1 - tokAfter / tokBefore) * 100 : 0
  const outSavings = ctrlOut > 0 ? (1 - treatOut / ctrlOut) * 100 : 0
  // Unweighted mean across rows — approximates "typical request" savings,
  // vs the token-weighted number the wallet feels on this corpus mix.
  const rowMean = rows.length ? rows.reduce((a, r) => a + (1 - r.tokAfter / r.tokBefore) * 100, 0) / rows.length : 0
  // Quality gate: compressed run may lose at most 1 answer vs control.
  const gate = treatPass >= ctrlPass - 1
  const score = gate ? +savings.toFixed(2) : 0

  const result = {
    id: ID, model: MODEL,
    stages: config.stages, minSize: config.minSize, outputMode: config.outputMode,
    total, ctrlPass, treatPass, gate,
    inputSavingsPct: +savings.toFixed(2),
    rowMeanSavingsPct: +rowMean.toFixed(2),
    outputSavingsPct: +outSavings.toFixed(2),
    tokBefore, tokAfter, ctrlOut, treatOut,
    score,
  }
  const outPath = `bench/results/recommend-${ID}.json`
  writeFileSync(outPath, JSON.stringify({ ...result, rows }, null, 2))
  console.error(`[recommend-eval] wrote ${outPath}`)
  console.log('RESULT ' + JSON.stringify(result))
}

main().catch(e => { console.error(e); process.exit(1) })
