/**
 * Unit tests for lib/rules-generator.js
 * Task-type detection and rule generation
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { detectTaskType, generateOutputRules, OUTPUT_MODES } from '../lib/rules-generator.js'

describe('detectTaskType', () => {
  // Safe task patterns
  it('detects safe task: add env var', () => {
    assert.strictEqual(detectTaskType('add FOO=bar to .env'), 'safe')
    assert.strictEqual(detectTaskType('Add environment variable BAZ to config'), 'safe')
  })

  it('detects safe task: fix typo', () => {
    assert.strictEqual(detectTaskType('fix typo in README'), 'safe')
    assert.strictEqual(detectTaskType('Fix typo in function name'), 'safe')
  })

  it('detects safe task: update documentation', () => {
    assert.strictEqual(detectTaskType('update README with new info'), 'safe')
    assert.strictEqual(detectTaskType('Update docs for API changes'), 'safe')
  })

  it('detects safe task: install package', () => {
    assert.strictEqual(detectTaskType('install lodash package'), 'safe')
    assert.strictEqual(detectTaskType('uninstall deprecated package'), 'safe')
  })

  it('detects safe task: add dependency', () => {
    assert.strictEqual(detectTaskType('add express as dependency'), 'safe')
  })

  it('detects safe task: update version', () => {
    assert.strictEqual(detectTaskType('update version to 1.2.3'), 'safe')
  })

  it('detects safe task: format/lint', () => {
    assert.strictEqual(detectTaskType('format all files'), 'safe')
    assert.strictEqual(detectTaskType('run linter'), 'safe')
  })

  // Dangerous task patterns (checked first, higher priority)
  it('detects dangerous task: security', () => {
    assert.strictEqual(detectTaskType('fix security vulnerability'), 'dangerous')
    assert.strictEqual(detectTaskType('Investigate potential exploit'), 'dangerous')
  })

  it('detects dangerous task: debug', () => {
    assert.strictEqual(detectTaskType('debug memory leak'), 'dangerous')
    assert.strictEqual(detectTaskType('investigate why API fails'), 'dangerous')
    assert.strictEqual(detectTaskType('troubleshoot connection issue'), 'dangerous')
  })

  it('detects dangerous task: performance', () => {
    assert.strictEqual(detectTaskType('optimize slow query'), 'dangerous')
    assert.strictEqual(detectTaskType('improve performance of loop'), 'dangerous')
  })

  it('detects dangerous task: refactor/architecture', () => {
    assert.strictEqual(detectTaskType('refactor this module'), 'dangerous')
    assert.strictEqual(detectTaskType('design new architecture'), 'dangerous')
  })

  it('detects dangerous task: fix bug', () => {
    assert.strictEqual(detectTaskType('fix bug in auth logic'), 'dangerous')
  })

  it('detects dangerous task: explain/why/how', () => {
    assert.strictEqual(detectTaskType('explain how this works'), 'dangerous')
    assert.strictEqual(detectTaskType('why does this fail?'), 'dangerous')
    assert.strictEqual(detectTaskType('how does authentication work?'), 'dangerous')
  })

  it('detects dangerous task: test/coverage', () => {
    assert.strictEqual(detectTaskType('add unit tests'), 'dangerous')
    assert.strictEqual(detectTaskType('increase test coverage'), 'dangerous')
  })

  // Complex tasks (default)
  it('detects complex task: ambiguous request', () => {
    assert.strictEqual(detectTaskType('create a new feature'), 'complex')
    assert.strictEqual(detectTaskType('help me understand this code'), 'complex')
    assert.strictEqual(detectTaskType('make it faster'), 'complex')
  })

  it('detects complex task: empty or null input', () => {
    assert.strictEqual(detectTaskType(''), 'complex')
    assert.strictEqual(detectTaskType(null), 'complex')
    assert.strictEqual(detectTaskType(undefined), 'complex')
  })

  // Priority: dangerous patterns override safe patterns
  it('prioritizes dangerous over safe patterns', () => {
    // "debug typo" - debug (dangerous) takes precedence over typo (safe)
    assert.strictEqual(detectTaskType('debug typo in code'), 'dangerous')
    // "fix security typo" - security (dangerous) takes precedence
    assert.strictEqual(detectTaskType('fix security typo'), 'dangerous')
  })
})

describe('OUTPUT_MODES', () => {
  it('has all three modes defined', () => {
    assert(OUTPUT_MODES.conservative)
    assert(OUTPUT_MODES.balanced)
    assert(OUTPUT_MODES.aggressive)
  })

  it('conservative mode has no compression for dangerous tasks', () => {
    assert.strictEqual(OUTPUT_MODES.conservative.dangerousTaskCompression, 'none')
    assert.strictEqual(OUTPUT_MODES.conservative.safeTaskCompression, 'none')
  })

  it('balanced mode compresses safe but not dangerous tasks', () => {
    assert.strictEqual(OUTPUT_MODES.balanced.safeTaskCompression, 'aggressive')
    assert.strictEqual(OUTPUT_MODES.balanced.dangerousTaskCompression, 'none')
  })

  it('aggressive mode compresses all tasks', () => {
    assert.strictEqual(OUTPUT_MODES.aggressive.safeTaskCompression, 'maximum')
    assert.strictEqual(OUTPUT_MODES.aggressive.dangerousTaskCompression, 'partial')
  })
})

describe('generateOutputRules', () => {
  it('returns rules for conservative mode with dangerous task', () => {
    const rules = generateOutputRules('conservative', 'dangerous')
    assert(rules.length > 0)  // Conservative mode always generates rules
    assert(rules.includes('Conservative'))
  })

  it('returns empty string for balanced mode with dangerous task', () => {
    const rules = generateOutputRules('balanced', 'dangerous')
    assert.strictEqual(rules, '')
  })

  it('returns rules for balanced mode with safe task', () => {
    const rules = generateOutputRules('balanced', 'safe')
    assert(rules.length > 0)
    assert(rules.includes('Token-Efficient Output'))
    assert(rules.includes('Safe Task'))  // Capitalized "Safe Task"
  })

  it('returns rules for aggressive mode with any task', () => {
    const rules = generateOutputRules('aggressive', 'safe')
    assert(rules.length > 0)
    assert(rules.includes('Minimal'))

    const dangerousRules = generateOutputRules('aggressive', 'dangerous')
    assert(dangerousRules.length > 0)
  })

  it('returns rules for conservative mode with safe task', () => {
    const rules = generateOutputRules('conservative', 'safe')
    assert(rules.length > 0)
    assert(rules.includes('Conservative'))
    assert(!rules.includes('Maximum'))
  })

  it('defaults to balanced mode for invalid mode', () => {
    const rules = generateOutputRules('invalid', 'safe')
    assert(rules.length > 0)
    assert(rules.includes('Balanced'))
  })
})
