import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { MultiSelect } from '@inkjs/ui'

const h = React.createElement

const DEFAULT_STAGES = ['minify', 'toon', 'strip-lines', 'whitespace', 'llmlingua', 'dedup', 'diff', 'prune']
const EXTRA_STAGES = ['strip-comments', 'textpress']

const STAGE_DESC = {
  minify:           'Strip JSON whitespace (lossless)',
  toon:             'Columnar array encoding (lossless)',
  'strip-lines':    'Remove line-number prefixes',
  whitespace:       'Collapse blank lines, trim trailing',
  llmlingua:        'Neural compression via LLMLingua-2',
  dedup:            'Deduplicate identical tool_results',
  diff:             'Replace similar re-reads with diffs',
  prune:            'Strip lockfile hashes & npm metadata',
  'strip-comments': 'Remove code comments (lossy)',
  textpress:        'LLM semantic compression (Ollama/OpenRouter)',
}

export function StagePicker({ version, envStages, onSelect }) {
  const [error, setError] = useState(null)

  const preSelected = envStages
    ? [...envStages]
    : [...DEFAULT_STAGES]

  const options = [
    ...DEFAULT_STAGES.map(s => ({
      label: `${s.padEnd(16)} ${STAGE_DESC[s]}`,
      value: s,
    })),
    ...EXTRA_STAGES.map(s => ({
      label: `${s.padEnd(16)} ${STAGE_DESC[s]}`,
      value: s,
    })),
  ]

  return h(Box, { flexDirection: 'column', paddingX: 1 },
    h(Box, { gap: 1, marginBottom: 1 },
      h(Text, { bold: true, color: 'cyan' }, 'Tamp'),
      h(Text, { dimColor: true }, `v${version}`),
    ),
    h(Text, { dimColor: true, marginBottom: 1 }, 'Select compression stages (space to toggle, enter to confirm):'),
    h(MultiSelect, {
      options,
      defaultValue: preSelected,
      onSubmit: (values) => {
        if (values.length === 0) {
          setError('At least one stage required.')
          return
        }
        onSelect(values)
      },
    }),
    error ? h(Text, { color: 'red' }, error) : null,
  )
}
