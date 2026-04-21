import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectOpenAIAuthMode, resolveOpenAIUpstream, detectProvider } from '../providers.js'
import { resolveUpstream } from '../index.js'
import { loadConfig } from '../config.js'

// Minimal env helper — loadConfig with an explicit env object so tests
// don't bleed into process.env.
function mkConfig(env = {}) {
  return loadConfig({ ...env })
}

describe('detectOpenAIAuthMode', () => {
  it('returns "api-key" for classic sk-* bearer', () => {
    const mode = detectOpenAIAuthMode({ authorization: 'Bearer sk-proj-abc123' })
    assert.equal(mode, 'api-key')
  })

  it('returns "chatgpt-oauth" for JWT bearer', () => {
    // Compact JWS: three base64url segments, header starts with eyJ
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1Iiwibm8iOjF9.sig'
    const mode = detectOpenAIAuthMode({ authorization: `Bearer ${jwt}` })
    assert.equal(mode, 'chatgpt-oauth')
  })

  it('returns "chatgpt-oauth" when chatgpt-account-id header present even without bearer', () => {
    const mode = detectOpenAIAuthMode({ 'chatgpt-account-id': 'acct_123' })
    assert.equal(mode, 'chatgpt-oauth')
  })

  it('returns "chatgpt-oauth" for JWT + chatgpt-account-id combo', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig'
    const mode = detectOpenAIAuthMode({
      authorization: `Bearer ${jwt}`,
      'chatgpt-account-id': 'acct_123',
    })
    assert.equal(mode, 'chatgpt-oauth')
  })

  it('returns "unknown" when no recognisable auth', () => {
    assert.equal(detectOpenAIAuthMode({}), 'unknown')
    assert.equal(detectOpenAIAuthMode({ authorization: 'Basic Zm9vOmJhcg==' }), 'unknown')
  })

  it('accepts a request-like object with .headers', () => {
    const req = { headers: { authorization: 'Bearer sk-abc' } }
    assert.equal(detectOpenAIAuthMode(req), 'api-key')
  })

  it('is case-insensitive on header names', () => {
    const mode = detectOpenAIAuthMode({ Authorization: 'Bearer sk-xxx' })
    assert.equal(mode, 'api-key')
  })
})

describe('resolveOpenAIUpstream', () => {
  it('routes chatgpt-oauth to chatgpt.com and prefixes /backend-api/codex', () => {
    const route = resolveOpenAIUpstream({
      mode: 'chatgpt-oauth',
      base: 'https://api.openai.com',
      providerName: 'openai-responses',
    })
    assert.equal(route.base, 'https://chatgpt.com')
    assert.equal(route.transformPath('/v1/responses'), '/backend-api/codex/v1/responses')
  })

  it('is idempotent — does not double-prefix /backend-api/codex', () => {
    const route = resolveOpenAIUpstream({ mode: 'chatgpt-oauth', base: 'x', providerName: 'openai' })
    assert.equal(route.transformPath('/backend-api/codex/v1/responses'), '/backend-api/codex/v1/responses')
  })

  it('passes api-key mode through with the default base', () => {
    const route = resolveOpenAIUpstream({
      mode: 'api-key',
      base: 'https://api.openai.com',
      providerName: 'openai',
    })
    assert.equal(route.base, 'https://api.openai.com')
    assert.equal(route.transformPath('/v1/chat/completions'), '/v1/chat/completions')
  })
})

describe('resolveUpstream (index.js integration)', () => {
  it('sk-* bearer → upstream host api.openai.com', () => {
    const config = mkConfig()
    const provider = detectProvider('POST', '/v1/responses')
    const route = resolveUpstream(provider, { authorization: 'Bearer sk-test' }, config)
    const u = new URL(route.base)
    assert.equal(u.hostname, 'api.openai.com')
    assert.equal(route.transformPath('/v1/responses'), '/v1/responses')
  })

  it('JWT bearer + chatgpt-account-id → upstream host chatgpt.com', () => {
    const config = mkConfig()
    const provider = detectProvider('POST', '/v1/responses')
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig'
    const route = resolveUpstream(provider, {
      authorization: `Bearer ${jwt}`,
      'chatgpt-account-id': 'acct_xyz',
    }, config)
    const u = new URL(route.base)
    assert.equal(u.hostname, 'chatgpt.com')
    assert.ok(route.transformPath('/v1/responses').startsWith('/backend-api/codex'))
  })

  it('JWT bearer alone (no account-id) still routes to chatgpt.com', () => {
    const config = mkConfig()
    const provider = detectProvider('POST', '/v1/responses')
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig'
    const route = resolveUpstream(provider, { authorization: `Bearer ${jwt}` }, config)
    assert.equal(new URL(route.base).hostname, 'chatgpt.com')
  })

  it('TAMP_DISABLE_CHATGPT_ROUTE=1 forces legacy api.openai.com routing', () => {
    const config = mkConfig({ TAMP_DISABLE_CHATGPT_ROUTE: '1' })
    const provider = detectProvider('POST', '/v1/responses')
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig'
    const route = resolveUpstream(provider, {
      authorization: `Bearer ${jwt}`,
      'chatgpt-account-id': 'acct_xyz',
    }, config)
    assert.equal(new URL(route.base).hostname, 'api.openai.com')
  })

  it('openai chat-completions with JWT also routes to chatgpt.com', () => {
    const config = mkConfig()
    const provider = detectProvider('POST', '/v1/chat/completions')
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig'
    const route = resolveUpstream(provider, { authorization: `Bearer ${jwt}` }, config)
    assert.equal(new URL(route.base).hostname, 'chatgpt.com')
  })

  it('anthropic provider is never rerouted based on OpenAI auth heuristics', () => {
    const config = mkConfig()
    const provider = detectProvider('POST', '/v1/messages')
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig'
    const route = resolveUpstream(provider, {
      authorization: `Bearer ${jwt}`,
      'chatgpt-account-id': 'acct_xyz',
    }, config)
    assert.equal(new URL(route.base).hostname, 'api.anthropic.com')
  })

  it('headers pass through verbatim — test responsibility is of forwardRequest, '
     + 'but resolveUpstream itself must not mutate headers', () => {
    const config = mkConfig()
    const provider = detectProvider('POST', '/v1/responses')
    const headers = Object.freeze({
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig',
      'chatgpt-account-id': 'acct_123',
      'x-custom': 'keep-me',
    })
    // Frozen object — any mutation throws in strict mode.
    assert.doesNotThrow(() => resolveUpstream(provider, headers, config))
  })
})
