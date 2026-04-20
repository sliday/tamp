/**
 * Task-type-aware output compression rules generator
 * Inspired by JuliusBrussee/caveman evaluation findings
 */

// Safe task patterns: simple, well-defined changes
const SAFE_TASK_PATTERNS = [
  /^(add|remove|update|set|unset)\s+(env\s+var|environment variable|config|configuration|\w+=)/i,
  /^fix\s+typo/i,
  /^update\s+(README|readme|documentation|docs)/i,
  /^(install|uninstall).*package/i,
  /^add\s+\w+\s+(as\s+)?dependency/i,
  /^update\s+version/i,
  /^(format|lint|fmt)|run linter/i,
]

// Dangerous task patterns: require detailed output
const DANGEROUS_TASK_PATTERNS = [
  /security|vulnerability|exploit|attack/i,
  /debug|investigate|diagnose|troubleshoot/i,
  /memory leak|performance|optimization|optimize/i,
  /^refactor|^architecture|^design/i,
  /^fix\s+bug/i,
  /^explain|^why|^how\s+(does|work)/i,
  /test|spec|coverage/i,
]

/**
 * Per-agent rule overrides. Keyed by `config.agent` (lowercased short name).
 * Shape: { <agent>: { safe?: string, dangerous?: string, complex?: string, conservative?: string } }
 *
 * Hook: populate these tables to tune phrasing per agent. A missing entry
 * falls through to the shared rules. Codex CLI's post-processor already
 * strips explanations, so we use terser phrasing there — other agents get
 * the default rules until we have evidence they benefit from variants.
 */
export const PER_AGENT_OVERRIDES = Object.freeze({
  codex: {
    safe: `## Token-Efficient Output (Balanced / Codex)
- Code only. No prose, no preamble, no summary.
- Single-line status after the change (e.g., "done", "noop").
`,
    complex: `## Token-Efficient Output (Balanced / Codex)
- Terse bullets. No filler sentences.
- Skip "Here's what I'll do" intros — just do it.
- Return code first; explanation only if non-obvious.
`,
  },
  // Intentionally empty — add overrides here if evidence warrants it.
  cursor: {},
  cline: {},
  aider: {},
  'claude-code': {},
})

/**
 * Detect task type from user message
 * @param {string} userMessage - User's input message
 * @returns {'safe' | 'dangerous' | 'complex'} - Task type classification
 */
export function detectTaskType(userMessage) {
  if (!userMessage || typeof userMessage !== 'string') return 'complex'

  const task = userMessage.toLowerCase().trim()

  // Check dangerous patterns first (safety priority)
  if (DANGEROUS_TASK_PATTERNS.some(p => p.test(task))) {
    return 'dangerous'
  }

  // Then check safe patterns
  if (SAFE_TASK_PATTERNS.some(p => p.test(task))) {
    return 'safe'
  }

  // Default to complex (ambiguous tasks)
  return 'complex'
}

/**
 * Output compression intensity levels
 */
export const OUTPUT_MODES = Object.freeze({
  conservative: {
    name: 'Conservative',
    description: 'Professional but concise',
    outputStyle: 'professional-concise',
    safeTaskCompression: 'none', // Full output
    dangerousTaskCompression: 'none', // Full output
    expectedSavings: '40-50%',
  },
  balanced: {
    name: 'Balanced',
    description: 'Terse, bullet points, task-type-aware',
    outputStyle: 'terse-bullets',
    safeTaskCompression: 'aggressive', // Compressed
    dangerousTaskCompression: 'none', // Full output
    expectedSavings: '65-75% on safe tasks',
  },
  aggressive: {
    name: 'Aggressive',
    description: 'Minimal caveman-style',
    outputStyle: 'minimal-caveman',
    safeTaskCompression: 'maximum', // Highly compressed
    dangerousTaskCompression: 'partial', // Some compression
    expectedSavings: '75-85% on safe tasks',
  },
})

/**
 * Generate optimized CLAUDE.md rules for output compression
 * @param {string} mode - Output mode (conservative | balanced | aggressive)
 * @param {string} taskType - Task type (safe | dangerous | complex)
 * @param {string} [agent] - Optional agent name for per-agent overrides
 * @returns {string} - Optimized CLAUDE.md rules text
 */
export function generateOutputRules(mode = 'balanced', taskType = 'complex', agent) {
  const modeConfig = OUTPUT_MODES[mode] || OUTPUT_MODES.balanced

  // Conservative mode always generates minimal rules (for all task types)
  if (mode === 'conservative') {
    const override = agent && PER_AGENT_OVERRIDES[agent]?.conservative
    return override || generateConservativeRules()
  }

  // Determine if we should compress based on mode + task type
  const shouldCompress = {
    safe: modeConfig.safeTaskCompression !== 'none',
    dangerous: modeConfig.dangerousTaskCompression === 'partial',
    complex: mode === 'aggressive', // Only compress complex in aggressive mode
  }[taskType]

  // If compression disabled for this task type, return empty
  if (!shouldCompress) {
    return ''
  }

  // Check per-agent override for this (agent, taskType) pair
  const override = agent && PER_AGENT_OVERRIDES[agent]?.[taskType]
  if (override) return override

  // Generate rules based on mode
  const rules = {
    balanced: generateBalancedRules(taskType),
    aggressive: generateAggressiveRules(taskType),
  }

  return rules[mode] || generateBalancedRules(taskType)
}

function generateConservativeRules() {
  return `## Token-Efficient Output (Conservative Mode)

Be concise but professional. Skip fluff, pleasantries, and meta-commentary.
- Use bullet points for lists
- Prefer active voice
- Avoid "Here's the summary" or "Let me explain" intros
- Return code first, explanation after if non-obvious
`
}

function generateBalancedRules(taskType) {
  const baseRules = `## Token-Efficient Output (Balanced Mode)

**Output Style:** Terse, actionable, task-appropriate.

### Core Rules
- Skip ALL pleasantries ("Sure!", "Great question!", "I hope this helps!")
- No sycophantic openers or closing fluff
- Return code first. Explanation after, only if non-obvious
- Use bullet points for multi-step explanations
- Single-sentence responses when possible
- No "Here's what I'll do" preambles — just do it
`

  if (taskType === 'safe') {
    return baseRules + `
### Safe Task Optimizations (Active)
This task classified as SAFE — maximum compression enabled:
- One-line responses when possible
- Omit obvious explanations
- Minimal context, focus on change
- Code-only if change is self-explanatory
`
  }

  return baseRules
}

function generateAggressiveRules(taskType) {
  const baseRules = `## Token-Efficient Output (Aggressive Mode)

**Output Style:** Minimal. Caveman-like but functional.

### Core Rules
- NEVER use pleasantries, intros, or summaries
- Code ONLY if change is self-explanatory
- One-word responses when possible (done, fixed, added, removed)
- Single bullet point per issue
- Omit ALL non-essential context
- No "## Section" headers in responses
- No markdown formatting unless code block
`

  if (taskType === 'safe') {
    return baseRules + `
### Safe Task Maximum Compression
- Name of file changed + status. That's it.
- No explanation unless ambiguous
- One character response: ✓ or ✗ if clear
`
  } else if (taskType === 'dangerous') {
    return baseRules + `
### Dangerous Task Partial Compression
- Bullet-point findings only
- Skip "investigating" status updates
- Final result + minimal reproduction steps
`
  }

  return baseRules
}

/**
 * Generate full CLAUDE.md content with injected rules
 * @param {string} existingContent - Current CLAUDE.md content
 * @param {string} mode - Output mode
 * @param {string} taskType - Task type
 * @returns {string} - Updated CLAUDE.md content
 */
export function injectOutputRules(existingContent, mode, taskType) {
  const rules = generateOutputRules(mode, taskType)
  if (!rules) return existingContent

  // Check if rules already exist, replace if so
  const markerStart = '## Token-Efficient Output'
  const existingStart = existingContent.indexOf(markerStart)

  if (existingStart !== -1) {
    // Replace existing rules section
    const before = existingContent.slice(0, existingStart)
    const afterMatch = existingContent.slice(existingStart).match(/\n\n(?:##|$)/)
    const after = afterMatch ? afterMatch[0] : '\n\n'
    return before + rules.trim() + after
  }

  // Append new rules
  return existingContent.trimEnd() + '\n\n' + rules.trim() + '\n'
}
