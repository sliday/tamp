import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Box, Text, useApp } from 'ink'
import { StagePicker } from './StagePicker.js'
import { SidecarLoader } from './SidecarLoader.js'
import { Dashboard } from './Dashboard.js'

const h = React.createElement

const DEFAULT_STAGES = ['minify', 'toon', 'strip-lines', 'whitespace', 'llmlingua', 'dedup', 'diff', 'prune']

export function App({ version, envStages, startSidecar, createProxy }) {
  const { exit } = useApp()
  const [phase, setPhase] = useState('pick')
  const [stages, setStages] = useState(null)
  const [events, setEvents] = useState([])
  const [totals, setTotals] = useState({ totalSaved: 0, totalOriginal: 0, totalTokensSaved: 0, compressionCount: 0 })
  const [config, setConfig] = useState(null)
  const serverRef = useRef(null)
  const sidecarUrlRef = useRef(null)
  const eventIdRef = useRef(0)

  const onCompress = useCallback((stats, newTotals, meta) => {
    const id = eventIdRef.current++
    setEvents(prev => [...prev, { id, stats, totals: newTotals, meta }])
    setTotals(newTotals)
  }, [])

  const startProxy = useCallback((selectedStages, sidecarUrl) => {
    process.env.TAMP_STAGES = selectedStages.join(',')
    if (sidecarUrl) process.env.TAMP_LLMLINGUA_URL = sidecarUrl

    const { config: proxyConfig, server } = createProxy({ onCompress, log: false })
    serverRef.current = server
    setConfig(proxyConfig)

    server.listen(proxyConfig.port, () => {
      setPhase('running')
    })
  }, [onCompress, createProxy])

  const onStagesSelected = useCallback((selected) => {
    setStages(selected)
    if (selected.includes('llmlingua')) {
      setPhase('loading')
    } else {
      startProxy(selected, null)
    }
  }, [startProxy])

  const onSidecarReady = useCallback((url) => {
    sidecarUrlRef.current = url
    startProxy(stages, url)
  }, [stages, startProxy])

  const onSidecarFail = useCallback(() => {
    const filtered = stages.filter(s => s !== 'llmlingua')
    setStages(filtered)
    startProxy(filtered, null)
  }, [stages, startProxy])

  useEffect(() => {
    const shutdown = () => {
      serverRef.current?.close()
      exit()
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    return () => {
      process.off('SIGINT', shutdown)
      process.off('SIGTERM', shutdown)
    }
  }, [exit])

  if (phase === 'pick') {
    return h(StagePicker, { version, envStages, onSelect: onStagesSelected })
  }

  if (phase === 'loading') {
    return h(SidecarLoader, { startSidecar, onReady: onSidecarReady, onFail: onSidecarFail })
  }

  if (phase === 'running' && config) {
    return h(Dashboard, { version, config, events, totals })
  }

  return h(Box, { paddingX: 1 }, h(Text, { dimColor: true }, 'Starting...'))
}
