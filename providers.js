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

// ---- Disclosure: find and rehydrate <tamp-ref:v1:...> quotes (Phase 5) ----

const DISCLOSURE_MARKER = /<tamp-ref:v1:([a-f0-9]{64}):(\d+)>/g

function scanStringForRefs(str, pathDesc, out) {
  if (typeof str !== 'string' || str.indexOf('<tamp-ref:v1:') === -1) return
  const re = new RegExp(DISCLOSURE_MARKER.source, DISCLOSURE_MARKER.flags)
  let m
  while ((m = re.exec(str)) !== null) {
    out.push({ hash: m[1], bytes: Number(m[2]), match: m[0], path: pathDesc.slice() })
  }
}

function findAnthropicReferences(body) {
  const out = []
  if (!Array.isArray(body?.messages)) return out
  for (let mi = 0; mi < body.messages.length; mi++) {
    const msg = body.messages[mi]
    if (!msg) continue
    if (typeof msg.content === 'string') {
      scanStringForRefs(msg.content, ['messages', mi, 'content'], out)
      continue
    }
    if (!Array.isArray(msg.content)) continue
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi]
      if (!block) continue
      if (block.type === 'text' && typeof block.text === 'string') {
        scanStringForRefs(block.text, ['messages', mi, 'content', bi, 'text'], out)
      } else if (block.type === 'tool_use') {
        if (block.input && typeof block.input === 'object') {
          const serialized = JSON.stringify(block.input)
          scanStringForRefs(serialized, ['messages', mi, 'content', bi, 'input'], out)
        } else if (typeof block.input === 'string') {
          scanStringForRefs(block.input, ['messages', mi, 'content', bi, 'input'], out)
        }
      } else if (block.type === 'tool_result') {
        if (typeof block.content === 'string') {
          scanStringForRefs(block.content, ['messages', mi, 'content', bi, 'content'], out)
        } else if (Array.isArray(block.content)) {
          for (let ci = 0; ci < block.content.length; ci++) {
            const sub = block.content[ci]
            if (sub?.type === 'text' && typeof sub.text === 'string') {
              scanStringForRefs(sub.text, ['messages', mi, 'content', bi, 'content', ci, 'text'], out)
            }
          }
        }
      }
    }
  }
  return out
}

function getAtPath(body, path) {
  let obj = body
  for (let i = 0; i < path.length; i++) obj = obj?.[path[i]]
  return obj
}

function setAtPath(body, path, value) {
  let obj = body
  for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]]
  obj[path[path.length - 1]] = value
}

// Replace marker(s) at each ref's path with the expanded block. For
// tool_use.input objects we round-trip via JSON. Idempotent: if the marker
// has already been replaced by an expansion (which contains "expanded -"
// sentinel for the same hash), we skip further replacement.
function applyAnthropicRehydration(body, refs) {
  const groups = new Map()
  for (const ref of refs) {
    if (!ref.expansion) continue
    const key = ref.path.join('|')
    if (!groups.has(key)) groups.set(key, { path: ref.path, items: [] })
    groups.get(key).items.push(ref)
  }

  for (const { path, items } of groups.values()) {
    const isToolUseInput = path[path.length - 1] === 'input'
    let current
    if (isToolUseInput) {
      const val = getAtPath(body, path)
      current = typeof val === 'string' ? val : JSON.stringify(val)
    } else {
      current = getAtPath(body, path)
    }
    if (typeof current !== 'string') continue

    let updated = current
    for (const ref of items) {
      const expandedSentinel = `<tamp-ref:v1:${ref.hash} expanded -`
      if (updated.indexOf(expandedSentinel) !== -1) continue
      const idx = updated.indexOf(ref.match)
      if (idx === -1) continue
      updated = updated.slice(0, idx) + ref.expansion + updated.slice(idx + ref.match.length)
    }

    if (updated === current) continue

    if (isToolUseInput) {
      try {
        const parsed = JSON.parse(updated)
        setAtPath(body, path, parsed)
        continue
      } catch { /* fall through to string */ }
    }
    setAtPath(body, path, updated)
  }
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
  findReferences(body) {
    return findAnthropicReferences(body)
  },
  applyRehydration(body, refs) {
    return applyAnthropicRehydration(body, refs)
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
