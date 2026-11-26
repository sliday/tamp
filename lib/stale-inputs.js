// Stale tool-call input pruning (opt-in, lossy).
//
// Rule table adapted from magic-compact (https://github.com/aerovato/magic-compact,
// BSD-3-Clause, src/prune.ts). Thresholds and per-tool choices follow that work.
//
// Tool-call inputs carry 26% of billed tokens across 60 large sessions — the
// largest mass tamp has never touched. An old tool call still needs to show its
// SHAPE (which tool, against which file) because that is the record of what the
// agent did. Its payload does not: the written file is on disk, the edit already
// landed, the agent prompt already ran. So headers stay, payloads go.
//
// Age-scoped for the same reason as stale-images: pruning the call the agent is
// still working with would break it. Rewriting old turns invalidates the prompt
// cache, which is why this is opt-in. Supports Anthropic (messages[].content[]
// tool_use), OpenAI Chat / Kimi / Moonshot (messages[].tool_calls[]), and
// OpenAI Responses / Codex CLI (input[] function_call & custom_tool_call).

const DEFAULT_KEEP_RECENT = 2
const DEFAULT_BATCH_SIZE = 1
const LIMIT = { words: 128, chars: 1024 }
const BASH_LIMIT = 1024
const BASH_HEAD = 512

const RECOVERY_FILE = 'Re-read the file if you need the current contents.'
const RECOVERY_OMITTED = 'Summary retained in tool header; payload omitted from older turn.'
const PATCH_HEADER_RE = /^\*\*\*\s+(?:Update File|Add File|Delete File|Move to):/

const PROTECTED_TOOLS = new Set(['askuserquestion'])
const EDIT_TOOLS = new Set(['edit', 'edit_file', 'replace_file_content'])
const SHELL_TOOLS = new Set(['bash', 'shell', 'exec_command', 'run_command', 'execute_command', 'local_shell'])

const WRITE_FIELDS = [
  ['content', 'file contents', RECOVERY_FILE],
  ['file_text', 'file contents', RECOVERY_FILE],
]

// lowercase tool name -> [[field, label, recovery], ...].
const OMIT_FIELDS = new Map([
  ['write', WRITE_FIELDS],
  ['write_file', WRITE_FIELDS],
  ['write_to_file', WRITE_FIELDS],
  ['create_file', WRITE_FIELDS],
  ['notebookedit', [['new_source', 'notebook source', RECOVERY_FILE]]],
  ['agent', [['prompt', 'agent prompt', RECOVERY_OMITTED]]],
  ['workflow', [['script', 'workflow script', RECOVERY_OMITTED]]],
  ['sendmessage', [['message', 'inter-agent message', RECOVERY_OMITTED]]],
])

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
}

function tooSmall(text) {
  if (typeof text !== 'string') return true
  const trimmed = text.trim()
  const words = trimmed ? trimmed.split(/\s+/).length : 0
  return words <= LIMIT.words && text.length <= LIMIT.chars
}

function notice(what, chars, recovery = RECOVERY_FILE) {
  return `[tamp: ${what} omitted from this older turn (${chars} chars). ${recovery}]`
}

function truncateCommand(text) {
  if (typeof text !== 'string' || text.length <= BASH_LIMIT) return null
  return `${text.slice(0, BASH_HEAD)}\n[tamp: command truncated, ${text.length} chars total]`
}

function prunePatchText(text) {
  if (typeof text !== 'string' || tooSmall(text)) return null
  const headers = text.split(/\r?\n/).filter(line => PATCH_HEADER_RE.test(line))
  const msg = notice('patch body', text.length, RECOVERY_FILE)
  return headers.length > 0 ? `${headers.join('\n')}\n${msg}` : msg
}

function pruneInput(name, input) {
  if (typeof name !== 'string' || !name || !isPlainObject(input)) return false
  const key = name.toLowerCase()
  if (PROTECTED_TOOLS.has(key)) return false

  if (SHELL_TOOLS.has(key)) {
    const field = typeof input.command === 'string' ? 'command'
      : typeof input.cmd === 'string' ? 'cmd'
      : null
    if (!field) return false
    const truncated = truncateCommand(input[field])
    if (truncated === null) return false
    input[field] = truncated
    return true
  }

  if (EDIT_TOOLS.has(key)) {
    if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      if (tooSmall(`${input.old_string}\n${input.new_string}`)) return false
      input.old_string = notice('edit old_string', input.old_string.length, RECOVERY_FILE)
      input.new_string = notice('edit new_string', input.new_string.length, RECOVERY_FILE)
      return true
    }
    if (typeof input.old_str === 'string' && typeof input.new_str === 'string') {
      if (tooSmall(`${input.old_str}\n${input.new_str}`)) return false
      input.old_str = notice('edit old_str', input.old_str.length, RECOVERY_FILE)
      input.new_str = notice('edit new_str', input.new_str.length, RECOVERY_FILE)
      return true
    }
    if (typeof input.replacement_content === 'string') {
      if (typeof input.target_content === 'string') {
        if (tooSmall(`${input.target_content}\n${input.replacement_content}`)) return false
        input.target_content = notice('edit target_content', input.target_content.length, RECOVERY_FILE)
        input.replacement_content = notice('edit replacement_content', input.replacement_content.length, RECOVERY_FILE)
        return true
      }
      if (tooSmall(input.replacement_content)) return false
      input.replacement_content = notice('edit replacement_content', input.replacement_content.length, RECOVERY_FILE)
      return true
    }
    return false
  }

  if (key === 'apply_patch') {
    let changed = false
    for (const field of ['patch', 'input']) {
      const pruned = prunePatchText(input[field])
      if (pruned !== null) {
        input[field] = pruned
        changed = true
      }
    }
    return changed
  }

  const fields = OMIT_FIELDS.get(key)
  if (!fields) return false
  let changed = false
  for (const [field, label, recovery] of fields) {
    const value = input[field]
    if (typeof value !== 'string' || tooSmall(value)) continue
    input[field] = notice(label, value.length, recovery)
    changed = true
  }
  return changed
}

function pruneRawInput(name, text) {
  if (typeof name !== 'string' || !name || typeof text !== 'string') return null
  const key = name.toLowerCase()
  if (PROTECTED_TOOLS.has(key)) return null
  if (key === 'apply_patch') return prunePatchText(text)
  if (SHELL_TOOLS.has(key)) return truncateCommand(text)
  return null
}

function pruneJsonArgs(name, rawArgs) {
  if (typeof name !== 'string' || !name || typeof rawArgs !== 'string') return null
  if (PROTECTED_TOOLS.has(name.toLowerCase())) return null
  let parsed
  try {
    parsed = JSON.parse(rawArgs)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  if (!pruneInput(name, parsed)) return null
  return JSON.stringify(parsed)
}

function pruneCustomToolCall(item) {
  const { name, input } = item
  if (typeof name !== 'string' || !name) return false
  if (PROTECTED_TOOLS.has(name.toLowerCase())) return false

  if (isPlainObject(input)) {
    return pruneInput(name, input)
  }

  if (typeof input !== 'string') return false

  if (input.trimStart().startsWith('{')) {
    let parsed = null
    try {
      parsed = JSON.parse(input)
    } catch { /* fall through to raw freeform handling */ }
    if (isPlainObject(parsed)) {
      if (!pruneInput(name, parsed)) return false
      item.input = JSON.stringify(parsed)
      return true
    }
  }

  const prunedRaw = pruneRawInput(name, input)
  if (prunedRaw === null) return false
  item.input = prunedRaw
  return true
}

function computeEvictCount(turnCount, keepRecent, batchSize) {
  const eligible = turnCount - keepRecent
  if (eligible <= 0) return 0
  const batch = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : DEFAULT_BATCH_SIZE
  return Math.floor(eligible / batch) * batch
}

function hasMessageToolCalls(msg) {
  if (msg?.role !== 'assistant') return false
  const hasAnthropic = Array.isArray(msg.content) && msg.content.some(b => b?.type === 'tool_use')
  const hasOpenAI = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
  return hasAnthropic || hasOpenAI
}

function pruneMessages(messages, keepRecent, batchSize) {
  const callTurns = []
  for (let mi = 0; mi < messages.length; mi++) {
    if (hasMessageToolCalls(messages[mi])) callTurns.push(mi)
  }
  const evictCount = computeEvictCount(callTurns.length, keepRecent, batchSize)
  if (evictCount <= 0) return { pruned: 0 }

  let pruned = 0
  for (const mi of callTurns.slice(0, evictCount)) {
    const msg = messages[mi]
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type !== 'tool_use') continue
        if (pruneInput(block.name, block.input)) pruned += 1
      }
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const fn = tc?.function
        if (!fn || typeof fn.name !== 'string') continue
        const next = pruneJsonArgs(fn.name, fn.arguments)
        if (next !== null) {
          fn.arguments = next
          pruned += 1
        }
      }
    }
  }

  return { pruned }
}

function isResponsesToolCall(item) {
  return item?.type === 'function_call' || item?.type === 'custom_tool_call'
}

function pruneResponsesInput(input, keepRecent, batchSize) {
  const callTurns = []
  let currentTurn = null
  for (let i = 0; i < input.length; i++) {
    if (isResponsesToolCall(input[i])) {
      if (!currentTurn) {
        currentTurn = []
        callTurns.push(currentTurn)
      }
      currentTurn.push(input[i])
    } else {
      currentTurn = null
    }
  }
  const evictCount = computeEvictCount(callTurns.length, keepRecent, batchSize)
  if (evictCount <= 0) return { pruned: 0 }

  let pruned = 0
  for (const turn of callTurns.slice(0, evictCount)) {
    for (const item of turn) {
      if (item.type === 'function_call') {
        const next = pruneJsonArgs(item.name, item.arguments)
        if (next !== null) {
          item.arguments = next
          pruned += 1
        }
      } else if (item.type === 'custom_tool_call') {
        if (pruneCustomToolCall(item)) pruned += 1
      }
    }
  }

  return { pruned }
}

export function pruneStaleInputs(body, { keepRecent = DEFAULT_KEEP_RECENT, batchSize = DEFAULT_BATCH_SIZE } = {}) {
  if (Array.isArray(body?.messages)) {
    return pruneMessages(body.messages, keepRecent, batchSize)
  }
  if (Array.isArray(body?.input)) {
    return pruneResponsesInput(body.input, keepRecent, batchSize)
  }
  return { pruned: 0 }
}
