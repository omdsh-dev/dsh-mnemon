import { useEffect, useRef, type ReactNode } from 'react'
import type { MnemonClientContext } from './dsh-context.ts'
import type { MnemonTranslate } from './locales.ts'
import type { MnemonBetterSidebarSeat, MnemonWorkspaceScope } from './better-sidebar-seat.ts'
import css from './MnemonWorkspace.module.css'

/** Stable type id exposed to Better Sidebar and its persisted tab state. */
export const MNEMON_BETTER_SIDEBAR_TAB_ID = 'dsh-mnemon:memory'

interface BetterSidebarTabProps {
  scope: MnemonWorkspaceScope
  visible: boolean
}

interface BetterSidebarTabDescriptor {
  id: string
  title: string | (() => string)
  icon?: ReactNode | ((size: number) => ReactNode)
  order?: number
  single?: boolean
  component: (props: BetterSidebarTabProps) => ReactNode
}

interface BetterSidebarService {
  registerTab(descriptor: BetterSidebarTabDescriptor): () => void
}

interface BetterSidebarMemoryTabProps extends BetterSidebarTabProps {
  seat: MnemonBetterSidebarSeat
}

function MnemonTabIcon({ size }: { size: number }): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="8" cy="3.5" rx="5" ry="2" />
    <path d="M3 3.5v4c0 1.1 2.2 2 5 2s5-.9 5-2v-4M3 7.5v4c0 1.1 2.2 2 5 2s5-.9 5-2v-4" />
  </svg>
}

/** Better Sidebar supplies a DOM seat; the DSH renderer remains the owner. */
function BetterSidebarMemoryTab(props: BetterSidebarMemoryTabProps): JSX.Element {
  const target = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (target.current === null) return
    return props.seat.attach(target.current, props.scope, props.visible)
  }, [props.scope.cwd, props.scope.sessionId, props.seat, props.visible])
  return <div ref={target} className={css.betterSidebarSeat} data-dsh-mnemon-better-sidebar-seat />
}

/**
 * Register Mnemon through Better Sidebar's documented optional service.
 *
 * The service is deliberately a soft dependency. Watching Cordis service
 * changes makes installation order and HMR irrelevant while preserving the
 * standalone Mnemon sidebar on profiles that do not install Better Sidebar.
 */
export function mountBetterSidebarTab(
  ctx: MnemonClientContext,
  t: MnemonTranslate,
  seat: MnemonBetterSidebarSeat,
): () => void {
  let current: { service: BetterSidebarService; dispose: () => void } | undefined

  const reconcile = (): void => {
    const service = ctx.get('betterSidebar') as BetterSidebarService | undefined
    if (current?.service === service) return
    current?.dispose()
    current = undefined
    if (service === undefined) return
    const dispose = service.registerTab({
      id: MNEMON_BETTER_SIDEBAR_TAB_ID,
      title: () => t('tab.label'),
      icon: size => <MnemonTabIcon size={size} />,
      order: 55,
      single: true,
      component: ({ scope, visible }) => <BetterSidebarMemoryTab seat={seat} scope={scope} visible={visible} />,
    })
    current = { service, dispose }
  }

  reconcile()
  const unsubscribe = ctx.on('internal/service', (name) => {
    if (name === 'betterSidebar') reconcile()
  })
  return () => {
    unsubscribe()
    current?.dispose()
    current = undefined
  }
}
