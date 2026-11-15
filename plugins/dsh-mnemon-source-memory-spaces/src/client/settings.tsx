import { css as pageCss, languageChain, settingsTranslate, SourceTranslation, supportsSettingsSection, useT, type DshLocale } from './presentation.ts'
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  Callout, installMemoryComponentUI, MemorySourcePageFrame, memorySettingsStyles, message,
  PanelActions, SelectField, ToggleRow, useLive, useStaged, WriteFailure,
  type MemoryComponentHost, type MemoryComponentSettingsProps, type MemoryComponentUIContext,
} from 'dsh-mnemon/client'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import {
  DEFAULT_EMBEDDING_ENDPOINT, DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_PROTOCOL,
  DEFAULT_RECALL_LIMIT, DEFAULT_RECALL_QUALITY_POLICY, DEFAULT_TIMEOUT_MS,
  EMBEDDING_ENVIRONMENT_NAME, MNEMON_EMBEDDING_PROTOCOLS, NATIVE_PROVIDER_ID,
  type MemoryPersistenceStrategy, type MemoryProviderDescriptor, type MemoryProviderServiceCatalog,
  type MnemonEmbeddingFill, type MnemonEmbeddingSettingsView, type MnemonEmbeddingSpaceStatus,
  type MnemonEmbeddingStatus, type RecallQualityConfig,
} from '../contracts.ts'
import {
  PlacementModeFieldset, PlacementTargetControls, cleanJson, createPlacementPolicyDraft,
  nativeFallbackProvider, placementPolicyProblem, serializePlacementPolicy, type PlacementPolicyDraft,
} from './placement-policy.tsx'
import { ProviderIcon } from './ProviderIcon.tsx'
import { ProviderSettingsSection } from './provider-settings.tsx'
import { memorySpacesSettingsClient } from './settings-client.ts'
import { mergeProviderDefaults } from './widgets.tsx'

/** The package these settings belong to, as Memory Spaces' plugin declaration names it. */
const PACKAGE_NAME = 'dsh-mnemon-source-memory-spaces'

/**
 * Whether dsh-mnemon yields the settings it keeps for Memory Spaces to these.
 * One that exports the priority it keeps them at promises both that they do
 * not collide with these and that it lends these `host`. dsh-mnemon 0.5.31 and
 * earlier draw them itself and lend nothing, so registering them there would
 * show a second, unworkable copy.
 */
export function yieldsComponentSettings(client: { readonly MNEMON_COMPONENT_FALLBACK_PRIORITY?: unknown }): boolean {
  return typeof client.MNEMON_COMPONENT_FALLBACK_PRIORITY === 'number'
}

/** Memory Spaces' own settings on its page under Plugins: its Providers and the embedding Mnemon Native reads. */
export function installMemorySpacesSettings(ctx: MemoryComponentUIContext & { locale?: DshLocale | undefined }): () => void {
  const { locale } = ctx
  return installMemoryComponentUI(ctx, { packageName: PACKAGE_NAME, settings: props => <MemorySpacesSettings {...props} {...(locale === undefined ? {} : { locale })} /> })
}

const RECALL_POLICY_IDS = ['strict-v1', 'balanced-v1', 'exhaustive-v1'] as const
type RecallPolicyId = typeof RECALL_POLICY_IDS[number]

function isRecallPolicyId(value: string | undefined): value is RecallPolicyId {
  return value !== undefined && (RECALL_POLICY_IDS as readonly string[]).includes(value)
}

/** The configuration keys these settings read, as dsh-mnemon lends them. */
interface SpacesConfiguration {
  embedding?: MnemonEmbeddingSettingsView
  persistenceStrategy?: MemoryPersistenceStrategy
  defaultRecallLimit?: number
  recallQuality?: RecallQualityConfig & {
    policy?: RecallPolicyId | string
    minFinalScore?: number
    relativeBestRatio?: number
    fallbackTopK?: number
    minAnchorLexicalScore?: number
  }
  timeoutMs?: number
  storageScope?: string
  writeEnabled?: boolean
}

/** The embedding connection DSH manages for Mnemon Native. */
interface EmbeddingDraft {
  endpoint: string
  model: string
  apiKey: string
  apiKeyEnv: string
  clearApiKey: boolean
  protocol: string
}

interface RecallDraft {
  defaultRecallLimit: string
  policy: RecallPolicyId
  timeoutMs: string
}

function embeddingDraft(value: SpacesConfiguration | undefined): EmbeddingDraft {
  const embedding = value?.embedding
  return {
    endpoint: embedding?.endpoint?.trim() || DEFAULT_EMBEDDING_ENDPOINT,
    model: embedding?.model?.trim() || DEFAULT_EMBEDDING_MODEL,
    apiKey: '',
    apiKeyEnv: embedding?.apiKeyEnv ?? '',
    clearApiKey: false,
    protocol: embedding?.protocol ?? DEFAULT_EMBEDDING_PROTOCOL,
  }
}

function recallDraft(value: SpacesConfiguration | undefined): RecallDraft {
  return {
    defaultRecallLimit: String(value?.defaultRecallLimit ?? DEFAULT_RECALL_LIMIT),
    policy: isRecallPolicyId(value?.recallQuality?.policy) ? value.recallQuality.policy : DEFAULT_RECALL_QUALITY_POLICY,
    timeoutMs: String(value?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  }
}

function parseStrictInteger(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!/^\d+$/u.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function validRecallLimit(raw: string): boolean {
  const parsed = parseStrictInteger(raw)
  return parsed !== undefined && parsed >= 1 && parsed <= 50
}

function validTimeoutMs(raw: string): boolean {
  const parsed = parseStrictInteger(raw)
  return parsed !== undefined && parsed >= 100 && parsed <= 120_000
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

const validProtocol = (protocol: string): boolean => MNEMON_EMBEDDING_PROTOCOLS.includes(protocol as typeof MNEMON_EMBEDDING_PROTOCOLS[number])

type Translate = ReturnType<typeof useT>

function embeddingProblem(draft: EmbeddingDraft, t: Translate): string | null {
  if (!validEmbeddingEndpoint(draft.endpoint)) return t('config.embeddingEndpointInvalid')
  if (!validEmbeddingModel(draft.model)) return t('config.embeddingModelInvalid')
  if (!validEmbeddingApiKey(draft.apiKey)) return t('config.embeddingApiKeyInvalid')
  if (draft.apiKeyEnv.trim() && !EMBEDDING_ENVIRONMENT_NAME.test(draft.apiKeyEnv.trim())) return t('config.embeddingEnvInvalid')
  if (draft.apiKey.trim() && draft.apiKeyEnv.trim()) return t('config.embeddingAuthChoice')
  if (!validProtocol(draft.protocol)) return t('config.embeddingProtocolInvalid')
  return null
}

function recallProblem(draft: RecallDraft, t: Translate): string | null {
  if (!validRecallLimit(draft.defaultRecallLimit)) return t('config.defaultRecallLimitInvalid')
  if (!validTimeoutMs(draft.timeoutMs)) return t('config.timeoutMsInvalid')
  return null
}

/** The stored value: a switched-off override keeps only the fields that are valid. */
function embeddingValue(enabled: boolean, draft: EmbeddingDraft, secure: boolean, legacyKey = ''): MemoryJsonValue {
  const auth = secure ? { apiKey: draft.apiKey.trim(), apiKeyEnv: draft.apiKeyEnv.trim(), ...(draft.clearApiKey ? { clearApiKey: true } : {}) } : { apiKey: legacyKey }
  const endpoint = draft.endpoint.trim().replace(/\/+$/u, '')
  if (enabled) return { enabled: true, endpoint, model: draft.model.trim(), protocol: draft.protocol, ...auth }
  return {
    enabled: false,
    ...(validEmbeddingEndpoint(draft.endpoint) ? { endpoint } : {}),
    ...(validEmbeddingModel(draft.model) ? { model: draft.model.trim() } : {}),
    ...(validProtocol(draft.protocol) ? { protocol: draft.protocol } : {}),
    ...(validEmbeddingApiKey(draft.apiKey) ? auth : {}),
  }
}

/**
 * Memory Spaces' own settings: the Providers that store its spaces, Mnemon
 * Native first with the embedding runtime only Native reads, default Space
 * placement policy, and recall/timeout parameters. They need what dsh-mnemon
 * lends them; without it they show nothing. With DSH's language service they
 * translate as dsh-mnemon drew them, through its language chain.
 */
export function MemorySpacesSettings(props: MemoryComponentSettingsProps & { locale?: DshLocale | undefined }): ReactNode {
  if (props.host === undefined) return null
  return <MemorySourcePageFrame locale={props.language}>
    <SettingsTranslation locale={props.locale} language={props.language}><SpacesSettings page={props} host={props.host} /></SettingsTranslation>
  </MemorySourcePageFrame>
}

const noLocaleChanges = (): (() => void) => () => {}

function SettingsTranslation(props: { locale: DshLocale | undefined; language: string; children: ReactNode }): JSX.Element {
  const { locale, language } = props
  const subscribe = useCallback((listener: () => void) => locale?.subscribe?.(listener) ?? noLocaleChanges(), [locale])
  // The chain as text, so a changed snapshot that keeps the chain renders nothing again.
  const getChain = useCallback(() => {
    const snapshot = locale?.getSnapshot?.()
    return snapshot === undefined ? '' : languageChain(snapshot).join('\n')
  }, [locale])
  const chain = useSyncExternalStore(subscribe, getChain, getChain)
  const translate = useMemo(() => locale === undefined ? undefined : settingsTranslate(locale, chain === '' ? undefined : chain.split('\n'), language), [locale, chain, language])
  return <SourceTranslation value={translate}>{props.children}</SourceTranslation>
}

// Whether the Host found the Mnemon CLI, in the host's retained store under a name every Memory Spaces version
// reads alike. It is kept only while a mount lasts, for the mount that replaces it.
const RETAINED_CLI = 'status-summary'
const RETAINED_PROVIDERS = 'provider-services'

function SpacesSettings({ page, host }: { page: MemoryComponentSettingsProps; host: MemoryComponentHost }): JSX.Element {
  const t = useT()
  // Read where it is drawn: a dsh-mnemon without this export (0.5.31) never draws these settings, and this
  // bundle's pages must still load beside it.
  const css = memorySettingsStyles
  const { configuration, retained } = host
  const snapshot = useSyncExternalStore(configuration.subscribe, configuration.getSnapshot, configuration.getSnapshot)
  const value = snapshot.value as SpacesConfiguration | undefined
  const client = useMemo(() => host.operations === undefined ? undefined : memorySpacesSettingsClient(host.operations), [host.operations])
  const saved = embeddingDraft(value)
  const secure = value?.embedding?.apiKeyStorage !== undefined
  const legacy = value?.embedding?.apiKeyStorage === 'legacy'
  const connectionValue = (enabled: boolean, draft: EmbeddingDraft) => embeddingValue(enabled, draft, secure, value?.embedding?.apiKey)
  const managedSaved = value?.embedding?.enabled === true
  // Whether DSH manages the embedding is a switch: it applies at once, with the saved connection.
  const managed = useLive(managedSaved, async enabled => { await configuration.set('embedding', connectionValue(enabled, saved)) })
  // The connection is typed, so it waits for its Apply.
  const form = useStaged(saved, async draft => {
    await configuration.set('embedding', connectionValue(managedSaved, draft))
    // A saved key is write-only; never leave it in the staged editor after success.
    form.edit({ apiKey: '', clearApiKey: false })
  })
  const [nativeCliFound, setNativeCliFound] = useState<boolean | undefined>(() => (retained.get(RETAINED_CLI) as { commandFound?: boolean } | undefined)?.commandFound)
  const [providerCatalog, setProviderCatalog] = useState<MemoryProviderServiceCatalog | undefined>(() =>
    client === undefined ? undefined : retained.get(RETAINED_PROVIDERS) as MemoryProviderServiceCatalog | undefined,
  )
  const [status, setStatus] = useState<{ state: 'idle' | 'loading' | 'ready' | 'error'; value?: MnemonEmbeddingStatus; error?: string }>({ state: 'idle' })
  const [fill, setFill] = useState<EmbeddingFillState | undefined>(undefined)
  const [policyOpen, setPolicyOpen] = useState(() => page.section === 'policy')
  const [recallOpen, setRecallOpen] = useState(() => page.section === 'recall')
  const statusRequest = useRef(0)
  useEffect(() => {
    if (page.section === 'policy') setPolicyOpen(true)
    if (page.section === 'recall') setRecallOpen(true)
  }, [page.section])
  const on = page.component.enabled
  // As dsh-mnemon's isWorkspaceStorageScope, which lives in its Host protocol, outside its public client.
  const activeScope = value?.storageScope === 'workspace' || value?.storageScope === 'workspaces' ? 'workspace' : 'global'
  const workspaceIdentity = activeScope === 'workspace'
    ? ((page.workspace as { id?: string; path?: string; label?: string } | undefined)?.id
      ?? (page.workspace as { path?: string } | undefined)?.path
      ?? page.workspace?.label
      ?? '')
    : ''
  const embeddingSignature = JSON.stringify([
    value?.embedding?.enabled ?? false,
    value?.embedding?.endpoint ?? '',
    value?.embedding?.model ?? '',
    value?.embedding?.protocol ?? '',
    value?.embedding?.apiKeyStorage ?? '',
    value?.embedding?.apiKeyConfigured ?? false,
    value?.embedding?.apiKeyEnv ?? '',
  ])
  const providerScopeKey = `${activeScope}:${workspaceIdentity}`
  const lastProviderScopeKey = useRef(providerScopeKey)
  const providerRefreshKeyRef = useRef(0)
  if (lastProviderScopeKey.current !== providerScopeKey) {
    lastProviderScopeKey.current = providerScopeKey
    providerRefreshKeyRef.current += 1
  }

  const fallbackProvider = useMemo(() => nativeFallbackProvider(t, nativeCliFound !== false), [nativeCliFound, t])
  const policyProviders = useMemo<MemoryProviderDescriptor[]>(() => {
    if (providerCatalog === undefined || providerCatalog.providers.length === 0) return [fallbackProvider]
    const serviceById = new Map(providerCatalog.items.map(item => [item.providerId, item]))
    return [
      fallbackProvider,
      ...providerCatalog.providers
        .filter(provider => provider.id !== NATIVE_PROVIDER_ID)
        .map(provider => {
          const item = serviceById.get(provider.id)
          return { ...provider, serviceConfigured: item !== undefined && item.enabled && item.configured }
        }),
    ]
  }, [fallbackProvider, providerCatalog])
  const policySaved = useMemo(
    () => createPlacementPolicyDraft(value?.persistenceStrategy, policyProviders),
    [policyProviders, value?.persistenceStrategy],
  )
  const policyForm = useStaged(policySaved, async draft => {
    const merged: PlacementPolicyDraft = {
      ...draft,
      providerConnections: mergeProviderDefaults(policyProviders, draft.providerConnections),
    }
    await configuration.set('persistenceStrategy', cleanJson(serializePlacementPolicy(merged, policyProviders)))
    host.changed()
  })
  const effectivePolicyDraft = useMemo<PlacementPolicyDraft>(() => ({
    ...policyForm.draft,
    providerConnections: mergeProviderDefaults(policyProviders, policyForm.draft.providerConnections),
  }), [policyForm.draft, policyProviders])

  const recallSaved = useMemo(() => recallDraft(value), [value?.defaultRecallLimit, value?.recallQuality?.policy, value?.timeoutMs])
  const recallForm = useStaged(recallSaved, async draft => {
    const nextLimit = parseStrictInteger(draft.defaultRecallLimit) ?? DEFAULT_RECALL_LIMIT
    const nextTimeout = parseStrictInteger(draft.timeoutMs) ?? DEFAULT_TIMEOUT_MS
    let wrote = false
    if (nextLimit !== (value?.defaultRecallLimit ?? DEFAULT_RECALL_LIMIT)) {
      await configuration.set('defaultRecallLimit', nextLimit)
      wrote = true
    }
    const savedPolicy = isRecallPolicyId(value?.recallQuality?.policy) ? value.recallQuality.policy : DEFAULT_RECALL_QUALITY_POLICY
    if (draft.policy !== savedPolicy) {
      await configuration.set('recallQuality', cleanJson({ ...(value?.recallQuality ?? {}), policy: draft.policy }))
      wrote = true
    }
    if (nextTimeout !== (value?.timeoutMs ?? DEFAULT_TIMEOUT_MS)) {
      await configuration.set('timeoutMs', nextTimeout)
      wrote = true
    }
    recallForm.edit({ defaultRecallLimit: String(nextLimit), timeoutMs: String(nextTimeout) })
    if (wrote) host.changed()
  })

  useEffect(() => {
    if (client === undefined || !on) { setNativeCliFound(undefined); setProviderCatalog(undefined); retained.delete(RETAINED_CLI); return }
    let current = true
    void client.statusSummary().then(summary => {
      if (!current) return
      setNativeCliFound(summary.commandFound)
      retained.set(RETAINED_CLI, { commandFound: summary.commandFound })
    }, () => { if (current) { setNativeCliFound(undefined); retained.delete(RETAINED_CLI) } })
    return () => { current = false }
  }, [activeScope, client, on, retained, workspaceIdentity])

  // A page opened again finds out anew, as it always has; only a mount that replaces this one starts from it.
  useEffect(() => () => {
    retained.delete(RETAINED_CLI)
  }, [retained])

  useEffect(() => {
    statusRequest.current += 1
    setStatus({ state: 'idle' })
    setFill(undefined)
  }, [activeScope, client, embeddingSignature, on, workspaceIdentity])

  // Providers are read only while their Source runs; the page's switch turns it on.
  if (!on) return <p className={css.panelNote}>{t('spaces.offNote')}</p>

  const test = (): void => {
    if (client === undefined) return
    const request = statusRequest.current + 1
    statusRequest.current = request
    // The list stays while it is counted again, so a fill's refresh does not make it jump.
    setStatus(previous => ({ state: 'loading', ...(previous.value === undefined ? {} : { value: previous.value }) }))
    void client.embeddingStatus().then(
      value => { if (statusRequest.current === request) setStatus({ state: 'ready', value }) },
      reason => { if (statusRequest.current === request) setStatus({ state: 'error', error: message(reason) }) },
    )
  }
  // A fill runs through the Host, with its data directory and embedding settings; the counts are read again after it.
  const fillSpace = (space: MnemonEmbeddingSpaceStatus): void => {
    if (client === undefined || fill?.state === 'running') return
    const target = { memoryBodyId: space.memoryBodyId, name: space.name }
    setFill({ ...target, state: 'running' })
    void client.fillEmbeddings(space.memoryBodyId).then(
      result => { setFill({ ...target, state: 'done', result }); test() },
      reason => { setFill({ ...target, state: 'failed', error: message(reason) }); test() },
    )
  }
  const readOnly = value?.writeEnabled === false
  const disabled = !page.writable || snapshot.status === 'loading' || !snapshot.writable
  const cliMissing = nativeCliFound === false
  const handleProviderChanged = (): void => {
    host.changed()
  }

  return <>
    <section className={css.panelSection} data-settings-section="providers" aria-labelledby="mnemon-spaces-providers">
      <div className={css.panelHeading}><h3 id="mnemon-spaces-providers">{t('config.providersTitle')}</h3><p>{t('config.providersDescription')}</p></div>
      <ProviderSettingsSection
        client={client}
        retained={retained}
        {...(activeScope !== 'workspace' || page.workspace?.label === undefined ? {} : { workspaceLabel: page.workspace.label })}
        activeScope={activeScope}
        refreshKey={providerRefreshKeyRef.current}
        disabled={disabled || readOnly}
        scopeChanging={false}
        onChanged={handleProviderChanged}
        onCatalog={setProviderCatalog}
        {...(readOnly ? { notice: <Callout tone="warning" className={css.groupCallout} title={t('config.providersReadOnlyTitle')}>{t('config.providersReadOnlyDetail')}</Callout> } : {})}
        leading={<NativeProviderCard activeScope={activeScope} cliMissing={cliMissing} t={t}>
          <EmbeddingEditor secure={secure} credentialSaved={value?.embedding?.apiKeyStorage === 'credentials'} managed={managed.value} draft={form.draft} disabled={disabled} connectionAvailable={client !== undefined} cliMissing={cliMissing} changing={form.dirty}
            status={status} t={t} onEdit={form.edit} onTest={() => { setFill(undefined); test() }}
            canFill={!disabled && !readOnly} fill={fill} onFill={fillSpace}
            onManaged={on => { if (!on) form.discard(); managed.set(on) }}
            actions={<>
              <WriteFailure error={managed.failed} t={t} />
              {legacy && !form.dirty && <Button variant="outline" size="sm" disabled={disabled || form.saving} onClick={() => { void form.apply() }}>{t('config.embeddingMigrateKey')}</Button>}
              <PanelActions dirty={form.dirty} saving={form.saving} invalid={embeddingProblem(form.draft, t)} failed={form.failed} applied={form.applied}
                disabled={disabled} t={t} onDiscard={form.discard} onApply={() => { void form.apply() }} />
            </>} />
        </NativeProviderCard>}
      />
    </section>

    {supportsSettingsSection('policy') && <section className={`${css.panelSection} ${pageCss.settingsSection} ${pageCss.settingsPolicy}`} data-settings-section="policy" data-open={policyOpen ? '' : undefined} aria-labelledby="mnemon-spaces-policy">
      <button type="button" className={pageCss.settingsPolicyToggle} aria-expanded={policyOpen}
        {...(policyOpen ? { 'aria-controls': 'mnemon-spaces-policy-body' } : {})}
        data-disclosure-open={policyOpen ? undefined : ''} onClick={() => setPolicyOpen(open => !open)}>
        <span className={pageCss.settingsPolicyHeading}>
          <strong id="mnemon-spaces-policy">{t('config.policyTitle')}</strong>
          <small>{t('config.policyDescription')}</small>
        </span>
        <span className={pageCss.settingsPolicyMeta}>
          <span className={pageCss.settingsPolicyBadge}>{t(effectivePolicyDraft.mode === 'automatic' ? 'overview.placementAutomatic' : 'overview.placementManual')}</span>
          <IconChevronDownOutlineRegular className={pageCss.smoothChevron} size={14} />
        </span>
      </button>
      {policyOpen && <div id="mnemon-spaces-policy-body" className={`${pageCss.settingsPolicyBody} ${pageCss.inlineExpand}`}>
        <PlacementModeFieldset mode={effectivePolicyDraft.mode} radioGroupName="settings-persistence-mode" disabled={disabled || policyForm.saving} onChange={mode => policyForm.edit({ mode })} />
        <PlacementTargetControls draft={effectivePolicyDraft} providers={policyProviders} providerRadioGroupName="settings-strategy-provider" fieldLayout="settings" disabled={disabled || policyForm.saving} onChange={policyForm.edit} />
        <PanelActions dirty={policyForm.dirty} saving={policyForm.saving} invalid={placementPolicyProblem(effectivePolicyDraft, policyProviders, t)} failed={policyForm.failed} applied={policyForm.applied}
          disabled={disabled} t={t} onDiscard={policyForm.discard} onApply={() => { void policyForm.apply() }} />
      </div>}
    </section>}

    {supportsSettingsSection('recall') && <section className={`${css.panelSection} ${pageCss.settingsSection} ${pageCss.settingsRecall}`} data-settings-section="recall" data-open={recallOpen ? '' : undefined} aria-labelledby="mnemon-spaces-recall">
      <button type="button" className={pageCss.settingsPolicyToggle} aria-expanded={recallOpen} aria-labelledby="mnemon-spaces-recall"
        {...(recallOpen ? { 'aria-controls': 'mnemon-spaces-recall-body' } : {})}
        data-disclosure-open={recallOpen ? undefined : ''} onClick={() => setRecallOpen(open => !open)}>
        <span className={pageCss.settingsPolicyHeading}>
          <strong id="mnemon-spaces-recall">{t('config.recallTitle')}</strong>
          <small>{t('config.recallDescription')}</small>
        </span>
        <span className={pageCss.settingsPolicyMeta}>
          <IconChevronDownOutlineRegular className={pageCss.smoothChevron} size={14} />
        </span>
      </button>
      {recallOpen && <div id="mnemon-spaces-recall-body" className={`${pageCss.settingsPolicyBody} ${pageCss.inlineExpand}`}>
        <div className={pageCss.settingsRows}>
          <SpacesSettingRow htmlFor="mnemon-spaces-recall-limit" title={t('config.defaultRecallLimit')} hint={t('config.defaultRecallLimitHint')}>
            <input id="mnemon-spaces-recall-limit" className={pageCss.settingsNumberInput} type="number" inputMode="numeric" min={1} max={50} step={1}
              aria-label={t('config.defaultRecallLimit')} aria-invalid={!validRecallLimit(recallForm.draft.defaultRecallLimit)}
              value={recallForm.draft.defaultRecallLimit} disabled={disabled || recallForm.saving}
              onChange={event => recallForm.edit({ defaultRecallLimit: event.target.value })} />
          </SpacesSettingRow>
          <SpacesSelectRow id="mnemon-spaces-recall-policy" label={t('config.recallQualityPolicy')} value={recallForm.draft.policy} disabled={disabled || recallForm.saving}
            options={RECALL_POLICY_IDS.map(id => ({
              value: id,
              label: t(`config.recallPolicy.${id}`),
              detail: t(`config.recallPolicy.${id}.detail`),
            }))}
            onChange={policy => recallForm.edit({ policy })} />
          <SpacesSettingRow htmlFor="mnemon-spaces-timeout-ms" title={t('config.timeoutMs')} hint={t('config.timeoutMsHint')}>
            <input id="mnemon-spaces-timeout-ms" className={pageCss.settingsNumberInput} type="number" inputMode="numeric" min={100} max={120000} step={100}
              aria-label={t('config.timeoutMs')} aria-invalid={!validTimeoutMs(recallForm.draft.timeoutMs)}
              value={recallForm.draft.timeoutMs} disabled={disabled || recallForm.saving}
              onChange={event => recallForm.edit({ timeoutMs: event.target.value })} />
          </SpacesSettingRow>
        </div>
        <PanelActions dirty={recallForm.dirty} saving={recallForm.saving} invalid={recallProblem(recallForm.draft, t)} failed={recallForm.failed} applied={recallForm.applied}
          disabled={disabled} t={t} onDiscard={recallForm.discard} onApply={() => { void recallForm.apply() }} />
      </div>}
    </section>}
  </>
}

/**
 * Self-contained preference row & selector so Memory Spaces settings never
 * depend on post-0.5.46 `dsh-mnemon/client` exports when upgraded standalone.
 */
function SpacesSettingRow(props: { title: string; titleId?: string | undefined; hint?: ReactNode; htmlFor?: string | undefined; children?: ReactNode }): JSX.Element {
  const title = props.htmlFor === undefined
    ? <strong id={props.titleId}>{props.title}</strong>
    : <label id={props.titleId} htmlFor={props.htmlFor}><strong>{props.title}</strong></label>
  return <div className={pageCss.settingsRow}>
    <div className={pageCss.settingsRowCopy}>{title}{props.hint !== undefined && props.hint !== '' && <small>{props.hint}</small>}</div>
    {props.children !== undefined && <div className={pageCss.settingsRowControl}>{props.children}</div>}
  </div>
}

function SpacesSelectRow<T extends string>(props: {
  id: string
  label: string
  value: T
  options: readonly { value: T; label: string; detail?: string | undefined }[]
  disabled?: boolean | undefined
  onChange: (value: T) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const titleId = `${props.id}-title`
  const valueId = useId()
  const current = props.options.find(option => option.value === props.value)
  return <SpacesSettingRow title={props.label} titleId={titleId} hint={current?.detail}>
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      align="end"
      portal
      selectedId={props.value}
      listClassName={pageCss.settingsSelectMenu}
      items={props.options.map(option => ({
        id: option.value,
        label: option.detail === undefined ? option.label : <span className={pageCss.settingsSelectOption}><span>{option.label}</span><small>{option.detail}</small></span>,
      }))}
      onSelect={id => { setOpen(false); if (id !== props.value) props.onChange(id as T) }}
      anchor={<button type="button" className={pageCss.settingsSelector} aria-haspopup="menu" aria-expanded={open} aria-labelledby={`${titleId} ${valueId}`} disabled={props.disabled === true} onClick={() => setOpen(value => !value)}>
        <span id={valueId}>{current?.label ?? props.value}</span>
        <IconChevronDownOutlineRegular size={12} />
      </button>}
    />
  </SpacesSettingRow>
}

/** Mnemon Native, listed first among the Providers; its body holds the settings only Native reads. */
function NativeProviderCard(props: { activeScope: 'global' | 'workspace'; cliMissing: boolean; t: Translate; children: ReactNode }): JSX.Element {
  const css = memorySettingsStyles
  return <details className={css.providerRow} data-provider={NATIVE_PROVIDER_ID} data-native="">
    <summary className={css.providerRowHeader}>
      <span className={css.providerIdentity}><ProviderIcon providerId={NATIVE_PROVIDER_ID} icon={{ kind: 'brand', value: 'mnemon' }} className={css.providerMark} /><span><strong>{props.t('config.nativeName')}</strong><small>{props.t('config.nativeSummary')}</small></span></span>
      <span className={css.providerEnableControl}>
        <span className={css.providerScopeTag} data-scope={props.activeScope}>{props.t(`config.${props.activeScope}`)}</span>
        <span className={css.providerState} data-enabled={props.cliMissing ? undefined : ''}>{props.t(props.cliMissing ? 'config.nativeCliMissing' : 'config.officialNative')}</span>
        <IconChevronDownOutlineRegular className={`${css.providerChevron} ${pageCss.smoothChevron}`} size={14} />
      </span>
    </summary>
    <div className={css.providerInlineBody}>{props.children}</div>
  </details>
}

/** Selected-model usability and stored-vector coverage; the protocol appears only when the Host reports one. */
function embeddingStatusText(t: Translate, status: MnemonEmbeddingStatus): string {
  const coverage = { embedded: status.embedded, total: status.totalInsights, coverage: status.coverage }
  return status.protocol === undefined
    ? t(status.available ? 'config.embeddingStatusAvailable' : 'config.embeddingStatusUnavailable', { model: status.model, ...coverage })
    : t(status.available ? 'config.embeddingStatusAvailableWithProtocol' : 'config.embeddingStatusUnavailableWithProtocol', { model: status.model, protocol: status.protocol, ...coverage })
}

/** The embedding runtime: the switch applies at once; the connection fields, shown while DSH manages it, wait for Apply. */
function EmbeddingEditor(props: {
  secure: boolean
  credentialSaved: boolean
  managed: boolean
  draft: EmbeddingDraft
  disabled: boolean
  connectionAvailable: boolean
  /** The test runs the Mnemon CLI, which only Mnemon Native needs. */
  cliMissing: boolean
  changing: boolean
  status: { state: 'idle' | 'loading' | 'ready' | 'error'; value?: MnemonEmbeddingStatus; error?: string }
  /** Whether this page may fill in a space's vectors: it is writable and Mnemon takes writes. */
  canFill: boolean
  fill: EmbeddingFillState | undefined
  onFill: (space: MnemonEmbeddingSpaceStatus) => void
  t: Translate
  actions: ReactNode
  onManaged: (managed: boolean) => void
  onEdit: (values: Partial<EmbeddingDraft>) => void
  onTest: () => void
}): JSX.Element {
  const { draft, t, status } = props
  const css = memorySettingsStyles
  const feedback = props.cliMissing ? t('config.embeddingCliMissing')
    : props.changing ? t('config.embeddingSaveBeforeTest')
      : status.state === 'loading' ? t('config.embeddingTesting')
        : status.state === 'error' ? t('config.embeddingStatusFailed', { error: status.error ?? '' })
          : status.state === 'ready' && status.value !== undefined ? embeddingStatusText(t, status.value)
            : !props.connectionAvailable ? t('config.embeddingTestUnavailable') : t('config.embeddingNotTested')
  const text = (field: 'endpoint' | 'model' | 'apiKey' | 'apiKeyEnv', type: string, label: string, valid: boolean, placeholder: string): JSX.Element => <label>
    {label}
    <input type={type} aria-label={label} aria-invalid={!valid} value={draft[field]} disabled={props.disabled || ((field === 'apiKey' || field === 'apiKeyEnv') && (!props.secure || draft.clearApiKey))}
      autoComplete="off" spellCheck={false} autoCapitalize="none" autoCorrect="off" placeholder={placeholder}
      onChange={event => props.onEdit({ [field]: event.target.value })} />
  </label>
  return <section className={css.editor} aria-labelledby="mnemon-embedding-heading">
    <div className={css.editorHeading}>
      <h3 id="mnemon-embedding-heading">{t('config.embeddingTitle')}</h3>
      <p>{t('config.embeddingDescription')}</p>
    </div>
    <ToggleRow id="mnemon-embedding-managed" label={t('config.embeddingManaged')} hint={t('config.embeddingManagedHint')} checked={props.managed} disabled={props.disabled}
      onChange={props.onManaged} />
    {props.managed && <div className={`${pageCss.embeddingManagedBody} ${pageCss.inlineExpand}`}>
      <div className={css.fieldGrid}>
        {text('endpoint', 'url', t('config.embeddingEndpoint'), validEmbeddingEndpoint(draft.endpoint), DEFAULT_EMBEDDING_ENDPOINT)}
        {text('model', 'text', t('config.embeddingModel'), validEmbeddingModel(draft.model), DEFAULT_EMBEDDING_MODEL)}
        <SelectField label={t('config.embeddingProtocol')} value={draft.protocol} disabled={props.disabled} options={[
          { value: 'auto', label: t('config.embeddingProtocolAuto') },
          { value: 'ollama', label: t('config.embeddingProtocolOllama') },
          { value: 'openai', label: t('config.embeddingProtocolOpenai') },
        ]} onChange={protocol => props.onEdit({ protocol })} />
        {text('apiKey', 'password', t('config.embeddingApiKey'), validEmbeddingApiKey(draft.apiKey), t('config.embeddingKeyPlaceholder'))}
        {props.secure && text('apiKeyEnv', 'text', t('config.embeddingApiKeyEnv'), !draft.apiKeyEnv.trim() || EMBEDDING_ENVIRONMENT_NAME.test(draft.apiKeyEnv.trim()), 'MY_EMBEDDING_API_KEY')}
      </div>
      {props.secure ? <>
        {props.credentialSaved && <p className={css.editorNote}>{t('config.embeddingCredentialSaved')}</p>}
        <label className={css.providerBoolean}><input type="checkbox" checked={draft.clearApiKey} disabled={props.disabled} onChange={event => props.onEdit({ clearApiKey: event.target.checked, apiKey: '', apiKeyEnv: '' })} /><span>{t('config.embeddingClearKey')}</span></label>
      </> : <p className={css.editorNote}>{t('config.embeddingUpgradeHost')}</p>}
      <p className={css.editorNote}>{t('config.embeddingSecurity')}</p>
    </div>}
    {props.actions}
    <div className={css.embeddingTest} aria-live="polite">
      <span className={status.state === 'error' ? css.error : undefined} role={status.state === 'error' ? 'alert' : undefined}>{feedback}</span>
      <Button variant="outline" size="sm" disabled={props.disabled || !props.connectionAvailable || props.cliMissing || props.changing || status.state === 'loading' || props.fill?.state === 'running'}
        onClick={props.onTest}>
        {t('config.embeddingTest')}
      </Button>
    </div>
    {!props.cliMissing && !props.changing && (status.state === 'ready' || status.state === 'loading') && (status.value?.spaces ?? []).length > 0
      && <EmbeddingSpaces spaces={status.value!.spaces!} available={status.value!.available} canFill={props.canFill} counting={status.state === 'loading'}
        fill={props.fill} onFill={props.onFill} t={t} />}
    <EmbeddingFillOutcome fill={props.fill} t={t} />
  </section>
}

/** A fill of one space's vectors: running, done with what it did, or failed with its reason (#392). */
type EmbeddingFillState = { memoryBodyId: string; name: string }
  & ({ state: 'running' } | { state: 'done'; result: MnemonEmbeddingFill } | { state: 'failed'; error: string })

/**
 * Each Mnemon Native space's vectors under the status line. Mnemon counts one Store at a
 * time, so the total alone could read as every space's health while one lacked vectors (#392).
 * A space that lacks them can have them filled in here while the embedding service answers.
 */
function EmbeddingSpaces(props: {
  spaces: readonly MnemonEmbeddingSpaceStatus[]
  available: boolean
  canFill: boolean
  /** The counts are being read again; the list stays, its buttons wait. */
  counting: boolean
  fill: EmbeddingFillState | undefined
  onFill: (space: MnemonEmbeddingSpaceStatus) => void
  t: Translate
}): JSX.Element {
  const { t, fill } = props
  const css = memorySettingsStyles
  const missing = (space: MnemonEmbeddingSpaceStatus): boolean => space.error === undefined && space.embedded < space.totalInsights
  const fillable = props.available && props.canFill
  const running = fill?.state === 'running' ? fill.memoryBodyId : undefined
  return <div className={css.embeddingSpaces}>
    <small id="mnemon-embedding-spaces">{t('config.embeddingSpaces')}</small>
    <ul aria-labelledby="mnemon-embedding-spaces">
      {props.spaces.map(space => <li key={space.memoryBodyId} data-missing={missing(space) ? '' : undefined} data-failed={space.error === undefined ? undefined : ''}>
        <span className={css.embeddingSpaceName} title={space.name}>{space.name}</span>
        {!space.active && <span className={css.embeddingSpaceState}>{t('common.inactive')}</span>}
        <span className={css.embeddingSpaceCount}>{space.error === undefined
          ? t('config.embeddingSpaceCounts', { embedded: space.embedded, total: space.totalInsights, coverage: space.coverage })
          : t('config.embeddingSpaceFailed', { error: space.error })}</span>
        {fillable && missing(space) && <Button variant="ghost" size="sm" disabled={running !== undefined || props.counting} aria-busy={running === space.memoryBodyId}
          aria-label={t(running === space.memoryBodyId ? 'config.embeddingFillingLabel' : 'config.embeddingFillLabel', { name: space.name })}
          onClick={() => props.onFill(space)}>{running === space.memoryBodyId ? t('config.embeddingFilling') : t('config.embeddingFill')}</Button>}
      </li>)}
    </ul>
    {props.spaces.some(missing) && <p>{t(!props.canFill ? 'config.embeddingMissing' : props.available ? 'config.embeddingMissingFill' : 'config.embeddingMissingOffline')}</p>}
    {props.spaces.some(space => space.error !== undefined) && <p>{t('config.embeddingSpacesUnread')}</p>}
  </div>
}

/** What the last fill did. It stays while the counts are read again, and reads as a failure when it wrote no vector. */
function EmbeddingFillOutcome(props: { fill: EmbeddingFillState | undefined; t: Translate }): JSX.Element | null {
  const { fill, t } = props
  const css = memorySettingsStyles
  if (fill === undefined || fill.state === 'running') return null
  const failure = (text: string): JSX.Element => <p className={`${css.embeddingFillOutcome} ${css.error}`} role="alert">{text}</p>
  if (fill.state === 'failed') return failure(t('config.embeddingFillFailed', { name: fill.name, error: fill.error }))
  const { filled, remaining, model, stopped } = fill.result
  const name = fill.name
  if (remaining > 0 && stopped === 'refused' && filled === 0) return failure(t('config.embeddingFillRefused', { name, model }))
  const text = remaining === 0
    ? filled > 0 ? t('config.embeddingFillDone', { name, filled }) : undefined
    : stopped === 'refused' ? t('config.embeddingFillPartly', { name, filled, remaining }) : t('config.embeddingFillMore', { name, filled, remaining })
  return text === undefined ? null : <p className={css.embeddingFillOutcome} role="status">{text}</p>
}
