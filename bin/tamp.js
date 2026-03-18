#!/usr/bin/env node
import { createProxy } from '../index.js'

const { config, server } = createProxy()

server.listen(config.port, () => {
  console.error('')
  console.error('  ┌─ Tamp ─────────────────────────────┐')
  console.error(`  │  Proxy: http://localhost:${config.port}      │`)
  console.error('  │  Status: ● Ready                   │')
  console.error('  │                                    │')
  console.error('  │  In another terminal:              │')
  console.error(`  │  export ANTHROPIC_BASE_URL=http://localhost:${config.port}`)
  console.error('  │  claude                            │')
  console.error('  └────────────────────────────────────┘')
  console.error('')
  console.error(`  Upstream: ${config.upstream}`)
  console.error(`  Stages: ${config.stages.join(', ')}`)
  console.error('')
})
