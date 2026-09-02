import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ClientSettingsScope, Config } from '../shared/contracts.ts'
import { MNEMON_ANCHOR_EVENT } from './anchor.ts'
import type { MnemonClientContext } from './dsh-compat.ts'
import type { MnemonTranslate } from './locales.ts'
import { MnemonView, type MnemonWorkspaceSelection } from './MnemonView.tsx'
import css from './MnemonWorkspace.module.css'
import { mountMnemonSidebarEntry } from './sidebar-entry.ts'
import { MnemonWorkspaceController } from './workspace-controller.ts'

export const MNEMON_VIEW_SELECTOR = '[data-dsh-mnemon-view]'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"], .dshDesktopConversationSurface'
const ACTIVE_ATTR = 'data-dsh-mnemon-active'
const TASKBOARD_ACTIVE_ATTR = 'data-dsh-taskboard-active'
const SSH_ACTIVE_ATTR = 'data-dsh-ssh-active'
const ACTIVATE_EVENT = 'dsh-panel-activate'
const SIDEBAR_CONTEXT_SELECTOR = '[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'

interface MnemonPanelProps {
  ctx: MnemonClientContext
  settings: ClientSettingsScope<Config>
  t: MnemonTranslate
  onClose?: () => void
  scope?: MnemonWorkspaceScope
}

export interface MnemonWorkspaceScope {
  sessionId: string
  cwd?: string
}

/** Shared sidebar-sized view used by both the legacy workspace and Better Sidebar. */
export function MnemonPanel({ ctx, settings, t, onClose, scope }: MnemonPanelProps): JSX.Element {
  const subscribeLocale = useCallback((listener: () => void) => ctx.locale.subscribe(listener), [ctx.locale])
  const getLocaleSnapshot = useCallback(() => ctx.locale.getSnapshot(), [ctx.locale])
  const locale = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot)
  const sessions = useSyncExternalStore(
    listener => ctx.sessions.list.subscribe(listener),
    () => ctx.sessions.list.getSnapshot(),
    () => ctx.sessions.list.getSnapshot(),
  )
  const workspaces = useSyncExternalStore(
    listener => ctx.workspaces.list.subscribe(listener),
    () => ctx.workspaces.list.getSnapshot(),
    () => ctx.workspaces.list.getSnapshot(),
  )
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>()
  const sessionId = scope?.sessionId ?? sessions.current
  const currentCwd = scope === undefined
    ? (sessions.current === undefined ? undefined : sessions.byId[sessions.current]?.cwd)
    : scope.cwd
  const normalizePath = (value: string): string => value.replace(/[\\/]+$/u, '')
  const effectiveWorkspace = currentCwd === undefined
    ? undefined
    : workspaces.items.find(workspace => normalizePath(workspace.path) === normalizePath(currentCwd))
  const fallbackWorkspace = effectiveWorkspace
    ?? workspaces.items[0]
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

  return <MnemonView connection={ctx.connection} settingsScope={settings} {...(sessionId === undefined ? {} : { sessionId })} {...(resolvedSelectedId === undefined ? {} : { workspaceId: resolvedSelectedId })} workspaceSelection={selection} t={t} locale={locale.active} {...(onClose === undefined ? {} : { onClose })} />
}

function conversationColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CONVERSATION_COLUMN_SELECTOR) ?? undefined
}

function mountPanel(controller: MnemonWorkspaceController, ctx: MnemonClientContext, settings: ClientSettingsScope<Config>, t: MnemonTranslate): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const ensure = (): void => {
    if (container !== undefined && container.isConnected) return
    if (container !== undefined) {
      root?.unmount()
      root = undefined
      container = undefined
    }
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshMnemonView = ''
    container.className = css.panelView ?? ''
    column.append(container)
    root = createRoot(container)
    root.render(<MnemonPanel ctx={ctx} settings={settings} t={t} onClose={() => { controller.close() }} />)
  }

  const waitObserver = new MutationObserver(ensure)
  waitObserver.observe(document.body, { childList: true, subtree: true })

  let suppressCompatibilityClose = false
  const applyActive = (): void => {
    if (!controller.getSnapshot().open) {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
      return
    }

    // Current task-board and SSH releases only close for one another's event
    // names. Send both compatibility events before announcing Mnemon.
    suppressCompatibilityClose = true
    try {
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'ssh' }))
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'taskboard' }))
    } finally {
      suppressCompatibilityClose = false
    }
    document.documentElement.removeAttribute(TASKBOARD_ACTIVE_ATTR)
    document.documentElement.removeAttribute(SSH_ACTIVE_ATTR)
    document.documentElement.setAttribute(ACTIVE_ATTR, '')
    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'mnemon' }))
  }

  const onOtherPanelActivate = (event: Event): void => {
    if (suppressCompatibilityClose || !controller.getSnapshot().open) return
    const detail = (event as CustomEvent<unknown>).detail
    if (detail === 'taskboard' || detail === 'ssh') controller.close()
  }

  const onSidebarContextClick = (event: MouseEvent): void => {
    if (!controller.getSnapshot().open) return
    const target = event.target
    if (target instanceof Element && target.closest(SIDEBAR_CONTEXT_SELECTOR) !== null) controller.close()
  }

  // DOM flags drive the released Web UI panels' actual visibility. Keep our
  // private snapshot in sync even when a peer does not deliver its event.
  const activeObserver = new MutationObserver(() => {
    if (!controller.getSnapshot().open) return
    const html = document.documentElement
    if (!html.hasAttribute(ACTIVE_ATTR) || html.hasAttribute(TASKBOARD_ACTIVE_ATTR) || html.hasAttribute(SSH_ACTIVE_ATTR)) controller.close()
  })
  activeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [ACTIVE_ATTR, TASKBOARD_ACTIVE_ATTR, SSH_ACTIVE_ATTR],
  })

  const onAnchor = (): void => { controller.open() }
  document.addEventListener('click', onSidebarContextClick, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherPanelActivate)
  window.addEventListener(MNEMON_ANCHOR_EVENT, onAnchor)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()

  return () => {
    document.removeEventListener('click', onSidebarContextClick, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherPanelActivate)
    window.removeEventListener(MNEMON_ANCHOR_EVENT, onAnchor)
    activeObserver.disconnect()
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}

/** Mount the sidebar row and its stateful center-column workspace as one unit. */
export function mountMnemonWorkspace(ctx: MnemonClientContext, settings: ClientSettingsScope<Config>, t: MnemonTranslate): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  const controller = new MnemonWorkspaceController()
  const disposeEntry = mountMnemonSidebarEntry(controller, t, listener => ctx.locale.subscribe(listener))
  const disposePanel = mountPanel(controller, ctx, settings, t)
  return () => {
    disposePanel()
    disposeEntry()
  }
}
