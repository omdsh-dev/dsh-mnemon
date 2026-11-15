import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from 'react'
import {
  normalizeDisplayMode,
  type ClientConnectionHandle,
  type ClientSettingsScope,
  type Config,
  type InteractionConfig,
  type MemoryCompositionStatus,
} from "../host/protocol.ts"
import type { MemoryPluginEntryView } from '../host/view-protocol.ts'
import { MnemonClient } from './api.ts'
import { isRemoteConnection } from './remote-rpc.ts'
import { CompositionBoard, usePageTrail, type ComponentSettingsRenderer, type LayerSettings } from './CompositionBoard.tsx'
import { subscribeComponentPage, takeComponentPageRequest } from './component-page-request.ts'
import { componentCopy } from './component-copy.ts'
import { useViewFeedback } from './view-feedback.tsx'
import { SelectRow, ToggleRow } from './settings-controls.tsx'
import { useLive, useScope, WriteFailure } from './settings-panel.tsx'
import { TaskAgentModelRows, useTaskAgentModel } from './task-agent-model.tsx'
import { useViewStore } from './view-store.ts'
import css from './MnemonSettingsCard.module.css'
import { isRecord } from './is-record.ts'
import { translateZh, type MnemonTranslate } from './locales.ts'
import { usePackTarget } from './MnemonPackSection.tsx'
import { MnemonStorageSection } from './MnemonStorageSection.tsx'
import type { MnemonDirectoryPicker } from './picker.ts'
import type { MnemonChangeSignal } from './change-signal.ts'
import type { MnemonComponentListSeat } from './component-list-seat.ts'

/** How the page reaches the settings components contribute to their own pages. */
export interface ComponentSettingsSource {
  /** Whether a component registered settings, by package name. */
  has(packageName: string): boolean
  /** Render them for one component's page. */
  render(entry: MemoryPluginEntryView, page: { enabled: boolean; label: string; writable: boolean; language: string; sessionId?: string; workspace?: { id: string; label?: string }; section?: string }): ReactNode
}

export interface MnemonSettingsCardProps {
  scope: ClientSettingsScope<Config>
  /** Separate live namespace; without it the interaction toggles use `scope`. */
  interactionScope?: ClientSettingsScope<InteractionConfig>
  /** Loopback RPC used for whole-directory ZIP backup and restore. */
  connection?: ClientConnectionHandle
  directoryPicker?: MnemonDirectoryPicker
  sessionId?: string
  workspaceId?: string
  workspaceLabel?: string
  t?: MnemonTranslate
  /** Active DSH locale id for installed Strategies that bring their own text. */
  language?: string
  /**
   * Moves when a component is switched through DSH's plugin manager, for example on the Plugins page below.
   * This page moves it too after a sync, a merge, an import or an applied plan, so the memory views read memory again.
   */
  componentChanges?: Pick<MnemonChangeSignal, 'subscribe' | 'getSnapshot' | 'bump'>
  /** The settings components contribute to their pages; without it a page shows what their declarations give. */
  componentSettings?: ComponentSettingsSource
  /** Show one component's page alone, by its package name, as DSH's row page for that component. */
  component?: string
  /** What DSH's component list below this configuration shows, as the page reports it. */
  componentList?: Pick<MnemonComponentListSeat, 'subscribe' | 'getSnapshot'>
}

const NO_CHANGE_SIGNAL: Pick<MnemonChangeSignal, 'subscribe' | 'getSnapshot' | 'bump'> = { subscribe: () => () => {}, getSnapshot: () => 0, bump: () => {} }
const NO_COMPONENT_LIST: Pick<MnemonComponentListSeat, 'subscribe' | 'getSnapshot'> = { subscribe: () => () => {}, getSnapshot: () => undefined }

/**
 * The dsh-mnemon configuration, shown on its bundle page under DSH Plugins:
 * the memory composition, then only what belongs to no component — where
 * memory lives and how the interface shows it. Each component's own settings
 * live on its page, which a component's name opens anywhere on this page.
 *
 * Switches and selectors apply when they change, as the composition's do.
 * Typed values wait for their group's Apply; the storage location waits too,
 * because it moves where every component reads and writes.
 */
function dataRelevantConfigKey(status: 'loading' | 'ready' | 'unavailable', value: Config | undefined): string {
  if (status === 'loading') return 'loading'
  if (status === 'unavailable') return 'unavailable'
  const record = value as (Config & { memoryView?: unknown }) | undefined
  return JSON.stringify([
    record?.storageScope ?? null,
    record?.dataDir ?? null,
    record?.customPackId ?? null,
    record?.customPacks ?? null,
    record?.excludedWorkspaces ?? null,
    record?.memoryTopology ?? null,
    record?.memoryView ?? null,
    record?.documents ?? null,
  ])
}

export function MnemonSettingsCard({ scope, interactionScope: suppliedInteractionScope, connection, directoryPicker, sessionId, workspaceId, workspaceLabel, t = translateZh, language = 'zh', componentChanges = NO_CHANGE_SIGNAL, componentSettings, component, componentList = NO_COMPONENT_LIST }: MnemonSettingsCardProps): JSX.Element | null {
  const interactionScope = suppliedInteractionScope ?? scope as unknown as ClientSettingsScope<InteractionConfig>
  const coreSnapshot = useScope(scope)
  const interactionSnapshot = useScope(interactionScope)
  const [targetRevision, setTargetRevision] = useState(0)
  // A component switched below this configuration, on DSH's own list, changes the composition.
  const componentRevision = useSyncExternalStore(componentChanges.subscribe, componentChanges.getSnapshot, componentChanges.getSnapshot)
  // DSH 0.2.0 and earlier list the Starter's grouping row below, always off; DSH 0.2.1 lists only the components.
  const groupRowListed = useSyncExternalStore(componentList.subscribe, componentList.getSnapshot, componentList.getSnapshot) === true
  // Key data-layer RPC refreshes only on storage and topology fields so UI-only
  // toggles (displayMode, syncEnabled, conversation interaction) do not trigger
  // redundant dashboard, memory-system, and pack-target round-trips.
  const dataConfigKey = dataRelevantConfigKey(coreSnapshot.status, coreSnapshot.value)
  const seenDataConfig = useRef({ key: dataConfigKey, revision: 0 })
  if (seenDataConfig.current.key !== dataConfigKey) {
    seenDataConfig.current = { key: dataConfigKey, revision: seenDataConfig.current.revision + 1 }
  }
  const dataRevision = targetRevision + componentRevision + seenDataConfig.current.revision
  const sharedClient = useMemo(() => connection === undefined ? undefined : new MnemonClient(connection, sessionId, workspaceId), [connection, sessionId, workspaceId])
  const view = useViewStore(sharedClient, dataRevision)
  const pages = usePageTrail()
  // A page elsewhere asked for one component's settings, such as 技能管理's gear: open its page here.
  const entries = view.state.dashboard?.entries
  const openPage = pages.open
  useEffect(() => {
    if (entries === undefined || component !== undefined) return
    const take = (): void => {
      const requested = takeComponentPageRequest()
      const entry = requested === undefined ? undefined : entries.find(candidate => candidate.packageName === requested.packageName)
      if (entry !== undefined) openPage(entry.entryId, 'configuration', requested?.section)
    }
    take()
    return subscribeComponentPage(take)
  }, [entries, component, openPage])
  // A layer an earlier configuration turned off comes back on through its saved switch.
  const layerSettings = useMemo<LayerSettings>(() => ({
    set: async (layerId, enabled) => {
      await scope.mutate([{ op: 'set', path: ['memoryTopology', 'layers', layerId, 'enabled'], value: enabled }])
      setTargetRevision(revision => revision + 1)
    },
  }), [scope])
  // Every change says what it did where the user is looking, and points at the rows it touched.
  const root = useRef<HTMLElement | null>(null)
  const feedbackToast = useViewFeedback(view, root, t, language)
  const [memorySystem, setMemorySystem] = useState<MemoryCompositionStatus | null>(null)
  const [memorySystemState, setMemorySystemState] = useState<'unavailable' | 'loading' | 'ready' | 'error'>(sharedClient === undefined ? 'unavailable' : 'loading')
  const topologyRequest = useRef(0)
  const { target } = usePackTarget(connection, sessionId, workspaceId, dataRevision, sharedClient)

  useEffect(() => {
    if (sharedClient === undefined) {
      topologyRequest.current += 1
      setMemorySystem(null)
      setMemorySystemState('unavailable')
      return
    }
    const request = topologyRequest.current + 1
    topologyRequest.current = request
    setMemorySystemState('loading')
    void sharedClient.memorySystem().then(descriptor => {
      if (topologyRequest.current !== request) return
      setMemorySystem(descriptor)
      setMemorySystemState('ready')
    }, () => {
      if (topologyRequest.current !== request) return
      setMemorySystem(null)
      setMemorySystemState('error')
    })
    return () => { topologyRequest.current += 1 }
  }, [sharedClient, dataRevision])

  const coreUser = useMemo(() => isRecord(coreSnapshot.user) ? coreSnapshot.user : {}, [coreSnapshot.user])
  const loading = coreSnapshot.status === 'loading' || interactionSnapshot.status === 'loading'
  // A successful writable settings snapshot is the Host's authoritative
  // capability grant. DSH authenticates the complete Host API, so transport
  // locality is not a capability signal.
  const writable = coreSnapshot.writable && interactionSnapshot.writable
  const display = useLive(normalizeDisplayMode(coreSnapshot.value?.displayMode), async value => { await scope.mutate([{ op: 'set', path: ['displayMode'], value }]) })
  const turnBar = useLive(interactionSnapshot.value?.turnBar !== false, async value => { await interactionScope.mutate([{ op: 'set', path: ['turnBar'], value }]) })
  const saveAction = useLive(interactionSnapshot.value?.saveAction !== false, async value => { await interactionScope.mutate([{ op: 'set', path: ['saveAction'], value }]) })
  const taskAgent = useTaskAgentModel({ scope, connection, sessionId, workspaceId })

  // The page's composition opens each component's page; what the component contributed renders there.
  const settingsRenderer = useMemo<ComponentSettingsRenderer | undefined>(() => componentSettings === undefined ? undefined : {
    has: packageName => componentSettings.has(packageName),
    render: (entry, writableNow, section) => componentSettings.render(entry, {
      enabled: entry.enabled, label: componentCopy(entry, language).label, writable: writableNow, language,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(workspaceId === undefined ? {} : { workspace: { id: workspaceId, ...(workspaceLabel === undefined ? {} : { label: workspaceLabel }) } }),
      ...(section === undefined ? {} : { section }),
    }),
  }, [componentSettings, language, sessionId, workspaceId, workspaceLabel])

  if (coreSnapshot.status === 'unavailable' && interactionSnapshot.status === 'unavailable') {
    return <section className={css.page} aria-label={t('config.aria')}><p className={css.error} role="alert">{t('config.unavailable')}</p></section>
  }

  const coreDisabled = loading || !coreSnapshot.writable
  const readOnlyNotice = connection !== undefined && isRemoteConnection(connection) ? t('config.remoteReadOnly') : t('config.readOnly')
  const interactionDisabled = loading || !interactionSnapshot.writable
  // DSH's row page for one component shows that component's page alone.
  if (component !== undefined) {
    return <section ref={root} className={css.page} aria-label={t('config.aria')} aria-busy={loading}>
      {!writable && !loading && <p className={css.readOnlyNotice}>{readOnlyNotice}</p>}
      <CompositionBoard view={view} system={memorySystem} systemPending={memorySystemState === 'loading'} layers={layerSettings} readOnly={!coreSnapshot.writable} language={language} t={t}
        pages={pages} page={component} {...(settingsRenderer === undefined ? {} : { componentSettings: settingsRenderer })} />
      {feedbackToast}
    </section>
  }
  // The DSH Plugins page draws the plugin's title and description above this
  // section. Composition comes first, then where memory lives, then how the
  // in-conversation surfaces behave.
  return (
    <section ref={root} className={css.page} aria-label={t('config.aria')} aria-busy={loading}>
      {loading ? <p className={css.loading} role="status">{t('common.loading')}</p> : <>
        {/* Like DSH's own settings forms, a read-only document says so above its controls. */}
        {!writable && <p className={css.readOnlyNotice}>{readOnlyNotice}</p>}
        <CompositionBoard view={view} system={memorySystem} systemPending={memorySystemState === 'loading'} layers={layerSettings} readOnly={!coreSnapshot.writable} language={language} t={t}
          pages={pages} {...(settingsRenderer === undefined ? {} : { componentSettings: settingsRenderer })} />

        <section className={css.section} data-settings-section="task-agent" aria-labelledby="mnemon-task-agent-heading">
          <div className={css.sectionHeading}>
            <h2 id="mnemon-task-agent-heading">{t('config.taskAgentSectionTitle')}</h2>
            <p>{t('config.taskAgentSectionDescription')}</p>
            {taskAgent.catalog.state === 'loading' && <span className={css.miniSpinner} aria-hidden="true" />}
          </div>
          <div className={css.rows}>
            <TaskAgentModelRows idPrefix="mnemon-card-task-agent" mode={taskAgent.choosing ? 'fixed' : taskAgent.route.mode} route={taskAgent.route}
              settled={taskAgent.settled} choosing={taskAgent.choosing} catalog={taskAgent.catalog.value} state={taskAgent.catalog.state}
              error={taskAgent.catalog.error} retry={taskAgent.retry} disabled={coreDisabled} onMode={taskAgent.setMode} onRoute={taskAgent.setRoute} t={t} />
          </div>
          <WriteFailure error={taskAgent.failed} t={t} />
        </section>

        <MnemonStorageSection scope={scope} value={coreSnapshot.value} user={coreUser} disabled={coreDisabled} dashboard={view.state.dashboard} target={target}
          {...(sharedClient === undefined ? {} : { client: sharedClient })}
          {...(directoryPicker === undefined ? {} : { directoryPicker })}
          {...(connection === undefined ? {} : { connection })} {...(sessionId === undefined ? {} : { sessionId })} {...(workspaceId === undefined ? {} : { workspaceId })}
          language={language} t={t} onOpen={entry => pages.open(entry.entryId, 'configuration')} onSaved={() => setTargetRevision(revision => revision + 1)}
          onDataChanged={componentChanges.bump} />

        <section className={css.section} aria-labelledby="mnemon-interface-heading">
          <div className={css.sectionHeading}><h2 id="mnemon-interface-heading">{t('config.interfaceTitle')}</h2></div>
          <div className={css.rows}>
            <SelectRow id="mnemon-display" label={t('config.displayTitle')} value={display.value} disabled={coreDisabled} onChange={display.set} options={[
              { value: 'sidebar', label: t('config.displaySidebar'), detail: t('config.displaySidebarHint') },
              { value: 'builtin', label: t('config.displayBuiltin'), detail: t('config.displayBuiltinHint') },
            ]} />
            <ToggleRow id="mnemon-interaction-turn-bar" label={t('config.interactionTurnBar')} hint={t('config.interactionTurnBarHint')} checked={turnBar.value} disabled={interactionDisabled} onChange={turnBar.set} />
            <ToggleRow id="mnemon-interaction-save-action" label={t('config.interactionSaveAction')} hint={t('config.interactionSaveActionHint')} checked={saveAction.value} disabled={interactionDisabled} onChange={saveAction.set} />
          </div>
          <WriteFailure error={display.failed ?? turnBar.failed ?? saveAction.failed} t={t} />
        </section>

        {/* DSH draws the bundle's component list right below this configuration. */}
        {groupRowListed && <p className={css.componentListNote}>{t('config.componentListNote')}</p>}

        {feedbackToast}
      </>}
    </section>
  )
}
