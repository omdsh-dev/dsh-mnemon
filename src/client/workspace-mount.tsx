import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientSettingsScope, Config } from "../host/protocol.ts"
import type { MnemonClientContext } from "./dsh-context.ts"
import type { MnemonTranslate } from './locales.ts'
import { MnemonWorkbench, type MnemonWorkspaceSelection } from './MnemonWorkbench.tsx'
import type { MemorySourcePageDirectory } from './source-pages.tsx'
import type { MnemonBetterSidebarSeat } from './better-sidebar-seat.ts'
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

interface MnemonWorkspaceSurface {
  column: HTMLElement
  frame?: HTMLElement
  details?: HTMLElement
}

function resolveWorkspaceSurface(): MnemonWorkspaceSurface | undefined {
  const explicit = document.querySelector<HTMLElement>('[data-pane="conversation"]')
    ?? document.querySelector<HTMLElement>('.dshDesktopConversationSurface')
  if (explicit !== null) return { column: explicit }

  const column = document.querySelector<HTMLElement>('[class*="centerCol"]')
  if (column === null) return undefined
  const frame = column.parentElement
  const details = frame === null
    ? undefined
    : Array.from(frame.children).find((child): child is HTMLElement => child instanceof HTMLElement && child !== column && child.className.includes('detailsCol'))
  return frame === null || details === undefined ? { column } : { column, frame, details }
}

function sameWorkspaceSurface(left: MnemonWorkspaceSurface | undefined, right: MnemonWorkspaceSurface | undefined): boolean {
  return left?.column === right?.column && left?.frame === right?.frame && left?.details === right?.details
}

function workspaceSurfaceBounds(surface: MnemonWorkspaceSurface): { left: number; top: number; width: number; height: number } {
  const columnRect = surface.column.getBoundingClientRect()
  if (surface.frame === undefined) {
    const { left, top, width, height } = columnRect
    return { left, top, width, height }
  }
  const frameRect = surface.frame.getBoundingClientRect()
  return {
    left: columnRect.left,
    top: frameRect.top,
    width: Math.max(0, frameRect.left + frameRect.width - columnRect.left),
    height: frameRect.height,
  }
}

function normalizePath(value: string): string {
  return value.replace(/[\\/]+$/u, '')
}

export interface MnemonWorkspaceNavigation {
  open(): void
  close(): void
}

export interface MnemonWorkspaceHostProps {
  connection: MnemonClientContext['connection']
  settingsScope: ClientSettingsScope<Config>
  sessions: MnemonClientContext['sessions']
  workspaces: MnemonClientContext['workspaces']
  localeRuntime: MnemonClientContext['locale']
  sourcePageDirectory: MemorySourcePageDirectory
  navigation?: MnemonWorkspaceNavigation
  t: MnemonTranslate
  sessionId?: string
  cwd?: string
  active?: boolean
  renderSlot?: PropsRenderSlots<'mnemon.source.page'>['renderSlot']
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
  return <MnemonWorkbench
    connection={props.connection}
    settingsScope={props.settingsScope}
    sessionId={props.sessionId}
    surface="builtin"
    t={props.t}
    locale={locale.active}
    sourcePageDirectory={props.sourcePageDirectory}
    {...(props.renderSlot === undefined ? {} : { renderSlot: props.renderSlot })}
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
  const currentCwd = props.cwd ?? (sessionId === undefined ? undefined : (sessions.byId as Record<string, { cwd?: string }>)[sessionId]?.cwd)
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

  return <MnemonWorkbench
    connection={props.connection}
    settingsScope={props.settingsScope}
    {...(sessionId === undefined ? {} : { sessionId })}
    {...(resolvedSelectedId === undefined ? {} : { workspaceId: resolvedSelectedId })}
    workspaceSelection={selection}
    active={props.active ?? true}
    t={props.t}
    locale={locale.active}
    sourcePageDirectory={props.sourcePageDirectory}
    {...(props.renderSlot === undefined ? {} : { renderSlot: props.renderSlot })}
    {...(props.navigation === undefined ? {} : { onClose: props.navigation.close })}
  />
}

/** Sidebar presentation in DSH's additive shell.overlay, also without a session. */
export function MnemonSidebarWorkspaceHost(props: MnemonWorkspaceHostProps & { controller: MnemonWorkspaceController; betterSidebarSeat?: MnemonBetterSidebarSeat }): JSX.Element {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot, props.controller.getSnapshot)
  const subscribeBetterSidebar = useCallback((listener: () => void) => props.betterSidebarSeat?.subscribe(listener) ?? (() => {}), [props.betterSidebarSeat])
  const getBetterSidebar = useCallback(() => props.betterSidebarSeat?.getSnapshot(), [props.betterSidebarSeat])
  const betterSidebar = useSyncExternalStore(subscribeBetterSidebar, getBetterSidebar, getBetterSidebar)
  const [bounds, setBounds] = useState<{ left: number; top: number; width: number; height: number }>()
  useEffect(() => {
    if (!state.open) return
    let surface: MnemonWorkspaceSurface | undefined
    const previousInert = new Map<HTMLElement, boolean>()
    const update = (): void => {
      if (surface === undefined) return
      const { left, top, width, height } = workspaceSurfaceBounds(surface)
      setBounds(previous => previous?.left === left && previous.top === top && previous.width === width && previous.height === height ? previous : { left, top, width, height })
    }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    const observedTargets = (value: MnemonWorkspaceSurface): HTMLElement[] => [...new Set([value.column, value.frame, value.details].filter((target): target is HTMLElement => target !== undefined))]
    const inertTargets = (value: MnemonWorkspaceSurface): HTMLElement[] => [value.column, value.details].filter((target): target is HTMLElement => target !== undefined)
    const detach = (): void => {
      if (surface !== undefined) {
        for (const target of observedTargets(surface)) observer?.unobserve(target)
      }
      for (const [target, inert] of previousInert) target.inert = inert
      previousInert.clear()
      surface = undefined
    }
    const connect = (): void => {
      const next = resolveWorkspaceSurface()
      if (!sameWorkspaceSurface(next, surface)) {
        detach()
        surface = next
        if (surface !== undefined) {
          for (const target of inertTargets(surface)) {
            previousInert.set(target, target.inert)
            target.inert = true
          }
          for (const target of observedTargets(surface)) observer?.observe(target)
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
      detach()
    }
  }, [state.open, props.controller])
  const betterSidebarView = betterSidebar === undefined ? null : createPortal(<MnemonWorkspaceHost
    connection={props.connection}
    settingsScope={props.settingsScope}
    sessions={props.sessions}
    workspaces={props.workspaces}
    localeRuntime={props.localeRuntime}
    sourcePageDirectory={props.sourcePageDirectory}
    sessionId={betterSidebar.scope.sessionId}
    {...(betterSidebar.scope.cwd === undefined ? {} : { cwd: betterSidebar.scope.cwd })}
    active={betterSidebar.visible}
    t={props.t}
    {...(props.renderSlot === undefined ? {} : { renderSlot: props.renderSlot })}
  />, betterSidebar.target)
  // Hide the existing DSH subtree so panel navigation retains Source page state.
  return <>
    {betterSidebarView}
    {bounds !== undefined && <section data-dsh-mnemon-view hidden={!state.open} className={css.workspacePanel} style={{ ...bounds, display: state.open ? undefined : 'none' }} aria-label={props.t('tab.label')}>
      <MnemonWorkspaceHost {...props} active={state.open} />
    </section>}
  </>
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
