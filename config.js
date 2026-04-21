import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_STAGES,
  VERSION,
  COMPRESSION_PRESETS,
  COMPRESSION_LEVELS,
  DEFAULT_LEVEL,
  LEVEL_ALIASES,
  resolveLevel,
} from './metadata.js'

const VALID_OUTPUT_MODES = new Set(['off', 'conservative', 'balanced', 'aggressive'])

function parseBoolean(value, defaultValue) {
  if (value === undefined) return defaultValue
  if (value === 'true') return true
  if (value === 'false') return false
  return defaultValue
}

// Coerce numeric strings to integers; leave alias strings untouched.
// Returns { value, valid } — value is the coerced input for resolveLevel(),
// valid is whether the input is recognisable as a level at all.
function coerceLevelInput(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null, valid: false }
  if (typeof raw === 'number') {
    const v = resolveLevel(raw) ? raw : null
    return { value: v, valid: v !== null }
  }
  const s = String(raw).trim()
  if (s === '') return { value: null, valid: false }
  if (/^-?\d+$/.test(s)) {
    const n = parseInt(s, 10)
    const v = resolveLevel(n) ? n : null
    return { value: v, valid: v !== null }
  }
  if (s in LEVEL_ALIASES) return { value: s, valid: true }
  return { value: null, valid: false }
}

// Convert a level input (number or alias) to its canonical integer.
function levelInputToInt(input) {
  if (typeof input === 'number') return input
  if (typeof input === 'string' && input in LEVEL_ALIASES) return LEVEL_ALIASES[input]
  return null
}

// Preset levels are the "anchor" rungs of the ladder — when a resolved level
// matches one of these, prefer the preset's stage ordering. This preserves
// the L4 === conservative / L5 === balanced / L8 === aggressive identity
// promise and keeps pre-Phase-C stage ordering stable for downstream code.
const LEVEL_TO_PRESET = Object.freeze({
  4: 'conservative',
  5: 'balanced',
  8: 'aggressive',
})

function stagesForLevel(level) {
  const presetName = LEVEL_TO_PRESET[level]
  if (presetName) return [...COMPRESSION_PRESETS[presetName].stages]
  return [...COMPRESSION_LEVELS[level].stages]
}

export const CONFIG_PATH = join(homedir(), '.config', 'tamp', 'config')

export function loadConfigFile(path) {
  const filePath = path || process.env.TAMP_CONFIG || CONFIG_PATH
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n')
    const vars = {}
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq < 1) continue
      const key = line.slice(0, eq).trim()
      let val = line.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      vars[key] = val
    }
    return vars
  } catch { return {} }
}

export function loadConfig(env = process.env, options = {}) {
  const fileVars = (env === process.env) ? loadConfigFile() : {}
  const get = (key) => env[key] !== undefined ? env[key] : fileVars[key]

  // --- Stage/level resolution with explicit precedence ---
  // 1. TAMP_STAGES (explicit stage list)     — power-user override
  // 2. --level CLI flag (options.levelOverride)
  // 3. TAMP_LEVEL env
  // 4. TAMP_COMPRESSION_PRESET env
  // 5. config-file `level` field
  // 6. DEFAULT_LEVEL (5)

  const explicitStagesStr = get('TAMP_STAGES')
  const explicitStages = explicitStagesStr
    ? explicitStagesStr.split(',').map(s => s.trim()).filter(Boolean)
    : []

  const presetNameRaw = get('TAMP_COMPRESSION_PRESET')
  const presetExplicit = typeof presetNameRaw === 'string' && presetNameRaw.length > 0

  const fileLevelRaw = fileVars.level
  const levelFlagRaw = options.levelOverride
  const levelEnvRaw = get('TAMP_LEVEL')

  let stages = null
  let level = null
  let levelSource = null
  let presetName = presetExplicit ? presetNameRaw : 'balanced'

  if (explicitStages.length > 0) {
    stages = explicitStages
    level = null
    levelSource = 'stages-env'
  } else {
    // Try level inputs in precedence order: CLI flag > env
    const candidates = [
      { raw: levelFlagRaw, source: 'level-flag' },
      { raw: levelEnvRaw,  source: 'level-env' },
    ]
    let chosen = null
    for (const c of candidates) {
      if (c.raw === undefined || c.raw === null || c.raw === '') continue
      const { value, valid } = coerceLevelInput(c.raw)
      if (valid) {
        chosen = { value, source: c.source }
        break
      } else {
        const label = c.source === 'level-flag' ? '--level' : 'TAMP_LEVEL'
        process.stderr.write(
          `[tamp] invalid ${label}=${JSON.stringify(c.raw)} — expected 1..9 or one of: ${Object.keys(LEVEL_ALIASES).join(', ')}. Ignoring.\n`
        )
      }
    }

    if (chosen) {
      level = levelInputToInt(chosen.value)
      stages = stagesForLevel(level)
      levelSource = chosen.source
    } else if (presetExplicit) {
      const preset = COMPRESSION_PRESETS[presetNameRaw]
      if (preset) {
        stages = [...preset.stages]
        level = typeof preset.level === 'number' ? preset.level : null
        levelSource = 'preset-env'
      } else {
        // Unknown preset name — fall through to default balanced
        stages = [...COMPRESSION_PRESETS.balanced.stages]
        level = COMPRESSION_PRESETS.balanced.level
        levelSource = 'default'
        presetName = 'balanced'
      }
    } else if (fileLevelRaw !== undefined && fileLevelRaw !== '') {
      const { value, valid } = coerceLevelInput(fileLevelRaw)
      if (valid) {
        level = levelInputToInt(value)
        stages = stagesForLevel(level)
        levelSource = 'config-file'
      } else {
        process.stderr.write(
          `[tamp] invalid level=${JSON.stringify(fileLevelRaw)} in config file — expected 1..9 or one of: ${Object.keys(LEVEL_ALIASES).join(', ')}. Ignoring.\n`
        )
        level = DEFAULT_LEVEL
        stages = stagesForLevel(DEFAULT_LEVEL)
        levelSource = 'default'
      }
    } else {
      level = DEFAULT_LEVEL
      stages = stagesForLevel(DEFAULT_LEVEL)
      levelSource = 'default'
    }
  }

  // Output mode precedence (highest wins):
  //   1. TAMP_OUTPUT_MODE      — explicit per-session override
  //   2. TAMP_OUTPUT_DEFAULT   — env-level default seed (v1.5.0 parity)
  //   3. 'off'                 — Caveman disabled unless opted in
  const explicitOutputMode = get('TAMP_OUTPUT_MODE')
  const defaultOutputMode = get('TAMP_OUTPUT_DEFAULT')
  let outputMode = explicitOutputMode || defaultOutputMode || 'off'
  if (!VALID_OUTPUT_MODES.has(outputMode)) outputMode = 'off'

  return Object.freeze({
    version: VERSION,
    port: parseInt(get('TAMP_PORT'), 10) || 7778,
    upstream: get('TAMP_UPSTREAM') || 'https://api.anthropic.com',
    upstreams: Object.freeze({
      anthropic: get('TAMP_UPSTREAM') || 'https://api.anthropic.com',
      openai: get('TAMP_UPSTREAM_OPENAI') || 'https://api.openai.com',
      'openai-responses': get('TAMP_UPSTREAM_OPENAI') || 'https://api.openai.com',
      gemini: get('TAMP_UPSTREAM_GEMINI') || 'https://generativelanguage.googleapis.com',
      // Kimi Code (subscription CLI) — proprietary path /coding/v1/*
      kimi: get('TAMP_UPSTREAM_KIMI') || 'https://api.kimi.com',
      // Moonshot public OpenAI-compat API — strictly /v1/*
      moonshot: get('TAMP_UPSTREAM_MOONSHOT') || 'https://api.moonshot.cn',
    }),
    // Codex CLI ChatGPT Plus routes to https://chatgpt.com/backend-api/codex
    // by default (not api.openai.com). Set TAMP_DISABLE_CHATGPT_ROUTE=1 to
    // force legacy api.openai.com routing even when a JWT bearer / account
    // id is detected.
    disableChatgptRoute: parseBoolean(get('TAMP_DISABLE_CHATGPT_ROUTE'), false) ||
      get('TAMP_DISABLE_CHATGPT_ROUTE') === '1',
    chatgptUpstream: get('TAMP_UPSTREAM_CHATGPT') || 'https://chatgpt.com',
    minSize: parseInt(get('TAMP_MIN_SIZE'), 10) || 200,
    stages,
    preset: presetName,
    level,
    levelSource,
    outputMode,
    outputModeDefault: defaultOutputMode && VALID_OUTPUT_MODES.has(defaultOutputMode) ? defaultOutputMode : null,
    agent: get('TAMP_AGENT') || null,
    autoDetectTaskType: parseBoolean(get('TAMP_AUTO_DETECT_TASK_TYPE'), true),
    log: get('TAMP_LOG') !== 'false',
    logFile: get('TAMP_LOG_FILE') || null,
    maxBody: parseInt(get('TAMP_MAX_BODY'), 10) || 10_485_760,
    cacheSafe: parseBoolean(get('TAMP_CACHE_SAFE'), true),
    llmLinguaUrl: get('TAMP_LLMLINGUA_URL') || null,
    textpressOllamaUrl: get('TAMP_TEXTPRESS_OLLAMA_URL') || 'http://localhost:11434',
    textpressOllamaModel: get('TAMP_TEXTPRESS_OLLAMA_MODEL') || 'qwen3.5:0.8b',
    textpressModel: get('TAMP_TEXTPRESS_MODEL') || 'google/gemini-3.1-flash-lite-preview',
    textpressApiKey: get('TAMP_TEXTPRESS_API_KEY') || get('OPENROUTER_API_KEY') || null,
    foundationModelsPath: get('TAMP_FOUNDATION_MODELS_PATH') || 'apfel',
    foundationModelsTimeout: parseInt(get('TAMP_FOUNDATION_MODELS_TIMEOUT'), 10) || 10000,
    foundationModelsSystemPrompt: get('TAMP_FOUNDATION_MODELS_SYSTEM_PROMPT') || 'Compress this text to 50% length while preserving all key information and meaning. Return only the compressed text without explanation.',
    tokenCost: parseFloat(get('TAMP_TOKEN_COST')) || 3,
  })
}

export const CONFIG_TEMPLATE = `# Tamp configuration
# Environment variables override these values
# https://github.com/sliday/tamp

# TAMP_PORT=7778
# TAMP_UPSTREAM=https://api.anthropic.com
# TAMP_UPSTREAM_OPENAI=https://api.openai.com
# TAMP_UPSTREAM_GEMINI=https://generativelanguage.googleapis.com
# TAMP_UPSTREAM_KIMI=https://api.kimi.com
# TAMP_UPSTREAM_MOONSHOT=https://api.moonshot.cn

# Codex CLI ChatGPT Plus routing (OAuth/JWT bearers land on chatgpt.com)
# Set to 1 to force legacy api.openai.com routing even when JWT is detected
# TAMP_DISABLE_CHATGPT_ROUTE=0

# Compression level 1..9 (or: conservative, balanced, aggressive, max)
# level=5

# Compression preset (conservative | balanced | aggressive)
# TAMP_COMPRESSION_PRESET=balanced

# Explicit stages (overrides preset if set)
# TAMP_STAGES=minify,toon,strip-lines,whitespace,llmlingua,dedup,diff,prune

# Output compression mode (conservative | balanced | aggressive | off)
# TAMP_OUTPUT_MODE=balanced

# Env-level default for output mode (used when TAMP_OUTPUT_MODE is unset).
# Valid: off | conservative | balanced | aggressive
# TAMP_OUTPUT_DEFAULT=off

# Auto-detect task type for output compression (true | false)
# TAMP_AUTO_DETECT_TASK_TYPE=true

# Agent identifier for per-agent output rule overrides
# (e.g. codex, cursor, cline, aider, claude-code)
# TAMP_AGENT=

# TAMP_MIN_SIZE=200
# TAMP_LOG=true
# TAMP_LOG_FILE=
# TAMP_MAX_BODY=10485760
# TAMP_CACHE_SAFE=true
# TAMP_TOKEN_COST=3
# TAMP_FOUNDATION_MODELS_PATH=apfel
# TAMP_FOUNDATION_MODELS_TIMEOUT=10000
# TAMP_FOUNDATION_MODELS_SYSTEM_PROMPT=
`
