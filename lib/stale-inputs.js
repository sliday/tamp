// Stale tool_use.input pruning (opt-in, lossy).
//
// Rule table adapted from magic-compact (https://github.com/aerovato/magic-compact,
// BSD-3-Clause, src/prune.ts). Thresholds and per-tool choices follow that work.
//
// tool_use.input carries 26% of billed tokens across 60 large sessions — the
// largest mass tamp has never touched. An old tool call still needs to show its
// SHAPE (which tool, against which file) because that is the record of what the
// agent did. Its payload does not: the written file is on disk, the edit already
// landed, the agent prompt already ran. So headers stay, payloads go.
//
// Age-scoped for the same reason as stale-images: pruning the call the agent is
// still working with would break it. Rewriting old turns invalidates the prompt
// cache, which is why this is opt-in. Anthropic block shape only.

const DEFAULT_KEEP_RECENT = 2
const LIMIT = { words: 128, chars: 1024 }
const BASH_LIMIT = 1024
const BASH_HEAD = 512

function tooSmall(text) {
  if (typeof text !== 'string') return true
  const trimmed = text.trim()
  const words = trimmed ? trimmed.split(/\s+/).length : 0
  return words <= LIMIT.words && text.length <= LIMIT.chars
}

function notice(what, chars) {
  return `[tamp: ${what} omitted from this older turn (${chars} chars). Re-read the file if you need the current contents.]`
}

// field -> label. Each is a payload the agent can recover another way.
const OMIT_FIELDS = {
  Write: [['content', 'file contents']],
  NotebookEdit: [['new_source', 'notebook source']],
  Agent: [['prompt', 'agent prompt']],
  Workflow: [['script', 'workflow script']],
  SendMessage: [['message', 'inter-agent message']],
}

function pruneInput(name, input) {
  if (!input || typeof input !== 'object') return false
  if (name === 'AskUserQuestion') return false

  if (name === 'Bash') {
    const command = input.command
    if (typeof command !== 'string' || command.length <= BASH_LIMIT) return false
    input.command = `${command.slice(0, BASH_HEAD)}\n[tamp: command truncated, ${command.length} chars total]`
    return true
  }

  if (name === 'Edit') {
    const oldStr = input.old_string
    const newStr = input.new_string
    if (typeof oldStr !== 'string' || typeof newStr !== 'string') return false
    if (tooSmall(`${oldStr}\n${newStr}`)) return false
    input.old_string = notice('edit old_string', oldStr.length)
    input.new_string = notice('edit new_string', newStr.length)
    return true
  }

  const fields = OMIT_FIELDS[name]
  if (!fields) return false
  let changed = false
  for (const [field, label] of fields) {
    const value = input[field]
    if (typeof value !== 'string' || tooSmall(value)) continue
    input[field] = notice(label, value.length)
    changed = true
  }
  return changed
}

export function pruneStaleInputs(body, { keepRecent = DEFAULT_KEEP_RECENT } = {}) {
  const messages = body?.messages
  const none = { pruned: 0 }
  if (!Array.isArray(messages)) return none

  const callTurns = []
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue
    if (msg.content.some(b => b?.type === 'tool_use')) callTurns.push(mi)
  }
  if (callTurns.length <= keepRecent) return none

  let pruned = 0
  for (const mi of callTurns.slice(0, callTurns.length - keepRecent)) {
    for (const block of messages[mi].content) {
      if (block?.type !== 'tool_use') continue
      if (pruneInput(block.name, block.input)) pruned += 1
    }
  }

  return { pruned }
}
