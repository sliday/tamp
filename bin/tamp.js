#!/usr/bin/env node
import { createProxy } from '../index.js'

const { config, server } = createProxy()

server.listen(config.port, () => {
  const url = `http://localhost:${config.port}`
  console.error('')
  console.error('  ┌─ Tamp ─────────────────────────────────┐')
  console.error(`  │  Proxy: ${url}              │`)
  console.error('  │  Status: ● Ready                       │')
  console.error('  │                                        │')
  console.error('  │  Claude Code:                          │')
  console.error(`  │    ANTHROPIC_BASE_URL=${url}  │`)
  console.error('  │                                        │')
  console.error('  │  Aider / Cursor / Cline:               │')
  console.error(`  │    OPENAI_BASE_URL=${url}     │`)
  console.error('  └────────────────────────────────────────┘')
  console.error('')
  console.error(`  Upstreams:`)
  console.error(`    anthropic → ${config.upstreams.anthropic}`)
  console.error(`    openai    → ${config.upstreams.openai}`)
  console.error(`    gemini    → ${config.upstreams.gemini}`)
  console.error(`  Stages: ${config.stages.join(', ')}`)
  console.error('')
})
