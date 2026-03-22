const anthropic = {
  name: 'anthropic',
  match(method, url) {
    return method === 'POST' && url.startsWith('/v1/messages')
  },
  extract(body) {
    const targets = []
    if (!body?.messages?.length) return targets

    let lastUserIdx = -1
    for (let i = body.messages.length - 1; i >= 0; i--) {
      if (body.messages[i].role === 'user') { lastUserIdx = i; break }
    }
    if (lastUserIdx === -1) return targets

    const msg = body.messages[lastUserIdx]

    if (typeof msg.content === 'string') {
      targets.push({ path: ['messages', lastUserIdx, 'content'], text: msg.content })
    } else if (Array.isArray(msg.content)) {
      for (let i = 0; i < msg.content.length; i++) {
        const block = msg.content[i]
        if (block.type !== 'tool_result') continue
        if (block.is_error) { targets.push({ skip: 'error', index: i }); continue }

        if (typeof block.content === 'string') {
          targets.push({ path: ['messages', lastUserIdx, 'content', i, 'content'], text: block.content, index: i })
        } else if (Array.isArray(block.content)) {
          for (let j = 0; j < block.content.length; j++) {
            const sub = block.content[j]
            if (sub.type === 'text') {
              targets.push({ path: ['messages', lastUserIdx, 'content', i, 'content', j, 'text'], text: sub.text, index: i })
            }
          }
        }
      }
    }
    return targets
  },
  apply(body, targets) {
    for (const t of targets) {
      if (t.skip || !t.compressed) continue
      let obj = body
      const path = t.path
      for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]]
      obj[path[path.length - 1]] = t.compressed
    }
  },
}

const openai = {
  name: 'openai',
  match(method, url) {
    return method === 'POST' && (
      url.startsWith('/v1/chat/completions') ||
      url.startsWith('/chat/completions') ||
      url.startsWith('/v1/responses') ||
      url.startsWith('/responses')
    )
  },
  normalizeUrl(url) {
    if (url.startsWith('/chat/completions')) return '/v1' + url
    if (url.startsWith('/responses')) return '/v1' + url
    return url
  },
  extract(body) {
    const targets = []

    // Responses API format: body.input array
    if (body?.input?.length) {
      for (let i = 0; i < body.input.length; i++) {
        const item = body.input[i]
        if (item.type === 'function_call_output' && typeof item.output === 'string') {
          targets.push({ path: ['input', i, 'output'], text: item.output, index: i })
          continue
        }
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (let j = 0; j < item.content.length; j++) {
            const part = item.content[j]
            if ((part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') {
              targets.push({ path: ['input', i, 'content', j, 'text'], text: part.text, index: i })
            }
          }
        }
      }
      return targets
    }

    // Chat Completions format
    if (!body?.messages?.length) return targets

    // Find last assistant message with tool_calls
    let lastAssistantIdx = -1
    for (let i = body.messages.length - 1; i >= 0; i--) {
      if (body.messages[i].role === 'assistant' && body.messages[i].tool_calls?.length) {
        lastAssistantIdx = i
        break
      }
    }
    if (lastAssistantIdx === -1) return targets

    // Collect all subsequent role:tool messages
    for (let i = lastAssistantIdx + 1; i < body.messages.length; i++) {
      const msg = body.messages[i]
      if (msg.role !== 'tool') break
      if (typeof msg.content === 'string') {
        targets.push({ path: ['messages', i, 'content'], text: msg.content, index: i })
      }
    }
    return targets
  },
  apply(body, targets) {
    for (const t of targets) {
      if (t.skip || !t.compressed) continue
      let obj = body
      const path = t.path
      for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]]
      obj[path[path.length - 1]] = t.compressed
    }
  },
}

const gemini = {
  name: 'gemini',
  match(method, url) {
    return method === 'POST' && url.includes('generateContent')
  },
  extract(body) {
    const targets = []
    if (!body?.contents?.length) return targets

    // Find last content with functionResponse parts
    for (let ci = body.contents.length - 1; ci >= 0; ci--) {
      const content = body.contents[ci]
      if (!content.parts?.length) continue
      for (let pi = 0; pi < content.parts.length; pi++) {
        const part = content.parts[pi]
        if (!part.functionResponse?.response) continue
        const resp = part.functionResponse.response
        const text = typeof resp === 'string' ? resp : JSON.stringify(resp, null, 2)
        targets.push({
          path: ['contents', ci, 'parts', pi, 'functionResponse', 'response'],
          text,
          index: pi,
          wasObject: typeof resp !== 'string',
        })
      }
      if (targets.length) break
    }
    return targets
  },
  apply(body, targets) {
    for (const t of targets) {
      if (t.skip || !t.compressed) continue
      let obj = body
      const path = t.path
      for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]]
      // If original was object, try to parse compressed back to object
      if (t.wasObject) {
        try {
          obj[path[path.length - 1]] = JSON.parse(t.compressed)
          continue
        } catch { /* fall through to string */ }
      }
      obj[path[path.length - 1]] = t.compressed
    }
  },
}

const providers = [anthropic, openai, gemini]

export function detectProvider(method, url) {
  for (const p of providers) {
    if (p.match(method, url)) return p
  }
  return null
}

export { anthropic, openai, gemini }
