#!/usr/bin/env node
// Capture or verify golden LLMLingua-2 compressed outputs
// Usage:
//   node test/capture-golden.js          # capture new golden files
//   node test/capture-golden.js --verify # verify existing goldens match

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const goldenDir = join(__dirname, 'fixtures', 'llmlingua-golden')
const SIDECAR_URL = process.env.LLMLINGUA_URL || 'http://localhost:5001'

const fixtures = [
  {
    id: 'typescript-hook',
    text: readFileSync(join(goldenDir, 'typescript-hook.json'), 'utf8').replace(/^.*?"original":\s*"/, '').split('",\n')[0],
  },
  {
    id: 'markdown-readme',
    text: `# Tamp — Token Compression Proxy\n\nTamp is a local proxy that sits between Claude Code and the Anthropic API.\nIt compresses tool_result content in your messages, reducing input tokens\nby 30-50% with zero behavior change.\n\n## Installation\n\nYou must have Node.js 18+ installed.\n\n\`\`\`bash\nnpx @sliday/tamp\n\`\`\`\n\n## How It Works\n\n1. Tamp intercepts POST requests to /v1/messages\n2. It identifies compressible content (JSON, text) in tool_result blocks\n3. JSON is minified and optionally TOON-encoded\n4. Text content is compressed via LLMLingua-2 neural compression\n5. The compressed request is forwarded to Anthropic's API\n\n## Configuration\n\nSet these environment variables:\n\n- \`TAMP_PORT\` — proxy port (default: 8080)\n- \`TAMP_STAGES\` — compression stages: minify,toon,llmlingua\n- \`TAMP_MIN_SIZE\` — minimum content size to compress (default: 200)\n- \`TAMP_LOG\` — enable debug logging\n\n## Important Notes\n\n- Error results (is_error: true) are NEVER compressed\n- Only the last user message is compressed\n- TOON encoding is NOT used for deeply nested objects\n- Do not set TAMP_MIN_SIZE below 50 characters\n\n## License\n\nMIT`,
  },
  {
    id: 'cli-output',
    text: `total 128\ndrwxr-xr-x  12 stas  staff    384 Mar 15 10:30 .\ndrwxr-xr-x   5 stas  staff    160 Mar 14 09:00 ..\n-rw-r--r--   1 stas  staff    245 Mar 15 10:30 package.json\n-rw-r--r--   1 stas  staff   1024 Mar 15 10:28 index.js\n-rw-r--r--   1 stas  staff   2048 Mar 15 10:25 compress.js\n-rw-r--r--   1 stas  staff    512 Mar 15 10:20 detect.js\n-rw-r--r--   1 stas  staff    768 Mar 15 10:18 config.js\n-rw-r--r--   1 stas  staff   3072 Mar 15 10:15 stats.js\ndrwxr-xr-x   4 stas  staff    128 Mar 15 10:10 bin\ndrwxr-xr-x   6 stas  staff    192 Mar 15 10:05 test\ndrwxr-xr-x   3 stas  staff     96 Mar 15 09:55 sidecar\n-rw-r--r--   1 stas  staff    456 Mar 14 15:30 README.md`,
  },
  {
    id: 'python-source',
    text: readFileSync(join(goldenDir, 'python-source.json'), 'utf8').replace(/^.*?"original":\s*"/, '').split('",\n')[0],
  },
  {
    id: 'mixed-instructions',
    text: readFileSync(join(goldenDir, 'mixed-instructions.json'), 'utf8').replace(/^.*?"original":\s*"/, '').split('",\n')[0],
  },
  {
    id: 'short-text',
    text: 'The quick brown fox jumps over the lazy dog. This sentence contains every letter of the alphabet at least once. It is commonly used for testing fonts and keyboard layouts.',
  },
  {
    id: 'error-stacktrace',
    text: readFileSync(join(goldenDir, 'error-stacktrace.json'), 'utf8').replace(/^.*?"original":\s*"/, '').split('",\n')[0],
  },
]

async function compress(text) {
  const res = await fetch(SIDECAR_URL + '/compress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, rate: 0.5 }),
  })
  if (!res.ok) throw new Error(`Sidecar returned ${res.status}`)
  return res.json()
}

async function capture() {
  console.log(`Capturing golden files from sidecar at ${SIDECAR_URL}...\n`)

  // Health check
  try {
    const health = await fetch(SIDECAR_URL + '/health')
    const data = await health.json()
    if (!data.model_loaded) throw new Error('Model not loaded')
    console.log('Sidecar healthy, model loaded.\n')
  } catch (err) {
    console.error(`Cannot reach sidecar: ${err.message}`)
    console.error('Start it with: cd sidecar && uvicorn server:app --port 5001')
    process.exit(1)
  }

  for (const fix of fixtures) {
    try {
      const golden = JSON.parse(readFileSync(join(goldenDir, `${fix.id}.json`), 'utf8'))
      const result = await compress(golden.original)
      golden.compressed = result.text
      golden.original_tokens = result.original_tokens
      golden.compressed_tokens = result.compressed_tokens
      golden.captured_at = new Date().toISOString()
      writeFileSync(join(goldenDir, `${fix.id}.json`), JSON.stringify(golden, null, 2) + '\n')
      const pct = ((1 - result.compressed_tokens / result.original_tokens) * 100).toFixed(1)
      console.log(`  ${fix.id}: ${result.original_tokens} -> ${result.compressed_tokens} tokens (${pct}% reduction)`)
    } catch (err) {
      console.error(`  ${fix.id}: FAILED — ${err.message}`)
    }
  }
  console.log('\nDone. Golden files updated.')
}

async function verify() {
  console.log(`Verifying golden files against sidecar at ${SIDECAR_URL}...\n`)
  let pass = 0, fail = 0

  for (const fix of fixtures) {
    try {
      const golden = JSON.parse(readFileSync(join(goldenDir, `${fix.id}.json`), 'utf8'))
      const result = await compress(golden.original)
      const tokenDiff = Math.abs(result.compressed_tokens - golden.compressed_tokens) / golden.compressed_tokens
      if (tokenDiff <= 0.05) {
        console.log(`  PASS ${fix.id}: tokens within 5% (golden=${golden.compressed_tokens}, live=${result.compressed_tokens})`)
        pass++
      } else {
        console.log(`  FAIL ${fix.id}: token drift ${(tokenDiff * 100).toFixed(1)}% (golden=${golden.compressed_tokens}, live=${result.compressed_tokens})`)
        fail++
      }
    } catch (err) {
      console.error(`  ERROR ${fix.id}: ${err.message}`)
      fail++
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
}

if (process.argv.includes('--verify')) {
  verify()
} else {
  capture()
}
