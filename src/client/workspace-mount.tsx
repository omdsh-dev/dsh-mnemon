import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientSettingsScope, Config } from '../shared/contracts.ts'
import type { MnemonClientContext } from './dsh-compat.ts'
import type { MnemonTranslate } from './locales.ts'
import { MnemonView, type MnemonWorkspaceSelection } from './MnemonView.tsx'
import type { MemorySourcePageDirectory } from './source-pages.tsx'
import { mountMnemonSidebarEntry } from './sidebar-entry.ts'
import { MnemonWorkspaceController } from './workspace-controller.ts'

/** Retained for consumers that used the old selector; the duplicate panel no longer exists. */
export const MNEMON_VIEW_SELECTOR = '[data-mnemon-surface]'

function normalizePath(value: string): string {
  return value.replace(/[\\/]+$/u, '')
}

export interface MnemonWorkspaceNavigation {
  open(): void
  close(): void
}

/** Navigate to and from the one DSH-owned conversation.view registration. */
export function createMnemonWorkspaceNavigation(t: MnemonTranslate): MnemonWorkspaceNavigation {
  let previousTab: HTMLElement | undefined
  const memoryTab = (): HTMLElement | undefined => {
    const label = t('tab.label').trim()
    return [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find(candidate => candidate.textContent?.trim() === label)
  }
  return {
    open() {
      const target = memoryTab()
      if (target === undefined) return
      const current = document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], [role="tab"][data-active]')
      if (current !== null && current !== target) previousTab = current
      target.click()
    },
    close() {
      const target = memoryTab()
      const fallback = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(candidate => candidate !== target)
      const destination = previousTab?.isConnected === true ? previousTab : fallback
      destination?.click()
    },
  }
}

export interface MnemonWorkspaceHostProps extends PropsRenderSlots<'mnemon.source.page'> {
  connection: MnemonClientContext['connection']
  settingsScope: ClientSettingsScope<Config>
  sessions: MnemonClientContext['sessions']
  workspaces: MnemonClientContext['workspaces']
  localeRuntime: MnemonClientContext['locale']
  sourcePageDirectory: MemorySourcePageDirectory
  navigation: MnemonWorkspaceNavigation
  surface: 'buildin' | 'sidebar'
  t: MnemonTranslate
  sessionId?: string
}

/** Canonical DSH conversation.view host; it alone receives child render authority. */
export function MnemonWorkspaceHost(props: MnemonWorkspaceHostProps): JSX.Element {
  const subscribeLocale = useCallback((listener: () => void) => props.localeRuntime.subscribe(listener), [props.localeRuntime])
  const getLocale = useCallback(() => props.localeRuntime.getSnapshot(), [props.localeRuntime])
  const subscribeSessions = useCallback((listener: () => void) => props.sessions.list.subscribe(listener), [props.sessions.list])
  const getSessions = useCallback(() => props.sessions.list.getSnapshot(), [props.sessions.list])
  const subscribeWorkspaces = useCallback((listener: () => void) => props.workspaces.list.subscribe(listener), [props.workspaces.list])
  const getWorkspaces = useCallback(() => props.workspaces.list.getSnapshot(), [props.workspaces.list])
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  const sessions = useSyncExternalStore(subscribeSessions, getSessions, getSessions)
  const workspaces = useSyncExternalStore(subscribeWorkspaces, getWorkspaces, getWorkspaces)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>()
  const sessionId = props.sessionId ?? sessions.current
  const currentCwd = sessionId === undefined ? undefined : (sessions.byId as Record<string, { cwd?: string }>)[sessionId]?.cwd
  const effectiveWorkspace = currentCwd === undefined
    ? undefined
    : workspaces.items.find(workspace => normalizePath(workspace.path) === normalizePath(currentCwd))
  const fallbackWorkspace = effectiveWorkspace ?? workspaces.items[0]
  const selectedExists = selectedWorkspaceId !== undefined && workspaces.items.some(workspace => String(workspace.workspaceId) === selectedWorkspaceId)
  const resolvedSelectedId = selectedExists ? selectedWorkspaceId : fallbackWorkspace === undefined ? undefined : String(fallbackWorkspace.workspaceId)

  useEffect(() => {
    if (resolvedSelectedId !== selectedWorkspaceId) setSelectedWorkspaceId(resolvedSelectedId)
  }, [resolvedSelectedId, selectedWorkspaceId])

  const selection = useMemo<MnemonWorkspaceSelection>(() => ({
    options: workspaces.items.map(workspace => ({ id: String(workspace.workspaceId), title: workspace.title, path: workspace.path })),
    ...(resolvedSelectedId === undefined ? {} : { selectedWorkspaceId: resolvedSelectedId }),
    ...(effectiveWorkspace === undefined ? {} : { effectiveWorkspaceId: String(effectiveWorkspace.workspaceId) }),
    onSelect: setSelectedWorkspaceId,
    onAlign: () => {
      if (effectiveWorkspace !== undefined) setSelectedWorkspaceId(String(effectiveWorkspace.workspaceId))
    },
  }), [effectiveWorkspace, resolvedSelectedId, workspaces.items])

  return <MnemonView
    connection={props.connection}
    settingsScope={props.settingsScope}
    {...(sessionId === undefined ? {} : { sessionId })}
    {...(resolvedSelectedId === undefined ? {} : { workspaceId: resolvedSelectedId })}
    workspaceSelection={selection}
    surface={props.surface}
    t={props.t}
    locale={locale.active}
    sourcePageDirectory={props.sourcePageDirectory}
    renderSlot={props.renderSlot}
    {...(props.surface === 'sidebar' ? { onClose: props.navigation.close } : {})}
  />
}

/** Core-owned sidebar row; it only opens the canonical conversation view. */
export function mountMnemonWorkspace(
  ctx: MnemonClientContext,
  _settings: ClientSettingsScope<Config>,
  t: MnemonTranslate,
  navigation: MnemonWorkspaceNavigation = createMnemonWorkspaceNavigation(t),
): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  const controller = new MnemonWorkspaceController()
  const disposeEntry = mountMnemonSidebarEntry(controller, t, listener => ctx.locale.subscribe(listener))
  const unsubscribe = controller.subscribe(() => {
    if (!controller.getSnapshot().open) return
    navigation.open()
    controller.close()
  })
  return () => {
    unsubscribe()
    disposeEntry()
  }
}
