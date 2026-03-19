export function formatRequestLog(stats, session, providerName, url) {
  const compressed = stats.filter(s => s.method)
  const skipped = stats.filter(s => s.skipped)
  const label = providerName || 'anthropic'
  const path = url || '/v1/messages'
  const lines = [`[tamp] ${label} ${path} — ${stats.length} blocks, ${compressed.length} compressed`]

  for (const s of stats) {
    if (s.skipped) {
      lines.push(`[tamp]   block[${s.index}]: skipped (${s.skipped})`)
    } else if (s.method) {
      const pct = (((s.originalLen - s.compressedLen) / s.originalLen) * 100).toFixed(1)
      const tokInfo = s.originalTokens ? ` ${s.originalTokens}->${s.compressedTokens} tok` : ''
      lines.push(`[tamp]   block[${s.index}]: ${s.originalLen}->${s.compressedLen} chars (-${pct}%)${tokInfo} [${s.method}]`)
    }
  }

  const totalOrig = compressed.reduce((a, s) => a + s.originalLen, 0)
  const totalComp = compressed.reduce((a, s) => a + s.compressedLen, 0)
  const totalOrigTok = compressed.reduce((a, s) => a + (s.originalTokens || 0), 0)
  const totalCompTok = compressed.reduce((a, s) => a + (s.compressedTokens || 0), 0)
  if (compressed.length > 0) {
    const pct = (((totalOrig - totalComp) / totalOrig) * 100).toFixed(1)
    const tokPct = totalOrigTok > 0 ? (((totalOrigTok - totalCompTok) / totalOrigTok) * 100).toFixed(1) : '0.0'
    lines.push(`[tamp]   total: ${totalOrig}->${totalComp} chars (-${pct}%), ${totalOrigTok}->${totalCompTok} tokens (-${tokPct}%)`)
  }

  if (session) {
    const totals = session.getTotals()
    lines.push(`[tamp]   session: ${totals.totalSaved} chars, ${totals.totalTokensSaved} tokens saved across ${totals.compressionCount} compressions`)
  }

  return lines.join('\n')
}

export function createSession() {
  let totalSaved = 0
  let totalTokensSaved = 0
  let compressionCount = 0

  return {
    record(stats) {
      for (const s of stats) {
        if (s.method && s.originalLen && s.compressedLen) {
          totalSaved += s.originalLen - s.compressedLen
          totalTokensSaved += (s.originalTokens || 0) - (s.compressedTokens || 0)
          compressionCount++
        }
      }
    },
    getTotals() {
      return { totalSaved, totalTokensSaved, compressionCount }
    },
  }
}
