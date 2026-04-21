import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { StagePicker } from './StagePicker.js'
import { COMPRESSION_LEVELS, DEFAULT_LEVEL, resolveLevel } from '../../metadata.js'

const h = React.createElement

// Pure reducer — exported for testability. Handles clamping and NaN-safe jumps.
export function levelReducer(state, action) {
  switch (action.type) {
    case 'moveLeft':
      return state > 1 ? state - 1 : 1
    case 'moveRight':
      return state < 9 ? state + 1 : 9
    case 'jumpTo': {
      const n = Number(action.value)
      if (!Number.isInteger(n) || n < 1 || n > 9) return state
      return n
    }
    default:
      return state
  }
}

export function initialLevel(envLevel) {
  if (Number.isInteger(envLevel) && envLevel >= 1 && envLevel <= 9) return envLevel
  return DEFAULT_LEVEL
}

// Build the payload emitted by onSelect when a level is confirmed.
export function buildLevelPayload(level) {
  return { kind: 'level', level, stages: [...resolveLevel(level).stages] }
}

function Slider({ level }) {
  // 9-position slider: o───●───o style
  const cells = []
  for (let i = 1; i <= 9; i++) {
    if (i === level) cells.push(h(Text, { key: i, color: 'cyan', bold: true }, '●'))
    else cells.push(h(Text, { key: i, dimColor: true }, '─'))
    if (i < 9) cells.push(h(Text, { key: `s${i}`, dimColor: true }, '─'))
  }
  return h(Box, null, ...cells)
}

function Chips({ stages }) {
  const children = []
  stages.forEach((s, i) => {
    children.push(h(Text, { key: `c${i}`, color: 'cyan' }, ` ${s} `))
    if (i < stages.length - 1) children.push(h(Text, { key: `g${i}` }, ' '))
  })
  return h(Box, { flexWrap: 'wrap' }, ...children)
}

export function LevelPicker({ version, envLevel, envStages, onSelect, onCancel }) {
  const [level, setLevel] = useState(() => initialLevel(envLevel))
  const [advanced, setAdvanced] = useState(false)

  useInput((input, key) => {
    if (advanced) return
    if (key.leftArrow || input === 'h') setLevel(s => levelReducer(s, { type: 'moveLeft' }))
    else if (key.rightArrow || input === 'l') setLevel(s => levelReducer(s, { type: 'moveRight' }))
    else if (input === 'a' || input === 'A') setAdvanced(true)
    else if (key.return) onSelect(buildLevelPayload(level))
    else if (key.escape) { if (onCancel) onCancel() }
    else if (input && /^[1-9]$/.test(input)) setLevel(s => levelReducer(s, { type: 'jumpTo', value: input }))
  })

  if (advanced) {
    return h(StagePicker, {
      version,
      envStages: envStages || resolveLevel(level).stages,
      onSelect: (stages) => onSelect({ kind: 'stages', stages }),
    })
  }

  const meta = resolveLevel(level) || COMPRESSION_LEVELS[DEFAULT_LEVEL]
  const lossy = meta.lossy

  return h(Box, { flexDirection: 'column', paddingX: 1 },
    h(Box, { gap: 1, marginBottom: 1 },
      h(Text, { bold: true, color: 'cyan' }, 'Tamp'),
      h(Text, { dimColor: true }, `v${version}`),
    ),
    h(Text, { dimColor: true }, 'Compression level — ← →  to adjust, 1-9 to jump, Enter to confirm'),
    h(Box, { marginTop: 1, gap: 2, alignItems: 'center' },
      h(Text, { bold: true, color: 'cyan' }, String(level)),
      h(Slider, { level }),
      h(Text, { color: lossy ? 'yellow' : 'green', bold: true }, lossy ? ' LOSSY ' : ' LOSSLESS '),
    ),
    h(Box, { marginTop: 1 },
      h(Text, null, 'Expected savings: '),
      h(Text, { bold: true, color: 'green' }, meta.savings),
    ),
    h(Box, { marginTop: 1, flexDirection: 'column' },
      h(Text, { dimColor: true }, `Stages (${meta.stages.length})`),
      h(Chips, { stages: meta.stages }),
    ),
    h(Box, { marginTop: 1 },
      h(Text, { dimColor: true }, 'Press '),
      h(Text, { bold: true }, 'A'),
      h(Text, { dimColor: true }, ' for advanced per-stage picker · '),
      h(Text, { bold: true }, 'Esc'),
      h(Text, { dimColor: true }, ' to cancel'),
    ),
  )
}
