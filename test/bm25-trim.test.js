import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, bm25Scores, rerankScores, trimLinesByRelevance } from '../lib/bm25.js'
import { compressRequest } from '../compress.js'
import { anthropic } from '../providers.js'

// Build an Anthropic request with a single huge tool_result body. The user's
// first turn carries the query; the second carries the synthetic tool output.
function buildRequest(userText, toolResultBody) {
  return {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: userText },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: '/tmp/huge.log' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: toolResultBody }],
      },
    ],
  }
}

describe('bm25 — tokenizer', () => {
  it('preserves identifiers with dots/underscores/dashes as one token', () => {
    // Choice: identifiers with intra-word separators are first collapsed to
    // underscore form (`user.email` -> `user_email`) so BM25 treats them as
    // a single semantic unit. This gives queries like "user.email" a strong
    // match on lines that reference the full property path.
    const toks = tokenize('Read user.email and max_tokens and read-diff value')
    assert.ok(toks.includes('user_email'), `expected user_email in ${toks.join(',')}`)
    assert.ok(toks.includes('max_tokens'), 'max_tokens should survive')
    assert.ok(toks.includes('read_diff'), 'read-diff should collapse to read_diff')
  })

  it('drops single-character tokens', () => {
    const toks = tokenize('a b cd ef g')
    for (const t of toks) assert.ok(t.length >= 2, `unexpected single-char token ${t}`)
    assert.ok(toks.includes('cd'))
    assert.ok(toks.includes('ef'))
  })

  it('lowercases and splits on non-alphanumeric', () => {
    const toks = tokenize('Hello, WORLD! foo123')
    assert.ok(toks.includes('hello'))
    assert.ok(toks.includes('world'))
    assert.ok(toks.includes('foo123'))
  })

  it('also emits identifier parts so split-word queries match', () => {
    // The collapsed form alone gives zero recall: a user asking about "parse
    // config" shares no term with `parseConfig` or `parse_config`.
    const camel = tokenize('function parseConfig(opts) {')
    assert.ok(camel.includes('parseconfig'), 'collapsed form must survive')
    assert.ok(camel.includes('parse') && camel.includes('config'), `parts missing: ${camel}`)

    const snake = tokenize('def parse_config(opts):')
    assert.ok(snake.includes('parse_config'), 'collapsed form must survive')
    assert.ok(snake.includes('parse') && snake.includes('config'), `parts missing: ${snake}`)

    const dotted = tokenize('user.email')
    assert.ok(dotted.includes('user_email') && dotted.includes('user') && dotted.includes('email'))
  })

  it('splits acronym runs without swallowing the following word', () => {
    const toks = tokenize('class parseHTTPResponse')
    assert.ok(toks.includes('parse'), `${toks}`)
    assert.ok(toks.includes('http'), `${toks}`)
    assert.ok(toks.includes('response'), `${toks}`)
  })

  it('does not double-count atomic identifiers', () => {
    // `config` has no internal structure, so emitting it twice would inflate
    // its term frequency and skew BM25 toward lines that merely repeat it.
    const toks = tokenize('config config')
    assert.equal(toks.filter(t => t === 'config').length, 2)
  })
})

describe('bm25 — scoring', () => {
  it('ranks the most relevant document highest (IR smoke test)', () => {
    const docs = [
      'the cat sat on the mat quietly',
      'async error handling in node promises',
      'the sun is bright and the sky is blue',
    ]
    const scores = bm25Scores(docs, 'async error handling')
    assert.ok(scores[1] > scores[0], 'doc[1] must outscore doc[0]')
    assert.ok(scores[1] > scores[2], 'doc[1] must outscore doc[2]')
  })

  it('returns zero scores on empty query', () => {
    const docs = ['hello world', 'foo bar baz']
    const scores = bm25Scores(docs, '')
    assert.equal(scores[0], 0)
    assert.equal(scores[1], 0)
  })

  it('scores split-identifier definitions above unrelated lines', () => {
    // Regression for the recall hole: before subtoken expansion both
    // definition lines scored exactly 0 and were the first to be dropped.
    const docs = [
      'function parseConfig(opts) {',
      'def parse_config(opts):',
      'const x = 1',
      'unrelated noise here',
    ]
    const scores = bm25Scores(docs, 'parse config')
    assert.ok(scores[0] > 0, 'camelCase definition scored zero')
    assert.ok(scores[1] > 0, 'snake_case definition scored zero')
    assert.ok(scores[0] > scores[2] && scores[1] > scores[3], 'definitions must outrank noise')
  })
})

describe('bm25 — rerank', () => {
  const q = tokenize('parse config')

  it('boosts a line that defines a query term over one that calls it', () => {
    const lines = ['function parseConfig(opts) {', 'const out = parseConfig(opts)']
    const base = bm25Scores(lines, 'parse config')
    const ranked = rerankScores(base, lines, q)
    assert.ok(ranked[0] > ranked[1], `definition must outrank the call site: ${Array.from(ranked)}`)
  })

  it('penalises comment lines against equivalent code', () => {
    const lines = ['parseConfig(opts)', '// parseConfig(opts)']
    const base = bm25Scores(lines, 'parse config')
    const ranked = rerankScores(base, lines, q)
    assert.ok(ranked[0] > ranked[1], `code must outrank the commented copy: ${Array.from(ranked)}`)
  })

  it('lends score to neighbours so survivors stay contiguous', () => {
    const lines = ['unrelated alpha', 'function parseConfig(o) {', 'unrelated beta', 'unrelated gamma']
    const base = bm25Scores(lines, 'parse config')
    const ranked = rerankScores(base, lines, q)
    assert.equal(base[0], 0, 'precondition: neighbour has no direct match')
    assert.ok(ranked[0] > 0, 'neighbour of a hit should inherit some score')
    assert.ok(ranked[0] > ranked[3], 'coherence must decay with distance')
  })

  it('leaves zero-scoring lines at zero', () => {
    const lines = ['nothing here', 'still nothing']
    const ranked = rerankScores(bm25Scores(lines, 'parse config'), lines, q)
    assert.equal(ranked[0], 0)
    assert.equal(ranked[1], 0)
  })
})

describe('bm25 — chunk-aware trimming', () => {
  // A file where the answer sits deep inside one function and everything else
  // is filler. Line-granular trimming keeps the matching line but discards its
  // signature and closing brace, producing output that no longer parses.
  function makeSource() {
    const lines = ['// module header', "import fs from 'node:fs'", '']
    for (let f = 0; f < 40; f++) {
      lines.push(`export function filler${f}(a, b) {`)
      for (let i = 0; i < 8; i++) lines.push(`  const step${i} = a + b + ${i} // routine padding value`)
      lines.push(`  return step0`)
      lines.push('}')
      lines.push('')
    }
    lines.push('export function parseConfig(opts) {')
    lines.push('  const merged = Object.assign({}, defaults, opts)')
    lines.push('  return merged')
    lines.push('}')
    lines.push('// end of module')
    return lines.join('\n')
  }

  it('keeps the enclosing signature and closer for any surviving body line', () => {
    const text = makeSource()
    const result = trimLinesByRelevance(text, 'parse config merged defaults', {
      targetTokens: 220,
      path: 'src/config.js',
    })
    assert.ok(result, 'should produce a trim')

    const out = result.text
    assert.match(out, /const merged = Object\.assign/, 'the relevant body line should survive')
    assert.match(out, /export function parseConfig\(opts\) \{/, 'enclosing signature was dropped')

    // Every surviving `{` line has a matching `}` — no orphaned bodies.
    const opens = (out.match(/\{\s*$/gm) || []).length
    const closes = (out.match(/^\s*\}/gm) || []).length
    assert.equal(opens, closes, `unbalanced output:\n${out}`)
  })

  it('falls back to plain line trimming on non-code bodies', () => {
    const lines = ['HEADER']
    for (let i = 0; i < 200; i++) lines.push(`INFO heartbeat ${i} status=200 latency=${i}ms routine`)
    lines.push('async error handling failed in worker')
    lines.push('TRAILER')
    const result = trimLinesByRelevance(lines.join('\n'), 'async error handling', { targetTokens: 120 })
    assert.ok(result, 'should still trim a log body')
    assert.match(result.text, /async error handling failed/)
    assert.match(result.text, /\[\.\.\. \d+ lines omitted, \d+ chars \.\.\.\]/)
  })

  it('keeps its own closer when a block header is selected on its own merit', () => {
    // Regression: closure only walked ANCESTORS, so a line that opens a block
    // was kept with no `}` of its own. Small fixtures hid it — the leak only
    // shows once budget filling picks many headers directly.
    const lines = ['// header', '']
    for (let f = 0; f < 200; f++) {
      lines.push(`export function helper${f}(value) {`)
      lines.push(`  const total = value + ${f} // routine padding`)
      lines.push('  return total')
      lines.push('}')
      lines.push('')
    }
    lines.push('export function parseConfig(opts) {')
    lines.push('  const merged = Object.assign({}, DEFAULTS, opts)')
    lines.push('  return merged')
    lines.push('}')
    lines.push('// end')

    const result = trimLinesByRelevance(lines.join('\n'), 'parse config merged defaults', {
      targetTokens: 900,
      path: 'src/config.js',
    })
    assert.ok(result, 'should produce a trim')
    const opens = (result.text.match(/\{\s*$/gm) || []).length
    const closes = (result.text.match(/^\s*\}/gm) || []).length
    assert.equal(opens, closes, `unbalanced: ${opens} opens vs ${closes} closes`)
    assert.match(result.text, /export function parseConfig\(opts\) \{/)
  })

  it('indents drop markers to the depth of the body they replace', () => {
    const text = makeSource()
    const result = trimLinesByRelevance(text, 'parse config merged defaults', {
      targetTokens: 220,
      path: 'src/config.js',
    })
    assert.ok(result)
    assert.match(result.text, /^ +\[\.\.\. \d+ lines omitted/m, 'expected at least one indented marker')
  })
})

describe('bm25 — trimLinesByRelevance under budget', () => {
  it('returns null when text is already under token budget', () => {
    const text = 'short line one\nshort line two\nshort line three'
    const result = trimLinesByRelevance(text, 'anything', { targetTokens: 4096 })
    assert.equal(result, null)
  })

  it('returns null when text has fewer than minLines lines even if over budget', () => {
    // 3 lines (< default minLines=10) with a tiny budget — still bail.
    const bigLine = 'x '.repeat(5000)
    const text = [bigLine, bigLine, bigLine].join('\n')
    const result = trimLinesByRelevance(text, 'query', { targetTokens: 100, minLines: 10 })
    assert.equal(result, null)
  })
})

describe('bm25 — trimLinesByRelevance above budget', () => {
  function makeBody() {
    const lines = []
    lines.push('FILE: /var/log/app.log  (header line, always preserved)')
    for (let i = 0; i < 48; i++) {
      lines.push(`routine INFO heartbeat ping ${i} ok status=200 latency=${i}ms`)
    }
    lines.push('async error handling failed: promise rejected in upload handler')
    lines.push('throw new AsyncError("connection timeout during async operation")')
    lines.push('error: async pipeline stalled — retry count exceeded')
    for (let i = 0; i < 48; i++) {
      lines.push(`routine DEBUG cache miss key=k${i} bucket=b${i} latency=${i}ms`)
    }
    lines.push('TRAILER: end of log  (footer line, always preserved)')
    return lines.join('\n')
  }

  it('drops low-relevance lines, keeps query-matching lines, preserves anchors', () => {
    const text = makeBody()
    const query = 'async error handling'
    // Budget chosen so the 3 relevant lines (~30 tokens total) plus anchors
    // fit comfortably, but only a handful of noise lines (~13 tokens each)
    // can squeeze in after the high-scoring ones are taken.
    const result = trimLinesByRelevance(text, query, { targetTokens: 150 })
    assert.ok(result, 'should produce a trim')
    assert.ok(result.trimmedTokens < result.originalTokens, 'trimmed must be smaller')

    const lines = result.text.split('\n')
    // Anchors preserved verbatim.
    assert.ok(lines[0].startsWith('FILE:'), 'first line anchor lost')
    assert.ok(lines[lines.length - 1].startsWith('TRAILER:'), 'last line anchor lost')

    // Drop marker appears somewhere.
    assert.match(result.text, /\[\.\.\. \d+ lines omitted, \d+ chars \.\.\.\]/)

    // All query-matching lines survived.
    assert.match(result.text, /async error handling failed/)
    assert.match(result.text, /AsyncError/)
    assert.match(result.text, /async pipeline stalled/)

    // Many noise lines were dropped.
    const noiseSurvivors = (result.text.match(/routine INFO heartbeat/g) || []).length
    assert.ok(noiseSurvivors < 10, `too many noise survivors: ${noiseSurvivors}`)
  })
})

describe('bm25-trim — integration with compressRequest', () => {
  it('trims a huge tool_result when stage is active and task is not dangerous', async () => {
    const lines = []
    lines.push('FILE: /var/log/prod.log  (header anchor)')
    // ~95 noise lines (each ~800 chars to push past 64 KB easily)
    const noise = 'debug cache miss key=nope bucket=none status=ok latency=1ms session=abc request=xyz '.repeat(10)
    for (let i = 0; i < 95; i++) {
      lines.push(`LINE${i} ${noise}`)
    }
    // 5 relevant lines sprinkled in mid-body.
    lines.splice(20, 0, 'async error handling failed in worker thread #4')
    lines.splice(40, 0, 'throw new AsyncError("connection timed out")')
    lines.splice(60, 0, 'caught async exception: retry count exceeded in upload')
    lines.splice(80, 0, 'error propagated through async handler chain')
    lines.splice(100, 0, 'async rejection: handler did not catch')
    lines.push('TRAILER: end of log  (footer anchor)')

    const body = lines.join('\n')
    assert.ok(Buffer.byteLength(body, 'utf8') > 64 * 1024, `body too small: ${Buffer.byteLength(body, 'utf8')}`)

    const request = buildRequest('help me trace async error handling in this log', body)
    const config = { minSize: 50, stages: ['bm25-trim'], llmLinguaUrl: null }
    const { body: out, stats } = await compressRequest(request, config, anthropic)

    const after = out.messages[2].content[0].content
    assert.ok(after.length < body.length * 0.6, `expected >= 40% drop, got ${(after.length / body.length * 100).toFixed(1)}% of original`)

    // All 5 relevant lines present.
    assert.match(after, /async error handling failed/)
    assert.match(after, /AsyncError/)
    assert.match(after, /caught async exception/)
    assert.match(after, /error propagated through async handler/)
    assert.match(after, /async rejection/)

    // Anchors preserved.
    assert.match(after, /^FILE: /m)
    assert.match(after, /TRAILER: end of log/)

    // Stats recorded as bm25-trim method.
    const trimStat = stats.find(s => s.method === 'bm25-trim')
    assert.ok(trimStat, 'expected bm25-trim stat entry')
  })
})

describe('bm25-trim — dangerous task bypass', () => {
  it('does not trim when the latest user message matches a dangerous pattern', async () => {
    const lines = []
    lines.push('HEADER')
    const padding = 'padding '.repeat(100)
    for (let i = 0; i < 400; i++) lines.push(`line ${i} ${padding}`)
    lines.push('FOOTER')
    const body = lines.join('\n')
    assert.ok(Buffer.byteLength(body, 'utf8') > 64 * 1024)

    const request = buildRequest('review this security vulnerability in the upload handler', body)
    const config = { minSize: 50, stages: ['bm25-trim'], llmLinguaUrl: null }
    const { body: out } = await compressRequest(request, config, anthropic)
    const after = out.messages[2].content[0].content
    assert.equal(after, body, 'body must pass through untouched on dangerous task')
  })
})

describe('bm25-trim — under-threshold no-op', () => {
  it('leaves a 4 KB body untouched even when stage is active', async () => {
    const body = 'small line content here with some words to score against\n'.repeat(60) // ~4 KB
    assert.ok(Buffer.byteLength(body, 'utf8') < 64 * 1024)

    const request = buildRequest('async error debugging', body)
    const config = { minSize: 50, stages: ['bm25-trim'], llmLinguaUrl: null }
    const { body: out } = await compressRequest(request, config, anthropic)
    const after = out.messages[2].content[0].content
    assert.equal(after, body)
  })
})

describe('bm25-trim — stage disabled', () => {
  it('does not trim even a 1 MB body when stage is not in config.stages', async () => {
    const lines = []
    lines.push('HEADER')
    const padding = 'padding content '.repeat(50)
    for (let i = 0; i < 4000; i++) lines.push(`line ${i} ${padding}`)
    lines.push('FOOTER')
    const body = lines.join('\n')
    assert.ok(Buffer.byteLength(body, 'utf8') > 1024 * 1024)

    const request = buildRequest('async error handling', body)
    const config = { minSize: 50, stages: [], llmLinguaUrl: null }
    const { body: out } = await compressRequest(request, config, anthropic)
    const after = out.messages[2].content[0].content
    assert.equal(after.length, body.length, 'body must pass through untouched')
  })
})

describe('trimLinesByRelevance - last-line anchor with trailing newline', () => {
  it('preserves the real final line (trailing error) when the body ends in a newline', () => {
    const noise = Array.from({ length: 2000 }, (_, i) => `processing item ${i} widget gadget`).join('\n')
    const text = noise + '\nERROR_AT_END: unhandled exception in widget parser\n'
    const r = trimLinesByRelevance(text, 'widget', { targetTokens: 300 })
    assert.ok(r, 'should produce a trim')
    assert.ok(r.text.includes('ERROR_AT_END'), 'trailing error line must survive the trim')
  })
})
