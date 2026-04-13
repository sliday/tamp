import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Box, Text, useApp } from 'ink'
import { StagePicker } from './StagePicker.js'
import { SidecarLoader } from './SidecarLoader.js'
import { Dashboard } from './Dashboard.js'
import { installShutdown, writePidFile, diagnoseBindConflict } from '../lifecycle.js'

const h = React.createElement

export function App({ version, envStages, startSidecar, createProxy, getSidecarProc, ensurePortFree }) {
  const { exit } = useApp()
  const [phase, setPhase] = useState('pick')
  const [stages, setStages] = useState(null)
  const [events, setEvents] = useState([])
  const [totals, setTotals] = useState({ totalSaved: 0, totalOriginal: 0, totalTokensSaved: 0, compressionCount: 0 })
  const [config, setConfig] = useState(null)
  const serverRef = useRef(null)
  const sidecarUrlRef = useRef(null)
  const stagesRef = useRef(null)
  const eventIdRef = useRef(0)

  const onCompress = useCallback((stats, newTotals, meta) => {
    const id = eventIdRef.current++
    setEvents(prev => [...prev, { id, stats, totals: newTotals, meta }])
    setTotals(newTotals)
  }, [])

  const startProxy = useCallback(async (selectedStages, sidecarUrl) => {
    process.env.TAMP_STAGES = selectedStages.join(',')
    if (sidecarUrl) process.env.TAMP_LLMLINGUA_URL = sidecarUrl

    const { config: proxyConfig, server } = createProxy({ onCompress, log: false })
    serverRef.current = server
    setConfig(proxyConfig)

    if (ensurePortFree) {
      try { await ensurePortFree(proxyConfig.port) } catch { return }
    }

    server.on('error', async (err) => {
      if (err.code === 'EADDRINUSE') {
        const diag = await diagnoseBindConflict(proxyConfig.port)
        exit()
        process.stderr.write(`\n[tamp] ${diag.message}\n`)
      } else {
        exit()
        process.stderr.write(`\n[tamp] Failed to start: ${err.message}\n`)
      }
      process.exit(1)
    })
    server.listen(proxyConfig.port, () => {
      try { writePidFile(proxyConfig.port) } catch {}
      installShutdown({
        server,
        getSidecar: getSidecarProc,
        port: proxyConfig.port,
        onBeforeExit: () => exit(),
      })
      setPhase('running')
    })
  }, [onCompress, createProxy, exit, getSidecarProc, ensurePortFree])

  const onStagesSelected = useCallback((selected) => {
    setStages(selected)
    stagesRef.current = selected
    if (selected.includes('llmlingua')) {
      setPhase('loading')
    } else {
      startProxy(selected, null)
    }
  }, [startProxy])

  // Use stagesRef to avoid stale closure — SidecarLoader's useEffect
  // captures onReady/onFail on first render only
  const onSidecarReady = useCallback((url) => {
    sidecarUrlRef.current = url
    startProxy(stagesRef.current, url)
  }, [startProxy])

  const onSidecarFail = useCallback(() => {
    const filtered = stagesRef.current.filter(s => s !== 'llmlingua')
    setStages(filtered)
    stagesRef.current = filtered
    startProxy(filtered, null)
  }, [startProxy])

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
