import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Box, Text, useApp } from 'ink'
import { LevelPicker } from './LevelPicker.js'
import { SidecarLoader } from './SidecarLoader.js'
import { Dashboard } from './Dashboard.js'
import { installShutdown, writePidFile, diagnoseBindConflict } from '../lifecycle.js'

const h = React.createElement

export const MAX_EVENTS = 200

export function appendBoundedEvent(events, event, max = MAX_EVENTS) {
  if (max <= 0) return []
  const next = [...events, event]
  return next.length > max ? next.slice(next.length - max) : next
}

export function buildInteractiveProxyArgs(selection, { sidecarUrl = null, sidecarFailed = false, onCompress, onUsage } = {}) {
  const overrides = { log: false }
  if (onCompress !== undefined) overrides.onCompress = onCompress
  if (onUsage !== undefined) overrides.onUsage = onUsage
  const loadOpts = {}

  const isLevel = selection?.kind === 'level' && Number.isInteger(selection.level)
  const rawStages = Array.isArray(selection?.stages) ? selection.stages : []
  const activeStages = sidecarFailed ? rawStages.filter(s => s !== 'llmlingua') : [...rawStages]

  if (isLevel) {
    loadOpts.levelOverride = selection.level
    if (sidecarFailed) {
      overrides.stages = activeStages
    }
  } else {
    overrides.stages = activeStages
    overrides.level = null
  }

  if (sidecarUrl) {
    overrides.llmLinguaUrl = sidecarUrl
  }

  return { overrides, loadOpts }
}

export async function handleServerError(err, {
  port,
  getSidecarProc,
  exit,
  diagnose = diagnoseBindConflict,
  stderr = process.stderr,
  exitProcess = process.exit,
} = {}) {
  let message = `\n[tamp] Failed to start: ${err?.message || String(err)}\n`
  if (err?.code === 'EADDRINUSE') {
    try {
      const diag = await diagnose(port)
      if (diag?.message) message = `\n[tamp] ${diag.message}\n`
    } catch {
      message = `\n[tamp] Port ${port} is already in use.\n`
    }
  }
  try { getSidecarProc?.()?.kill() } catch {}
  try { exit?.() } catch {}
  stderr.write(message)
  exitProcess(1)
}

export function App({ version, envStages, argvLevel, startSidecar, createProxy, getSidecarProc, ensurePortFree }) {
  const { exit } = useApp()
  const [phase, setPhase] = useState('pick')
  const [events, setEvents] = useState([])
  const [totals, setTotals] = useState({ totalSaved: 0, totalOriginal: 0, totalTokensSaved: 0, compressionCount: 0 })
  const [usage, setUsage] = useState(null)
  const [config, setConfig] = useState(null)
  const serverRef = useRef(null)
  const sidecarUrlRef = useRef(null)
  const selectionRef = useRef(null)
  const eventIdRef = useRef(0)

  const onCompress = useCallback((stats, newTotals, meta) => {
    const id = eventIdRef.current++
    setEvents(prev => appendBoundedEvent(prev, { id, stats, totals: newTotals, meta }))
    setTotals(newTotals)
  }, [])

  const onUsage = useCallback((snapshot) => {
    setUsage(snapshot)
  }, [])

  const startProxy = useCallback(async (selection, { sidecarUrl = null, sidecarFailed = false } = {}) => {
    const { overrides, loadOpts } = buildInteractiveProxyArgs(selection, {
      sidecarUrl,
      sidecarFailed,
      onCompress,
      onUsage,
    })

    const { config: proxyConfig, server } = createProxy(overrides, loadOpts)
    serverRef.current = server
    setConfig(proxyConfig)

    if (ensurePortFree) {
      try { await ensurePortFree(proxyConfig.port) } catch { return }
    }

    server.on('error', async (err) => {
      await handleServerError(err, {
        port: proxyConfig.port,
        getSidecarProc,
        exit,
      })
    })
    server.listen(proxyConfig.port, proxyConfig.host, () => {
      try { writePidFile(proxyConfig.port) } catch {}
      installShutdown({
        server,
        getSidecar: getSidecarProc,
        port: proxyConfig.port,
        onBeforeExit: () => exit(),
      })
      setPhase('running')
    })
  }, [onCompress, onUsage, createProxy, exit, getSidecarProc, ensurePortFree])

  const onPickerSubmit = useCallback((payload) => {
    // payload: { kind: 'level', level, stages } | { kind: 'stages', stages }
    selectionRef.current = payload
    const selected = Array.isArray(payload?.stages) ? payload.stages : []
    if (selected.includes('llmlingua')) {
      setPhase('loading')
    } else {
      startProxy(payload, { sidecarUrl: null, sidecarFailed: false })
    }
  }, [startProxy])

  // Use selectionRef to avoid stale closure — SidecarLoader's useEffect
  // captures onReady/onFail on first render only
  const onSidecarReady = useCallback((url) => {
    sidecarUrlRef.current = url
    startProxy(selectionRef.current, { sidecarUrl: url, sidecarFailed: false })
  }, [startProxy])

  const onSidecarFail = useCallback(() => {
    startProxy(selectionRef.current, { sidecarUrl: null, sidecarFailed: true })
  }, [startProxy])

  if (phase === 'pick') {
    return h(LevelPicker, { version, envLevel: argvLevel, envStages, onSelect: onPickerSubmit })
  }

  if (phase === 'loading') {
    return h(SidecarLoader, { startSidecar, onReady: onSidecarReady, onFail: onSidecarFail })
  }

  if (phase === 'running' && config) {
    return h(Dashboard, { version, config, events, totals, usage })
  }

  return h(Box, { paddingX: 1 }, h(Text, { dimColor: true }, 'Starting...'))
}
