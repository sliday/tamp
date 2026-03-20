const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
}

export function formatRequestLog(stats, session, providerName, url, bodySize, tokenCost) {
  const compressed = stats.filter(s => s.method)
  const label = providerName || 'anthropic'
  const path = url || '/v1/messages'
  const sizeInfo = bodySize ? ` ${c.dim}${fmtSize(bodySize)}${c.reset}` : ''

  if (!compressed.length && !stats.length) {
    return `[tamp] ${c.cyan}${label}${c.reset} ${path}${sizeInfo} ${c.dim}— passthrough${c.reset}`
  }

  if (!compressed.length) {
    const skipCount = stats.filter(s => s.skipped).length
    const n = stats.length
    const reason = skipCount ? `${skipCount} skipped` : 'nothing to compress'
    return `[tamp] ${c.cyan}${label}${c.reset} ${path}${sizeInfo} ${c.dim}— ${n} block${n !== 1 ? 's' : ''}, ${reason}${c.reset}`
  }

  const totalOrig = compressed.reduce((a, s) => a + s.originalLen, 0)
  const totalComp = compressed.reduce((a, s) => a + s.compressedLen, 0)
  const totalOrigTok = compressed.reduce((a, s) => a + (s.originalTokens || 0), 0)
  const totalCompTok = compressed.reduce((a, s) => a + (s.compressedTokens || 0), 0)
  const pct = (((totalOrig - totalComp) / totalOrig) * 100).toFixed(1)
  const saved = totalOrig - totalComp
  const tokSaved = totalOrigTok - totalCompTok

  const lines = []
  const n = compressed.length
  lines.push(`[tamp] ${c.cyan}${label}${c.reset} ${path}${sizeInfo} ${c.green}— ${n} block${n !== 1 ? 's' : ''} compressed, -${pct}%${c.reset}`)

  for (const s of compressed) {
    const sPct = (((s.originalLen - s.compressedLen) / s.originalLen) * 100).toFixed(1)
    const tokInfo = s.originalTokens ? ` ${c.dim}${s.originalTokens}→${s.compressedTokens} tok${c.reset}` : ''
    lines.push(`[tamp]   ${c.dim}block[${s.index}]${c.reset} ${fmtSize(s.originalLen)}→${fmtSize(s.compressedLen)} ${c.green}-${sPct}%${c.reset}${tokInfo} ${c.dim}[${s.method}]${c.reset}`)
  }

  for (const s of stats.filter(s => s.skipped)) {
    lines.push(`[tamp]   ${c.dim}block[${s.index}] skipped (${s.skipped})${c.reset}`)
  }

  if (session) {
    const t = session.getTotals()
    const sessionPct = t.totalOriginal > 0 ? (((t.totalSaved) / t.totalOriginal) * 100).toFixed(1) : '0.0'
    const costPerM = tokenCost || 3
    const dollarsSaved = (t.totalTokensSaved / 1_000_000) * costPerM
    const moneyInfo = t.totalTokensSaved > 0 ? ` ${c.green}$${dollarsSaved.toFixed(4)} saved${c.reset} ${c.dim}@ $${costPerM}/Mtok${c.reset}` : ''
    lines.push(`[tamp]   ${c.magenta}session${c.reset} ${fmtSize(t.totalSaved)} chars, ${t.totalTokensSaved} tokens saved across ${t.compressionCount} blocks ${c.dim}(${sessionPct}% avg)${c.reset}${moneyInfo}`)
  }

  return lines.join('\n')
}

function fmtSize(n) {
  if (n >= 1024) return (n / 1024).toFixed(1) + 'k'
  return n + ''
}

export function createSession() {
  let totalSaved = 0
  let totalOriginal = 0
  let totalTokensSaved = 0
  let compressionCount = 0

  return {
    record(stats) {
      for (const s of stats) {
        if (s.method && s.originalLen && s.compressedLen) {
          totalSaved += s.originalLen - s.compressedLen
          totalOriginal += s.originalLen
          totalTokensSaved += (s.originalTokens || 0) - (s.compressedTokens || 0)
          compressionCount++
        }
      }
    },
    getTotals() {
      return { totalSaved, totalOriginal, totalTokensSaved, compressionCount }
    },
  }
}
