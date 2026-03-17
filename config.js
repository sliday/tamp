export function loadConfig(env = process.env) {
  const stages = (env.TOONA_STAGES || 'minify').split(',').map(s => s.trim()).filter(Boolean)
  return Object.freeze({
    port: parseInt(env.TOONA_PORT, 10) || 8787,
    upstream: env.TOONA_UPSTREAM || 'https://api.anthropic.com',
    minSize: parseInt(env.TOONA_MIN_SIZE, 10) || 200,
    stages,
    log: env.TOONA_LOG !== 'false',
    logFile: env.TOONA_LOG_FILE || null,
    maxBody: parseInt(env.TOONA_MAX_BODY, 10) || 10_485_760,
    cacheSafe: true,
    llmLinguaUrl: env.TOONA_LLMLINGUA_URL || null,
  })
}
