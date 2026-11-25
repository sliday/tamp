import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { redactText } from '../lib/redact.js'

describe('redactText — provider-shaped tokens', () => {
  it('masks AWS, GitHub, Anthropic, OpenAI, Google, Slack, Stripe keys', () => {
    const cases = [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_' + 'a'.repeat(36),
      'sk-ant-' + 'A'.repeat(40),
      'sk-proj-' + 'B'.repeat(40),
      'AIza' + 'C'.repeat(35),
      'xoxb-' + '1'.repeat(20),
      'sk_live_' + 'd'.repeat(24),
    ]
    for (const secret of cases) {
      const { text, count } = redactText(`value=${secret} done`)
      assert.equal(count >= 1, true, `should match ${secret}`)
      assert.equal(text.includes(secret), false, `${secret} must not survive`)
      assert.equal(text.includes('‹redacted:'), true)
    }
  })

  it('masks OpenRouter, npm, PyPI, HuggingFace, Groq, and xAI keys with specific labels', () => {
    const cases = [
      ['openrouter-key', 'sk-or-v1-' + 'a1b2c3d4'.repeat(8)],
      ['npm-token', 'npm_' + 'A'.repeat(36)],
      ['pypi-token', 'pypi-AgEI' + 'B'.repeat(48)],
      ['huggingface-token', 'hf_' + 'C'.repeat(34)],
      ['groq-key', 'gsk_' + 'D'.repeat(44)],
      ['xai-key', 'xai-' + 'E'.repeat(44)],
    ]
    for (const [label, secret] of cases) {
      const { text, count } = redactText(`token=${secret} end`)
      assert.equal(count, 1, `should match ${label}`)
      assert.equal(text.includes(secret), false, `${label} secret must not survive`)
      assert.equal(text, `token=‹redacted:${label}› end`, `${label} must use its specific marker`)
    }
  })

  it('masks a JWT and a PEM private key block', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiwidHlwIjoiSldUI.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'
    assert.equal(redactText(jwt).count, 1)
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1\n-----END RSA PRIVATE KEY-----'
    const out = redactText(pem)
    assert.equal(out.count, 1)
    assert.equal(out.text.includes('MIIEpAIBAAKCAQEA1'), false)
  })
})

describe('redactText — assignment lines (.env / shell)', () => {
  it('masks the value but keeps the key for secret-named vars', () => {
    const env = 'API_KEY=abcd1234secret\nDATABASE_PASSWORD="hunter2hunter"\nexport AUTH_TOKEN=zzzzzzzz'
    const { text, count } = redactText(env)
    assert.equal(count, 3)
    assert.equal(text.includes('abcd1234secret'), false)
    assert.equal(text.includes('hunter2hunter'), false)
    assert.equal(text.startsWith('API_KEY='), true)
    assert.equal(text.includes('DATABASE_PASSWORD="‹redacted:secret›"'), true)
  })

  it('leaves non-secret assignments alone', () => {
    const cfg = 'PORT=8080\nHOST=localhost\nDEBUG=true\nNAME=tamp'
    assert.equal(redactText(cfg).count, 0)
    assert.equal(redactText(cfg).text, cfg)
  })
})

describe('redactText — precision (no false positives)', () => {
  it('does not touch ordinary prose, code, or short values', () => {
    const prose = 'The function returns a token count and the password field is empty.'
    assert.equal(redactText(prose).count, 0)
    const code = 'const apiKey = getKey()\nreturn sk_test_short'
    assert.equal(redactText(code).count, 0)
  })

  it('returns the same reference when nothing matches', () => {
    const s = 'nothing secret here'
    assert.equal(redactText(s).text, s)
  })
})

describe('redactText — ReDoS guard', () => {
  it('stays linear on a large uppercase blob (no catastrophic backtracking)', () => {
    // A 256KB CONSTANT_CASE run used to be O(n^2) via the unbounded key prefix
    // and stalled the proxy event loop for seconds. Must complete near-instantly.
    const blob = 'A'.repeat(256_000)
    const start = process.hrtime.bigint()
    redactText(blob)
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    assert.ok(ms < 250, `redaction took ${ms.toFixed(0)}ms — expected < 250ms (ReDoS regression)`)
  })
})

describe('redactText — idempotency', () => {
  it('does not double-mask or increment count on a second pass', () => {
    const env = [
      'API_KEY=abcd1234secret',
      'DATABASE_PASSWORD="hunter2hunter"',
      `OPENROUTER_API_KEY=sk-or-v1-${'f0'.repeat(32)}`,
      `OPENAI_API_KEY="sk-proj-${'Z'.repeat(40)}"`,
    ].join('\n')

    const first = redactText(env)
    assert.equal(first.count, 4)
    assert.ok(first.text.includes('API_KEY=‹redacted:secret›'))
    assert.ok(first.text.includes('DATABASE_PASSWORD="‹redacted:secret›"'))
    assert.ok(first.text.includes('OPENROUTER_API_KEY=‹redacted:openrouter-key›'))
    assert.ok(first.text.includes('OPENAI_API_KEY="‹redacted:openai-key›"'))

    const second = redactText(first.text)
    assert.equal(second.count, 0, 'second pass must report 0 secrets')
    assert.equal(second.text, first.text, 'second pass must return the exact same text')
  })

  it('still masks a secret that merely starts with a redaction marker prefix', () => {
    const forged = 'API_KEY=‹redacted:secret›real_secret_tail'
    const out = redactText(forged)
    assert.equal(out.count, 1)
    assert.equal(out.text, 'API_KEY=‹redacted:secret›')
  })
})

describe('redactText — remove mode', () => {
  it('deletes the secret entirely', () => {
    const { text, count } = redactText('token=ghp_' + 'a'.repeat(36), 'remove')
    assert.equal(count, 1)
    assert.equal(text.includes('‹redacted'), false)
    assert.equal(/ghp_a+/.test(text), false)
  })
})
