import { useLayoutEffect, useRef } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MnemonClientContext } from './dsh-context.ts'
import type { MnemonTranslate } from './locales.ts'
import type { MnemonNativeSidebarSeat } from './native-sidebar-seat.ts'
import type { MnemonWorkspaceController } from './workspace-controller.ts'
import { mountMnemonSidebarEntry } from './sidebar-entry.ts'
import { coordinateSidebarPanels } from './workspace-mount.tsx'
import { MemoryIcon } from './memory-icon.tsx'
import css from './MnemonWorkspace.module.css'

export const MNEMON_MAIN_PANEL_ID = 'mnemon' as MainPanelId

type UsePanelInfoHook = <T>(selector: (info: { activePanelId: string | null }) => T) => T

/** The native Sidebar owns the surrounding button, label, tooltip and state. */
function MnemonSidebarIcon({ size }: Pick<PropsRuntime<'sidebar.panellist'>, 'size'>): JSX.Element {
  return <MemoryIcon size={size} data-dsh-plugin="dsh-mnemon" data-dsh-part="sidebar-icon" />
}

/** DSH selects this seat; the shell registration retains Source render authority. */
function MnemonMainPanel({ seat, controller, usePanelInfo }: { seat: MnemonNativeSidebarSeat; controller: MnemonWorkspaceController; usePanelInfo?: UsePanelInfoHook }): JSX.Element {
  const parent = useRef<HTMLDivElement>(null)
  const panelActive = usePanelInfo === undefined ? true : usePanelInfo(info => info.activePanelId === MNEMON_MAIN_PANEL_ID)
  useLayoutEffect(() => {
    if (parent.current === null || !panelActive) return
    const detach = seat.attach(parent.current)
    controller.open()
    return () => { controller.close(); detach() }
  }, [seat, controller, panelActive])
  // The top clearance this seat keeps is the window's title bar on DSH Desktop; marking it
  // lets the window move from there, as from DSH's own pages.
  return <div ref={parent} className={css.nativeWorkspace} data-dsh-mnemon-main-seat>
    <div className={css.windowDragBand} data-window-drag aria-hidden="true" />
  </div>
}

interface LayoutPanelInfo {
  getSnapshot(): { activePanelId: MainPanelId | string | null }
  subscribe(listener: () => void): () => void
}

/** Use the published panel contract, with a fallback for replacement layouts. */
export function mountMnemonSidebarNavigation(
  ctx: MnemonClientContext,
  t: MnemonTranslate,
  controller: MnemonWorkspaceController,
  seat: MnemonNativeSidebarSeat,
): { open(): void; close(): void; dispose(): void } {
  let stopFallback: (() => void) | undefined
  let stopFallbackPanels: (() => void) | undefined
  let disposed = false
  const navigation = {
    open(): void {
      if (seat.getSnapshot().available) ctx.layout.selectPanel(MNEMON_MAIN_PANEL_ID)
      controller.open()
    },
    close(): void {
      if (seat.getSnapshot().available && controller.getSnapshot().open) ctx.layout.selectPanel(null)
      controller.close()
    },
  }
  const reconcileFallback = (): void => {
    if (disposed || seat.getSnapshot().available) {
      stopFallback?.()
      stopFallback = undefined
      stopFallbackPanels?.()
      stopFallbackPanels = undefined
    } else {
      stopFallbackPanels ??= coordinateSidebarPanels(controller, navigation.close)
      stopFallback ??= mountMnemonSidebarEntry(controller, t, listener => ctx.locale.subscribe(listener))
    }
  }
  let stopNative: (() => void) | undefined
  let stopPanelInfo: (() => void) | undefined
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    stopPanelInfo?.()
    stopPanelInfo = undefined
    stopNative?.()
    stopFallback?.()
    stopFallbackPanels?.()
    stopFallback = undefined
    stopFallbackPanels = undefined
    controller.close()
  }
  try {
    const panelInfo = (ctx.layout as { panelInfo?: LayoutPanelInfo } | undefined)?.panelInfo
    if (panelInfo !== undefined && typeof panelInfo.subscribe === 'function' && typeof panelInfo.getSnapshot === 'function') {
      stopPanelInfo = panelInfo.subscribe(() => {
        if (!seat.getSnapshot().available) return
        if (panelInfo.getSnapshot().activePanelId !== MNEMON_MAIN_PANEL_ID && controller.getSnapshot().open) {
          controller.close()
        }
      })
    }
    // Replacement shells may not declare the native panel seats; the fallback entry covers them.
    stopNative = ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
      const stopMain = ctx.slots.register({
        name: 'main', key: MNEMON_MAIN_PANEL_ID, inject: () => ({ seat, controller }),
      }, MnemonMainPanel as never)
      let stopIcon: (() => void) | undefined
      try {
        stopIcon = ctx.slots.register({
          name: 'sidebar.panellist', id: MNEMON_MAIN_PANEL_ID, order: 30,
          label: () => t('tab.label'), locale: 'mnemon',
        }, MnemonSidebarIcon)
        seat.setAvailable(true)
        reconcileFallback()
        if (controller.getSnapshot().open) navigation.open()
      } catch (error) {
        seat.setAvailable(false)
        stopIcon?.()
        stopMain()
        throw error
      }
      return () => {
        controller.close()
        seat.setAvailable(false)
        stopIcon?.()
        stopMain()
        reconcileFallback()
      }
    }))
    reconcileFallback()
    return { ...navigation, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}
