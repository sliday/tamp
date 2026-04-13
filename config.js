import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_STAGES, VERSION, COMPRESSION_PRESETS } from './metadata.js'

function parseBoolean(value, defaultValue) {
  if (value === undefined) return defaultValue
  if (value === 'true') return true
  if (value === 'false') return false
  return defaultValue
}

function resolvePreset(presetName, explicitStages) {
  // If user explicitly set TAMP_STAGES, ignore preset
  if (explicitStages && explicitStages.length > 0) {
    return explicitStages
  }

  // Resolve preset name to stages
  const preset = COMPRESSION_PRESETS[presetName]
  if (preset) {
    return preset.stages
  }

  // Default to balanced preset if preset name not recognized
  return COMPRESSION_PRESETS.balanced.stages
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

export function loadConfig(env = process.env) {
  const fileVars = (env === process.env) ? loadConfigFile() : {}
  const get = (key) => env[key] !== undefined ? env[key] : fileVars[key]

  // Get explicit stages (if user set TAMP_STAGES directly)
  const explicitStagesStr = get('TAMP_STAGES')
  const explicitStages = explicitStagesStr ? explicitStagesStr.split(',').map(s => s.trim()).filter(Boolean) : []

  // Get compression preset
  const presetName = get('TAMP_COMPRESSION_PRESET') || 'balanced'

  // Resolve preset to stages (or use explicit stages if provided)
  const stages = resolvePreset(presetName, explicitStages)

  return Object.freeze({
    version: VERSION,
    port: parseInt(get('TAMP_PORT'), 10) || 7778,
    upstream: get('TAMP_UPSTREAM') || 'https://api.anthropic.com',
    upstreams: Object.freeze({
      anthropic: get('TAMP_UPSTREAM') || 'https://api.anthropic.com',
      openai: get('TAMP_UPSTREAM_OPENAI') || 'https://api.openai.com',
      'openai-responses': get('TAMP_UPSTREAM_OPENAI') || 'https://api.openai.com',
      gemini: get('TAMP_UPSTREAM_GEMINI') || 'https://generativelanguage.googleapis.com',
    }),
    minSize: parseInt(get('TAMP_MIN_SIZE'), 10) || 200,
    stages,
    preset: presetName,
    outputMode: get('TAMP_OUTPUT_MODE') || 'balanced',
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

# Compression preset (conservative | balanced | aggressive)
# TAMP_COMPRESSION_PRESET=balanced

# Explicit stages (overrides preset if set)
# TAMP_STAGES=minify,toon,strip-lines,whitespace,llmlingua,dedup,diff,prune

# Output compression mode (conservative | balanced | aggressive)
# TAMP_OUTPUT_MODE=balanced

# Auto-detect task type for output compression (true | false)
# TAMP_AUTO_DETECT_TASK_TYPE=true

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
