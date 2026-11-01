import { useCallback, useEffect, useRef, useState } from 'react'
import type { StatusView } from '../host/protocol.ts'
import type { MnemonClient } from './api.ts'
import { message } from './page-kit.tsx'

/**
 * The Memory System's status for one view context and the read that loads it: the summary first, then the full
 * status while the summary still waits for a space or the CLI version. Another view context starts empty, and only
 * the latest read answers.
 */
export function useWorkspaceStatus(client: MnemonClient, viewContextKey: string, active = true): {
  status: StatusView | null
  statusLoading: boolean
  statusError: string | null
  loadStatus: () => Promise<void>
} {
  const [statusState, setStatusState] = useState<{ contextKey: string; value: StatusView | null; loading: boolean; error: string | null }>(() => ({ contextKey: viewContextKey, value: null, loading: true, error: null }))
  const currentStatusState = statusState.contextKey === viewContextKey
    ? statusState
    : { contextKey: viewContextKey, value: null, loading: true, error: null }
  const status = currentStatusState.value
  const statusLoading = currentStatusState.loading
  const statusError = currentStatusState.error
  const statusRequest = useRef(0)

  const current = useRef({ client, viewContextKey, active })
  current.current = { client, viewContextKey, active }
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const loadStatus = useCallback(async () => {
    if (!mounted.current || !current.current.active || current.current.client !== client || current.current.viewContextKey !== viewContextKey) return
    const request = ++statusRequest.current
    const isCurrent = (): boolean => request === statusRequest.current && mounted.current && current.current.active && current.current.client === client && current.current.viewContextKey === viewContextKey
    setStatusState(current => ({ contextKey: viewContextKey, value: current.contextKey === viewContextKey ? current.value : null, loading: true, error: null }))
    try {
      const summary = await client.statusSummary()
      if (!isCurrent()) return
      // A full status also reads the CLI version, which the summary has only after one did.
      const needsDeepStatus = summary.memoryBodies?.some(body => body.statusLoading === true) === true
        || summary.commandFound === true && summary.version === undefined
      setStatusState({ contextKey: viewContextKey, value: summary, loading: needsDeepStatus, error: null })
      if (!needsDeepStatus) return
      try {
        const next = await client.status()
        if (isCurrent()) setStatusState({ contextKey: viewContextKey, value: next, loading: false, error: null })
      } catch (reason) {
        if (isCurrent()) setStatusState({ contextKey: viewContextKey, value: summary, loading: false, error: message(reason) })
      }
    } catch (reason) {
      if (isCurrent()) setStatusState({ contextKey: viewContextKey, value: null, loading: false, error: message(reason) })
    }
  }, [client, viewContextKey])
  return { status, statusLoading, statusError, loadStatus }
}
