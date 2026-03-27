function applyTargets(body, targets) {
  for (const t of targets) {
    if (t.skip || !t.compressed) continue
    let obj = body
    const path = t.path
    for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]]
    obj[path[path.length - 1]] = t.compressed
  }
}

function findLatestEligibleGroup(items, extractTargets) {
  let fallback = null
  for (let i = items.length - 1; i >= 0; i--) {
    const targets = extractTargets(items[i], i)
    if (!targets.length) continue
    fallback ||= targets
    if (targets.some(target => !target.skip)) return targets
  }
  return fallback || []
}

function extractAnthropicMessageTargets(msg, mi) {
  const targets = []
  if (msg.role !== 'user') return targets

  if (typeof msg.content === 'string') {
    targets.push({ path: ['messages', mi, 'content'], text: msg.content, index: mi })
  } else if (Array.isArray(msg.content)) {
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i]
      if (block.type !== 'tool_result') continue
      if (block.is_error) {
        targets.push({ skip: 'error', index: i })
        continue
      }

      if (typeof block.content === 'string') {
        targets.push({ path: ['messages', mi, 'content', i, 'content'], text: block.content, index: i })
      } else if (Array.isArray(block.content)) {
        for (let j = 0; j < block.content.length; j++) {
          const sub = block.content[j]
          if (sub.type === 'text') {
            targets.push({ path: ['messages', mi, 'content', i, 'content', j, 'text'], text: sub.text, index: i })
          }
        }
      }
    }
  }

  return targets
}

const anthropic = {
  name: 'anthropic',
  match(method, url) {
    return method === 'POST' && url.startsWith('/v1/messages')
  },
  extract(body, config = {}) {
    if (!body?.messages?.length) return []
    if (config.cacheSafe) {
      return findLatestEligibleGroup(body.messages, extractAnthropicMessageTargets)
    }

    return body.messages.flatMap(extractAnthropicMessageTargets)
  },
  apply(body, targets) {
    applyTargets(body, targets)
  },
}

function extractOpenAIResponsesTargets(item, i) {
  const targets = []
  if (item.type === 'function_call_output' && typeof item.output === 'string') {
    targets.push({ path: ['input', i, 'output'], text: item.output, index: i })
    return targets
  }
  if (item.type === 'message' && Array.isArray(item.content)) {
    for (let j = 0; j < item.content.length; j++) {
      const part = item.content[j]
      if ((part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') {
        targets.push({ path: ['input', i, 'content', j, 'text'], text: part.text, index: i })
      }
    }
  }
  return targets
}

function extractOpenAIChatTargets(msg, i) {
  if (msg.role !== 'tool' || typeof msg.content !== 'string') return []
  return [{ path: ['messages', i, 'content'], text: msg.content, index: i }]
}

const openai = {
  name: 'openai',
  match(method, url) {
    return method === 'POST' && (
      url.startsWith('/v1/chat/completions') ||
      url.startsWith('/chat/completions') ||
      url.startsWith('/v1/responses')
    )
  },
  normalizeUrl(url) {
    if (url.startsWith('/chat/completions')) return '/v1' + url
    return url
  },
  extract(body, config = {}) {
    // Responses API format: body.input array (Codex CLI)
    if (body?.input?.length) {
      if (config.cacheSafe) {
        const targets = []
        for (let i = body.input.length - 1; i >= 0; i--) {
          const itemTargets = extractOpenAIResponsesTargets(body.input[i], i)
          if (!itemTargets.length) break
          targets.unshift(...itemTargets)
        }
        return targets
      }

      return body.input.flatMap(extractOpenAIResponsesTargets)
    }

    // Chat Completions format
    if (!body?.messages?.length) return []

    if (config.cacheSafe) {
      const targets = []
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const msg = body.messages[i]
        if (msg.role !== 'tool') break
        targets.unshift(...extractOpenAIChatTargets(msg, i))
      }
      return targets
    }

    return body.messages.flatMap(extractOpenAIChatTargets)
  },
  apply(body, targets) {
    applyTargets(body, targets)
  },
}

function extractGeminiContentTargets(content, ci) {
  const targets = []
  if (!content.parts?.length) return targets

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

  return targets
}

const gemini = {
  name: 'gemini',
  match(method, url) {
    return method === 'POST' && url.includes('generateContent')
  },
  extract(body, config = {}) {
    if (!body?.contents?.length) return []
    if (config.cacheSafe) {
      return findLatestEligibleGroup(body.contents, extractGeminiContentTargets)
    }

    return body.contents.flatMap(extractGeminiContentTargets)
  },
  apply(body, targets) {
    for (const t of targets) {
      if (t.skip || !t.compressed) continue
      let obj = body
      const path = t.path
      for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]]
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
