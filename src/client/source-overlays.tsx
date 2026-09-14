import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientSettingsScope, Config, MemorySourceManagementInstance } from '../host/protocol.ts'
import type { MnemonClientContext } from './dsh-context.ts'
import type { MemorySourcePageDirectory } from './source-pages.tsx'
import { bindSourceManagementClient } from './source-client.ts'
import { MnemonClient } from './api.ts'

export const MNEMON_CLOSE_WORKSPACE_EVENT = 'dsh-mnemon-close-workspace'
export interface SourceOverlaysHostProps {
  connection: MnemonClientContext['connection']
  sessions: MnemonClientContext['sessions']
  localeRuntime: MnemonClientContext['locale']
  settingsScope: ClientSettingsScope<Config>
  directory: MemorySourcePageDirectory
  renderSlot?: PropsRenderSlots<'mnemon.source.overlay'>['renderSlot']
}

/** Shell ownership and authenticated clients only; all widget behavior belongs to its Source. */
export function SourceOverlaysHost(props: SourceOverlaysHostProps): JSX.Element | null {
  const subscribe = useCallback((changed: () => void) => props.directory.subscribe(changed), [props.directory])
  const get = useCallback(() => props.directory.getSnapshot(), [props.directory])
  const entries = useSyncExternalStore(subscribe, get, get)
  return entries.length ? <BoundSourceOverlays {...props} entries={entries} /> : null
}
function BoundSourceOverlays(props: SourceOverlaysHostProps & { entries: ReturnType<MemorySourcePageDirectory['getSnapshot']> }): JSX.Element {
  const subscribeSessions = useCallback((changed: () => void) => props.sessions.list.subscribe(changed), [props.sessions.list])
  const getSessions = useCallback(() => props.sessions.list.getSnapshot(), [props.sessions.list])
  const sessions = useSyncExternalStore(subscribeSessions, getSessions, getSessions)
  const subscribeLocale = useCallback((changed: () => void) => props.localeRuntime.subscribe(changed), [props.localeRuntime])
  const getLocale = useCallback(() => props.localeRuntime.getSnapshot(), [props.localeRuntime])
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  const subscribeSettings = useCallback((changed: () => void) => props.settingsScope.subscribe(changed), [props.settingsScope])
  const getSettings = useCallback(() => props.settingsScope.getSnapshot(), [props.settingsScope])
  const settings = useSyncExternalStore(subscribeSettings, getSettings, getSettings)
  const client = useMemo(() => new MnemonClient(props.connection, sessions.current), [props.connection, sessions.current])
  const [catalog, setCatalog] = useState<{ owner: MnemonClient; instances: MemorySourceManagementInstance[] }>()
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true, pending = false
    const refresh = async () => {
      if (pending || typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      pending = true
      try {
        const value = await client.sourceManagementCatalog()
        if (active) setCatalog({ owner: client, instances: value.sources })
      } catch { if (active) setCatalog(undefined) }
      finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 15000)
    return () => { active = false; clearInterval(timer) }
  }, [client, props.entries, settings, revision])
  const instances = catalog?.owner === client ? catalog.instances : []
  const latestInstances = useRef(instances)
  latestInstances.current = instances
  const bindingSignature = JSON.stringify(instances.map(instance => [instance.sourceInstanceKey, instance.sourceTypeId, instance.availability, instance.capabilities, instance.assistance]))
  // Revision refreshes must not replace a Source's client identity and erase its open form.
  // A new session still gets a new client; changed participation removes the old binding.
  const clients = useMemo(() => new Map(instances.map(instance => {
    const bound = { ...instance, get revision() { return latestInstances.current.find(value => value.sourceInstanceKey === instance.sourceInstanceKey)?.revision ?? instance.revision } }
    return [instance.sourceInstanceKey, bindSourceManagementClient(client, bound, client)]
  })), [client, bindingSignature])
  const openSession = props.sessions.open === undefined ? undefined : async (id: string) => {
    await props.sessions.refresh?.()
    props.sessions.open!(id as SessionId)
    window.dispatchEvent(new Event(MNEMON_CLOSE_WORKSPACE_EVENT))
  }
  return <>{props.entries.flatMap(entry => instances.filter(instance => instance.sourceTypeId === entry.sourceTypeId && instance.availability !== 'unavailable').map(instance => <Fragment key={entry.id + ':' + instance.sourceInstanceKey}>
    {props.renderSlot?.('mnemon.source.overlay', {
      sourceTypeId: entry.sourceTypeId, sourceInstanceKey: instance.sourceInstanceKey,
      sourceInstances: instances.filter(value => value.sourceTypeId === entry.sourceTypeId), management: clients.get(instance.sourceInstanceKey)!,
      writable: settings.status === 'ready' && settings.writable && settings.value?.writeEnabled === true,
      locale: locale.active, ...(sessions.current ? { sessionId: sessions.current } : {}),
      ...(openSession ? { sessionNavigation: { open: openSession } } : {}),
      ...(entry.coordinateSources ? { managementDirectory: { sources: instances, client: (key: string) => clients.get(key) } } : {}),
      onRefresh: () => setRevision(current => current + 1),
    }, { only: entry.id })}
  </Fragment>))}</>
}
