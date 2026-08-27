// Stale image eviction (opt-in, lossy).
//
// Tamp's target extractor only collects `type: 'text'` sub-blocks, so base64
// image blocks inside tool_results pass through untouched. Measured across 403
// code-only sessions they carry 79% of all tokens: reading PNGs in graphics and
// game projects, not just browser screenshots.
//
// Images are also the safest thing to drop, because they are reloadable — the
// agent can re-Read the file or re-take the screenshot. What is not safe is
// dropping the image the agent just asked to see, so eviction is scoped by age:
// the newest `keepRecent` image-bearing turns keep their pixels.
//
// Cost: rewriting old turns invalidates the prompt cache, which is exactly what
// tamp's cacheSafe mode exists to avoid. That is why this stage is opt-in.
// Anthropic block shape only.

const DEFAULT_KEEP_RECENT = 2

function isImageBlock(block) {
  return block?.type === 'image'
}

function hasImage(block) {
  return block?.type === 'tool_result'
    && Array.isArray(block.content)
    && block.content.some(isImageBlock)
}

// Map<tool_use_id, file_path> so the notice can name what was dropped.
function buildPathIndex(messages) {
  const index = new Map()
  for (const msg of messages) {
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block?.type !== 'tool_use' || !block.id) continue
      const path = block.input?.file_path || block.input?.path || block.input?.filePath
      if (typeof path === 'string' && path.length > 0) index.set(block.id, path)
    }
  }
  return index
}

// Named source beats a bare "an image": it tells the agent what to re-read.
function notice(path, chars) {
  const subject = path ? `Image of ${path}` : 'Image'
  return `<tamp-stale-image>\n${subject} dropped — it is older than the most recent turns and images are reloadable.\nIf you still need to see it, re-read the file (or re-take the screenshot).\nDropped: ${chars} base64 characters\n</tamp-stale-image>`
}

export function evictStaleImages(body, { keepRecent = DEFAULT_KEEP_RECENT } = {}) {
  const messages = body?.messages
  const none = { evicted: 0, chars: 0 }
  if (!Array.isArray(messages)) return none

  const imageTurns = []
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]
    if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue
    if (msg.content.some(hasImage)) imageTurns.push(mi)
  }
  if (imageTurns.length <= keepRecent) return none

  const paths = buildPathIndex(messages)
  const stale = imageTurns.slice(0, imageTurns.length - keepRecent)
  let evicted = 0
  let chars = 0

  for (const mi of stale) {
    for (const block of messages[mi].content) {
      if (!hasImage(block)) continue
      block.content = block.content.map(sub => {
        if (!isImageBlock(sub)) return sub
        const size = typeof sub.source?.data === 'string' ? sub.source.data.length : 0
        evicted += 1
        chars += size
        return { type: 'text', text: notice(paths.get(block.tool_use_id), size) }
      })
    }
  }

  return { evicted, chars }
}
