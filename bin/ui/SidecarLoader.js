import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { Spinner, StatusMessage } from '@inkjs/ui'

const h = React.createElement

export function SidecarLoader({ startSidecar, onReady, onFail }) {
  const [status, setStatus] = useState('loading')
  const [message, setMessage] = useState(null)

  useEffect(() => {
    let mounted = true
    startSidecar().then(url => {
      if (!mounted) return
      if (url) {
        setStatus('success')
        setMessage(`LLMLingua-2 ready on ${url}`)
        setTimeout(() => onReady(url), 600)
      } else {
        setStatus('warning')
        setMessage('LLMLingua-2 not available. Continuing without neural compression.')
        setTimeout(() => onFail(), 1200)
      }
    })
    return () => { mounted = false }
  }, [])

  if (status === 'loading') {
    return h(Box, { paddingX: 1 },
      h(Spinner, { label: 'Starting LLMLingua-2 sidecar...' }),
    )
  }

  if (status === 'success') {
    return h(Box, { paddingX: 1 },
      h(StatusMessage, { variant: 'success' }, message),
    )
  }

  return h(Box, { paddingX: 1, flexDirection: 'column' },
    h(StatusMessage, { variant: 'warning' }, message),
  )
}
