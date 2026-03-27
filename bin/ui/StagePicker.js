import React, { useState } from 'react'
import { Box, Text } from 'ink'
import { MultiSelect } from '@inkjs/ui'
import { DEFAULT_STAGES, EXTRA_STAGES, STAGE_DESCRIPTIONS } from '../../metadata.js'

const h = React.createElement

export function StagePicker({ version, envStages, onSelect }) {
  const [error, setError] = useState(null)

  const preSelected = envStages
    ? [...envStages]
    : [...DEFAULT_STAGES]

  const options = [
    ...DEFAULT_STAGES.map(s => ({
      label: `${s.padEnd(16)} ${STAGE_DESCRIPTIONS[s]}`,
      value: s,
    })),
    ...EXTRA_STAGES.map(s => ({
      label: `${s.padEnd(16)} ${STAGE_DESCRIPTIONS[s]}`,
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
      visibleOptionCount: 12,
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
