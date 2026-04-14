import React from 'react'
import { Box, Text } from 'ink'
import { Badge } from '@inkjs/ui'
import { ALL_STAGES, DEFAULT_STAGES, EXTRA_STAGES, STAGE_HINTS, isLossy } from '../../metadata.js'

const h = React.createElement

export function Banner({ version, port, stages, llmLinguaUrl, outputMode }) {
  const url = `http://localhost:${port}`
  const active = new Set(stages)
  const defaultActive = DEFAULT_STAGES.filter(s => active.has(s))
  const extraActive = EXTRA_STAGES.filter(s => active.has(s))
  const disabled = ALL_STAGES.filter(s => !active.has(s))
  const showOutput = outputMode && outputMode !== 'off'

  return h(Box, { flexDirection: 'column', paddingX: 1 },
    h(Box, { gap: 2 },
      h(Text, { bold: true, color: 'cyan' }, 'Tamp'),
      h(Text, { dimColor: true }, `v${version}`),
      h(Badge, { color: 'green' }, 'READY'),
      h(Text, { color: 'green' }, url),
    ),
    h(Text, null, ''),
    h(Text, { bold: true }, 'Setup'),
    h(Box, { paddingLeft: 2, flexDirection: 'column' },
      h(Text, null,
        h(Text, { dimColor: true }, 'Claude Code:  '),
        h(Text, null, 'ANTHROPIC_BASE_URL='),
        h(Text, { color: 'yellow' }, url),
      ),
      h(Text, null,
        h(Text, { dimColor: true }, 'Aider/Cursor: '),
        h(Text, null, 'OPENAI_API_BASE='),
        h(Text, { color: 'yellow' }, url),
      ),
    ),
    h(Text, null, ''),
    showOutput ? h(Text, { bold: true }, 'Output mode ',
      h(Text, { color: 'yellow' }, outputMode),
      h(Text, { dimColor: true }, ' (caveman, task-aware)')
    ) : null,
    showOutput ? h(Text, null, '') : null,
    h(Text, { bold: true }, `Stages `, h(Text, { dimColor: true }, `(${stages.length} of ${ALL_STAGES.length} active)`)),
    h(Box, { paddingLeft: 2, flexDirection: 'column' },
      ...defaultActive.map(s =>
        h(Text, { key: s },
          h(Text, { color: 'green' }, '\u2713 '),
          h(Text, { color: 'cyan' }, s),
          s === 'llmlingua' && llmLinguaUrl ? h(Text, { dimColor: true }, ` (${llmLinguaUrl})`) : null,
        )
      ),
      ...extraActive.map(s =>
        h(Text, { key: s },
          h(Text, { color: 'yellow' }, '\u2713 '),
          h(Text, { color: 'yellow' }, s),
          h(Text, { dimColor: true }, isLossy(s) ? ' (lossy)' : ' (opt-in)'),
        )
      ),
    ),
    disabled.length ? h(Text, null, '') : null,
    disabled.length ? h(Text, { bold: true }, 'Available ', h(Text, { dimColor: true }, '(not active — opt in for more savings)')) : null,
    disabled.length ? h(Box, { paddingLeft: 2, flexDirection: 'column' },
      ...disabled.flatMap(s => {
        const hint = STAGE_HINTS[s]
        const lines = [
          h(Text, { key: s },
            h(Text, { dimColor: true }, '\u25EF '),
            h(Text, { color: 'cyan' }, s),
            hint ? h(Text, { dimColor: true }, ` \u2014 ${hint.summary}`) : null,
          )
        ]
        if (hint?.setup) {
          lines.push(h(Text, { key: s + '-setup', dimColor: true }, `    \u2192 ${hint.setup}`))
        }
        return lines
      })
    ) : null,
  )
}
