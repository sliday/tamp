// Pure unit tests for the Ink Banner component. Walks the React.createElement
// tree directly without rendering — Ink/React are not invoked, so no TTY is
// needed and no extra deps (ink-testing-library, node-pty) are required.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Banner } from '../bin/ui/Banner.js'

// Recursively flatten a React element tree into a single space-joined string.
// React elements are plain objects with shape `{ type, props: { children } }`
// — children may be a string, number, element, array, or null.
function getAllText(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getAllText).filter(Boolean).join(' ')
  if (typeof node === 'object' && node.props) return getAllText(node.props.children)
  return ''
}

const baseProps = { version: '0.5.9', port: 7778, stages: ['minify', 'dedup'] }

describe('Banner — output mode line', () => {
  it('shows Output mode line when outputMode is "balanced"', () => {
    const tree = Banner({ ...baseProps, outputMode: 'balanced' })
    const text = getAllText(tree)
    assert.match(text, /Output mode/, 'header missing')
    assert.match(text, /balanced/, 'mode value missing')
    assert.match(text, /caveman/, 'caveman tag missing')
  })

  it('shows Output mode line when outputMode is "conservative"', () => {
    const tree = Banner({ ...baseProps, outputMode: 'conservative' })
    const text = getAllText(tree)
    assert.match(text, /Output mode/)
    assert.match(text, /conservative/)
  })

  it('shows Output mode line when outputMode is "aggressive"', () => {
    const tree = Banner({ ...baseProps, outputMode: 'aggressive' })
    const text = getAllText(tree)
    assert.match(text, /Output mode/)
    assert.match(text, /aggressive/)
  })

  it('hides Output mode line when outputMode is "off"', () => {
    const tree = Banner({ ...baseProps, outputMode: 'off' })
    const text = getAllText(tree)
    assert.doesNotMatch(text, /Output mode/)
  })

  it('hides Output mode line when outputMode is undefined (default)', () => {
    const tree = Banner({ ...baseProps })
    const text = getAllText(tree)
    assert.doesNotMatch(text, /Output mode/)
  })

  it('hides Output mode line when outputMode is null', () => {
    const tree = Banner({ ...baseProps, outputMode: null })
    const text = getAllText(tree)
    assert.doesNotMatch(text, /Output mode/)
  })
})

describe('Banner — stages discoverability', () => {
  it('shows "X of Y active" denominator', () => {
    const tree = Banner({ ...baseProps, stages: ['minify'] })
    const text = getAllText(tree)
    assert.match(text, /1 of 12 active/)
  })

  it('shows Available section when stages are disabled', () => {
    const tree = Banner({ ...baseProps, stages: ['minify'] })
    const text = getAllText(tree)
    assert.match(text, /Available/)
  })

  it('shows hints for known opt-in stages in Available section', () => {
    const tree = Banner({ ...baseProps, stages: ['minify'] })
    const text = getAllText(tree)
    assert.match(text, /llmlingua/, 'llmlingua entry missing')
    assert.match(text, /neural text compression/, 'llmlingua hint missing')
    assert.match(text, /graph/, 'graph entry missing')
    assert.match(text, /cross-request dedup/, 'graph hint missing')
  })

  it('shows setup commands for stages that have them', () => {
    const tree = Banner({ ...baseProps, stages: ['minify'] })
    const text = getAllText(tree)
    assert.match(text, /install uv/, 'llmlingua setup hint missing')
    assert.match(text, /TAMP_STAGES=\.\.\.,graph/, 'graph setup hint missing')
  })

  it('hides Available section entirely when all 12 stages are active', () => {
    const allStages = [
      'minify','toon','strip-lines','whitespace','llmlingua','dedup','diff','prune',
      'strip-comments','textpress','foundation-models','graph',
    ]
    const tree = Banner({ ...baseProps, stages: allStages })
    const text = getAllText(tree)
    assert.doesNotMatch(text, /Available/)
  })
})

describe('Banner — setup labels', () => {
  it('shows ANTHROPIC_BASE_URL and OPENAI_API_BASE setup lines with port', () => {
    const tree = Banner({ ...baseProps, port: 17999 })
    const text = getAllText(tree)
    // Sibling Text nodes get joined with whitespace by our flattener — the
    // actual rendered Ink output is a single line, but we just check that
    // both env var names AND the port appear together.
    assert.match(text, /ANTHROPIC_BASE_URL=/)
    assert.match(text, /OPENAI_API_BASE=/)
    assert.match(text, /http:\/\/localhost:17999/)
  })

  it('shows version header', () => {
    const tree = Banner({ ...baseProps, version: '9.9.9-test' })
    const text = getAllText(tree)
    assert.match(text, /9\.9\.9-test/)
  })
})
