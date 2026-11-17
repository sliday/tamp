// Passive token-usage telemetry for upstream responses.
//
// The proxy pipes upstream bytes to the client untouched. This tap sees the
// same chunks on a side path and pulls the provider's usage counters out of
// them, prompt-cache counters included, so a cache-breaking rewrite shows up as
// a falling hit rate instead of a silent bill. It never writes to, holds up, or
// alters what the client gets: write() copies only the bytes it must keep, and
// any internal failure turns the tap into a no-op.
//
// The format comes from the payload shape, not from a provider argument:
//   Anthropic Messages   message_start.message.usage + message_delta.usage, or top-level usage
//   OpenAI Chat          usage.prompt_tokens / prompt_tokens_details.cached_tokens
//   OpenAI Responses     response.*.response.usage, or top-level usage with input_tokens_details
//   Gemini               usageMetadata (last one wins)
//
// Normalized inputTokens means UNCACHED input: inputTokens + cacheReadTokens +
// cacheCreationTokens is the full prompt. Anthropic already reports it that
// way; OpenAI and Gemini include cached tokens in the prompt count, so we
// subtract.

import zlib from 'node:zlib'

const DEFAULT_MAX_BUFFER = 1024 * 1024

const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)

function normalized(provider, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens) {
  return { provider, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }
}

function fromOpenAIChat(u) {
  const d = isObj(u.prompt_tokens_details) ? u.prompt_tokens_details : {}
  const read = num(d.cached_tokens)
  const write = num(d.cache_write_tokens)
  return normalized('openai', Math.max(0, num(u.prompt_tokens) - read - write), num(u.completion_tokens), read, write)
}

function fromOpenAIResponses(u) {
  const d = isObj(u.input_tokens_details) ? u.input_tokens_details : {}
  const read = num(d.cached_tokens)
  const write = num(d.cache_write_tokens)
  return normalized('openai-responses', Math.max(0, num(u.input_tokens) - read - write), num(u.output_tokens), read, write)
}

function fromGemini(m) {
  const read = num(m.cachedContentTokenCount)
  // candidatesTokenCount excludes thinking; the other providers bill reasoning
  // as output, so fold thoughtsTokenCount in to keep outputTokens comparable.
  const output = num(m.candidatesTokenCount) + num(m.thoughtsTokenCount)
  return normalized('gemini', Math.max(0, num(m.promptTokenCount) - read), output, read, 0)
}

function fromAnthropic(a) {
  return normalized('anthropic', num(a.input_tokens), num(a.output_tokens),
    num(a.cache_read_input_tokens), num(a.cache_creation_input_tokens))
}

const ANTHROPIC_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']

// Collects usage across a response. Later values win; Anthropic fields merge
// because message_start and message_delta each carry part of the picture.
function createExtractor() {
  let result = null
  let anthropic = null

  function mergeAnthropic(u) {
    if (!anthropic) anthropic = {}
    for (const k of ANTHROPIC_FIELDS) if (u[k] != null) anthropic[k] = u[k]
    result = fromAnthropic(anthropic)
  }

  function take(obj) {
    if (Array.isArray(obj)) {
      for (const item of obj) take(item)
      return
    }
    if (!isObj(obj)) return
    const type = typeof obj.type === 'string' ? obj.type : ''

    if (type === 'message_start' && isObj(obj.message) && isObj(obj.message.usage)) return mergeAnthropic(obj.message.usage)
    if (type === 'message_delta' && isObj(obj.usage)) return mergeAnthropic(obj.usage)
    if (type.startsWith('response.') && isObj(obj.response) && isObj(obj.response.usage)) {
      result = fromOpenAIResponses(obj.response.usage)
      return
    }
    if (isObj(obj.usageMetadata)) {
      result = fromGemini(obj.usageMetadata)
      return
    }
    const u = obj.usage
    if (!isObj(u)) return
    if (u.prompt_tokens != null) {
      result = fromOpenAIChat(u)
    } else if (type === 'message' || u.cache_read_input_tokens != null || u.cache_creation_input_tokens != null) {
      anthropic = null
      mergeAnthropic(u)
    } else if (obj.object === 'response' || isObj(u.input_tokens_details)) {
      result = fromOpenAIResponses(u)
    }
  }

  return { take, result: () => result }
}

// Incremental SSE reader. Splits on LF bytes (a UTF-8 multi-byte sequence never
// contains 0x0A, so decoding whole lines is safe), strips a trailing CR, joins
// data: lines per event, and hands each event's payload to onData. At most one
// partial line and one event's data stay in memory, each capped at max bytes;
// anything over the cap is dropped and parsing resumes at the next line/event.
function createSseReader(max, onData) {
  let parts = []
  let partLen = 0
  let skipping = false
  let data = []
  let dataLen = 0
  let dropEvent = false

  const resetPartial = () => { parts = []; partLen = 0 }

  function dispatch() {
    if (!dropEvent && data.length) onData(data.join('\n'))
    data = []
    dataLen = 0
    dropEvent = false
  }

  function line(str) {
    if (str.endsWith('\r')) str = str.slice(0, -1)
    if (str === '') return dispatch()
    if (!str.startsWith('data:')) return
    if (dropEvent) return
    let v = str.slice(5)
    if (v.startsWith(' ')) v = v.slice(1)
    dataLen += v.length + 1
    if (dataLen > max) {
      data = []
      dropEvent = true
      return
    }
    data.push(v)
  }

  function endLine(seg) {
    if (skipping) {
      skipping = false
      return
    }
    const total = partLen + seg.length
    if (total > max) {
      resetPartial()
      return
    }
    if (partLen === 0) return line(seg.toString('utf8'))
    parts.push(seg)
    const full = Buffer.concat(parts, total)
    resetPartial()
    line(full.toString('utf8'))
  }

  function addPartial(seg) {
    if (skipping || seg.length === 0) return
    if (partLen + seg.length > max) {
      resetPartial()
      skipping = true
      return
    }
    parts.push(Buffer.from(seg))
    partLen += seg.length
  }

  return {
    push(buf) {
      let pos = 0
      while (pos < buf.length) {
        const nl = buf.indexOf(10, pos)
        if (nl === -1) {
          addPartial(buf.subarray(pos))
          return
        }
        endLine(buf.subarray(pos, nl))
        pos = nl + 1
      }
    },
    end() {
      if (!skipping && partLen) {
        const full = Buffer.concat(parts, partLen)
        resetPartial()
        line(full.toString('utf8'))
      }
      dispatch()
    },
  }
}

// Bounded whole-body collector for non-streaming JSON. Over the cap it drops
// everything and reports overflow so the caller can give up.
function createJsonReader(max, onData) {
  let parts = []
  let len = 0
  let over = false
  return {
    push(buf) {
      if (over) return
      if (len + buf.length > max) {
        over = true
        parts = []
        return
      }
      parts.push(Buffer.from(buf))
      len += buf.length
    },
    end() {
      if (over || len === 0) return
      const text = Buffer.concat(parts, len).toString('utf8')
      parts = []
      onData(text)
    },
    overflowed: () => over,
  }
}

function pickDecoder(encoding, firstChunk) {
  if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.createGunzip()
  if (encoding === 'br') return zlib.createBrotliDecompress()
  if (encoding === 'deflate') {
    // HTTP "deflate" is meant to be zlib-wrapped, but some servers send raw
    // deflate. A zlib header has CM=8 and a header checksum divisible by 31.
    const b0 = firstChunk[0]
    const b1 = firstChunk.length > 1 ? firstChunk[1] : 0
    const wrapped = (b0 & 0x0f) === 8 && ((b0 << 8) | b1) % 31 === 0
    return wrapped ? zlib.createInflate() : zlib.createInflateRaw()
  }
  return null
}

function parseEncoding(value) {
  if (value == null) return 'identity'
  if (typeof value !== 'string') return null
  const parts = value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (parts.length === 0) return 'identity'
  if (parts.length > 1) return null // stacked encodings: not worth the risk
  return parts[0]
}

const NOOP = Object.freeze({ write() {}, end() {} })

export function createUsageTap({ contentType, contentEncoding, onUsage, maxBufferBytes } = {}) {
  try {
    if (typeof onUsage !== 'function' || typeof contentType !== 'string') return NOOP
    const ct = contentType.toLowerCase()
    const isSse = ct.includes('text/event-stream')
    const isJson = !isSse && ct.includes('json')
    if (!isSse && !isJson) return NOOP

    const encoding = parseEncoding(contentEncoding)
    if (encoding !== 'identity' && encoding !== 'gzip' && encoding !== 'x-gzip' && encoding !== 'br' && encoding !== 'deflate') return NOOP

    const max = Number.isFinite(maxBufferBytes) && maxBufferBytes > 0 ? maxBufferBytes : DEFAULT_MAX_BUFFER
    const extractor = createExtractor()
    let dead = false
    let finished = false
    let decoder = null

    const kill = () => {
      dead = true
      if (decoder) {
        try { decoder.destroy() } catch {}
        decoder = null
      }
    }

    const parse = (text) => {
      // Cheap filter: content deltas outnumber usage events by orders of magnitude.
      if (!text.includes('"usage')) return
      let obj
      try { obj = JSON.parse(text) } catch { return }
      extractor.take(obj)
    }

    const reader = isSse ? createSseReader(max, parse) : createJsonReader(max, parse)

    const finish = () => {
      if (dead || finished) return
      finished = true
      try {
        reader.end()
        const usage = extractor.result()
        if (usage) onUsage(usage)
      } catch {}
      kill()
    }

    const feed = (buf) => {
      if (dead) return
      reader.push(buf)
      if (reader.overflowed && reader.overflowed()) kill()
    }

    let decoderPicked = encoding === 'identity'

    return {
      write(chunk) {
        if (dead || finished) return
        try {
          if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return
          if (chunk.length === 0) return
          if (!decoderPicked) {
            decoderPicked = true
            decoder = pickDecoder(encoding, chunk)
            if (!decoder) return kill()
            decoder.on('data', (out) => { try { feed(out) } catch { kill() } })
            decoder.on('error', kill)
            decoder.on('end', finish)
          }
          if (decoder) {
            // The decoder works off-thread; if compressed input piles up faster
            // than it drains, stop rather than buffer the whole response.
            if (decoder.writableLength + chunk.length > max) return kill()
            decoder.write(Buffer.from(chunk))
          } else {
            feed(chunk)
          }
        } catch {
          kill()
        }
      },
      end() {
        if (dead || finished) return
        try {
          if (decoder) decoder.end()
          else if (decoderPicked) finish()
          else kill() // encoded response with no body
        } catch {
          kill()
        }
      },
    }
  } catch {
    return NOOP
  }
}

export function createUsageTotals() {
  const t = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  return {
    record(usage) {
      if (!isObj(usage)) return
      t.requests++
      t.inputTokens += num(usage.inputTokens)
      t.outputTokens += num(usage.outputTokens)
      t.cacheReadTokens += num(usage.cacheReadTokens)
      t.cacheCreationTokens += num(usage.cacheCreationTokens)
    },
    snapshot() {
      const denom = t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens
      return { ...t, cacheHitRate: denom > 0 ? t.cacheReadTokens / denom : null }
    },
  }
}
