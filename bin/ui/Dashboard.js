import React from 'react'
import { Box, Text, Static } from 'ink'
import { Banner } from './Banner.js'

const h = React.createElement

function fmtSize(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'M'
  if (n >= 1024) return (n / 1024).toFixed(1) + 'k'
  return n + ''
}

function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return n + ''
}

function LogEntry({ event }) {
  const { stats, meta } = event
  const compressed = stats.filter(s => s.method)
  const skipped = stats.filter(s => s.skipped)

  if (!compressed.length) {
    const reason = skipped.length ? `${skipped.length} skipped` : 'passthrough'
    return h(Text, { dimColor: true },
      `  ${meta.provider} ${meta.url} \u2014 ${stats.length} block${stats.length !== 1 ? 's' : ''}, ${reason}`
    )
  }

  const totalOrig = compressed.reduce((a, s) => a + s.originalLen, 0)
  const totalComp = compressed.reduce((a, s) => a + s.compressedLen, 0)
  const pct = (((totalOrig - totalComp) / totalOrig) * 100).toFixed(1)
  const tokSaved = compressed.reduce((a, s) => a + (s.originalTokens || 0) - (s.compressedTokens || 0), 0)
  const n = compressed.length

  return h(Text, null,
    h(Text, { color: 'cyan' }, `  ${meta.provider}`),
    h(Text, null, ` ${meta.url} `),
    h(Text, { dimColor: true }, `${fmtSize(meta.bodySize)} `),
    h(Text, { color: 'green', bold: true }, `-${pct}%`),
    h(Text, null, ` ${n} block${n !== 1 ? 's' : ''}`),
    tokSaved > 0 ? h(Text, { dimColor: true }, ` (${fmtTokens(tokSaved)} tok saved)`) : null,
  )
}

function StatsBar({ totals, tokenCost }) {
  const { totalSaved, totalOriginal, totalTokensSaved, compressionCount } = totals
  const pct = totalOriginal > 0 ? (((totalSaved) / totalOriginal) * 100).toFixed(1) : '0.0'
  const costPerM = tokenCost || 3
  const dollars = (totalTokensSaved / 1_000_000) * costPerM

  if (compressionCount === 0) {
    return h(Box, { paddingX: 1, marginTop: 1 },
      h(Text, { dimColor: true }, 'Waiting for requests...'),
    )
  }

  return h(Box, { paddingX: 1, marginTop: 1, gap: 2 },
    h(Text, null,
      h(Text, { dimColor: true }, 'Session '),
      h(Text, { bold: true, color: 'magenta' }, `${compressionCount}`),
      h(Text, { dimColor: true }, ` block${compressionCount !== 1 ? 's' : ''}`),
    ),
    h(Text, null,
      h(Text, { color: 'green', bold: true }, `-${pct}%`),
      h(Text, { dimColor: true }, ' avg'),
    ),
    h(Text, null,
      h(Text, { dimColor: true }, 'saved '),
      h(Text, { bold: true }, `${fmtSize(totalSaved)} chars`),
      totalTokensSaved > 0
        ? h(Text, null,
            h(Text, { dimColor: true }, ', '),
            h(Text, { bold: true }, `${fmtTokens(totalTokensSaved)} tok`),
          )
        : null,
    ),
    dollars > 0.001
      ? h(Text, null,
          h(Text, { color: 'green', bold: true }, `$${dollars.toFixed(4)}`),
          h(Text, { dimColor: true }, ` @ $${costPerM}/Mtok`),
        )
      : null,
  )
}

export function Dashboard({ version, config, events, totals }) {
  return h(Box, { flexDirection: 'column' },
    h(Banner, {
      version,
      port: config.port,
      stages: config.stages,
      llmLinguaUrl: config.llmLinguaUrl,
      outputMode: config.outputMode,
    }),
    h(StatsBar, { totals, tokenCost: config.tokenCost }),
    events.length > 0
      ? h(Box, { flexDirection: 'column', marginTop: 1 },
          h(Static, { items: events },
            (event) => h(LogEntry, { key: event.id, event }),
          ),
        )
      : null,
  )
}
