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

function getLastUserTextFromAnthropicMessages(messages) {
  if (!Array.isArray(messages)) return null
  // Walk back across user messages until we find one with actual text
  // content. Latest user messages in a Claude Code session are often
  // pure tool_result blocks; the human's intent text is in an earlier turn.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== 'user') continue
    if (typeof msg.content === 'string') return msg.content
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b?.type === 'text' && typeof b.text === 'string') return b.text
      }
    }
    // No text in this user message — keep walking back
  }
  return null
}

function appendToLastUserMessageAnthropic(messages, text) {
  if (!Array.isArray(messages) || !text) return false
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== 'user') continue
    if (typeof msg.content === 'string') {
      msg.content = msg.content + '\n\n' + text
      return true
    }
    if (Array.isArray(msg.content)) {
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const b = msg.content[j]
        if (b?.type === 'text' && typeof b.text === 'string') {
          b.text = b.text + '\n\n' + text
          return true
        }
      }
      msg.content.push({ type: 'text', text })
      return true
    }
    return false
  }
  return false
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
  getLastUserText(body) {
    return getLastUserTextFromAnthropicMessages(body?.messages)
  },
  injectOutputHint(body, text) {
    return appendToLastUserMessageAnthropic(body?.messages, text)
  },
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
      url.startsWith('/chat/completions')
    )
  },
  normalizeUrl(url) {
    if (url.startsWith('/chat/completions')) return '/v1' + url
    return url
  },
  extract(body, config = {}) {
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
  getLastUserText(body) {
    if (!body?.messages?.length) return null
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const msg = body.messages[i]
      if (msg?.role === 'user' && typeof msg.content === 'string') return msg.content
    }
    return null
  },
  injectOutputHint(body, text) {
    if (!body?.messages?.length || !text) return false
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const msg = body.messages[i]
      if (msg?.role !== 'user') continue
      if (typeof msg.content === 'string') {
        msg.content = msg.content + '\n\n' + text
        return true
      }
      return false
    }
    return false
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
  getLastUserText(body) {
    if (!body?.contents?.length) return null
    for (let i = body.contents.length - 1; i >= 0; i--) {
      const c = body.contents[i]
      if (c?.role && c.role !== 'user') continue
      if (!Array.isArray(c?.parts)) continue
      for (const p of c.parts) {
        if (typeof p?.text === 'string') return p.text
      }
    }
    return null
  },
  injectOutputHint(body, text) {
    if (!body?.contents?.length || !text) return false
    for (let i = body.contents.length - 1; i >= 0; i--) {
      const c = body.contents[i]
      if (c?.role && c.role !== 'user') continue
      if (!Array.isArray(c?.parts)) continue
      for (let j = c.parts.length - 1; j >= 0; j--) {
        const p = c.parts[j]
        if (typeof p?.text === 'string') {
          p.text = p.text + '\n\n' + text
          return true
        }
      }
      c.parts.push({ text })
      return true
    }
    return false
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

function extractOpenAIResponsesTargets(item, i) {
  if (item?.type !== 'function_call_output') return []
  if (typeof item.output !== 'string') return []
  return [{ path: ['input', i, 'output'], text: item.output, index: i }]
}

const openaiResponses = {
  name: 'openai-responses',
  match(method, url) {
    return method === 'POST' && (
      url.startsWith('/v1/responses') ||
      url.startsWith('/responses')
    )
  },
  normalizeUrl(url) {
    if (url.startsWith('/responses')) return '/v1' + url
    return url
  },
  extract(body, config = {}) {
    if (!Array.isArray(body?.input) || !body.input.length) return []

    if (config.cacheSafe) {
      const targets = []
      for (let i = body.input.length - 1; i >= 0; i--) {
        const item = body.input[i]
        if (item?.type !== 'function_call_output') break
        targets.unshift(...extractOpenAIResponsesTargets(item, i))
      }
      return targets
    }

    return body.input.flatMap(extractOpenAIResponsesTargets)
  },
  apply(body, targets) {
    applyTargets(body, targets)
  },
  getLastUserText(body) {
    if (!Array.isArray(body?.input) || !body.input.length) return null
    // Walk back across user items until we find one with actual text content
    for (let i = body.input.length - 1; i >= 0; i--) {
      const item = body.input[i]
      if (item?.role !== 'user' || !Array.isArray(item.content)) continue
      for (const block of item.content) {
        if (block?.type === 'input_text' && typeof block.text === 'string') return block.text
      }
    }
    return null
  },
  injectOutputHint(body, text) {
    if (!Array.isArray(body?.input) || !body.input.length || !text) return false
    // Target the LATEST user item (cache-safe). If it has no input_text
    // block we push one, so injection always succeeds for any user item.
    for (let i = body.input.length - 1; i >= 0; i--) {
      const item = body.input[i]
      if (item?.role !== 'user' || !Array.isArray(item.content)) continue
      for (let j = item.content.length - 1; j >= 0; j--) {
        const block = item.content[j]
        if (block?.type === 'input_text' && typeof block.text === 'string') {
          block.text = block.text + '\n\n' + text
          return true
        }
      }
      item.content.push({ type: 'input_text', text })
      return true
    }
    return false
  },
}

const providers = [anthropic, openai, openaiResponses, gemini]

export function detectProvider(method, url) {
  for (const p of providers) {
    if (p.match(method, url)) return p
  }
  return null
}

export { anthropic, openai, openaiResponses, gemini }
