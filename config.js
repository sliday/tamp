import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_STAGES, VERSION } from './metadata.js'

function parseBoolean(value, defaultValue) {
  if (value === undefined) return defaultValue
  if (value === 'true') return true
  if (value === 'false') return false
  return defaultValue
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

  const stages = (get('TAMP_STAGES') || DEFAULT_STAGES.join(',')).split(',').map(s => s.trim()).filter(Boolean)
  return Object.freeze({
    version: VERSION,
    port: parseInt(get('TAMP_PORT'), 10) || 7778,
    upstream: get('TAMP_UPSTREAM') || 'https://api.anthropic.com',
    upstreams: Object.freeze({
      anthropic: get('TAMP_UPSTREAM') || 'https://api.anthropic.com',
      openai: get('TAMP_UPSTREAM_OPENAI') || 'https://api.openai.com',
      gemini: get('TAMP_UPSTREAM_GEMINI') || 'https://generativelanguage.googleapis.com',
    }),
    minSize: parseInt(get('TAMP_MIN_SIZE'), 10) || 200,
    stages,
    log: get('TAMP_LOG') !== 'false',
    logFile: get('TAMP_LOG_FILE') || null,
    maxBody: parseInt(get('TAMP_MAX_BODY'), 10) || 10_485_760,
    cacheSafe: parseBoolean(get('TAMP_CACHE_SAFE'), true),
    llmLinguaUrl: get('TAMP_LLMLINGUA_URL') || null,
    textpressOllamaUrl: get('TAMP_TEXTPRESS_OLLAMA_URL') || 'http://localhost:11434',
    textpressOllamaModel: get('TAMP_TEXTPRESS_OLLAMA_MODEL') || 'qwen3.5:0.8b',
    textpressModel: get('TAMP_TEXTPRESS_MODEL') || 'google/gemini-3.1-flash-lite-preview',
    textpressApiKey: get('TAMP_TEXTPRESS_API_KEY') || get('OPENROUTER_API_KEY') || null,
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
# TAMP_STAGES=minify,toon,strip-lines,whitespace,llmlingua,dedup,diff,prune
# TAMP_MIN_SIZE=200
# TAMP_LOG=true
# TAMP_LOG_FILE=
# TAMP_MAX_BODY=10485760
# TAMP_CACHE_SAFE=true
# TAMP_TOKEN_COST=3
`
