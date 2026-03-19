export function loadConfig(env = process.env) {
  const stages = (env.TAMP_STAGES || 'minify').split(',').map(s => s.trim()).filter(Boolean)
  return Object.freeze({
    port: parseInt(env.TAMP_PORT, 10) || 7778,
    upstream: env.TAMP_UPSTREAM || 'https://api.anthropic.com',
    upstreams: Object.freeze({
      anthropic: env.TAMP_UPSTREAM || 'https://api.anthropic.com',
      openai: env.TAMP_UPSTREAM_OPENAI || 'https://api.openai.com',
      gemini: env.TAMP_UPSTREAM_GEMINI || 'https://generativelanguage.googleapis.com',
    }),
    minSize: parseInt(env.TAMP_MIN_SIZE, 10) || 200,
    stages,
    log: env.TAMP_LOG !== 'false',
    logFile: env.TAMP_LOG_FILE || null,
    maxBody: parseInt(env.TAMP_MAX_BODY, 10) || 10_485_760,
    cacheSafe: true,
    llmLinguaUrl: env.TAMP_LLMLINGUA_URL || null,
  })
}
