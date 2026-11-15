import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { MNEMON_COMPONENT_SETTINGS_SLOT, type ComponentSettingsDirectory, type MemoryComponentSettingsProps } from './component-ui.tsx'
import type { ComponentHosts } from './component-host.ts'
import { MnemonSettingsCard, type ComponentSettingsSource, type MnemonSettingsCardProps } from './MnemonSettingsCard.tsx'
import type { MnemonClientContext } from './dsh-context.ts'
import { useMnemonSessionId, type MnemonSessionBinding } from './session-binding.ts'

interface MnemonSettingsHostProps extends Omit<MnemonSettingsCardProps, 'sessionId' | 'workspaceId' | 'workspaceLabel' | 'language' | 'componentSettings'>, Partial<PropsRenderSlots<typeof MNEMON_COMPONENT_SETTINGS_SLOT>> {
  /** The DSH Plugins page renders a bundle's configuration as its `page` view only. */
  view: PluginConfigViewProps['view']
  currentSession: MnemonSessionBinding
  localeRuntime: LocaleRuntime
  sessions: MnemonClientContext['sessions']
  workspaces: MnemonClientContext['workspaces']
  /** The components that contributed settings to their pages. */
  componentSettingsDirectory?: ComponentSettingsDirectory
  /** What the page lends the shipped components whose settings dsh-mnemon used to draw. */
  componentHost?: ComponentHosts
  /**
   * Renders a contribution on a page that does not own the settings region,
   * such as DSH's row page, or the configuration when a shell draws it
   * without DSH's renderSlot.
   */
  renderContributed?: (packageName: string, props: MemoryComponentSettingsProps) => ReactNode
}

/** The dsh-mnemon bundle page body; root-slot injection is cached, so session and workspace stay live here. */
export function MnemonSettingsHost({ view, currentSession, sessions, workspaces, localeRuntime, componentSettingsDirectory, componentHost, renderSlot, renderContributed, ...props }: MnemonSettingsHostProps): JSX.Element | null {
  const sessionId = useMnemonSessionId(currentSession)
  const subscribeSessions = useCallback((listener: () => void) => sessions.list.subscribe(listener), [sessions.list])
  const getSessionCwd = useCallback((): string | null => {
    const byId = sessions.list.getSnapshot().byId as Record<string, { cwd?: string } | undefined>
    if (sessionId === undefined || !Object.hasOwn(byId, sessionId)) return null
    return byId[sessionId]?.cwd ?? null
  }, [sessionId, sessions.list])
  const subscribeWorkspaces = useCallback((listener: () => void) => workspaces.list.subscribe(listener), [workspaces.list])
  const getWorkspaces = useCallback(() => workspaces.list.getSnapshot(), [workspaces.list])
  const subscribeLocale = useCallback((listener: () => void) => localeRuntime.subscribe(listener), [localeRuntime])
  const getLanguage = useCallback((): string => localeRuntime.getSnapshot().active, [localeRuntime])
  const language = useSyncExternalStore(subscribeLocale, getLanguage, getLanguage)
  const cwd = useSyncExternalStore(subscribeSessions, getSessionCwd, getSessionCwd) ?? undefined
  const workspaceList = useSyncExternalStore(subscribeWorkspaces, getWorkspaces, getWorkspaces)
  const subscribeDirectory = useCallback((listener: () => void) => componentSettingsDirectory?.subscribe(listener) ?? (() => {}), [componentSettingsDirectory])
  const getDirectory = useCallback(() => componentSettingsDirectory?.getSnapshot(), [componentSettingsDirectory])
  const contributed = useSyncExternalStore(subscribeDirectory, getDirectory, getDirectory)
  // Each component's page renders the settings it registered, keyed by its package name:
  // through the region where this page declares it, otherwise as registered.
  const componentSettings = useMemo<ComponentSettingsSource | undefined>(() => (renderSlot === undefined && renderContributed === undefined) || contributed === undefined ? undefined : {
    has: packageName => contributed.has(packageName),
    render: (entry, page) => {
      const host = componentHost?.(entry.packageName, page.sessionId, page.workspace?.id)
      const owner: MemoryComponentSettingsProps = {
        component: { packageName: entry.packageName, label: page.label, enabled: page.enabled },
        writable: page.writable, language: page.language,
        ...(page.sessionId === undefined ? {} : { sessionId: page.sessionId }),
        ...(page.workspace === undefined ? {} : { workspace: page.workspace }),
        ...(page.section === undefined ? {} : { section: page.section }),
        ...(host === undefined ? {} : { host }),
      }
      return renderSlot !== undefined ? renderSlot(MNEMON_COMPONENT_SETTINGS_SLOT, owner, { entryKey: entry.packageName, fallback: null }) : renderContributed!(entry.packageName, owner)
    },
  }, [renderSlot, renderContributed, contributed, componentHost])
  if (view !== 'page') return null
  const normalizePath = (value: string): string => value.replace(/[\\/]+$/u, '')
  const workspace = sessionId === undefined
    ? workspaceList.items[0]
    : cwd === undefined ? undefined : workspaceList.items.find(candidate => normalizePath(candidate.path) === normalizePath(cwd))
  return <MnemonSettingsCard
    {...props}
    {...(componentSettings === undefined ? {} : { componentSettings })}
    language={language}
    {...(sessionId === undefined ? {} : { sessionId })}
    {...(workspace === undefined ? {} : { workspaceId: String(workspace.workspaceId), workspaceLabel: workspace.title })}
  />
}

/**
 * DSH's page for one component row: the component's page alone. The settings
 * region is declared by the bundle's configuration, so contributions render as
 * they were registered rather than through a slot of this entry.
 */
export function MnemonComponentRowHost(props: Omit<MnemonSettingsHostProps, 'renderSlot' | '__renders'> & { component: string }): JSX.Element | null {
  return <MnemonSettingsHost {...props} />
}
