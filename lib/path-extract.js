// Given a `targets` array and the raw body, return a parallel array of
// `path | null` such that targets[i] belongs to file paths[i].
// Strategy: scan message history for tool_use blocks whose id matches the
// tool_use_id of the tool_result; extract input.file_path (Anthropic Read),
// input.path, or input.filePath. Provider-specific — Anthropic only.

function buildToolUseIndex(messages) {
  // Map<tool_use_id, { file_path }>. Scan assistant messages for tool_use
  // blocks and record their resolved file path once.
  const index = new Map()
  if (!Array.isArray(messages)) return index

  for (const msg of messages) {
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block?.type !== 'tool_use' || !block.id || !block.input) continue
      const input = block.input
      const filePath = input.file_path || input.path || input.filePath
      if (typeof filePath === 'string' && filePath.length > 0) {
        index.set(block.id, filePath)
      }
    }
  }
  return index
}

function findToolUseIdForTarget(body, target) {
  // Target path shape (Anthropic): ['messages', mi, 'content', i, ...]
  // The tool_result block lives at body.messages[mi].content[i].
  const path = target?.path
  if (!Array.isArray(path) || path[0] !== 'messages') return null
  const mi = path[1]
  const ci = path[3]
  const msg = body?.messages?.[mi]
  if (!msg || !Array.isArray(msg.content)) return null
  const block = msg.content[ci]
  if (!block || block.type !== 'tool_result') return null
  return typeof block.tool_use_id === 'string' ? block.tool_use_id : null
}

export function extractTargetPaths(body, targets) {
  const index = buildToolUseIndex(body?.messages)
  return targets.map(target => {
    if (!target || target.skip) return null
    const toolUseId = findToolUseIdForTarget(body, target)
    if (!toolUseId) return null
    return index.get(toolUseId) || null
  })
}
