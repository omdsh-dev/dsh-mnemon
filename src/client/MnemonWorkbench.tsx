import { isWorkspaceStorageScope } from '../host/protocol.ts'
import { isDefaultSourceInstance } from '../host/protocol.ts'
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { IconChevronLeftOutline14, IconRefreshOutlineRegular, IconSettingsOutlineRegular } from './ui-icons.ts'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'

import { DEFAULT_SKILLS_CONFIG, type ClientConnectionHandle, type ClientSettingsScope, type ClientSettingsSnapshot, type Config, type JsonValue, type MemorySourceManagementInstance, type SkillsConfig, type StorageAreaInventory, type StorageScopeKind, type VersionRestartStatus } from "../host/protocol.ts"
import type { MemoryPluginEntryView, MemoryViewDashboard } from '../host/view-protocol.ts'
import { MnemonClient } from "./api.ts"
import { isRemoteConnection } from "./remote-rpc.ts"
import { StatusPage, storageScopeLabel, type ComponentCard, type LayerState } from './StatusPage.tsx'
import { SourceManagementPage } from './SourceManagementPage.tsx'
import { useWorkspaceStatus } from './use-workspace-status.ts'
import { useSourceCatalog } from './use-source-catalog.ts'
import { managedSourceTypeId, sourcePageEntryId, stoppedSourceTypeId, useWorkspaceNavigation, type Page, type SourceNavigationEntry } from './use-workspace-navigation.ts'
import { requestComponentPage } from './component-page-request.ts'
import { translateZh, type MnemonTranslate } from "./locales.ts"

import { MNEMON_SOURCE_PAGE_SLOT, type MemorySourcePageDirectory, type MemorySourcePageEntry } from "./source-pages.tsx"
import type { MnemonActionSeat } from './action-seat.ts'
import type { MnemonChangeSignal } from './change-signal.ts'
import type { MnemonDisplayMode } from '../host/protocol.ts'
import { appearanceClass } from './view-styles.ts'
import { compositionNotice } from './composition-notice.ts'
import { layerOf, sourceOf } from './component-model.ts'
import { componentCopy } from './component-copy.ts'
import { WorkbenchStatusContext } from './component-status.tsx'
import { MNEMON_COMPONENT_STATUS_SLOT } from './component-ui.tsx'
import { Callout, Reveal, useToast } from './feedback.tsx'
import feedbackCss from './MnemonFeedback.module.css'
import { Button, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { SelectField } from './page-controls.tsx'
import { jsonRecord } from './is-record.ts'
import sidebarCss from './MnemonSidebarView.module.css'
import css from "./MnemonView.module.css"
import { I18nContext, LocaleContext, useT, useLocale, PageHeader, EmptyState } from "./page-kit.tsx"

interface MnemonWorkbenchProps {
  connection: ClientConnectionHandle
  settingsScope: ClientSettingsScope<Config>
  sessionId?: string
  workspaceId?: string
  workspaceSelection?: MnemonWorkspaceSelection
  /** Placement changes scope controls, not Source pages or their visual skin. */
  surface?: MnemonDisplayMode
  /** Retain page state while hidden, suspend reads, and refresh when reopened. */
  active?: boolean
  /**
   * The header is the top edge of the window, as in DSH's main column. DSH Desktop then
   * moves the window by it, like its own page headers, while its controls stay clickable.
   */
  titleBar?: boolean
  t?: MnemonTranslate
  locale?: string
  onClose?: () => void
  /** Opens the dsh-mnemon page under DSH Plugins, where the configuration lives, while that page offers navigation. */
  configuration?: MnemonActionSeat
  /** Moves when a component is switched through DSH's plugin manager, or memory changes on the configuration page. */
  componentChanges?: MnemonChangeSignal
  sourcePageDirectory?: MemorySourcePageDirectory
  renderSlot?: PropsRenderSlots<typeof MNEMON_SOURCE_PAGE_SLOT | typeof MNEMON_COMPONENT_STATUS_SLOT>['renderSlot']
  /**
   * Show one Source's pages alone, as its own sidebar entry does: the header
   * carries its title, refresh and settings, with no tabs and no Status.
   */
  focus?: { sourceTypeId: string; title: string }
  /** Source types whose pages live in an entry of their own, such as 技能管理's. */
  hiddenSourceTypes?: readonly string[]
  /** 技能管理's settings, so its page can show and switch evolution. */
  skillsScope?: ClientSettingsScope<SkillsConfig>
}

/** 技能管理's Source type. */
const SKILLS_SOURCE_TYPE = 'skills'
const NO_SKILLS_SNAPSHOT: ClientSettingsSnapshot<SkillsConfig> = { status: 'unavailable', writable: false, mode: 'host' }
const NO_SKILLS_SCOPE: Pick<ClientSettingsScope<SkillsConfig>, 'subscribe' | 'getSnapshot'> = { subscribe: () => () => {}, getSnapshot: () => NO_SKILLS_SNAPSHOT }

const NO_ACTION_SEAT: Pick<MnemonActionSeat, 'subscribe' | 'getSnapshot'> = { subscribe: () => () => {}, getSnapshot: () => undefined }
const NO_CHANGE_SIGNAL: Pick<MnemonChangeSignal, 'subscribe' | 'getSnapshot'> = { subscribe: () => () => {}, getSnapshot: () => 0 }

export interface MnemonWorkspaceSelection {
  options: Array<{ id: string; title: string; path: string }>
  selectedWorkspaceId?: string
  effectiveWorkspaceId?: string
  onSelect(workspaceId: string): void
  onAlign(): void
}

const EMPTY_SOURCE_PAGE_SNAPSHOT: readonly MemorySourcePageEntry[] = Object.freeze([])

const EMPTY_SOURCE_PAGE_DIRECTORY: MemorySourcePageDirectory = {
  getSnapshot: () => EMPTY_SOURCE_PAGE_SNAPSHOT,
  subscribe: () => () => {},
}

/**
 * How memory is composed now, beside the connection in the header: the main
 * Strategy composing it, and on hover each layer's state. Selecting it opens
 * the configuration where that composition is changed.
 */
function CompositionStatus(props: { tone: StateDotState; label: string; strategy?: string | undefined; layers: ReadonlyArray<{ id: string; label: string; state: 'on' | 'off' | 'stopped' | 'memory-off' }>; onOpen: (() => void) | undefined }): JSX.Element {
  const t = useT()
  const summaryId = useId()
  const layerDot = (state: 'on' | 'off' | 'stopped' | 'memory-off'): StateDotState => state === 'on' ? 'done' : state === 'stopped' ? 'warning' : 'idle'
  const layerNote = (state: 'on' | 'off' | 'stopped' | 'memory-off'): string | undefined => state === 'on' ? undefined
    : t(state === 'off' ? 'layers.disabledBadge' : state === 'stopped' ? 'layers.stoppedBadge' : 'layers.memoryOffBadge')
  const anchor = <button type="button" className={css.compositionStatus} onClick={props.onOpen} disabled={props.onOpen === undefined}
    aria-label={props.strategy === undefined ? props.label : `${props.label} · ${props.strategy}`} {...(props.layers.length === 0 ? {} : { 'aria-describedby': summaryId })}>
    <StateDot state={props.tone} />
    <span>{props.label}</span>
    {props.strategy !== undefined && <span className={css.compositionStrategy}>{props.strategy}</span>}
  </button>
  if (props.layers.length === 0) return anchor
  // A popover under the status, aligned to its right edge, shown on hover and on keyboard focus.
  return <span className={css.compositionStatusWrap}>
    {anchor}
    <span id={summaryId} className={css.compositionSummary} role="tooltip">
      <strong>{t('board.title')}</strong>
      {props.strategy !== undefined && <span className={feedbackCss.chip} data-state={props.tone === 'done' ? 'done' : 'warning'}><StateDot state={props.tone === 'done' ? 'done' : 'warning'} /><span className={feedbackCss.chipLabel}>{props.strategy}</span></span>}
      <span className={css.compositionLayers}>{props.layers.map(layer => <span key={layer.id} className={feedbackCss.chip} data-state={layerDot(layer.state)}>
        <StateDot state={layerDot(layer.state)} />
        <span className={feedbackCss.chipLabel}>{layer.label}</span>
        {layerNote(layer.state) !== undefined && <span className={feedbackCss.chipNote}>{layerNote(layer.state)}</span>}
      </span>)}</span>
      {props.onOpen !== undefined && <span className={css.compositionHint}>{t('header.compositionHint')}</span>}
    </span>
  </span>
}

function SourceDisabledPage(props: { title: string; onOpenConfiguration: (() => void) | undefined }): JSX.Element {
  const t = useT()
  return <div className={css.page}>
    <PageHeader title={props.title} description={t('layers.disabledDescription')} meta={t('layers.disabledBadge')} {...(props.onOpenConfiguration === undefined ? {} : { action: <button type="button" className={css.secondaryButton} onClick={props.onOpenConfiguration}>{t('common.openConfiguration')}</button> })} />
    <EmptyState glyph="⊘" title={t('layers.disabledTitle', { layer: props.title })}>{t('layers.disabledText')}</EmptyState>
  </div>
}

/** A layer that is on but whose Source is not running: its component did not start, or no memory is composed at all. */
function SourceStoppedPage(props: { title: string; memoryOff: boolean; onOpenConfiguration: (() => void) | undefined }): JSX.Element {
  const t = useT()
  return <div className={css.page}>
    <PageHeader title={props.title} description={t(props.memoryOff ? 'layers.memoryOffDescription' : 'layers.stoppedDescription')} meta={t(props.memoryOff ? 'layers.memoryOffBadge' : 'layers.stoppedBadge')} {...(props.onOpenConfiguration === undefined ? {} : { action: <button type="button" className={css.secondaryButton} onClick={props.onOpenConfiguration}>{t('common.openConfiguration')}</button> })} />
    <EmptyState glyph="⊘" title={t(props.memoryOff ? 'layers.memoryOffTitle' : 'layers.stoppedTitle', { layer: props.title })}>{t(props.memoryOff ? 'layers.memoryOffText' : 'layers.stoppedText')}</EmptyState>
  </div>
}

function WorkspaceNavigation(props: { page: Page; onSelect(page: Page): void; sourcePages: readonly SourceNavigationEntry[]; disabledTypes: ReadonlySet<string>; memoryOff: boolean }): JSX.Element {
  const t = useT()
  const entries: readonly SourceNavigationEntry[] = [
    { id: 'status', page: 'status', label: t('nav.status'), detail: '', group: 'system', glyph: '⌘', primary: true },
    ...props.sourcePages,
  ]
  const selectedType = sourcePageEntryId(props.page)?.split('/')[0]
  const button = (item: SourceNavigationEntry) => {
    const active = props.page === item.page || selectedType !== undefined && selectedType === item.sourceTypeId
    const disabled = item.sourceTypeId !== undefined && props.disabledTypes.has(item.sourceTypeId)
    // A switched-off layer says so first; a stopped Source matters only while the layer is on.
    const badge = disabled ? t('layers.disabledBadge') : item.stopped === true ? t(props.memoryOff ? 'layers.memoryOffBadge' : 'layers.stoppedBadge') : undefined
    return <button key={item.id} type="button" role="tab" aria-selected={active} data-active={active ? '' : undefined} aria-label={badge === undefined ? undefined : item.label + ' · ' + badge} data-layer-disabled={badge === undefined ? undefined : ''} onClick={() => props.onSelect(item.page)}><span>{item.label}</span>{badge !== undefined && <em className={css.layerDisabledBadge}>{badge}</em>}</button>
  }
  return <div className={appearanceClass(css.topNavigation, sidebarCss.topNavigation)}>
    <div className={appearanceClass(css.nav, sidebarCss.nav)} role="tablist" aria-label={t('nav.aria')}>{entries.filter(entry => entry.primary).map(button)}</div>
  </div>
}

/**
 * An installed update waits for DSH to restart: the Host keeps the code it loaded, while DSH has
 * already swapped in this page. Every Memory System page says so until the restart.
 */
function RestartReminder({ pending }: { pending: VersionRestartStatus }): JSX.Element {
  const t = useT()
  return pending.installed !== undefined
    ? <Callout tone="warning" title={t('versions.pendingInstalledTitle', { version: pending.installed })}>{t('versions.pendingInstalledDetail', { running: pending.running })}</Callout>
    : <Callout tone="warning" title={t('versions.pendingPackagesTitle', { names: (pending.packages ?? []).join(t('config.listSeparator')) })}>{t('versions.pendingPackagesDetail')}</Callout>
}

/** Resolve the configured scope before the first status round-trip to keep the Sidebar header stable. */
function configuredStorageScope(config: Config | undefined): StorageScopeKind {
  return config?.storageScope ?? (config?.dataDir?.trim() ? 'custom' : 'global')
}

/** The Source whose data a storage area holds. */
const AREA_SOURCES: Readonly<Partial<Record<StorageAreaInventory['kind'], string>>> = { runtime: 'runtime', documents: 'documents', 'memory-bodies': 'memory-spaces' }

function storageAreaLabel(t: MnemonTranslate, kind: StorageAreaInventory['kind']): string {
  return t(kind === 'runtime' ? 'status.storageRuntime' : kind === 'memory-bodies' ? 'status.storageSpaces' : kind === 'documents' ? 'status.storageDocuments' : 'status.storageState')
}

export function MnemonWorkbench(props: MnemonWorkbenchProps): JSX.Element {
  // A retained panel follows conversation context only while visible. Keeping the
  // last visible props also keeps Source drafts mounted during hidden A/B/A switches.
  const visibleProps = useRef(props)
  if (props.active !== false) visibleProps.current = props
  const t = props.t ?? translateZh
  return <I18nContext.Provider value={t}><LocaleContext.Provider value={props.locale ?? 'zh'}><MnemonWorkspace {...visibleProps.current} active={props.active ?? true} /></LocaleContext.Provider></I18nContext.Provider>
}

function MnemonWorkspace({ connection, settingsScope, sessionId, workspaceId, workspaceSelection, surface = 'sidebar', active = true, titleBar = false, onClose, configuration, componentChanges, sourcePageDirectory = EMPTY_SOURCE_PAGE_DIRECTORY, renderSlot, focus, hiddenSourceTypes, skillsScope }: MnemonWorkbenchProps): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const configurationSeat = configuration ?? NO_ACTION_SEAT
  const openConfiguration = useSyncExternalStore(configurationSeat.subscribe, configurationSeat.getSnapshot, configurationSeat.getSnapshot)
  const componentSignal = componentChanges ?? NO_CHANGE_SIGNAL
  const componentRevision = useSyncExternalStore(componentSignal.subscribe, componentSignal.getSnapshot, componentSignal.getSnapshot)
  const subscribeSettings = useCallback((listener: () => void) => settingsScope.subscribe(listener), [settingsScope])
  const getSettingsSnapshot = useCallback(() => settingsScope.getSnapshot(), [settingsScope])
  const liveSettingsSnapshot = useSyncExternalStore(subscribeSettings, getSettingsSnapshot, getSettingsSnapshot)
  const visibleSettings = useRef(liveSettingsSnapshot)
  if (active) visibleSettings.current = liveSettingsSnapshot
  const settingsSnapshot = visibleSettings.current
  const subscribeSourcePages = useCallback((listener: () => void) => sourcePageDirectory.subscribe(listener), [sourcePageDirectory])
  const getSourcePages = useCallback(() => sourcePageDirectory.getSnapshot(), [sourcePageDirectory])
  const allSourcePageEntries = useSyncExternalStore(subscribeSourcePages, getSourcePages, getSourcePages)
  const skillsSeat = skillsScope ?? NO_SKILLS_SCOPE
  const subscribeSkills = useCallback((listener: () => void) => skillsSeat.subscribe(listener), [skillsSeat])
  const getSkillsSnapshot = useCallback(() => skillsSeat.getSnapshot(), [skillsSeat])
  const skillsSnapshot = useSyncExternalStore(subscribeSkills, getSkillsSnapshot, getSkillsSnapshot)
  // The Source types this view shows: the focused one alone, or all but those with an entry of their own.
  const focusType = focus?.sourceTypeId
  const hiddenKey = hiddenSourceTypes?.join('\u0000') ?? ''
  const shows = useCallback((sourceTypeId: string): boolean => focusType !== undefined ? sourceTypeId === focusType : !hiddenKey.split('\u0000').includes(sourceTypeId), [focusType, hiddenKey])
  const sourcePageEntries = useMemo(() => allSourcePageEntries.filter(entry => shows(entry.sourceTypeId)), [allSourcePageEntries, shows])
  const client = useMemo(() => new MnemonClient(connection, sessionId, workspaceId), [connection, sessionId, workspaceId])
  const taskClient = useMemo(() => surface === 'builtin' ? client : new MnemonClient(connection, undefined, workspaceId), [client, connection, surface, workspaceId])
  const connectionContext = useRef({ connection, revision: 0 })
  if (connectionContext.current.connection !== connection) connectionContext.current = { connection, revision: connectionContext.current.revision + 1 }
  const clientContextKey = `${connectionContext.current.revision}\u0000${sessionId ?? ''}\u0000${workspaceId ?? ''}`
  // Pages remount only when they would show other data: another storage scope
  // or directory. Any other save re-reads in place and keeps page drafts.
  const storageContext = settingsSnapshot.revision === undefined ? 'loading'
    : JSON.stringify([settingsSnapshot.value?.storageScope ?? null, settingsSnapshot.value?.dataDir ?? null, settingsSnapshot.value?.runtimeUserScope ?? null])
  const viewContextKey = `${clientContextKey}\u0000${storageContext}`
  const workspaceToast = useToast()
  const showWorkspaceToast = workspaceToast.show
  const canvasRef = useRef<HTMLElement | null>(null)

  /** Pages share one plugin-owned scroll container; never mutate DSH ancestor scrollports. */
  const resetViewportScroll = useCallback(() => {
    const canvas = canvasRef.current
    if (canvas !== null) canvas.scrollTop = 0
  }, [])
  const revealElement = useCallback((element: HTMLElement, topInset?: number) => {
    const canvas = canvasRef.current
    if (canvas === null || !canvas.contains(element)) return
    // A locked page header covers the canvas top; a Source that pins its own header measures it.
    const header = topInset === undefined && canvas.hasAttribute('data-lock-page-header') ? canvas.querySelector<HTMLElement>(`.${css.pageHeader}`) : null
    const inset = topInset ?? (header === null ? 0 : header.getBoundingClientRect().height + 12)
    canvas.scrollTop = Math.max(0, canvas.scrollTop + element.getBoundingClientRect().top - canvas.getBoundingClientRect().top - inset)
  }, [])

  const { status, statusLoading, statusError, loadStatus } = useWorkspaceStatus(client, viewContextKey, active)
  const [revision, setRevision] = useState(0)
  const { sourceCatalogState, sourceCatalog, sourceInstances, sourceManagementClients, visibleSourcePages, managedSourceTypes: allManagedSourceTypes } = useSourceCatalog(client, taskClient, revision, viewContextKey, sourcePageEntries, active)
  const managedSourceTypes = useMemo(() => allManagedSourceTypes.filter(([sourceTypeId]) => shows(sourceTypeId)), [allManagedSourceTypes, shows])
  const [selectedSourceInstances, setSelectedSourceInstances] = useState<Record<string, string>>({})
  // Configured layers whose Source is not running: its component is off, or
  // nothing is composed. They keep a tab that says so instead of vanishing.
  const stoppedLayers = status?.memorySystem?.configuration.layers
  const stoppedTypes = useMemo(() => {
    if (sourceCatalog === null || stoppedLayers === undefined) return new Set<string>()
    const running = new Set(sourceInstances.map(source => source.sourceTypeId))
    return new Set(Object.keys(stoppedLayers).filter(id => !running.has(id) && shows(id)))
  }, [sourceCatalog, sourceInstances, stoppedLayers, shows])
  // The installed components name themselves: every name here comes from a
  // component's own declaration, the way the configuration shows it.
  const [dashboard, setDashboard] = useState<MemoryViewDashboard | null>(null)
  useEffect(() => {
    if (!active) return
    let current = true
    // Names are a courtesy: an unreadable dashboard leaves the pages' own labels.
    client.viewDashboard().then(value => { if (current) setDashboard(Array.isArray(value?.entries) ? value : null) }, () => { if (current) setDashboard(null) })
    return () => { current = false }
  }, [active, client, revision, componentRevision])
  const sourceName = useCallback((sourceTypeId: string, fallback?: string): string => {
    const component = dashboard === null ? undefined : sourceOf(dashboard, sourceTypeId)
    return component === undefined ? fallback ?? sourceTypeId : componentCopy(component, locale).label
  }, [dashboard, locale])
  const strategyName = (typeId: string): string => {
    const component = dashboard?.entries.find(entry => entry.roles.includes('strategy') && entry.typeId === typeId)
    return component === undefined ? typeId : componentCopy(component, locale).label
  }
  // A stopped layer whose Source component is switched off is off: the
  // configuration shows that component as the layer's own switch.
  const switchedOff = useMemo(() => new Set(dashboard === null ? [] : [...stoppedTypes].filter(id => sourceOf(dashboard, id)?.enabled === false)), [dashboard, stoppedTypes])
  // A focused view opens its Source's first page and stays there; anchors for other pages are another view's.
  const focusPage = focusType === undefined ? undefined : sourcePageEntries.find(entry => entry.navigation?.primary ?? true)
  const home: Page = focusPage === undefined ? 'status' : `source:${focusPage.id}`
  const accepts = useCallback((target: string): boolean => target === 'status' ? focusType === undefined : shows(target.split('/')[0]!), [focusType, shows])
  const { page, navigationInput, openTab, sourceNavigationEntries } = useWorkspaceNavigation({
    sessionId, viewContextKey, resetViewportScroll, sourceCatalog, sourcePageEntries, visibleSourcePages, managedSourceTypes, stoppedTypes, dashboard, sourceName, showWorkspaceToast, accepts, home,
  })
  // Runs after the catalog and component-name reads, so the three requests keep their order.
  useEffect(() => { if (active) void loadStatus() }, [active, loadStatus])

  const currentView = useRef({ active, client, viewContextKey })
  currentView.current = { active, client, viewContextKey }
  const isCurrentView = useCallback(() => currentView.current.active && currentView.current.client === client && currentView.current.viewContextKey === viewContextKey, [client, viewContextKey])
  const assertCurrentView = () => { if (!isCurrentView()) throw new Error('Source page is inactive or its view context changed') }
  const mutate = useCallback(() => { if (!isCurrentView()) return; setRevision(value => value + 1); void loadStatus() }, [isCurrentView, loadStatus])
  const refreshAll = mutate
  // The header's refresh also asks the open Source page to reload its data.
  const [refreshKey, setRefreshKey] = useState(0)
  const refreshPage = useCallback(() => { setRefreshKey(value => value + 1); refreshAll() }, [refreshAll])
  // The configuration lives on another page: re-read when the Sidebar
  // reopens the workspace and when a component is switched elsewhere. The
  // active-gated effects above refresh on reopening. A component switch or a
  // Provider saved under Plugins also reloads the open page, so Memory Spaces lists the Providers a new space can use, and so
  // does a sync, a merge, an import or an applied plan there, so the page
  // shows the memory it brought in.
  const seenComponents = useRef(componentRevision)
  useEffect(() => {
    if (!active || componentRevision === seenComponents.current) return
    seenComponents.current = componentRevision
    refreshPage()
  }, [active, componentRevision, refreshPage])
  // A save that keeps the storage re-reads in place; one that changes it
  // moves the context key, which reloads everything by itself.
  const seenSettings = useRef({ revision: settingsSnapshot.revision, context: viewContextKey })
  useEffect(() => {
    if (!active) return
    const seen = seenSettings.current
    seenSettings.current = { revision: settingsSnapshot.revision, context: viewContextKey }
    if (seen.revision !== settingsSnapshot.revision && seen.context === viewContextKey) refreshAll()
  }, [active, settingsSnapshot.revision, viewContextKey, refreshAll])
  const activationEnabled = status?.writeEnabled === true
  const writeEnabled = activationEnabled && settingsSnapshot.status === 'ready' && settingsSnapshot.writable
  // A remote page without the management grant says why it cannot write.
  const remoteReadOnly = activationEnabled && settingsSnapshot.status === 'ready' && !settingsSnapshot.writable && isRemoteConnection(connection)
  const workspaceContext = status?.workspaceContext
  const storageMode = workspaceContext?.mode ?? status?.storage?.activeKind ?? configuredStorageScope(settingsSnapshot.value)
  const storageModeText = storageScopeLabel(t, storageMode)
  const showWorkspacePicker = isWorkspaceStorageScope(storageMode) && workspaceSelection !== undefined && workspaceSelection.options.length > 0
  const workspaceDiverged = workspaceContext !== undefined && isWorkspaceStorageScope(workspaceContext.mode) && !workspaceContext.aligned
  const canAlignWorkspace = workspaceDiverged && workspaceSelection?.effectiveWorkspaceId !== undefined
  const workspaceDifference = workspaceContext === undefined
    ? ''
    : `${t('workspace.selectedRoot', { root: workspaceContext.selectedRoot })}; ${t('workspace.effectiveRoot', { root: workspaceContext.effectiveRoot })}`
  const workspacePicker = showWorkspacePicker && <SelectField inline size="sm" className={appearanceClass(css.workspacePicker, sidebarCss.workspacePicker)} label={t('workspace.viewing')} ariaLabel={t('workspace.selectorAria')} value={workspaceSelection.selectedWorkspaceId ?? ''} options={workspaceSelection.options.map(workspace => ({ value: workspace.id, label: workspace.title }))} onChange={workspaceSelection.onSelect} />
  // The saved settings answer at once; the status catches up after it reloads.
  const savedLayers = settingsSnapshot.value?.memoryTopology?.layers
  const configuredLayers = status?.memorySystem?.configuration.layers
  const disabledTypes = new Set([...new Set([...Object.keys(configuredLayers ?? {}), ...Object.keys(savedLayers ?? {})])]
    .filter(id => (savedLayers?.[id]?.enabled ?? configuredLayers?.[id]?.enabled) === false || switchedOff.has(id)))
  const notice = compositionNotice(status?.memorySystem, t)
  const memoryOff = status?.memorySystem !== undefined && !status.memorySystem.serving
  const composingType = status?.memorySystem?.serving === true ? status.memorySystem.strategyTypeId : undefined
  const composingLabel = composingType === undefined ? undefined : strategyName(composingType)
  const statusTone: StateDotState = status === null && statusLoading ? 'ongoing'
    : statusError !== null || notice?.tone === 'error' || status?.healthy === false && notice === undefined ? 'error'
      : notice !== undefined ? 'warning' : 'done'
  const connectionLabel = status === null && statusLoading
    ? t('header.checking')
    : notice?.tone === 'error'
      ? t('status.memoryOff')
      : status?.healthy !== true
        ? t('header.unavailable')
        : (t('header.connected'))
  const allInstancesFor = (sourceTypeId: string): MemorySourceManagementInstance[] => sourceInstances.filter(source => source.sourceTypeId === sourceTypeId)
  const instancesFor = (sourceTypeId: string): MemorySourceManagementInstance[] => allInstancesFor(sourceTypeId)
  const renderSourceContribution = (entryId: string): ReactNode => {
    const sourceTypeId = entryId.split('/')[0]!
    const instances = instancesFor(sourceTypeId)
    const selectedKey = selectedSourceInstances[sourceTypeId]
    const selected = instances.find(instance => instance.sourceInstanceKey === selectedKey) ?? instances.find(instance => isDefaultSourceInstance(instance.sourceInstanceKey, sourceTypeId)) ?? instances[0]
    if (selected === undefined || renderSlot === undefined) return null
    if (disabledTypes.has(sourceTypeId)) return <SourceDisabledPage title={sourceName(sourceTypeId, selected.management.label)} onOpenConfiguration={openConfiguration} />
    const management = sourceManagementClients.get(selected.sourceInstanceKey)
    const skillsPreferences = sourceTypeId !== SKILLS_SOURCE_TYPE || skillsScope === undefined || skillsSnapshot.status !== 'ready' ? undefined : {
      value: { evolution: skillsSnapshot.value?.evolution ?? DEFAULT_SKILLS_CONFIG.evolution } as JsonValue,
      writable: skillsSnapshot.writable,
      replace: async (value: JsonValue) => {
        assertCurrentView()
        const evolution = jsonRecord(value)?.evolution
        if (typeof evolution !== 'boolean') throw new Error('Skills preferences take evolution as a boolean')
        await skillsScope.mutate([{ op: 'set', path: ['evolution'], value: evolution }])
      },
    }
    const openSettings = openConfiguration === undefined ? undefined : () => { requestComponentPage(selected.packageName); openConfiguration() }
    const preferences = skillsPreferences ?? (!isDefaultSourceInstance(selected.sourceInstanceKey, 'memory-spaces') ? undefined : {
      value: JSON.parse(JSON.stringify({ persistenceStrategy: { ...settingsSnapshot.value?.persistenceStrategy, providerConnections: {} } })) as JsonValue,
      writable: settingsSnapshot.writable,
      replace: async (value: JsonValue) => {
        assertCurrentView()
        const requested = jsonRecord(value)?.persistenceStrategy
        const strategy = requested === undefined ? undefined : jsonRecord(requested)
        if (strategy === undefined) throw new Error('Persistence strategy preferences must be an object')
        const connections = jsonRecord(strategy.providerConnections ?? {}) ?? {}
        const merged = { ...settingsSnapshot.value?.persistenceStrategy?.providerConnections }
        for (const [id, fields] of Object.entries(connections)) merged[id] = { ...merged[id], ...jsonRecord(fields) } as NonNullable<typeof merged[string]>
        await settingsScope.mutate([{ op: 'set', path: ['persistenceStrategy'], value: { ...strategy, providerConnections: merged } }])
      },
    })
    return renderSlot(MNEMON_SOURCE_PAGE_SLOT, {
      sourceTypeId, sourceInstanceKey: selected.sourceInstanceKey, sourceInstances: instances, writable: writeEnabled, locale, active,
      ...(management === undefined ? {} : { management }),
      ...(sessionId === undefined ? {} : { sessionId }), ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(navigationInput?.page === entryId ? { navigationInput: navigationInput.value } : {}),
      ...(preferences === undefined ? {} : { preferences }), onRefresh: mutate, refreshKey, onResetScroll: resetViewportScroll, onRevealElement: revealElement,
      ...(onClose === undefined ? {} : { onReturnToConversation: onClose }),
      ...(openSettings === undefined ? {} : { onOpenSettings: openSettings }),
      ...(focusType === undefined ? {} : { standalone: true }),
    }, { only: entryId })
  }
  const activeStoppedType = stoppedSourceTypeId(page)
  const stoppedTitle = (sourceTypeId: string): string => sourceName(sourceTypeId, sourceNavigationEntries.find(entry => entry.page === page)?.label)
  const layerState = (sourceTypeId: string): LayerState => disabledTypes.has(sourceTypeId) ? 'off'
    : !stoppedTypes.has(sourceTypeId) ? 'on' : memoryOff ? 'memory-off' : 'stopped'
  const layerIds = Object.keys(status?.memorySystem?.configuration.layers ?? {})
  const headerLayers = layerIds.map(id => ({ id, label: sourceName(id), state: layerState(id) }))
  // Every Source component has a card, in the order the configuration lists its layer; a
  // component that is off and registered nothing still has one. Without the components,
  // the configured layers stand in.
  const sourceComponents = (dashboard?.entries ?? []).filter(entry => entry.roles.includes('source'))
  const rank = (entry: MemoryPluginEntryView): number => { const index = layerIds.indexOf(layerOf(entry) ?? ''); return index < 0 ? layerIds.length : index }
  const componentCards: ComponentCard[] = dashboard === null
    ? layerIds.map(id => ({ key: id, packageName: 'dsh-mnemon-source-' + id, label: sourceName(id), enabled: layerState(id) !== 'off', state: layerState(id) }))
    : [...sourceComponents].sort((left, right) => rank(left) - rank(right)).map(entry => {
      const layerId = layerOf(entry)
      return { key: entry.entryId, packageName: entry.packageName, label: componentCopy(entry, locale).label, enabled: entry.enabled,
        state: !entry.enabled ? 'off' : layerId === undefined ? (memoryOff ? 'memory-off' : 'stopped') : layerState(layerId) }
    })
  const renderCard = (card: ComponentCard): ReactNode => renderSlot === undefined ? <strong>{t('board.running')}</strong> : renderSlot(MNEMON_COMPONENT_STATUS_SLOT, {
    component: { packageName: card.packageName, label: card.label, enabled: card.enabled }, language: locale,
    ...(sessionId === undefined ? {} : { sessionId }), ...(workspaceId === undefined ? {} : { workspace: { id: workspaceId } }),
  }, { entryKey: card.packageName, fallback: <strong>{t('board.running')}</strong> })
  const areaName = (kind: StorageAreaInventory['kind']): string => {
    const sourceTypeId = AREA_SOURCES[kind]
    return sourceTypeId === undefined ? storageAreaLabel(t, kind) : sourceName(sourceTypeId, storageAreaLabel(t, kind))
  }
  const activeSourcePageId = sourcePageEntryId(page)
  const activeSourcePage = activeSourcePageId === undefined ? undefined : visibleSourcePages.find(entry => entry.id === activeSourcePageId)
  const activeSourceInstances = activeSourcePage === undefined ? [] : instancesFor(activeSourcePage.sourceTypeId)
  const activeSelectedKey = activeSourcePage === undefined ? undefined : selectedSourceInstances[activeSourcePage.sourceTypeId]
  const activeSelectedInstance = activeSourceInstances.find(instance => instance.sourceInstanceKey === activeSelectedKey) ?? activeSourceInstances.find(instance => isDefaultSourceInstance(instance.sourceInstanceKey, activeSourcePage?.sourceTypeId ?? '')) ?? activeSourceInstances[0]
  const customSourcePage = activeSourcePage === undefined || activeSelectedInstance === undefined ? null : <div className={css.page} data-source-page={activeSourcePage.id}>
    {activeSourceInstances.length > 1 && <SelectField inline size="sm" className={css.workspacePicker} label={t('sourcePage.instance')} ariaLabel={t('sourcePage.instanceAria')} value={activeSelectedInstance.sourceInstanceKey} options={activeSourceInstances.map(instance => ({ value: instance.sourceInstanceKey, label: instance.management.label, detail: instance.sourceInstanceKey }))} onChange={value => setSelectedSourceInstances(current => ({ ...current, [activeSourcePage.sourceTypeId]: value }))} />}
    {renderSourceContribution(activeSourcePage.id)}
  </div>
  const activeManagedSourceTypeId = managedSourceTypeId(page)
  const activeManagedSourceInstances = activeManagedSourceTypeId === undefined ? [] : allInstancesFor(activeManagedSourceTypeId)
  const activeManagedSelectedKey = activeManagedSourceTypeId === undefined ? undefined : selectedSourceInstances[activeManagedSourceTypeId]
  const activeManagedSourceInstance = activeManagedSourceInstances.find(instance => instance.sourceInstanceKey === activeManagedSelectedKey) ?? activeManagedSourceInstances[0]
  const managedSourcePageContent = activeManagedSourceTypeId === undefined || activeManagedSourceInstance === undefined ? null : <SourceManagementPage
    instance={activeManagedSourceInstance}
    instances={activeManagedSourceInstances}
    {...(sourceManagementClients.get(activeManagedSourceInstance.sourceInstanceKey) === undefined ? {} : { management: sourceManagementClients.get(activeManagedSourceInstance.sourceInstanceKey)! })}
    onSelect={sourceInstanceKey => setSelectedSourceInstances(current => ({ ...current, [activeManagedSourceTypeId]: sourceInstanceKey }))}
    onMutate={mutate}
  />

  // A focused view's gear opens its own component's settings rather than the whole configuration.
  const focusPackage = focusType === undefined ? undefined : sourceInstances.find(source => source.sourceTypeId === focusType)?.packageName
  const openSettings = openConfiguration === undefined ? undefined
    : focusPackage === undefined ? (focusType === undefined ? openConfiguration : undefined)
      : () => { requestComponentPage(focusPackage); openConfiguration() }
  const focused = focusType !== undefined
  return (
    <main className={appearanceClass(css.shell, sidebarCss.shell)} data-dsh-plugin="dsh-mnemon" data-dsh-part="mnemon-view" data-mnemon-surface={surface} data-mnemon-focus={focusType}>
      <header className={appearanceClass(css.masthead, sidebarCss.masthead)} data-window-drag={titleBar || undefined}>
        {onClose !== undefined && <button type="button" className={appearanceClass(css.ghostButton, css.backButton)} onClick={onClose} aria-label={t('header.backToConversation')}><IconChevronLeftOutline14 size={14} /><span>{t('header.backToConversation')}</span></button>}
        <div className={appearanceClass(css.brand, sidebarCss.brand)}>
          <h1>{focus?.title ?? t('tab.label')}</h1>
          {surface === 'sidebar' && <>
            <span className={css.storageMode} aria-label={t('workspace.storageModeAria', { mode: storageModeText })}><span>{t('workspace.storageMode')}</span><strong>{storageModeText}</strong></span>
            {workspacePicker}
            {canAlignWorkspace && <div className={appearanceClass(css.workspaceMismatch, sidebarCss.workspaceMismatch)} role="status" aria-label={`${t('workspace.mismatchTitle')}. ${workspaceDifference}`} title={workspaceDifference}><span>{t('workspace.mismatchShort')}</span><button type="button" onClick={workspaceSelection.onAlign}>{t('workspace.align')}</button></div>}
          </>}
        </div>
        <div className={appearanceClass(css.headerActions, sidebarCss.headerActions)}><div className={appearanceClass(css.statusCluster, sidebarCss.statusCluster)}>{!focused && <CompositionStatus tone={statusTone} label={connectionLabel} strategy={composingLabel} layers={headerLayers} onOpen={openConfiguration} />}<button type="button" className={css.iconButton} disabled={statusLoading} onClick={refreshPage} aria-label={t('common.refresh')} title={t('common.refresh')}><IconRefreshOutlineRegular size={16} /></button></div>{openSettings !== undefined && <button type="button" className={css.iconButton} onClick={openSettings} aria-label={t('header.configure')} title={t('header.configure')}><IconSettingsOutlineRegular size={16} /></button>}</div>
      </header>
      {sourceCatalogState.contextKey === viewContextKey && sourceCatalogState.error !== null && <div className={css.alert} role="alert">{sourceCatalogState.error}</div>}
      {(statusError !== null || status?.healthy === false && notice === undefined) && <div className={css.alert} role="alert"><strong>{t('header.notReady')}</strong><span>{statusError ?? status?.error}</span></div>}
      <Reveal className={css.notice}>{!focused && statusError === null && notice !== undefined && <Callout tone={notice.tone === 'error' ? 'error' : 'warning'} title={notice.title}
        actions={openConfiguration === undefined ? undefined : <Button variant="outline" size="sm" onClick={openConfiguration}>{t('common.openConfiguration')}</Button>}>
        {notice.detail}
      </Callout>}</Reveal>
      <Reveal className={css.notice}>{status?.restartPending !== undefined && <RestartReminder pending={status.restartPending} />}</Reveal>
      {workspaceToast.element}
      {remoteReadOnly && <div className={css.alert} role="status">{t('workspace.remoteReadOnly')}</div>}
      {!focused && status?.lifecycle?.current?.idleReviewBlocked === 'agent-team' && <div className={css.alert} role="status">{t('status.reviewTeamPaused')}</div>}
      {!focused && status?.lifecycle?.current?.lastError !== undefined && <div className={css.alert} role="alert" aria-label={t('status.reviewFailed')}>
        <strong>{t('status.reviewFailed')}</strong>
        <span>{status.lifecycle.current.lastError}</span>
        <span>{t('status.reviewFailedDetail')}</span>
        {status.lifecycle.current.lastReviewFailure?.status === 'partial' && <>
          <strong>{t('status.reviewPartial')}</strong>
          <span>{t('status.reviewRun', { id: status.lifecycle.current.lastReviewFailure.runId ?? '' })}</span>
          <ul>{status.lifecycle.current.lastReviewFailure.receipts.map((receipt, index) => <li key={index}>{[receipt.tool, receipt.action, receipt.documentId, receipt.target, receipt.revision].filter(Boolean).join(' · ')}</li>)}</ul>
        </>}
        {/CONTEXT_WINDOW_EXCEEDED|exceed(?:s|ed)? (?:the )?(?:available )?context (?:size|window)/iu.test(status.lifecycle.current.lastError) && <span>{t('status.reviewContextWindow')}</span>}
      </div>}
      <div className={css.workspace}>
        {!focused && <WorkspaceNavigation page={page} onSelect={openTab} sourcePages={sourceNavigationEntries} disabledTypes={disabledTypes} memoryOff={memoryOff} />}
        <section key={viewContextKey} className={appearanceClass(css.canvas, sidebarCss.canvas)} ref={canvasRef} data-testid="mnemon-canvas" data-lock-page-header={(activeSourcePage?.navigation?.stickyHeader !== false) ? '' : undefined}>
          {page === 'status' && !focused && <WorkbenchStatusContext.Provider value={status}>
            <StatusPage client={client} status={status} loading={statusLoading} writeEnabled={writeEnabled} attention={notice !== undefined}
              components={componentCards} renderCard={renderCard} areaName={areaName} onRefresh={() => void loadStatus()} onOpenConfiguration={openConfiguration} />
          </WorkbenchStatusContext.Provider>}
          {activeManagedSourceInstance !== undefined && managedSourcePageContent}
          {activeSourcePage !== undefined && customSourcePage}
          {activeStoppedType !== undefined && (disabledTypes.has(activeStoppedType)
            ? <SourceDisabledPage title={stoppedTitle(activeStoppedType)} onOpenConfiguration={openConfiguration} />
            : <SourceStoppedPage title={stoppedTitle(activeStoppedType)} memoryOff={memoryOff} onOpenConfiguration={openConfiguration} />)}
        </section>

      </div>
    </main>
  )
}
