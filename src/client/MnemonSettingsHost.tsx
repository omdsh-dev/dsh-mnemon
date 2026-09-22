import { useCallback, useSyncExternalStore } from 'react'
import { MnemonSettingsCard, type MnemonSettingsCardProps } from './MnemonSettingsCard.tsx'
import type { MnemonClientContext } from './dsh-context.ts'
import { useMnemonSessionId, type MnemonSessionBinding } from './session-binding.ts'

export interface MnemonSettingsHostProps extends Omit<MnemonSettingsCardProps, 'sessionId' | 'workspaceId' | 'workspaceLabel'> {
  currentSession: MnemonSessionBinding
  sessions: MnemonClientContext['sessions']
  workspaces: MnemonClientContext['workspaces']
}

/** Root-slot injection is cached; keep its session and workspace context live. */
export function MnemonSettingsHost({ currentSession, sessions, workspaces, ...props }: MnemonSettingsHostProps): JSX.Element {
  const sessionId = useMnemonSessionId(currentSession)
  const subscribeSessions = useCallback((listener: () => void) => sessions.list.subscribe(listener), [sessions.list])
  const getSessions = useCallback(() => sessions.list.getSnapshot(), [sessions.list])
  const subscribeWorkspaces = useCallback((listener: () => void) => workspaces.list.subscribe(listener), [workspaces.list])
  const getWorkspaces = useCallback(() => workspaces.list.getSnapshot(), [workspaces.list])
  const catalog = useSyncExternalStore(subscribeSessions, getSessions, getSessions)
  const workspaceList = useSyncExternalStore(subscribeWorkspaces, getWorkspaces, getWorkspaces)
  const cwd = sessionId === undefined ? undefined : Object.entries(catalog.byId).find(([id]) => id === sessionId)?.[1]?.cwd
  const normalizePath = (value: string): string => value.replace(/[\\/]+$/u, '')
  const workspace = sessionId === undefined
    ? workspaceList.items[0]
    : cwd === undefined ? undefined : workspaceList.items.find(candidate => normalizePath(candidate.path) === normalizePath(cwd))
  return <MnemonSettingsCard
    {...props}
    {...(sessionId === undefined ? {} : { sessionId })}
    {...(workspace === undefined ? {} : { workspaceId: String(workspace.workspaceId), workspaceLabel: workspace.title })}
  />
}
