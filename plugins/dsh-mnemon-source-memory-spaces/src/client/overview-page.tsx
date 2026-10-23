import { css, sidebarCss, useT } from './presentation.ts'
import type { JSX } from 'react'
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { MEMORY_SPACE_DESCRIPTION_MAX_LENGTH, MEMORY_SPACE_NAME_MAX_LENGTH, NATIVE_PROVIDER_ID, type MemorySpaceCatalog, type MemorySpaceMetadataUpdate, type MemorySpaceRediscovery, type MemorySpaceView, type MemorySpaceWritePolicy, type MemoryGraphNode, type MemoryGraphSnapshot, type MemoryProviderConnection, type MemoryProviderId } from '../contracts.ts'
import type { MemorySpacesPageClient } from './api.ts'
import { ProviderIcon } from './ProviderIcon.tsx'
import { providerSummary } from './provider-presentation.ts'
import { appearanceClass, useLocale, humanBytes, message, PageHeader, SidebarModal, EmptyState } from 'dsh-mnemon/client'
import { MemoryProviderBadge, ProviderMemoryFields, ReadSourcePanel, categoryLabel, mergeProviderDefaults, nativeSpaceProvider, providerDraftComplete, providerUnavailableKey, readyFirst, readyProviderId, type ProviderDrafts } from './widgets.tsx'
import { MemoryGraph, enrichMultiSpaceGraph, graphKindLabel, graphNodeKey, graphNodeKind } from './memory-graph.tsx'

/** Full-text popup for a selected graph node whose inspector preview is clamped. */
function ContentPreview(props: { node: MemoryGraphNode; kind: string; onClose: () => void }): JSX.Element {
  const t = useT()
  const meta = [props.kind, props.node.id, props.node.memoryBodyName].filter((entry): entry is string => entry !== undefined).join(' · ')
  return (
    <SidebarModal title={t('overview.previewTitle')} description={meta} onClose={props.onClose}>
      <p className={css.previewContent}>{props.node.content}</p>
    </SidebarModal>
  )
}

export function OverviewPage(props: { client: MemorySpacesPageClient; metadataClient: MemorySpacesPageClient; revision: number; reloadKey?: number; activationEnabled: boolean; writeEnabled: boolean; agentAvailable: boolean; fallbackBodies: MemorySpaceView[]; fallbackDirectory: string | undefined; catalogKnown: boolean; onMutate: () => void; onAgentRefresh: () => void; onBodyReconnect: (body: MemorySpaceView) => void; onBodyMetadata: (updates: readonly MemorySpaceMetadataUpdate[]) => void; onExplore: (query: string) => void }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const spaceCreateFormId = useId()
  const spaceEditFormId = useId()
  const [graph, setGraph] = useState<MemoryGraphSnapshot | null>(null)
  const [catalog, setCatalog] = useState<MemorySpaceCatalog | null>(null)
  const [selected, setSelected] = useState<MemoryGraphNode | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [healthLoading, setHealthLoading] = useState(true)
  const [graphLoading, setGraphLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [changing, setChanging] = useState<string | null>(null)
  const [reconnectingSpace, setReconnectingSpace] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [creatingSpaceOpen, setCreatingSpaceOpen] = useState(false)
  const [spaceName, setSpaceName] = useState('')
  const [spaceDescription, setSpaceDescription] = useState('')
  const [spaceProviderId, setSpaceProviderId] = useState<MemoryProviderId>(NATIVE_PROVIDER_ID)
  const [providerDrafts, setProviderDrafts] = useState<ProviderDrafts>({})
  const [catalogUnavailable, setCatalogUnavailable] = useState(false)
  const [editingSpace, setEditingSpace] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editConnection, setEditConnection] = useState<MemoryProviderConnection>({})
  const [editClearSecrets, setEditClearSecrets] = useState<string[]>([])
  const [editWritePolicy, setEditWritePolicy] = useState<MemorySpaceWritePolicy>('writable')
  const [savingSpace, setSavingSpace] = useState<string | null>(null)
  const [confirmingDeleteSpace, setConfirmingDeleteSpace] = useState<string | null>(null)
  const [deletingSpace, setDeletingSpace] = useState<string | null>(null)
  const [preview, setPreview] = useState<MemoryGraphNode | null>(null)
  const [metadataOpen, setMetadataOpen] = useState(false)
  const [metadataSelection, setMetadataSelection] = useState<string[]>([])
  const [metadataTasks, setMetadataTasks] = useState<Record<string, { status: 'running' | 'success' | 'error'; error?: string }>>({})
  const [lastFullSyncAt, setLastFullSyncAt] = useState<number | null>(null)
  const [rediscovering, setRediscovering] = useState(false)
  const [pageRediscovery, setPageRediscovery] = useState<MemorySpaceRediscovery | null>(null)
  const [seenRediscovery, setSeenRediscovery] = useState<string | null>(readSeenRediscovery)
  const [syncClock, setSyncClock] = useState(() => Date.now())
  const loadRequest = useRef(0)
  const initialSyncStarted = useRef(false)
  const directoryRetryStarted = useRef(false)
  const fullSyncObserved = useRef(true)
  const load = useCallback(async (quiet = false) => {
    const request = ++loadRequest.current
    setCatalogLoading(true)
    setHealthLoading(true)
    setGraphLoading(true)
    setError(null)
    let directoryUnavailable = false
    try {
      // Render the control-plane directory first. Health and graph I/O then
      // resolve independently without holding the cards or each other back.
      const nextCatalog = await props.client.bodyDirectory().then(next => { setCatalogUnavailable(false); return next }).catch(() => {
        directoryUnavailable = true
        setCatalogUnavailable(!props.catalogKnown)
        return {
          items: props.fallbackBodies,
          providers: [],
          total: props.fallbackBodies.length,
          activeCount: props.fallbackBodies.filter(body => body.active).length,
          directory: props.fallbackDirectory ?? '',
          generatedAt: new Date().toISOString(),
        }
      })
      if (request !== loadRequest.current) return
      setProviderDrafts(current => mergeProviderDefaults(nextCatalog.providers, current))
      setCatalog(nextCatalog)
      setCatalogLoading(false)
      void props.client.bodies().then(next => {
        if (request !== loadRequest.current) return
        setCatalog(next)
      }).catch(reason => {
        if (request === loadRequest.current && !quiet && !directoryUnavailable) setError(message(reason))
      }).finally(() => { if (request === loadRequest.current) setHealthLoading(false) })
      void props.client.graph().then(next => {
        if (request !== loadRequest.current) return
        const enriched = enrichMultiSpaceGraph(next, nextCatalog.items)
        setGraph(enriched)
        setSelected(current => current === null ? null : enriched.nodes.find(node => graphNodeKey(node) === graphNodeKey(current)) ?? null)
      }).catch(reason => {
        if (request === loadRequest.current && !directoryUnavailable) setError(message(reason))
      }).finally(() => { if (request === loadRequest.current) setGraphLoading(false) })
    } catch (reason) {
      if (request === loadRequest.current) {
        setError(message(reason))
        setCatalogLoading(false)
        setHealthLoading(false)
        setGraphLoading(false)
      }
    }
  }, [props.catalogKnown, props.client, props.fallbackBodies, props.fallbackDirectory])

  useEffect(() => {
    if (initialSyncStarted.current) return
    initialSyncStarted.current = true
    void load()
  }, [load])
  // The workspace's refresh reloads the whole directory quietly.
  const seenReload = useRef(props.reloadKey)
  useEffect(() => {
    if (seenReload.current === props.reloadKey) return
    seenReload.current = props.reloadKey
    void load(true)
  }, [load, props.reloadKey])
  useEffect(() => {
    if (!catalogUnavailable || !props.catalogKnown || directoryRetryStarted.current) return
    directoryRetryStarted.current = true
    void load(true)
  }, [catalogUnavailable, load, props.catalogKnown])
  useEffect(() => {
    const timer = window.setInterval(() => setSyncClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])
  // A new space starts with a provider that can take it now.
  useEffect(() => { setSpaceProviderId(current => readyProviderId(catalog?.providers ?? [], current) ?? current) }, [catalog])
  // A pass the Host started while this page is open: read the directory again until it ends, then
  // show what it found. The read also brings the Source's new revision, so the switches keep working.
  const hostRediscovering = catalog?.rediscovery?.running === true && !rediscovering
  useEffect(() => {
    if (!hostRediscovering) return
    let active = true
    const timer = window.setInterval(() => {
      void props.client.bodyDirectory().then(next => {
        if (!active || next.rediscovery?.running === true) return
        active = false
        window.clearInterval(timer)
        void load(true)
        if (next.rediscovery?.last?.results.some(result => result.added.length > 0)) props.onMutate()
      }).catch(() => {})
    }, REDISCOVERY_POLL_MS)
    return () => { active = false; window.clearInterval(timer) }
  }, [hostRediscovering, load, props.client, props.onMutate])

  const toggle = async (body: MemorySpaceView) => {
    setChanging(body.id); setError(null)
    try {
      await props.client.updateBody(body.id, { active: !body.active })
      await load(true)
      props.onMutate()
    } catch (reason) { setError(message(reason)) } finally { setChanging(null) }
  }

  const reconnect = async (body: MemorySpaceView) => {
    if (reconnectingSpace !== null || editingSpace !== null || deletingSpace !== null) return
    setReconnectingSpace(body.id); setError(null)
    setCatalog(current => current === null ? current : {
      ...current,
      items: current.items.map(item => item.id === body.id ? { ...item, statusLoading: true } : item),
    })
    try {
      const next = await props.client.reconnectBody(body.id)
      setCatalog(current => current === null ? current : {
        ...current,
        items: current.items.map(item => item.id === next.id ? next : item),
      })
      props.onBodyReconnect(next)
    } catch (reason) {
      const failure = message(reason)
      setCatalog(current => current === null ? current : {
        ...current,
        items: current.items.map(item => item.id === body.id ? { ...item, healthy: false, statusLoading: false, error: failure } : item),
      })
      setError(failure)
    } finally {
      setReconnectingSpace(null)
    }
  }

  const beginEdit = (body: MemorySpaceView) => {
    setEditingSpace(body.id); setEditName(body.name); setEditDescription(body.description ?? ''); setError(null)
    setEditConnection(nativeSpaceProvider(body.provider) ? {} : { ...body.provider.settings })
    setEditClearSecrets([])
    setEditWritePolicy(body.writePolicy ?? 'writable')
  }

  const saveEdit = async (event: FormEvent, body: MemorySpaceView) => {
    event.preventDefault()
    if (editName.trim() === '') return
    setSavingSpace(body.id); setError(null)
    try {
      const descriptor = catalog?.providers.find(provider => provider.id === body.provider.id)
      const connection = descriptor === undefined ? {} : Object.fromEntries(Object.entries(editConnection).filter(([key, value]) => {
        const field = descriptor.fields.find(candidate => candidate.key === key)
        return field?.input !== 'secret' || String(value) !== ''
      }))
      const updated = await props.client.updateBody(body.id, {
        name: editName,
        description: editDescription,
        ...(nativeSpaceProvider(body.provider) ? {} : { connection, ...(editClearSecrets.length === 0 ? {} : { clearSecrets: editClearSecrets }) }),
      })
      // The choice is for the namespace the space reads once its settings are saved (#434).
      if (props.client.setWritePolicy !== undefined && (updated?.writePolicy ?? 'writable') !== editWritePolicy) await props.client.setWritePolicy(body.id, editWritePolicy)
      setEditingSpace(null)
      await load(true)
      props.onMutate()
    } catch (reason) { setError(message(reason)) } finally { setSavingSpace(null) }
  }

  const create = async (event: FormEvent) => {
    event.preventDefault()
    const providers = catalog?.providers ?? []
    const manualProvider = providers.find(provider => provider.id === spaceProviderId)
    if (spaceName.trim() === '' || spaceDescription.trim() === '' || !providerDraftComplete(manualProvider, providerDrafts[spaceProviderId])) return
    setCreating(true); setError(null)
    try {
      await props.client.createBody({
        name: spaceName,
        description: spaceDescription,
        providerId: spaceProviderId,
        ...(manualProvider?.origin === 'native' ? {} : { connection: providerDrafts[spaceProviderId] ?? {} }),
      })
      setSpaceName(''); setSpaceDescription(''); setSpaceProviderId(current => readyProviderId(providers) ?? current)
      setProviderDrafts(current => Object.fromEntries(providers.map(provider => [provider.id, Object.fromEntries(Object.entries(current[provider.id] ?? {}).map(([key, value]) => [key, provider.fields.some(field => field.key === key && field.input === 'secret') ? '' : value]))])))
      setCreatingSpaceOpen(false)
      await load(true)
      props.onMutate()
    } catch (reason) { setError(message(reason)) } finally { setCreating(false) }
  }

  // Providers are asked again for namespaces they gained; the new spaces start inactive (#373).
  const rediscover = async () => {
    if (props.client.rediscoverBodies === undefined || rediscovering) return
    setRediscovering(true); setError(null)
    try {
      const outcome = await props.client.rediscoverBodies()
      setPageRediscovery(outcome)
      await load(true)
      if (outcome.results.some(result => result.added.length > 0)) props.onMutate()
    } catch (reason) { setError(message(reason)) } finally { setRediscovering(false) }
  }
  const dismissRediscovery = (at: string) => {
    setSeenRediscovery(at)
    writeSeenRediscovery(at)
  }

  const deleteBody = async (body: MemorySpaceView) => {
    setDeletingSpace(body.id); setError(null)
    try {
      await props.client.deleteBody(body.id)
      setConfirmingDeleteSpace(null)
      await load(true)
      props.onMutate()
    } catch (reason) { setError(message(reason)) } finally { setDeletingSpace(null) }
  }

  const maintainMetadata = () => {
    if (metadataSelection.length === 0) return
    const selectedIds = metadataSelection.filter(id => metadataTasks[id]?.status !== 'running')
    if (selectedIds.length === 0) return
    setError(null)
    setMetadataSelection([])
    setMetadataTasks(current => ({
      ...current,
      ...Object.fromEntries(selectedIds.map(id => [id, { status: 'running' as const }])),
    }))
    for (const id of selectedIds) {
      void props.metadataClient.maintainBodyMetadata([id]).then(result => {
        const update = result.updates.find(candidate => candidate.memoryBodyId === id)
        if (update === undefined) throw new Error(`metadata task Agent omitted Memory Space ${id}`)
        setCatalog(current => current === null ? current : {
          ...current,
          items: current.items.map(body => body.id === id ? { ...body, name: update.title, description: update.description } : body),
        })
        props.onBodyMetadata([update])
        setMetadataTasks(current => ({ ...current, [id]: { status: 'success' } }))
      }).catch(reason => {
        setMetadataTasks(current => ({ ...current, [id]: { status: 'error', error: message(reason) } }))
      })
    }
  }

  const generated = graph === null ? t('overview.waitingSnapshot') : t('overview.updatedAt', { time: new Date(graph.generatedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })
  const graphSpaces = graph?.nodes.filter(node => graphNodeKind(node) === 'space').length ?? 0
  const graphEntities = graph?.nodes.filter(node => graphNodeKind(node) === 'entity').length ?? 0
  const graphMemories = graph?.nodes.filter(node => graphNodeKind(node) === 'memory').length ?? 0
  const graphSources = graph?.sources ?? []
  const onlyQueryOrUnsupported = graphSources.length > 0 && graphSources.every(source => source.mode === 'query-only' || source.mode === 'unsupported' || source.status === 'unavailable')
  const selectedKind = selected === null ? null : graphNodeKind(selected)
  const editingSpaceView = editingSpace === null ? undefined : catalog?.items.find(body => body.id === editingSpace)
  const deletingSpaceView = confirmingDeleteSpace === null ? undefined : catalog?.items.find(body => body.id === confirmingDeleteSpace)
  const providers = catalog?.providers ?? []
  // The status summary already carries the non-blocking control-plane
  // directory. Keep metadata maintenance usable while the richer Memory page
  // health/graph requests are still resolving.
  const metadataCandidates = (catalog?.items ?? props.fallbackBodies).filter(body => body.active && body.providerEnabled !== false)
  const metadataRunningCount = Object.values(metadataTasks).filter(task => task.status === 'running').length
  const metadataBusy = metadataRunningCount > 0
  const metadataSelectable = metadataCandidates.filter(body => metadataTasks[body.id]?.status !== 'running')
  const metadataAllSelected = metadataSelectable.length > 0 && metadataSelectable.every(body => metadataSelection.includes(body.id))
  const loading = catalogLoading || healthLoading || graphLoading
  useEffect(() => {
    if (loading) {
      fullSyncObserved.current = true
      return
    }
    if (!fullSyncObserved.current) return
    fullSyncObserved.current = false
    if (error !== null) return
    const completedAt = Date.now()
    setLastFullSyncAt(completedAt)
    setSyncClock(completedAt)
  }, [error, loading])
  const fullSyncAge = lastFullSyncAt === null
    ? t('overview.fullSyncPending')
    : (() => {
        const seconds = Math.max(0, Math.floor((syncClock - lastFullSyncAt) / 1_000))
        if (seconds < 5) return t('overview.fullSyncJustNow')
        if (seconds < 60) return t('overview.fullSyncSeconds', { count: seconds })
        const minutes = Math.floor(seconds / 60)
        if (minutes < 60) return t('overview.fullSyncMinutes', { count: minutes })
        const hours = Math.floor(minutes / 60)
        if (hours < 24) return t('overview.fullSyncHours', { count: hours })
        return t('overview.fullSyncDays', { count: Math.floor(hours / 24) })
      })()
  const selectedProvider = providers.find(provider => provider.id === spaceProviderId)
  // The latest pass: one started here answers even when it found nothing; one from start-up
  // speaks only when it has news.
  const directoryRediscovery = catalog?.rediscovery?.last ?? null
  const rediscovery = pageRediscovery !== null && (directoryRediscovery === null || pageRediscovery.at >= directoryRediscovery.at) ? pageRediscovery : directoryRediscovery
  const rediscoveryAdded = rediscovery?.results.flatMap(result => result.added) ?? []
  const rediscoveryDisconnected = rediscovery?.results.reduce((sum, result) => sum + result.disconnected, 0) ?? 0
  const rediscoveryFailures = rediscovery?.results.filter(result => result.error !== undefined) ?? []
  const rediscoveryShown = rediscovery !== null && rediscovery.at !== seenRediscovery
    && (rediscovery === pageRediscovery || rediscoveryAdded.length > 0 || rediscoveryFailures.length > 0)
  const newSpaceIds = new Set(rediscoveryShown ? rediscoveryAdded.map(body => body.id) : [])
  const canRediscover = props.writeEnabled && !catalogUnavailable && props.client.rediscoverBodies !== undefined
    && providers.some(provider => provider.origin !== 'native' && provider.serviceConfigured === true)
  const rediscoveryRunning = rediscovering || catalog?.rediscovery?.running === true
  const nativeSpaceCount = catalog?.items.filter(body => nativeSpaceProvider(body.provider)).length ?? 0
  // Deleting a Mnemon Native space removes its Store, which a read-only space keeps (#434).
  const deleteBlocked = (body: MemorySpaceView): string | undefined => !nativeSpaceProvider(body.provider) ? undefined
    : nativeSpaceCount <= 1 ? t('overview.lastStoreDeleteHint') : body.writePolicy === 'read-only' ? t('overview.readOnlyDeleteHint') : undefined
  const canDeleteSpace = (body: MemorySpaceView): boolean => deleteBlocked(body) === undefined
  const updateProviderDraft = (providerId: MemoryProviderId, key: string, value: string | number | boolean) => setProviderDrafts(current => ({ ...current, [providerId]: { ...(current[providerId] ?? {}), [key]: value } }))
  const placementReceipt = (body: MemorySpaceView) => body.placement === undefined ? null : <div className={css.placementReceipt} title={body.placement.reason}><span aria-hidden="true">✦</span><div><strong>{t(body.placement.decidedBy === 'llm' ? 'overview.placementByLlm' : 'overview.placementByRules')}</strong><small>{t('overview.placementConfidence', { confidence: t(`overview.confidence.${body.placement.confidence}`) })}</small><p>{body.placement.reason}</p></div></div>
  const spaceEditForm = (body: MemorySpaceView) => <form id={spaceEditFormId} className={css.bodyEdit} onSubmit={event => void saveEdit(event, body)}>
    <label>{t('overview.editName')}<input aria-label={t('overview.editName')} value={editName} onChange={event => setEditName(event.target.value)} maxLength={MEMORY_SPACE_NAME_MAX_LENGTH} required /></label>
    <label>{t('overview.editDescription')}<textarea aria-label={t('overview.editDescription')} value={editDescription} onChange={event => setEditDescription(event.target.value)} rows={4} maxLength={MEMORY_SPACE_DESCRIPTION_MAX_LENGTH} /></label>
    {props.client.setWritePolicy !== undefined && (body.provider.capabilities.remember || body.writePolicy === 'read-only') && <fieldset className={css.writePolicy}><legend>{t('overview.writePolicy')}</legend>
      <label data-selected={editWritePolicy === 'writable' || undefined}><input type="radio" name="memory-space-write-policy" value="writable" checked={editWritePolicy === 'writable'} onChange={() => setEditWritePolicy('writable')} /><i className={css.choiceControl} data-kind="radio" aria-hidden="true" /><span><strong>{t('overview.writable')}</strong><small>{t('overview.writableHint')}</small></span></label>
      <label data-selected={editWritePolicy === 'read-only' || undefined}><input type="radio" name="memory-space-write-policy" value="read-only" checked={editWritePolicy === 'read-only'} onChange={() => setEditWritePolicy('read-only')} /><i className={css.choiceControl} data-kind="radio" aria-hidden="true" /><span><strong>{t('common.readOnlySpace')}</strong><small>{t('overview.readOnlyHint')}</small></span></label>
    </fieldset>}
    {!nativeSpaceProvider(body.provider) && (() => { const descriptor = providers.find(provider => provider.id === body.provider.id); return descriptor === undefined ? null : <ProviderMemoryFields provider={descriptor} connection={editConnection} onChange={(key, value) => setEditConnection(current => ({ ...current, [key]: value }))} body={body} clearSecrets={editClearSecrets} onClearSecretsChange={setEditClearSecrets} /> })()}
  </form>
  const spaceCreateForm = <form id={spaceCreateFormId} className={appearanceClass(css.bodyEdit, css.bodyCreateForm)} onSubmit={event => void create(event)}>
    <section className={css.createSection}>
      <div className={css.createSectionHeading}><span>01</span><div><strong>{t('overview.createIdentityTitle')}</strong><small>{t('overview.createIdentityHint')}</small></div></div>
      <div className={css.createIdentityGrid}>
        <label>{t('overview.createName')}<input data-autofocus aria-label={t('overview.createName')} value={spaceName} onChange={event => setSpaceName(event.target.value)} placeholder={t('overview.createNamePlaceholder')} maxLength={MEMORY_SPACE_NAME_MAX_LENGTH} required /></label>
        <label>{t('overview.createDescription')}<textarea aria-label={t('overview.createDescription')} value={spaceDescription} onChange={event => setSpaceDescription(event.target.value)} placeholder={t('overview.createDescriptionPlaceholder')} rows={3} maxLength={MEMORY_SPACE_DESCRIPTION_MAX_LENGTH} required /></label>
      </div>
    </section>
    <section className={css.createSection}>
      <div className={css.createSectionHeading}><span>02</span><div><strong>{t('overview.createPlacementTitle')}</strong><small>{t('overview.createPlacementHint')}</small></div></div>
      <fieldset className={css.providerChoice}><legend>{t('overview.providerLabel')}</legend>{readyFirst(providers).map(provider => {
        const serviceMissing = provider.serviceConfigured === false
        return <label key={provider.id} data-selected={spaceProviderId === provider.id || undefined} data-native={provider.origin === 'native' || undefined} data-disabled={serviceMissing || undefined}>
          <input type="radio" name="memory-provider" value={provider.id} checked={spaceProviderId === provider.id} disabled={serviceMissing} onChange={() => setSpaceProviderId(provider.id)} />
          <ProviderIcon providerId={provider.id} icon={provider.icon} className={css.providerChoiceIcon} />
          <span><strong>{provider.label}{provider.origin === 'native' && <em>{t('overview.nativeOfficial')}</em>}</strong><small>{serviceMissing ? t(providerUnavailableKey(provider)) : `${t(`overview.workspaceBinding.${provider.workspaceBinding}`)} · ${providerSummary(t, provider)}`}</small></span>
          <i className={css.choiceControl} data-kind="radio" aria-hidden="true" />
        </label>
      })}</fieldset>
      {providers.some(provider => provider.serviceConfigured === false) && <small className={css.providerEnableHint}>{t('overview.providerEnableHint')}</small>}
      {selectedProvider !== undefined && selectedProvider.origin !== 'native' && <ProviderMemoryFields provider={selectedProvider} connection={providerDrafts[selectedProvider.id] ?? {}} onChange={(key, value) => updateProviderDraft(selectedProvider.id, key, value)} />}
    </section>
  </form>
  const spaceToggle = (body: MemorySpaceView) => <button type="button" className={css.bodySwitch} role="switch" aria-checked={body.active} aria-label={t('overview.toggleAria', { name: body.name })} disabled={!props.activationEnabled || changing === body.id || deletingSpace === body.id} onClick={() => void toggle(body)}><span className={css.bodySwitchTrack} aria-hidden="true"><i /></span><span>{changing === body.id ? t('overview.toggling') : body.active ? t('common.active') : t('common.inactive')}</span></button>
  const spaceEditActionClass = appearanceClass(css.ghostButton, appearanceClass(sidebarCss.itemActionButton, sidebarCss.itemEditAction))
  const spaceDeleteActionClass = appearanceClass(css.dangerButton, appearanceClass(sidebarCss.itemActionButton, sidebarCss.itemDangerAction))
  return (
    <div className={css.page}>
      <PageHeader title={t('nav.overview')} description={t(('overview.pageDescription'))} meta={fullSyncAge} {...(loading ? { loadingLabel: catalogLoading ? t('overview.directoryLoading') : graphLoading ? t('overview.snapshotLoading') : t('overview.healthLoading') } : {})}
 />
      {error !== null && <div className={css.inlineError} role="alert">{error}</div>}
      <section className={css.bodyDirectory} aria-label={t('overview.directory')}>
        <div className={css.bodyDirectoryHeader}>
          <div><h3>{t('overview.directory')}</h3><p>{t('overview.directory.description')}</p>{catalogUnavailable && <code className={css.bodyDirectoryPath}>{t('overview.directory.unsynced')}</code>}</div>
          <div className={appearanceClass(css.bodyDirectoryControls, sidebarCss.bodyDirectoryActions)}>
            <strong>{catalogUnavailable ? t('overview.directory.unsyncedBadge') : `${catalog?.activeCount ?? '—'} / ${catalog?.total ?? '—'} ${t('common.active')}`}</strong>
            {canRediscover && <button type="button" className={spaceEditActionClass} title={t('overview.rediscoverHint')} aria-busy={rediscoveryRunning || undefined} onClick={() => void rediscover()}>{rediscoveryRunning ? t('overview.rediscovering') : t('overview.rediscoverAction')}</button>}
            {props.writeEnabled && !catalogUnavailable && <button type="button" className={spaceEditActionClass} title={!props.agentAvailable ? t('overview.metadataUnavailable') : undefined} onClick={() => { setMetadataSelection([]); setMetadataTasks({}); setMetadataOpen(true); if (!props.agentAvailable) props.onAgentRefresh() }}>{t('overview.metadataAction')}</button>}
            {props.writeEnabled && !catalogUnavailable && <button type="button" className={spaceEditActionClass} onClick={() => setCreatingSpaceOpen(true)}>{t('overview.createTitle')}</button>}
          </div>
        </div>
        {/* Present before it has anything to say, so assistive technology announces what it says. */}
        <div role="status">{rediscoveryShown && <div className={css.rediscoveryNotice}>
          <div>
            <p>{rediscoveryAdded.length > 0 ? t('overview.rediscoveryAdded', { count: rediscoveryAdded.length }) : t('overview.rediscoveryNone')}</p>
            {rediscoveryDisconnected > 0 && <p>{t('overview.rediscoveryDisconnected', { count: rediscoveryDisconnected })}</p>}
            {rediscoveryFailures.map(result => <p key={result.providerId} data-failed="">{result.timedOut === true
              ? t('overview.rediscoveryTimedOut', { provider: result.label })
              : t('overview.rediscoveryFailed', { provider: result.label, error: result.error ?? '' })}</p>)}
          </div>
          <button type="button" className={spaceEditActionClass} onClick={() => dismissRediscovery(rediscovery.at)}>{t('overview.rediscoveryDismiss')}</button>
        </div>}</div>
        <div className={css.bodyGrid}>
          {catalog?.items.map(body => (
            <article key={body.id} className={css.bodyCard} data-provider={body.provider.id} data-active={body.active || undefined} data-healthy={!body.statusLoading && body.healthy || undefined} data-status-loading={body.statusLoading || undefined} data-reconnectable="" data-reconnecting={reconnectingSpace === body.id || undefined} data-mnemon-default={body.mnemonDefault || undefined} data-editing={undefined} tabIndex={0} aria-label={t('overview.reconnectAria', { name: body.name })} title={reconnectingSpace === body.id ? t('overview.reconnecting') : body.error ?? t('overview.reconnectHint')} onClick={event => {
              if (event.target instanceof Element && event.target.closest('button, input, textarea, select, label, a, [role="switch"]') !== null) return
              void reconnect(body)
            }} onKeyDown={event => {
              if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
              event.preventDefault(); void reconnect(body)
            }}>
              {<><div className={sidebarCss.bodyCardHeader}><div className={sidebarCss.bodyCardIdentity}><span className={css.bodySignal} /><div><strong title={body.id}>{body.name}</strong><div className={sidebarCss.bodyCardMeta}><MemoryProviderBadge providerId={body.provider.id} label={body.provider.label} /><small className={css.bodyHealth}>{reconnectingSpace === body.id ? t('overview.reconnecting') : body.statusLoading ? t('overview.storageChecking') : body.healthy ? t('overview.storageHealthy') : t('overview.storageUnhealthy')}</small>{body.mnemonDefault && <small className={css.mnemonDefaultBadge}>{t('overview.mnemonDefault')}</small>}{body.writePolicy === 'read-only' && <small className={css.readOnlyBadge} title={t('overview.readOnlyHint')}>{t('common.readOnlySpace')}</small>}{newSpaceIds.has(body.id) && <small className={css.newSpaceBadge}>{t('overview.newSpace')}</small>}</div></div></div>{spaceToggle(body)}</div><p title={body.description || t('overview.noDescription')}>{body.description || t('overview.noDescription')}</p>{placementReceipt(body)}<footer className={sidebarCss.bodyCardFooter}><div className={sidebarCss.bodyCardStats}>{!nativeSpaceProvider(body.provider) ? <><span className={css.bodyFooterBlock} title={t(body.provider.kind === 'remote' ? 'overview.providerRemote' : 'overview.providerLocal')}>{t(body.provider.kind === 'remote' ? 'overview.providerRemote' : 'overview.providerLocal')}</span><span className={`${css.bodyFooterBlock} ${css.bodyFooterGrow}`} title={body.provider.location || body.provider.label}>{body.provider.location || body.provider.label}</span></> : <><span className={css.bodyFooterBlock} title={t('common.memories', { count: body.stats?.totalInsights ?? 0 })}>{t('common.memories', { count: body.stats?.totalInsights ?? 0 })}</span><span className={css.bodyFooterBlock} title={t('common.edges', { count: body.stats?.edgeCount ?? 0 })}>{t('common.edges', { count: body.stats?.edgeCount ?? 0 })}</span><span className={css.bodyFooterBlock} title={humanBytes(body.stats?.dbSizeBytes ?? 0)}>{humanBytes(body.stats?.dbSizeBytes ?? 0)}</span></>}</div><div className={css.bodyCardActions}><button type="button" className={spaceEditActionClass} aria-label={t('overview.editSpaceAria', { name: body.name })} disabled={!props.writeEnabled || deletingSpace === body.id} onClick={() => beginEdit(body)}>{t('overview.editSpace')}</button><button type="button" className={spaceDeleteActionClass} aria-label={t(!nativeSpaceProvider(body.provider) ? 'overview.disconnectSpaceAria' : 'overview.deleteSpaceAria', { name: body.name })} title={deleteBlocked(body)} disabled={!props.writeEnabled || deletingSpace === body.id || !canDeleteSpace(body)} onClick={() => setConfirmingDeleteSpace(body.id)}>{!nativeSpaceProvider(body.provider) ? t('overview.disconnectSpace') : t('overview.deleteSpace')}</button></div></footer></>}
            </article>
          ))}
          {catalog?.total === 0 && <div className={css.bodyDirectoryEmpty}><span>◇</span><div><strong>{catalogUnavailable ? t('overview.unsyncedTitle') : t('overview.emptyTitle')}</strong><p>{catalogUnavailable ? t('overview.unsyncedShort') : t('overview.emptyShort')}</p></div></div>}
        </div>

      </section>
      <div className={css.asyncRegion}><ReadSourcePanel title={t('overview.snapshotSources')} hint={t('overview.snapshotSourcesHint')} sources={graphSources} /></div>
      {creatingSpaceOpen && <SidebarModal title={t('overview.createTitle')} description={t('overview.createDialogHint')} busy={creating} wide onClose={() => setCreatingSpaceOpen(false)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.secondaryButton} disabled={creating} onClick={() => setCreatingSpaceOpen(false)}>{t('common.cancel')}</button><button type="submit" form={spaceCreateFormId} className={css.primaryButton} disabled={creating || spaceName.trim() === '' || spaceDescription.trim() === '' || !providerDraftComplete(selectedProvider, providerDrafts[spaceProviderId])}>{creating ? t('overview.creating') : t('overview.createAction')}</button></div>}>{spaceCreateForm}</SidebarModal>}
      {metadataOpen && <SidebarModal title={t('overview.metadataTitle')} description={t('overview.metadataDescription')} busy={metadataBusy} wide onClose={() => setMetadataOpen(false)} footer={<><p className={css.modalFooterNote}>{t('overview.metadataSafety')}</p><div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.secondaryButton} disabled={metadataBusy} onClick={() => setMetadataOpen(false)}>{t('common.cancel')}</button><button type="button" className={css.primaryButton} disabled={!props.agentAvailable || metadataSelection.length === 0} title={!props.agentAvailable ? t('overview.metadataUnavailable') : undefined} onClick={maintainMetadata}>{t('overview.metadataGenerate', { count: metadataSelection.length })}</button></div></>}><div className={css.metadataDialog}>
        {!props.agentAvailable && <div className={css.inlineError} role="status">{t('overview.metadataUnavailable')}</div>}
        <div className={css.metadataToolbar}><span>{t('overview.metadataSelected', { count: metadataSelection.length })}{metadataRunningCount > 0 && <em>{t('overview.metadataRunningCount', { count: metadataRunningCount })}</em>}</span><button type="button" className={css.ghostButton} disabled={metadataSelectable.length === 0} onClick={() => setMetadataSelection(metadataAllSelected ? [] : metadataSelectable.map(body => body.id))}>{metadataAllSelected ? t('overview.metadataClear') : t('overview.metadataSelectAll')}</button></div>
        <div className={css.metadataList} aria-live="polite">{metadataCandidates.length === 0 && <div className={css.metadataEmpty}>{catalogLoading ? t('overview.metadataLoading') : t('overview.metadataEmpty')}</div>}{metadataCandidates.map(body => {
          const selected = metadataSelection.includes(body.id)
          const task = metadataTasks[body.id]
          return <label key={body.id} data-provider={body.provider.id} data-selected={selected || undefined} data-refreshing={task?.status === 'running' || undefined} data-refreshed={task?.status === 'success' || undefined} data-failed={task?.status === 'error' || undefined}><input type="checkbox" checked={selected} disabled={task?.status === 'running'} onChange={event => setMetadataSelection(current => event.target.checked ? [...new Set([...current, body.id])] : current.filter(id => id !== body.id))} /><i className={css.choiceControl} data-kind="check" aria-hidden="true" /><span><strong>{body.name}</strong><small>{body.description || t('overview.noDescription')}</small><span><MemoryProviderBadge providerId={body.provider.id} label={body.provider.label} />{task === undefined ? <code>{body.id}</code> : <small className={css.metadataTaskStatus} data-status={task.status} title={task.error}>{task.status === 'running' ? t('overview.metadataTaskRunning') : task.status === 'success' ? t('overview.metadataTaskSuccess') : t('overview.metadataTaskError', { error: task.error ?? t('overview.metadataTaskUnknown') })}</small>}</span></span></label>
        })}</div>
      </div></SidebarModal>}
      {editingSpaceView !== undefined && <SidebarModal title={t('overview.editSpaceAria', { name: editingSpaceView.name })} description={editingSpaceView.id} busy={savingSpace === editingSpaceView.id} onClose={() => setEditingSpace(null)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.secondaryButton} disabled={savingSpace === editingSpaceView.id} onClick={() => setEditingSpace(null)}>{t('common.cancel')}</button><button type="submit" form={spaceEditFormId} className={css.primaryButton} disabled={savingSpace === editingSpaceView.id || editName.trim() === ''}>{savingSpace === editingSpaceView.id ? t('overview.savingSpace') : t('overview.saveSpace')}</button></div>}>{spaceEditForm(editingSpaceView)}</SidebarModal>}
      {deletingSpaceView !== undefined && <SidebarModal title={t(!nativeSpaceProvider(deletingSpaceView.provider) ? 'overview.disconnectTitle' : 'overview.deleteTitle', { name: deletingSpaceView.name })} description={deletingSpaceView.id} busy={deletingSpace === deletingSpaceView.id} onClose={() => setConfirmingDeleteSpace(null)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close data-autofocus className={css.secondaryButton} disabled={deletingSpace === deletingSpaceView.id} onClick={() => setConfirmingDeleteSpace(null)}>{t('common.cancel')}</button><button type="button" className={css.dangerSolidButton} title={deleteBlocked(deletingSpaceView)} disabled={deletingSpace === deletingSpaceView.id || !canDeleteSpace(deletingSpaceView)} onClick={() => void deleteBody(deletingSpaceView)}>{deletingSpace === deletingSpaceView.id ? t('overview.deletingSpace') : t(!nativeSpaceProvider(deletingSpaceView.provider) ? 'overview.disconnectAction' : 'overview.deleteAction')}</button></div>}><div className={css.bodyDeleteConfirm}><p>{t(!nativeSpaceProvider(deletingSpaceView.provider) ? 'overview.disconnectWarning' : 'overview.deleteWarning', { provider: deletingSpaceView.provider.label })}</p><div className={css.bodyDeleteSummary}><strong>{deletingSpaceView.name}</strong><span>{deletingSpaceView.provider.label} · {deletingSpaceView.provider.location || t('common.memories', { count: deletingSpaceView.stats?.totalInsights ?? 0 })}</span></div></div></SidebarModal>}
      {!catalogUnavailable && graph !== null && graph.nodes.length > 0 ? (
        <div className={css.graphLayout}>
          <section className={css.graphPanel}>
            <div className={css.graphToolbar}>
              <div><span className={css.liveDot} />{t('overview.snapshot')} <small>{generated}</small></div>
              <div className={css.graphLegend}><span data-edge="scope">{t('overview.edgeScope')}</span><span data-edge="temporal">{t('overview.edgeTemporal')}</span><span data-edge="semantic">{t('overview.edgeSemantic')}</span><span data-edge="causal">{t('overview.edgeCausal')}</span><span data-edge="entity">{t('overview.edgeEntity')}</span></div>
            </div>
            <div className={css.graphViewport}><MemoryGraph graph={graph} selectedId={selected === null ? undefined : graphNodeKey(selected)} onSelect={setSelected} /></div>
            <div className={css.graphFooter}><span>{t('overview.graphComposition', { spaces: graphSpaces, memories: graphMemories, entities: graphEntities })}</span><span>{t('overview.graphCount', { visible: Math.min(graph.nodes.length, 60), total: graph.nodes.length })} · {t('overview.graphEdges', { count: graph.edges.length })}</span></div>
          </section>
          <aside className={css.graphInspector} data-empty={selected === null || undefined}>
            {selected === null ? (
              <div className={css.inspectorEmpty}><span className={appearanceClass(css.inspectorLogo, sidebarCss.inspectorGlyph)} aria-hidden="true">◇</span><h3>{t('overview.selectNode')}</h3><p>{t('overview.selectNodeText')}</p></div>
            ) : (
              <>
                <div className={css.inspectorHeading}><span>{t(selectedKind === 'space' ? 'overview.inspectorSpace' : selectedKind === 'entity' ? 'overview.inspectorEntity' : 'overview.inspector')}</span><button type="button" onClick={() => setSelected(null)} aria-label={t('overview.closeInspector')}>×</button></div>
                <div className={css.inspectorChips}><span className={css.categoryChip}>{graphKindLabel(t, selected)}</span>{selected.memoryProviderId !== undefined && <MemoryProviderBadge providerId={selected.memoryProviderId} label={selected.memoryProviderLabel ?? selected.memoryProviderId} />}</div>
                <div className={css.inspectorTitleRow}><h3 className={css.inspectorTitle}>{selected.content}</h3>{selectedKind === 'memory' && selected.content.length > 140 && <button type="button" className={css.inspectorEye} onClick={() => setPreview(selected)} aria-label={t('overview.previewAria')} title={t('overview.previewAria')}><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1 8s2.6-4.4 7-4.4S15 8 15 8s-2.6 4.4-7 4.4S1 8 1 8z" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="8" cy="8" r="2.1" fill="currentColor" /></svg></button>}</div>
                {selectedKind === 'space'
                  ? <dl className={css.inspectorMeta}><div><dt>{t('overview.spaceId')}</dt><dd><code>{selected.memoryBodyId ?? selected.id}</code></dd></div><div><dt>{t('overview.containedMemories')}</dt><dd>{selected.occurrenceCount ?? 0}</dd></div></dl>
                  : selectedKind === 'entity'
                    ? <dl className={css.inspectorMeta}><div><dt>{t('overview.entityMentions')}</dt><dd>{selected.occurrenceCount ?? 0}</dd></div><div><dt>{t('term.spaces')}</dt><dd>{selected.memoryBodyNames?.join(' · ') || '—'}</dd></div></dl>
                    : <dl className={css.inspectorMeta}><div><dt>{t('term.space')}</dt><dd>{selected.memoryBodyName ?? '—'} <code>{selected.memoryBodyId ?? ''}</code></dd></div><div><dt>{t('overview.memoryId')}</dt><dd><code>{selected.id}</code></dd></div><div><dt>{t('common.category')}</dt><dd>{categoryLabel(t, selected.category ?? 'general')}</dd></div></dl>}
                <div className={css.inspectorActions}>{selectedKind !== 'space' && <button type="button" className={css.primaryButton} onClick={() => props.onExplore(selected.content)}>{t('overview.exploreNode')}</button>}<button type="button" className={css.secondaryButton} onClick={() => void writeClipboard(selected.id)}>{t('common.copyId')}</button></div>
              </>
            )}
          </aside>
        </div>
      ) : !graphLoading && error === null ? (
        catalogUnavailable
          ? <EmptyState glyph="◇" title={t('overview.unsyncedTitle')}>{t('overview.unsyncedLong')}</EmptyState>
          : catalog?.total === 0
          ? <EmptyState glyph="◇" title={t('overview.emptyTitle')}>{t('overview.emptyLong')}</EmptyState>
          : catalog?.activeCount === 0
            ? <EmptyState glyph="◇" title={t('overview.noActiveTitle')}>{t('overview.noActiveText')}</EmptyState>
            : <EmptyState glyph="◇" title={t(onlyQueryOrUnsupported ? 'overview.noVisualTitle' : 'overview.noContentTitle')}>{t(onlyQueryOrUnsupported ? 'overview.noVisualText' : 'overview.noContentText')}</EmptyState>
      ) : (
        <div className={css.asyncPlaceholder}><span>{t('overview.loading')}</span></div>
      )}
      {preview !== null && <ContentPreview node={preview} kind={graphKindLabel(t, preview)} onClose={() => setPreview(null)} />}
    </div>
  )
}

/** The rediscovery a person last dismissed on this browser, so the same news is not shown twice. */
const REDISCOVERY_SEEN_KEY = 'dsh-mnemon.memory-spaces.rediscovery-seen'
/** How often an open page looks again while the Host asks the Providers. */
const REDISCOVERY_POLL_MS = 2_000

function readSeenRediscovery(): string | null {
  try { return globalThis.localStorage?.getItem(REDISCOVERY_SEEN_KEY) ?? null } catch { return null }
}

function writeSeenRediscovery(at: string): void {
  try { globalThis.localStorage?.setItem(REDISCOVERY_SEEN_KEY, at) } catch {
    // A browser that keeps nothing shows the news again next time.
  }
}
