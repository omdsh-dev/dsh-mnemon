import { useCallback, useEffect, useRef, useState } from 'react'
import type { StatusView } from '../host/protocol.ts'
import type { MnemonClient } from './api.ts'
import { message } from './page-kit.tsx'

interface WorkspaceStatusState {
  contextKey: string
  value: StatusView | null
  loading: boolean
  needsFullStatus: boolean
  error: string | null
}

/**
 * The Memory System's status for one view context and the read that loads it: the summary first, then the full
 * status only while the Status page is open and the summary still waits for a space or the CLI version. Another view
 * context starts empty, and only the latest read answers.
 */
export function useWorkspaceStatus(client: MnemonClient, viewContextKey: string, active = true): {
  status: StatusView | null
  statusLoading: boolean
  statusError: string | null
  loadStatus: (includeFull?: boolean | (() => boolean)) => Promise<void>
  ensureFullStatus: () => void
} {
  const [statusState, setStatusState] = useState<WorkspaceStatusState>(() => ({ contextKey: viewContextKey, value: null, loading: true, needsFullStatus: false, error: null }))
  const currentStatusState: WorkspaceStatusState = statusState.contextKey === viewContextKey
    ? statusState
    : { contextKey: viewContextKey, value: null, loading: true, needsFullStatus: false, error: null }
  const status = currentStatusState.value
  const statusLoading = currentStatusState.loading
  const statusError = currentStatusState.error
  const statusRequest = useRef(0)

  const current = useRef({ client, viewContextKey, active })
  current.current = { client, viewContextKey, active }
  const stateRef = useRef(currentStatusState)
  stateRef.current = currentStatusState
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const loadStatus = useCallback(async (includeFull: boolean | (() => boolean) = true) => {
    if (!mounted.current || !current.current.active || current.current.client !== client || current.current.viewContextKey !== viewContextKey) return
    const request = ++statusRequest.current
    const isCurrent = (): boolean => request === statusRequest.current && mounted.current && current.current.active && current.current.client === client && current.current.viewContextKey === viewContextKey
    setStatusState(previous => ({
      contextKey: viewContextKey,
      value: previous.contextKey === viewContextKey ? previous.value : null,
      loading: true,
      needsFullStatus: false,
      error: null,
    }))
    try {
      const summary = await client.statusSummary()
      if (!isCurrent()) return
      // A full status also reads the CLI version, which the summary has only after one did.
      const needsDeepStatus = summary.memoryBodies?.some(body => body.statusLoading === true) === true
        || summary.commandFound === true && summary.version === undefined
      const resolveFull = typeof includeFull === 'function' ? includeFull() : includeFull
      if (!needsDeepStatus || !resolveFull) {
        setStatusState({ contextKey: viewContextKey, value: summary, loading: false, needsFullStatus: needsDeepStatus, error: null })
        return
      }
      setStatusState({ contextKey: viewContextKey, value: summary, loading: true, needsFullStatus: false, error: null })
      try {
        const next = await client.status()
        if (isCurrent()) setStatusState({ contextKey: viewContextKey, value: next, loading: false, needsFullStatus: false, error: null })
      } catch (reason) {
        if (isCurrent()) setStatusState({ contextKey: viewContextKey, value: summary, loading: false, needsFullStatus: false, error: message(reason) })
      }
    } catch (reason) {
      if (isCurrent()) setStatusState({ contextKey: viewContextKey, value: null, loading: false, needsFullStatus: false, error: message(reason) })
    }
  }, [client, viewContextKey])

  const ensureFullStatus = useCallback(() => {
    const snapshot = stateRef.current
    if (!mounted.current || !current.current.active || current.current.client !== client || current.current.viewContextKey !== viewContextKey) return
    if (!snapshot.needsFullStatus || snapshot.loading) return
    const request = ++statusRequest.current
    const isCurrent = (): boolean => request === statusRequest.current && mounted.current && current.current.active && current.current.client === client && current.current.viewContextKey === viewContextKey
    const summary = snapshot.value
    setStatusState({ contextKey: viewContextKey, value: summary, loading: true, needsFullStatus: false, error: null })
    void client.status().then(
      next => { if (isCurrent()) setStatusState({ contextKey: viewContextKey, value: next, loading: false, needsFullStatus: false, error: null }) },
      reason => { if (isCurrent()) setStatusState({ contextKey: viewContextKey, value: summary, loading: false, needsFullStatus: false, error: message(reason) }) },
    )
  }, [client, viewContextKey])

  return { status, statusLoading, statusError, loadStatus, ensureFullStatus }
}
