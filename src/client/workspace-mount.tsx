import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientSettingsScope, Config } from "../host/protocol.ts"
import type { MnemonClientContext } from "./dsh-context.ts"
import type { MnemonTranslate } from './locales.ts'
import { MnemonView, type MnemonWorkspaceSelection } from './MnemonView.tsx'
import type { MemorySourcePageDirectory } from './source-pages.tsx'
import { mountMnemonSidebarEntry } from './sidebar-entry.ts'
import { MnemonWorkspaceController } from './workspace-controller.ts'
import css from './MnemonWorkspace.module.css'

/** The single visible Mnemon workspace, mounted by DSH's shell overlay. */
export const MNEMON_VIEW_SELECTOR = '[data-dsh-mnemon-view]'

const ACTIVE_ATTR = 'data-dsh-mnemon-active'
const TASKBOARD_ACTIVE_ATTR = 'data-dsh-taskboard-active'
const SSH_ACTIVE_ATTR = 'data-dsh-ssh-active'
const ACTIVATE_EVENT = 'dsh-panel-activate'
const SIDEBAR_CONTEXT_SELECTOR = '[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

function normalizePath(value: string): string {
  return value.replace(/[\\/]+$/u, '')
}

export interface MnemonWorkspaceNavigation {
  open(): void
  close(): void
}

export interface MnemonWorkspaceHostProps extends PropsRenderSlots<'mnemon.source.page'> {
  connection: MnemonClientContext['connection']
  settingsScope: ClientSettingsScope<Config>
  sessions: MnemonClientContext['sessions']
  workspaces: MnemonClientContext['workspaces']
  localeRuntime: MnemonClientContext['locale']
  sourcePageDirectory: MemorySourcePageDirectory
  navigation: MnemonWorkspaceNavigation
  t: MnemonTranslate
  sessionId?: string
  active?: boolean
}

export interface MnemonBuiltinWorkspaceHostProps extends Pick<MnemonWorkspaceHostProps,
  'connection' | 'settingsScope' | 'localeRuntime' | 'sourcePageDirectory' | 'renderSlot' | 't'> {
  sessionId: string
}

/** Builtin follows its DSH slot session, never the Sidebar's workspace picker. */
export function MnemonBuiltinWorkspaceHost(props: MnemonBuiltinWorkspaceHostProps): JSX.Element {
  const subscribeLocale = useCallback((listener: () => void) => props.localeRuntime.subscribe(listener), [props.localeRuntime])
  const getLocale = useCallback(() => props.localeRuntime.getSnapshot(), [props.localeRuntime])
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  return <MnemonView
    connection={props.connection}
    settingsScope={props.settingsScope}
    sessionId={props.sessionId}
    surface="builtin"
    t={props.t}
    locale={locale.active}
    sourcePageDirectory={props.sourcePageDirectory}
    renderSlot={props.renderSlot}
  />
}

/** Shared workspace body; its DSH registration owns Source child-render authority. */
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
    active={props.active ?? true}
    t={props.t}
    locale={locale.active}
    sourcePageDirectory={props.sourcePageDirectory}
    renderSlot={props.renderSlot}
    onClose={props.navigation.close}
  />
}

/** Sidebar presentation in DSH's additive shell.overlay, also without a session. */
export function MnemonSidebarWorkspaceHost(props: MnemonWorkspaceHostProps & { controller: MnemonWorkspaceController }): JSX.Element | null {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot, props.controller.getSnapshot)
  const [bounds, setBounds] = useState<{ left: number; top: number; width: number; height: number }>()
  useEffect(() => {
    if (!state.open) return
    let column: HTMLElement | null = null
    let wasInert = false
    const update = (): void => {
      if (column === null) return
      const { left, top, width, height } = column.getBoundingClientRect()
      setBounds(previous => previous?.left === left && previous.top === top && previous.width === width && previous.height === height ? previous : { left, top, width, height })
    }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    const connect = (): void => {
      const next = document.querySelector<HTMLElement>('[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface')
      if (next !== column) {
        if (column !== null) { observer?.unobserve(column); column.inert = wasInert }
        column = next
        if (column !== null) {
          wasInert = column.inert
          column.inert = true
          observer?.observe(column)
        }
      }
      update()
    }
    connect()
    const shell = new MutationObserver(connect)
    shell.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', update)
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented && document.querySelector('[role="dialog"]') === null) props.controller.close()
    }
    window.addEventListener('keydown', escape)
    return () => {
      shell.disconnect()
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('keydown', escape)
      if (column !== null) column.inert = wasInert
    }
  }, [state.open, props.controller])
  if (bounds === undefined) return null
  // Hide the existing DSH subtree so panel navigation retains Source page state.
  return <section data-dsh-mnemon-view hidden={!state.open} className={css.workspacePanel} style={{ ...bounds, display: state.open ? undefined : 'none' }} aria-label={props.t('tab.label')}>
    <MnemonWorkspaceHost {...props} active={state.open} />
  </section>
}

/** Core-owned sidebar row; presentation state is shared with its DSH seat. */
export function mountMnemonSidebarLauncher(
  ctx: MnemonClientContext,
  t: MnemonTranslate,
  controller: MnemonWorkspaceController,
): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  const stopEntry = mountMnemonSidebarEntry(controller, t, listener => ctx.locale.subscribe(listener))
  const stopPanels = coordinateSidebarPanels(controller)
  return () => { stopPanels(); stopEntry() }
}

/** Coordinate released peer panels; their DOM flags also cover lost events. */
function coordinateSidebarPanels(controller: MnemonWorkspaceController): () => void {
  let announcing = false
  const applyActive = (): void => {
    const html = document.documentElement
    if (!controller.getSnapshot().open) { html.removeAttribute(ACTIVE_ATTR); return }
    // Released Taskboard and SSH only close for each other's event names.
    announcing = true
    try {
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'ssh' }))
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'taskboard' }))
    } finally { announcing = false }
    html.removeAttribute(TASKBOARD_ACTIVE_ATTR)
    html.removeAttribute(SSH_ACTIVE_ATTR)
    html.setAttribute(ACTIVE_ATTR, '')
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'mnemon' }))
  }
  const onActivate = (event: Event): void => {
    if (announcing || !controller.getSnapshot().open) return
    const detail = (event as CustomEvent<unknown>).detail
    if (detail === 'taskboard' || detail === 'ssh') controller.close()
  }
  const onContext = (event: MouseEvent): void => {
    if (controller.getSnapshot().open && event.target instanceof Element && event.target.closest(SIDEBAR_CONTEXT_SELECTOR) !== null) controller.close()
  }
  const observer = new MutationObserver(() => {
    if (!controller.getSnapshot().open) return
    const html = document.documentElement
    if (!html.hasAttribute(ACTIVE_ATTR) || html.hasAttribute(TASKBOARD_ACTIVE_ATTR) || html.hasAttribute(SSH_ACTIVE_ATTR)) controller.close()
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [ACTIVE_ATTR, TASKBOARD_ACTIVE_ATTR, SSH_ACTIVE_ATTR] })
  document.addEventListener('click', onContext, true)
  document.addEventListener(ACTIVATE_EVENT, onActivate)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  return () => {
    unsubscribe()
    observer.disconnect()
    document.removeEventListener('click', onContext, true)
    document.removeEventListener(ACTIVATE_EVENT, onActivate)
    document.documentElement.removeAttribute(ACTIVE_ATTR)
  }
}
