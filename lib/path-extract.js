// Given a `targets` array and the raw body, return a parallel array of
// `path | null` (or `toolName | null`) such that targets[i] is attributed to
// the tool call that produced it. Supports Anthropic (/v1/messages),
// OpenAI Chat / Kimi / Moonshot (/v1/chat/completions), and OpenAI Responses /
// Codex CLI (/v1/responses).

function pickFilePath(input) {
  if (!input || typeof input !== 'object') return null
  for (const key of ['file_path', 'path', 'filePath', 'filename']) {
    const val = input[key]
    if (typeof val === 'string' && val.length > 0) return val
  }
  return null
}

function parseArgs(raw) {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function buildToolCallIndex(body) {
  // Map<callId, { name, filePath }> across Anthropic, OpenAI Chat, and
  // OpenAI Responses tool-call shapes.
  const index = new Map()
  if (!body || typeof body !== 'object') return index

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg?.role !== 'assistant') continue
      // Anthropic: assistant content[] blocks of type 'tool_use'
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type !== 'tool_use' || typeof block.id !== 'string' || !block.id) continue
          const name = typeof block.name === 'string' && block.name.length > 0 ? block.name : null
          const filePath = pickFilePath(block.input)
          index.set(block.id, { name, filePath })
        }
      }
      // OpenAI Chat / Kimi / Moonshot: assistant tool_calls[]
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc || typeof tc.id !== 'string' || !tc.id) continue
          const fn = tc.function
          const name = typeof fn?.name === 'string' && fn.name.length > 0 ? fn.name : null
          const filePath = pickFilePath(parseArgs(fn?.arguments))
          index.set(tc.id, { name, filePath })
        }
      }
    }
  }

  // OpenAI Responses (Codex CLI): input[] items of type function_call / custom_tool_call
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || (item.type !== 'function_call' && item.type !== 'custom_tool_call')) continue
      if (typeof item.call_id !== 'string' || !item.call_id) continue
      const name = typeof item.name === 'string' && item.name.length > 0 ? item.name : null
      const filePath = pickFilePath(parseArgs(item.arguments) || parseArgs(item.input))
      index.set(item.call_id, { name, filePath })
    }
  }

  return index
}

function findToolCallIdForTarget(body, target) {
  const path = target?.path
  if (!Array.isArray(path) || path.length < 3) return null

  if (path[0] === 'messages') {
    const msg = body?.messages?.[path[1]]
    if (!msg) return null
    // OpenAI Chat / Kimi / Moonshot: ['messages', mi, 'content', ...]
    if (msg.role === 'tool') {
      return typeof msg.tool_call_id === 'string' && msg.tool_call_id.length > 0 ? msg.tool_call_id : null
    }
    // Anthropic: ['messages', mi, 'content', ci, ...]
    if (Array.isArray(msg.content) && path.length >= 4) {
      const block = msg.content[path[3]]
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && block.tool_use_id.length > 0) {
        return block.tool_use_id
      }
    }
    return null
  }

  if (path[0] === 'input') {
    const item = body?.input?.[path[1]]
    if (!item) return null
    // OpenAI Responses: ['input', i, 'output', ...]
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      return typeof item.call_id === 'string' && item.call_id.length > 0 ? item.call_id : null
    }
    return null
  }

  return null
}

export function extractTargetPaths(body, targets) {
  const index = buildToolCallIndex(body)
  return targets.map(target => {
    if (!target || target.skip) return null
    const id = findToolCallIdForTarget(body, target)
    if (!id) return null
    return index.get(id)?.filePath || null
  })
}

// Parallel to `targets`: the tool name that produced each target, or null when
// it can't be attributed. Never reorders — callers index by position.
export function extractTargetToolNames(body, targets) {
  const index = buildToolCallIndex(body)
  return targets.map(target => {
    if (!target || target.skip) return null
    const id = findToolCallIdForTarget(body, target)
    if (!id) return null
    return index.get(id)?.name || null
  })
}
