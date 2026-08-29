import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import {
  DEFAULT_EMBEDDING_ENDPOINT,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_PROTOCOL,
  MNEMON_EMBEDDING_PROTOCOLS,
  normalizeDisplayMode,
  type ClientConnectionHandle,
  type ClientSettingsScope,
  type ClientSettingsSnapshot,
  type Config,
  type InteractionConfig,
  type MemorySystemDescriptor,
  type MemoryTopologyDefinition,
  type MnemonEmbeddingStatus,
  type SettingsOperation,
  type TaskAgentModelCatalog,
} from '../shared/contracts.ts'
import { MnemonClient } from './api.ts'
import css from './MnemonSettingsCard.module.css'
import { GlobalLocationSetting } from './GlobalLocationSetting.tsx'
import { translateZh, type MnemonTranslate } from './locales.ts'
import { MnemonPackSection } from './MnemonPackSection.tsx'
import { ProviderIcon } from './ProviderIcon.tsx'
import { ProviderSettingsSection } from './ProviderSettingsSection.tsx'

export interface MnemonSettingsCardProps {
  scope: ClientSettingsScope<Config>
  /** Separate live namespace; falls back to the core scope for older hosts. */
  interactionScope?: ClientSettingsScope<InteractionConfig>
  /** Loopback RPC used for whole-directory ZIP backup and restore. */
  connection?: ClientConnectionHandle
  sessionId?: string
  workspaceId?: string
  workspaceLabel?: string
  t?: MnemonTranslate
}

type CoreField = 'displayMode' | 'storageScope' | 'runtimeUserScope' | 'dataDir'
type EmbeddingField = 'embeddingEnabled' | 'embeddingEndpoint' | 'embeddingModel' | 'embeddingApiKey' | 'embeddingProtocol'
type TaskAgentField = 'taskAgentModelMode' | 'taskAgentProvider' | 'taskAgentModel'
type InteractionField = 'turnBar' | 'saveAction'
type TopologyField = `memoryTopology.${string}`
type DraftField = CoreField | EmbeddingField | TaskAgentField | InteractionField
type Field = DraftField | TopologyField
interface Draft extends Record<InteractionField, boolean> {
  displayMode: 'sidebar' | 'builtin'
  storageScope: string
  runtimeUserScope: 'storage' | 'global'
  dataDir: string
  embeddingEnabled: boolean
  embeddingEndpoint: string
  embeddingModel: string
  embeddingApiKey: string
  embeddingProtocol: string
  taskAgentModelMode: 'inherit' | 'fixed'
  taskAgentProvider: string
  taskAgentModel: string
}

const CORE_FIELDS: CoreField[] = ['displayMode', 'storageScope', 'runtimeUserScope', 'dataDir']
const EMBEDDING_FIELDS: EmbeddingField[] = ['embeddingEnabled', 'embeddingEndpoint', 'embeddingModel', 'embeddingApiKey', 'embeddingProtocol']
const INTERACTION_FIELDS: InteractionField[] = ['turnBar', 'saveAction']
const TASK_AGENT_FIELDS: TaskAgentField[] = ['taskAgentModelMode', 'taskAgentProvider', 'taskAgentModel']
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function legacyPackDirectory(value: Config): string {
  const packs = value.customPacks ?? []
  return packs.find(pack => pack.id === value.customPackId)?.dataDir?.trim()
    ?? (packs.length === 1 ? packs[0]?.dataDir?.trim() : undefined)
    ?? ''
}

function coreDraft(value: Config | undefined): Pick<Draft, CoreField | EmbeddingField | TaskAgentField> {
  const resolved = value ?? {}
  const dataDir = resolved.dataDir?.trim() || legacyPackDirectory(resolved)
  return {
    displayMode: normalizeDisplayMode(resolved.displayMode),
    storageScope: resolved.storageScope ?? (dataDir === '' ? 'global' : 'custom'),
    runtimeUserScope: resolved.runtimeUserScope === 'global' ? 'global' : 'storage',
    dataDir,
    embeddingEnabled: resolved.embedding?.enabled === true,
    embeddingEndpoint: resolved.embedding?.endpoint?.trim() || DEFAULT_EMBEDDING_ENDPOINT,
    embeddingModel: resolved.embedding?.model?.trim() || DEFAULT_EMBEDDING_MODEL,
    embeddingApiKey: resolved.embedding?.apiKey?.trim() ?? '',
    embeddingProtocol: resolved.embedding?.protocol ?? DEFAULT_EMBEDDING_PROTOCOL,
    taskAgentModelMode: resolved.taskAgentModel?.mode === 'fixed' ? 'fixed' : 'inherit',
    taskAgentProvider: resolved.taskAgentModel?.provider?.trim() ?? '',
    taskAgentModel: resolved.taskAgentModel?.model?.trim() ?? '',
  }
}

function validEmbeddingEndpoint(value: string): boolean {
  const endpoint = value.trim()
  if (endpoint === '' || endpoint.length > 2048) return false
  try {
    const parsed = new URL(endpoint)
    return ['http:', 'https:'].includes(parsed.protocol)
      && parsed.username === '' && parsed.password === ''
      && !endpoint.includes('?') && !endpoint.includes('#')
  } catch {
    return false
  }
}

function validEmbeddingModel(value: string): boolean {
  const model = value.trim()
  return model.length > 0 && model.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(model)
}

function validEmbeddingApiKey(value: string): boolean {
  const key = value.trim()
  return key.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(key)
}

function interactionDraft(value: InteractionConfig | undefined): Pick<Draft, InteractionField> {
  return {
    turnBar: value?.turnBar !== false,
    saveAction: value?.saveAction !== false,
  }
}

function draftOf(core: Config | undefined, interaction: InteractionConfig | undefined): Draft {
  return { ...coreDraft(core), ...interactionDraft(interaction) }
}

function topologyOf(descriptor: MemorySystemDescriptor): MemoryTopologyDefinition {
  return {
    id: descriptor.topology.id,
    strategyId: descriptor.topology.strategyId,
    layers: descriptor.topology.layers.map(layer => ({
      id: layer.id,
      enabled: layer.enabled,
      participation: { ...layer.participation },
      adapterIds: [...layer.adapterIds],
    })),
  }
}

function validation(t: MnemonTranslate, draft: Draft): string | null {
  if (!['global', 'workspace', 'custom'].includes(draft.storageScope)) return t('config.invalidScope')
  if (!['storage', 'global'].includes(draft.runtimeUserScope)) return t('config.invalidRuntimeUserScope')
  if (draft.storageScope === 'custom') {
    const directory = draft.dataDir.trim()
    if (directory === '') return t('config.customRequired')
    const posixAbsolute = directory.startsWith('/')
    const homeRelative = directory === '~' || directory.startsWith('~/')
    const windowsDriveAbsolute = /^[a-zA-Z]:[\\/]/.test(directory)
    const windowsUncAbsolute = /^\\\\[^\\/]+[\\/][^\\/]+/.test(directory)
    if (!posixAbsolute && !homeRelative && !windowsDriveAbsolute && !windowsUncAbsolute) return t('config.customAbsolute')
  }
  if (draft.embeddingEnabled && !validEmbeddingEndpoint(draft.embeddingEndpoint)) return t('config.embeddingEndpointInvalid')
  if (draft.embeddingEnabled && !validEmbeddingModel(draft.embeddingModel)) return t('config.embeddingModelInvalid')
  if (draft.embeddingEnabled && !validEmbeddingApiKey(draft.embeddingApiKey)) return t('config.embeddingApiKeyInvalid')
  if (draft.embeddingEnabled && !MNEMON_EMBEDDING_PROTOCOLS.includes(draft.embeddingProtocol as typeof MNEMON_EMBEDDING_PROTOCOLS[number])) return t('config.embeddingProtocolInvalid')
  if (draft.taskAgentModelMode === 'fixed' && (draft.taskAgentProvider.trim() === '' || draft.taskAgentModel.trim() === '')) return t('config.taskAgentRouteRequired')
  return null
}

function useScope<T>(scope: ClientSettingsScope<T>): ClientSettingsSnapshot<T> {
  const subscribe = useMemo(() => scope.subscribe.bind(scope), [scope])
  const getSnapshot = useMemo(() => scope.getSnapshot.bind(scope), [scope])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function operations(fields: readonly DraftField[], dirty: ReadonlySet<Field>, draft: Draft): SettingsOperation[] {
  return fields.flatMap((field): SettingsOperation[] => {
    if (!dirty.has(field)) return []
    if (field === 'dataDir' && draft.dataDir.trim() === '') return [{ op: 'unset', path: [field] }]
    const value = draft[field]
    return [{ op: 'set', path: [field], value: typeof value === 'string' ? value.trim() : value }]
  })
}

async function commit<T>(scope: ClientSettingsScope<T>, edits: SettingsOperation[]): Promise<void> {
  if (scope.mutate !== undefined) return scope.mutate(edits)
  for (const edit of edits) {
    if (edit.path.length === 1) {
      if (edit.op === 'set') await scope.set(edit.path[0]!, edit.value)
      else await scope.unset(edit.path[0]!)
    } else if (edit.op === 'set') await scope.setPath(edit.path, edit.value)
    else await scope.unsetPath(edit.path)
  }
}

/** Dedicated Mnemon page contributed directly to DSH's settings navigation. */
export function MnemonSettingsCard({ scope, interactionScope: suppliedInteractionScope, connection, sessionId, workspaceId, workspaceLabel, t = translateZh }: MnemonSettingsCardProps): JSX.Element | null {
  const interactionScope = suppliedInteractionScope ?? scope as unknown as ClientSettingsScope<InteractionConfig>
  const coreSnapshot = useScope(scope)
  const interactionSnapshot = useScope(interactionScope)
  const [draft, setDraft] = useState<Draft>(() => draftOf(coreSnapshot.value, interactionSnapshot.value))
  const [dirty, setDirty] = useState<Set<Field>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [applied, setApplied] = useState(false)
  const [targetRevision, setTargetRevision] = useState(0)
  const [modelCatalog, setModelCatalog] = useState<TaskAgentModelCatalog | null>(null)
  const [modelCatalogState, setModelCatalogState] = useState<'unavailable' | 'loading' | 'ready' | 'error'>(connection === undefined ? 'unavailable' : 'loading')
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null)
  const [fullModelCatalogLoaded, setFullModelCatalogLoaded] = useState(false)
  const modelCatalogRequest = useRef(0)
  const [memorySystem, setMemorySystem] = useState<MemorySystemDescriptor | null>(null)
  const [topologyDraft, setTopologyDraft] = useState<MemoryTopologyDefinition | null>(null)
  const [topologyState, setTopologyState] = useState<'unavailable' | 'loading' | 'ready' | 'error'>(connection === undefined ? 'unavailable' : 'loading')
  const topologyRequest = useRef(0)
  const [embeddingStatus, setEmbeddingStatus] = useState<MnemonEmbeddingStatus | null>(null)
  const [embeddingStatusState, setEmbeddingStatusState] = useState<'unavailable' | 'idle' | 'loading' | 'ready' | 'error'>(connection === undefined ? 'unavailable' : 'idle')
  const [embeddingStatusError, setEmbeddingStatusError] = useState<string | null>(null)
  const embeddingStatusRequest = useRef(0)
  const configuredTaskAgentMode = coreSnapshot.value?.taskAgentModel?.mode === 'fixed' ? 'fixed' : 'inherit'

  useEffect(() => {
    if (dirty.size === 0) setDraft(draftOf(coreSnapshot.value, interactionSnapshot.value))
  }, [dirty.size, coreSnapshot.value, interactionSnapshot.value])

  const loadModelCatalog = useCallback((includeCatalog: boolean): void => {
    if (connection === undefined) {
      modelCatalogRequest.current += 1
      setModelCatalog(null)
      setModelCatalogState('unavailable')
      setModelCatalogError(null)
      setFullModelCatalogLoaded(false)
      return
    }
    const request = modelCatalogRequest.current + 1
    modelCatalogRequest.current = request
    setModelCatalogState('loading')
    setModelCatalogError(null)
    void new MnemonClient(connection).taskAgentModels(includeCatalog).then(catalog => {
      if (modelCatalogRequest.current !== request) return
      setModelCatalog(catalog)
      setModelCatalogState('ready')
      setFullModelCatalogLoaded(includeCatalog)
      if (includeCatalog) {
        setDraft(current => {
          if (current.taskAgentModelMode !== 'fixed') return current
          const provider = current.taskAgentProvider
            || catalog.defaultSelection?.provider
            || catalog.groups[0]?.id
            || ''
          const group = catalog.groups.find(candidate => candidate.id === provider)
          const model = current.taskAgentModel
            || (catalog.defaultSelection?.provider === provider ? catalog.defaultSelection.model : undefined)
            || group?.models[0]?.id
            || ''
          return provider === current.taskAgentProvider && model === current.taskAgentModel
            ? current
            : { ...current, taskAgentProvider: provider, taskAgentModel: model }
        })
      }
    }, reason => {
      if (modelCatalogRequest.current !== request) return
      setModelCatalogState('error')
      setModelCatalogError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [connection])

  useEffect(() => {
    loadModelCatalog(configuredTaskAgentMode === 'fixed')
    return () => { modelCatalogRequest.current += 1 }
  }, [configuredTaskAgentMode, loadModelCatalog])

  useEffect(() => {
    if (connection === undefined) {
      topologyRequest.current += 1
      setMemorySystem(null)
      setTopologyDraft(null)
      setTopologyState('unavailable')
      return
    }
    const request = topologyRequest.current + 1
    topologyRequest.current = request
    setTopologyState('loading')
    void new MnemonClient(connection, sessionId, workspaceId).memorySystem().then(descriptor => {
      if (topologyRequest.current !== request) return
      setMemorySystem(descriptor)
      setTopologyDraft(topologyOf(descriptor))
      setTopologyState('ready')
    }, () => {
      if (topologyRequest.current !== request) return
      setMemorySystem(null)
      setTopologyDraft(null)
      setTopologyState('error')
    })
    return () => { topologyRequest.current += 1 }
  }, [connection, sessionId, workspaceId, targetRevision])

  useEffect(() => {
    embeddingStatusRequest.current += 1
    setEmbeddingStatus(null)
    setEmbeddingStatusError(null)
    setEmbeddingStatusState(connection === undefined ? 'unavailable' : 'idle')
    return () => { embeddingStatusRequest.current += 1 }
  }, [connection, sessionId, workspaceId, targetRevision])

  const testEmbedding = (): void => {
    if (connection === undefined) return
    const request = embeddingStatusRequest.current + 1
    embeddingStatusRequest.current = request
    setEmbeddingStatus(null)
    setEmbeddingStatusError(null)
    setEmbeddingStatusState('loading')
    void new MnemonClient(connection, sessionId, workspaceId).embeddingStatus().then(status => {
      if (embeddingStatusRequest.current !== request) return
      setEmbeddingStatus(status)
      setEmbeddingStatusState('ready')
    }, reason => {
      if (embeddingStatusRequest.current !== request) return
      setEmbeddingStatusError(reason instanceof Error ? reason.message : String(reason))
      setEmbeddingStatusState('error')
    })
  }

  const coreUser = useMemo(() => record(coreSnapshot.user), [coreSnapshot.user])
  const activeScope = coreDraft(coreSnapshot.value).storageScope === 'workspace' ? 'workspace' : 'global'
  const error = validation(t, draft)
  const loading = coreSnapshot.status === 'loading' || interactionSnapshot.status === 'loading'
  // A successful writable settings snapshot is the Host's authoritative
  // capability grant. DSH authenticates the complete Host API, so transport
  // locality is not a capability signal.
  const writable = coreSnapshot.writable && interactionSnapshot.writable

  if (coreSnapshot.status === 'unavailable' && interactionSnapshot.status === 'unavailable') {
    return <section className={css.page} aria-label={t('config.aria')}><p className={css.error} role="alert">{t('config.unavailable')}</p></section>
  }

  const edit = (field: Field, value: string | boolean): void => {
    setDraft(current => ({ ...current, [field]: value }))
    setDirty(current => new Set(current).add(field))
    setFailed(null)
    setApplied(false)
  }

  const editMany = (values: Partial<Draft>): void => {
    setDraft(current => ({ ...current, ...values }))
    setDirty(current => new Set([...current, ...Object.keys(values) as Field[]]))
    setFailed(null)
    setApplied(false)
  }

  const discard = (): void => {
    setDraft(draftOf(coreSnapshot.value, interactionSnapshot.value))
    setTopologyDraft(memorySystem === null ? null : topologyOf(memorySystem))
    setDirty(new Set()); setFailed(null); setApplied(false)
  }

  const save = async (): Promise<void> => {
    if (error !== null || dirty.size === 0 || saving || !writable) return
    setSaving(true); setFailed(null)
    try {
      const coreOps = operations(CORE_FIELDS, dirty, draft)
      const regularCoreChanged = coreOps.length > 0
      const embeddingChanged = EMBEDDING_FIELDS.some(field => dirty.has(field))
      const taskAgentChanged = TASK_AGENT_FIELDS.some(field => dirty.has(field))
      const topologyChanged = [...dirty].some(field => field.startsWith('memoryTopology.'))
      if (regularCoreChanged) {
        if (Object.hasOwn(coreUser, 'customPackId')) coreOps.push({ op: 'unset', path: ['customPackId'] })
        if (Object.hasOwn(coreUser, 'customPacks')) coreOps.push({ op: 'unset', path: ['customPacks'] })
      }
      if (taskAgentChanged) {
        coreOps.push({
          op: 'set',
          path: ['taskAgentModel'],
          value: draft.taskAgentModelMode === 'inherit'
            ? { mode: 'inherit' }
            : { mode: 'fixed', provider: draft.taskAgentProvider.trim(), model: draft.taskAgentModel.trim() },
        })
      }
      if (embeddingChanged) {
        const validEndpoint = validEmbeddingEndpoint(draft.embeddingEndpoint)
        const validModel = validEmbeddingModel(draft.embeddingModel)
        const validApiKey = validEmbeddingApiKey(draft.embeddingApiKey)
        const validProtocol = MNEMON_EMBEDDING_PROTOCOLS.includes(draft.embeddingProtocol as typeof MNEMON_EMBEDDING_PROTOCOLS[number])
        coreOps.push({
          op: 'set',
          path: ['embedding'],
          value: draft.embeddingEnabled
            ? {
                enabled: true,
                endpoint: draft.embeddingEndpoint.trim().replace(/\/+$/u, ''),
                model: draft.embeddingModel.trim(),
                protocol: draft.embeddingProtocol,
                apiKey: draft.embeddingApiKey.trim(),
              }
            : {
                enabled: false,
                ...(validEndpoint ? { endpoint: draft.embeddingEndpoint.trim().replace(/\/+$/u, '') } : {}),
                ...(validModel ? { model: draft.embeddingModel.trim() } : {}),
                ...(validProtocol ? { protocol: draft.embeddingProtocol } : {}),
                ...(validApiKey ? { apiKey: draft.embeddingApiKey.trim() } : {}),
              },
        })
      }
      if (topologyChanged && topologyDraft !== null) {
        for (const layer of topologyDraft.layers) {
          if (!dirty.has(`memoryTopology.${layer.id}.enabled`)) continue
          coreOps.push({ op: 'set', path: ['memoryTopology', 'layers', layer.id, 'enabled'], value: layer.enabled })
        }
      }
      const interactionOps = operations(INTERACTION_FIELDS, dirty, draft)
      await Promise.all([
        ...(coreOps.length === 0 ? [] : [commit(scope, coreOps)]),
        ...(interactionOps.length === 0 ? [] : [commit(interactionScope, interactionOps)]),
      ])
      setDirty(new Set())
      setApplied(true)
      if (regularCoreChanged || embeddingChanged || topologyChanged) setTargetRevision(revision => revision + 1)
    } catch (reason) {
      setFailed(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  const coreDisabled = loading || saving || !coreSnapshot.writable
  const interactionDisabled = loading || saving || !interactionSnapshot.writable
  const scopeChanging = dirty.has('storageScope') || dirty.has('runtimeUserScope') || dirty.has('dataDir')
  const embeddingChanging = EMBEDDING_FIELDS.some(field => dirty.has(field))
  const editLayerEnabled = (layerId: string, enabled: boolean): void => {
    setTopologyDraft(current => current === null ? current : {
      ...current,
      layers: current.layers.map(layer => layer.id === layerId ? { ...layer, enabled } : layer),
    })
    setDirty(current => new Set(current).add(`memoryTopology.${layerId}.enabled`))
    setFailed(null)
    setApplied(false)
  }
  return (
    <section className={css.page} aria-label={t('config.aria')} aria-busy={saving || loading}>
      {loading ? <p className={css.loading} role="status">{t('common.loading')}</p> : <>
        <header className={css.pageHeader}>
          <h1>{t('config.title')}</h1>
          <p>{t('config.description')}</p>
        </header>

        <section className={css.section} aria-labelledby="mnemon-display-heading">
          <div className={css.sectionHeading}>
            <div><h2 id="mnemon-display-heading">{t('config.displayTitle')}</h2><p>{t('config.displayDescription')}</p></div>
          </div>
          <div className={css.choiceGrid} role="radiogroup" aria-label={t('config.displayAria')}>
            <ChoiceCard id="mnemon-display-sidebar" name="mnemon-display" label={t('config.displaySidebar')} detail={t('config.displaySidebarHint')} checked={draft.displayMode === 'sidebar'} disabled={coreDisabled} onChange={() => edit('displayMode', 'sidebar')} />
            <ChoiceCard id="mnemon-display-builtin" name="mnemon-display" label={t('config.displayBuiltin')} detail={t('config.displayBuiltinHint')} checked={draft.displayMode === 'builtin'} disabled={coreDisabled} onChange={() => edit('displayMode', 'builtin')} />
          </div>
        </section>

        <section className={css.section} aria-labelledby="mnemon-storage-heading">
          <div className={css.sectionHeading}>
            <div><h2 id="mnemon-storage-heading">{t('config.storageTitle')}</h2><p>{t('config.storageDescription')}</p></div>
          </div>
          <div className={css.choiceGrid} role="radiogroup" aria-label={t('config.scopeAria')}>
            <ChoiceCard id="mnemon-storage-global" name="mnemon-storage" label={t('config.global')} detail={t('config.globalScopeHint')} checked={draft.storageScope !== 'workspace'} disabled={coreDisabled} onChange={() => edit('storageScope', draft.dataDir.trim() === '' ? 'global' : 'custom')} />
            <ChoiceCard id="mnemon-storage-workspace" name="mnemon-storage" label={t('config.workspace')} detail="<workspace>/.mnemon" checked={draft.storageScope === 'workspace'} disabled={coreDisabled} onChange={() => edit('storageScope', 'workspace')} />
          </div>
        </section>

        <section className={css.section} aria-labelledby="mnemon-runtime-user-scope-heading">
          <div className={css.sectionHeading}>
            <div><h2 id="mnemon-runtime-user-scope-heading">{t('config.runtimeUserScopeTitle')}</h2><p>{t('config.runtimeUserScopeDescription')}</p></div>
          </div>
          <div className={css.choiceGrid} role="radiogroup" aria-label={t('config.runtimeUserScopeAria')}>
            <ChoiceCard id="mnemon-runtime-user-storage" name="mnemon-runtime-user-scope" label={t('config.runtimeUserScopeStorage')} detail={t('config.runtimeUserScopeStorageHint')} checked={draft.runtimeUserScope === 'storage'} disabled={coreDisabled} onChange={() => edit('runtimeUserScope', 'storage')} />
            <ChoiceCard id="mnemon-runtime-user-global" name="mnemon-runtime-user-scope" label={t('config.runtimeUserScopeGlobal')} detail={t('config.runtimeUserScopeGlobalHint')} checked={draft.runtimeUserScope === 'global'} disabled={coreDisabled} onChange={() => edit('runtimeUserScope', 'global')} />
          </div>
        </section>

        <MemoryTopologySection
          descriptor={memorySystem}
          topology={topologyDraft}
          state={topologyState}
          disabled={coreDisabled}
          onEnabled={editLayerEnabled}
          t={t}
        />

        <section className={css.section} aria-labelledby="mnemon-providers-heading">
          <div className={css.sectionHeading}>
            <div><h2 id="mnemon-providers-heading">{t('config.providersTitle')}</h2><p>{t('config.providersDescription')}</p></div>
          </div>
          <details className={css.providerPanel} open>
            <summary>
              <span className={css.providerIdentity}><ProviderIcon providerId="mnemon-native" icon={{ kind: 'brand', value: 'mnemon' }} className={css.nativeMark} /><span><strong>mnemon</strong><small>{t('config.nativeSummary')}</small></span></span>
              <span className={css.providerHeaderMeta}><span className={css.providerScopeTag} data-scope={activeScope}>{t(`config.${activeScope}`)}</span><span className={css.providerState}>{t('config.officialNative')}</span></span>
            </summary>
            <div className={css.providerPanelBody}>
              <GlobalLocationSetting
                name="mnemon-native-location"
                ariaLabel={t('config.nativeGlobalLocation')}
                label={t('config.nativeGlobalLocation')}
                hint={draft.storageScope === 'workspace' ? t('config.nativeGlobalLocationWorkspaceHint') : t('config.nativeGlobalLocationHint')}
                defaultLabel={t('config.nativeDefaultLocation')}
                customLabel={t('config.custom')}
                custom={draft.storageScope === 'custom'}
                workspace={draft.storageScope === 'workspace'}
                disabled={coreDisabled}
                onChange={custom => custom ? edit('storageScope', 'custom') : editMany({ storageScope: 'global', dataDir: '' })}
              >
                <div className={css.settingRow}>
                  <div className={css.settingCopy}><strong>{t('config.customDirectory')}</strong><small>{t('config.customDirectoryHint')}</small></div>
                  <div className={css.directoryControl}>
                    <input
                      id="mnemon-custom-directory"
                      name="mnemon-custom-directory"
                      type="text"
                      className={css.directoryInput}
                      aria-label={t('config.customAria')}
                      aria-invalid={error !== null}
                      placeholder={t('config.customPlaceholder')}
                      value={draft.dataDir}
                      disabled={coreDisabled}
                      autoComplete="off"
                      spellCheck={false}
                      autoCapitalize="none"
                      autoCorrect="off"
                      onChange={event => edit('dataDir', event.target.value)}
                    />
                  </div>
                </div>
              </GlobalLocationSetting>
              <EmbeddingSettingsSection
                draft={draft}
                disabled={coreDisabled}
                connectionAvailable={connection !== undefined}
                changing={embeddingChanging}
                status={embeddingStatus}
                state={embeddingStatusState}
                error={embeddingStatusError}
                onEdit={edit}
                onTest={testEmbedding}
                t={t}
              />
              <MnemonPackSection {...(connection === undefined ? {} : { connection })} {...(sessionId === undefined ? {} : { sessionId })} {...(workspaceId === undefined ? {} : { workspaceId })} refreshKey={targetRevision} t={t} embedded />
            </div>
          </details>
          <ProviderSettingsSection
            {...(connection === undefined ? {} : { connection })}
            {...(sessionId === undefined ? {} : { sessionId })}
            {...(workspaceId === undefined ? {} : { workspaceId })}
            {...(activeScope !== 'workspace' || workspaceLabel === undefined ? {} : { workspaceLabel })}
            activeScope={activeScope}
            refreshKey={targetRevision}
            disabled={coreDisabled}
            scopeChanging={scopeChanging}
            t={t}
          />
        </section>

        <TaskAgentModelSection
          draft={draft}
          catalog={modelCatalog}
          state={modelCatalogState}
          error={modelCatalogError}
          disabled={coreDisabled}
          fullCatalogLoaded={fullModelCatalogLoaded}
          onLoadCatalog={() => loadModelCatalog(true)}
          onEdit={edit}
          onEditMany={editMany}
          t={t}
        />

        <section className={css.section} aria-labelledby="mnemon-interaction-heading">
          <div className={css.sectionHeading}>
            <div><h2 id="mnemon-interaction-heading">{t('config.interactionTitle')}</h2><p>{t('config.interactionHint')}</p></div>
          </div>
          <div className={css.rowGroup}>
            <ToggleRow id="mnemon-interaction-turn-bar" label={t('config.interactionTurnBar')} hint={t('config.interactionTurnBarHint')} checked={draft.turnBar} disabled={interactionDisabled} onChange={value => edit('turnBar', value)} />
            <ToggleRow id="mnemon-interaction-save-action" label={t('config.interactionSaveAction')} hint={t('config.interactionSaveActionHint')} checked={draft.saveAction} disabled={interactionDisabled} onChange={value => edit('saveAction', value)} />
          </div>
        </section>

        <div className={css.feedback} aria-live="polite">
          {error !== null && <p className={css.error} role="alert">{error}</p>}
          {failed !== null && <p className={css.error} role="alert">{t('config.saveFailed', { error: failed })}</p>}
          {applied && <p className={css.success} role="status">{t('config.ready')}</p>}
          {!writable && <p className={css.readOnly}>{t('config.readOnly')}</p>}
        </div>

        <footer className={`${css.actions} ${dirty.size > 0 ? css.actionsVisible : ''}`} aria-live="polite">
          <span>{t('config.unsaved')}</span>
          <div><button type="button" className={css.discard} disabled={saving} onClick={discard}>{t('config.discard')}</button><button type="button" className={css.save} disabled={saving || error !== null || !writable} onClick={() => void save()}>{saving ? t('config.saving') : t('config.save')}</button></div>
        </footer>
        <p className={css.settingsNote}>{t('config.noticeBefore')} <code>.dsh/settings.yaml</code>{t('config.noticeAfter')}</p>
      </>}
    </section>
  )
}

function EmbeddingSettingsSection(props: {
  draft: Draft
  disabled: boolean
  connectionAvailable: boolean
  changing: boolean
  status: MnemonEmbeddingStatus | null
  state: 'unavailable' | 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  onEdit: (field: Field, value: string | boolean) => void
  onTest: () => void
  t: MnemonTranslate
}): JSX.Element {
  const feedback = props.changing
    ? props.t('config.embeddingSaveBeforeTest')
    : props.state === 'loading'
      ? props.t('config.embeddingTesting')
      : props.state === 'error'
        ? props.t('config.embeddingStatusFailed', { error: props.error ?? '' })
        : props.state === 'ready' && props.status !== null
          ? props.status.available
            ? props.status.protocol === undefined
              ? props.t('config.embeddingStatusAvailable', {
                  model: props.status.model,
                  embedded: props.status.embedded,
                  total: props.status.totalInsights,
                  coverage: props.status.coverage,
                })
              : props.t('config.embeddingStatusAvailableWithProtocol', {
                  model: props.status.model,
                  protocol: props.status.protocol,
                  embedded: props.status.embedded,
                  total: props.status.totalInsights,
                  coverage: props.status.coverage,
                })
            : props.status.protocol === undefined
              ? props.t('config.embeddingStatusUnavailable', {
                  model: props.status.model,
                  embedded: props.status.embedded,
                  total: props.status.totalInsights,
                  coverage: props.status.coverage,
                })
              : props.t('config.embeddingStatusUnavailableWithProtocol', {
                  model: props.status.model,
                  protocol: props.status.protocol,
                  embedded: props.status.embedded,
                  total: props.status.totalInsights,
                  coverage: props.status.coverage,
                })
          : props.state === 'unavailable'
            ? props.t('config.embeddingTestUnavailable')
            : props.t('config.embeddingNotTested')
  return <section className={css.embeddingSection} aria-labelledby="mnemon-embedding-heading">
    <div className={css.embeddingHeading}>
      <h3 id="mnemon-embedding-heading">{props.t('config.embeddingTitle')}</h3>
      <p>{props.t('config.embeddingDescription')}</p>
    </div>
    <ToggleRow
      id="mnemon-embedding-managed"
      label={props.t('config.embeddingManaged')}
      hint={props.t('config.embeddingManagedHint')}
      checked={props.draft.embeddingEnabled}
      disabled={props.disabled}
      onChange={value => props.onEdit('embeddingEnabled', value)}
    />
    <div className={css.providerIdentityFields}>
      <label>
        {props.t('config.embeddingEndpoint')}
        <input
          type="url"
          aria-label={props.t('config.embeddingEndpoint')}
          aria-invalid={props.draft.embeddingEnabled && !validEmbeddingEndpoint(props.draft.embeddingEndpoint)}
          value={props.draft.embeddingEndpoint}
          disabled={props.disabled || !props.draft.embeddingEnabled}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          placeholder={DEFAULT_EMBEDDING_ENDPOINT}
          onChange={event => props.onEdit('embeddingEndpoint', event.target.value)}
        />
      </label>
      <label>
        {props.t('config.embeddingModel')}
        <input
          type="text"
          aria-label={props.t('config.embeddingModel')}
          aria-invalid={props.draft.embeddingEnabled && !validEmbeddingModel(props.draft.embeddingModel)}
          value={props.draft.embeddingModel}
          disabled={props.disabled || !props.draft.embeddingEnabled}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          placeholder={DEFAULT_EMBEDDING_MODEL}
          onChange={event => props.onEdit('embeddingModel', event.target.value)}
        />
      </label>
      <label>
        {props.t('config.embeddingProtocol')}
        <select
          aria-label={props.t('config.embeddingProtocol')}
          value={props.draft.embeddingProtocol}
          disabled={props.disabled || !props.draft.embeddingEnabled}
          onChange={event => props.onEdit('embeddingProtocol', event.target.value)}
        >
          <option value="auto">{props.t('config.embeddingProtocolAuto')}</option>
          <option value="ollama">{props.t('config.embeddingProtocolOllama')}</option>
          <option value="openai">{props.t('config.embeddingProtocolOpenai')}</option>
        </select>
      </label>
      <label>
        {props.t('config.embeddingApiKey')}
        <input
          type="password"
          aria-label={props.t('config.embeddingApiKey')}
          aria-invalid={props.draft.embeddingEnabled && !validEmbeddingApiKey(props.draft.embeddingApiKey)}
          value={props.draft.embeddingApiKey}
          disabled={props.disabled || !props.draft.embeddingEnabled}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="sk-…"
          onChange={event => props.onEdit('embeddingApiKey', event.target.value)}
        />
      </label>
    </div>
    <p className={css.embeddingSecurity}>{props.t('config.embeddingSecurity')}</p>
    <div className={css.embeddingTest} aria-live="polite">
      <span className={props.state === 'error' ? css.error : undefined} role={props.state === 'error' ? 'alert' : undefined}>{feedback}</span>
      <button
        type="button"
        className={css.textButton}
        disabled={props.disabled || !props.connectionAvailable || props.changing || props.state === 'loading'}
        onClick={props.onTest}
      >{props.t('config.embeddingTest')}</button>
    </div>
  </section>
}

function MemoryTopologySection(props: {
  descriptor: MemorySystemDescriptor | null
  topology: MemoryTopologyDefinition | null
  state: 'unavailable' | 'loading' | 'ready' | 'error'
  disabled: boolean
  onEnabled: (layerId: string, enabled: boolean) => void
  t: MnemonTranslate
}): JSX.Element {
  const layerDescriptors = new Map(props.descriptor?.catalog.layers.map(layer => [layer.id, layer]) ?? [])

  const builtInCopy = (layerId: string): { label: string; description: string } | undefined => {
    if (layerId === 'runtime') return { label: props.t('layers.runtimeLabel'), description: props.t('layers.runtimeDescription') }
    if (layerId === 'documents') return { label: props.t('layers.documentsLabel'), description: props.t('layers.documentsDescription') }
    if (layerId === 'memory-spaces') return { label: props.t('layers.memorySpacesLabel'), description: props.t('layers.memorySpacesDescription') }
    return undefined
  }

  return <section className={css.section} aria-labelledby="mnemon-topology-heading">
    <div className={css.sectionHeading}>
      <div><h2 id="mnemon-topology-heading">{props.t('config.topologyTitle')}</h2><p>{props.t('config.topologyDescription')}</p></div>
      {props.state === 'loading' && <span className={css.miniSpinner} aria-hidden="true" />}
    </div>
    {props.topology === null
      ? <p className={css.topologyUnavailable}>{props.state === 'loading' ? props.t('config.topologyLoading') : props.t('config.topologyUnavailable')}</p>
      : <>
        <div className={css.topologyList}>
          {props.topology.layers.map(layer => {
            const descriptor = layerDescriptors.get(layer.id)
            const copy = builtInCopy(layer.id)
            const label = copy?.label ?? descriptor?.label ?? layer.id
            const description = copy?.description ?? descriptor?.description ?? layer.id
            return <article className={css.topologyLayer} data-enabled={layer.enabled} key={layer.id}>
              <header>
                <span><strong>{label}</strong><small>{description}</small></span>
                <label className={css.topologyToggle} htmlFor={`mnemon-layer-${layer.id}`}>
                  <span>{layer.enabled ? props.t('config.topologyEnabled') : props.t('config.topologyDisabled')}</span>
                  <input id={`mnemon-layer-${layer.id}`} type="checkbox" aria-label={props.t('config.topologyLayerToggle', { layer: label })} checked={layer.enabled} disabled={props.disabled} onChange={event => props.onEnabled(layer.id, event.target.checked)} />
                  <i aria-hidden="true" />
                </label>
              </header>
            </article>
          })}
        </div>
      </>}
  </section>
}

function TaskAgentModelSection(props: {
  draft: Draft
  catalog: TaskAgentModelCatalog | null
  state: 'unavailable' | 'loading' | 'ready' | 'error'
  error: string | null
  disabled: boolean
  fullCatalogLoaded: boolean
  onLoadCatalog: () => void
  onEdit: (field: Field, value: string | boolean) => void
  onEditMany: (values: Partial<Draft>) => void
  t: MnemonTranslate
}): JSX.Element {
  const groups = props.catalog?.groups ?? []
  const group = groups.find(candidate => candidate.id === props.draft.taskAgentProvider)
  const inherited = props.catalog?.defaultSelection
    ?? (props.catalog?.effective?.source === 'fixed' ? undefined : props.catalog?.effective)
  const effective = props.draft.taskAgentModelMode === 'fixed'
    ? (props.draft.taskAgentProvider.trim() === '' || props.draft.taskAgentModel.trim() === '' ? undefined : { provider: props.draft.taskAgentProvider, model: props.draft.taskAgentModel })
    : inherited

  const chooseFixed = (): void => {
    const preferredProvider = props.draft.taskAgentProvider
      || inherited?.provider
      || groups[0]?.id
      || ''
    const models = groups.find(candidate => candidate.id === preferredProvider)?.models ?? []
    const preferredModel = props.draft.taskAgentModel
      || (inherited?.provider === preferredProvider ? inherited.model : undefined)
      || models[0]?.id
      || ''
    props.onEditMany({ taskAgentModelMode: 'fixed', taskAgentProvider: preferredProvider, taskAgentModel: preferredModel })
    if (!props.fullCatalogLoaded) props.onLoadCatalog()
  }
  const chooseProvider = (provider: string): void => {
    const models = groups.find(candidate => candidate.id === provider)?.models ?? []
    props.onEditMany({ taskAgentProvider: provider, taskAgentModel: models[0]?.id ?? '' })
  }

  return <section className={css.section} aria-labelledby="mnemon-task-agent-heading">
    <div className={css.sectionHeading}>
      <div><h2 id="mnemon-task-agent-heading">{props.t('config.taskAgentTitle')}</h2><p>{props.t('config.taskAgentDescription')}</p></div>
      {props.state === 'loading' && <span className={css.miniSpinner} aria-hidden="true" />}
    </div>
    <div className={css.choiceGrid} role="radiogroup" aria-label={props.t('config.taskAgentModeAria')}>
      <ChoiceCard id="mnemon-task-agent-inherit" name="mnemon-task-agent" label={props.t('config.taskAgentInherit')} detail={props.t('config.taskAgentInheritHint')} checked={props.draft.taskAgentModelMode === 'inherit'} disabled={props.disabled} onChange={() => props.onEditMany({ taskAgentModelMode: 'inherit' })} />
      <ChoiceCard id="mnemon-task-agent-fixed" name="mnemon-task-agent" label={props.t('config.taskAgentFixed')} detail={props.t('config.taskAgentFixedHint')} checked={props.draft.taskAgentModelMode === 'fixed'} disabled={props.disabled || props.state === 'unavailable'} onChange={chooseFixed} />
    </div>
    <div className={css.taskAgentPanel} data-mode={props.draft.taskAgentModelMode}>
      {props.draft.taskAgentModelMode === 'fixed' && <div className={css.taskAgentFields}>
        <label>
          <span><strong>{props.t('config.taskAgentProvider')}</strong><small>{props.t('config.taskAgentProviderHint')}</small></span>
          <select aria-label={props.t('config.taskAgentProvider')} value={props.draft.taskAgentProvider} disabled={props.disabled || props.state !== 'ready'} onChange={event => chooseProvider(event.target.value)}>
            <option value="">{props.t('config.taskAgentChooseProvider')}</option>
            {props.draft.taskAgentProvider !== '' && !groups.some(candidate => candidate.id === props.draft.taskAgentProvider) && <option value={props.draft.taskAgentProvider}>{props.draft.taskAgentProvider}</option>}
            {groups.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
        <label>
          <span><strong>{props.t('config.taskAgentModel')}</strong><small>{props.t('config.taskAgentModelHint')}</small></span>
          <select aria-label={props.t('config.taskAgentModel')} value={props.draft.taskAgentModel} disabled={props.disabled || props.state !== 'ready' || group === undefined} onChange={event => props.onEdit('taskAgentModel', event.target.value)}>
            <option value="">{props.t('config.taskAgentChooseModel')}</option>
            {props.draft.taskAgentModel !== '' && !group?.models.some(model => model.id === props.draft.taskAgentModel) && <option value={props.draft.taskAgentModel}>{props.draft.taskAgentModel}</option>}
            {(group?.models ?? []).map(model => <option key={model.id} value={model.id}>{model.name}{model.inputModalities?.includes('image') === true ? ` · ${props.t('config.taskAgentImageInput')}` : ''}</option>)}
          </select>
        </label>
      </div>}
      <div className={css.taskAgentEffective}>
        <span>{props.t('config.taskAgentEffective')}</span>
        {effective === undefined
          ? <small>{props.state === 'loading' ? props.t('config.taskAgentLoading') : props.t('config.taskAgentUnavailable')}</small>
          : <code>{effective.provider} / {effective.model}</code>}
      </div>
      {props.state === 'error' && <p className={css.taskAgentWarning}>{props.t('config.taskAgentLoadFailed', { error: props.error ?? '' })}</p>}
      {(props.catalog?.failures.length ?? 0) > 0 && groups.length > 0 && <p className={css.taskAgentWarning}>{props.t('config.taskAgentPartial', { count: props.catalog!.failures.length })}</p>}
    </div>
  </section>
}

function ChoiceCard(props: { id: string; name: string; label: string; detail: string; checked: boolean; disabled: boolean; onChange: () => void }): JSX.Element {
  return <label className={css.choiceCard} htmlFor={props.id}><input id={props.id} name={props.name} type="radio" aria-label={props.label} checked={props.checked} disabled={props.disabled} onChange={props.onChange} /><span className={css.choiceFace}><strong>{props.label}</strong><small>{props.detail}</small><span className={css.check} aria-hidden="true">✓</span></span></label>
}

function ToggleRow(props: { id: string; label: string; hint: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return <label className={css.toggleRow} htmlFor={props.id}><span className={css.settingCopy}><strong>{props.label}</strong><small>{props.hint}</small></span><input id={props.id} type="checkbox" aria-label={props.label} checked={props.checked} disabled={props.disabled} onChange={event => props.onChange(event.target.checked)} /><span className={css.switch} aria-hidden="true"><i /></span></label>
}
