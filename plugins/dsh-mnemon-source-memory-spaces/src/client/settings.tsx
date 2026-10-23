import { languageChain, settingsTranslate, SourceTranslation, useT, type DshLocale } from './presentation.ts'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  Callout, installMemoryComponentUI, MemorySourcePageFrame, memorySettingsStyles, message, PanelActions, SelectField, ToggleRow, useLive, useStaged, WriteFailure,
  type MemoryComponentHost, type MemoryComponentSettingsProps, type MemoryComponentUIContext,
} from 'dsh-mnemon/client'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import { DEFAULT_EMBEDDING_ENDPOINT, DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_PROTOCOL, MNEMON_EMBEDDING_PROTOCOLS, NATIVE_PROVIDER_ID, type MnemonEmbeddingConfig, type MnemonEmbeddingFill, type MnemonEmbeddingSpaceStatus, type MnemonEmbeddingStatus } from '../contracts.ts'
import { ProviderIcon } from './ProviderIcon.tsx'
import { ProviderSettingsSection } from './provider-settings.tsx'
import { memorySpacesSettingsClient } from './settings-client.ts'

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

/** The configuration keys these settings read, as dsh-mnemon lends them. */
interface SpacesConfiguration {
  embedding?: MnemonEmbeddingConfig
  storageScope?: string
  writeEnabled?: boolean
}

/** The embedding connection DSH manages for Mnemon Native. */
interface EmbeddingDraft {
  endpoint: string
  model: string
  apiKey: string
  protocol: string
}

function embeddingDraft(value: SpacesConfiguration | undefined): EmbeddingDraft {
  const embedding = value?.embedding
  return {
    endpoint: embedding?.endpoint?.trim() || DEFAULT_EMBEDDING_ENDPOINT,
    model: embedding?.model?.trim() || DEFAULT_EMBEDDING_MODEL,
    apiKey: embedding?.apiKey?.trim() ?? '',
    protocol: embedding?.protocol ?? DEFAULT_EMBEDDING_PROTOCOL,
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

const validProtocol = (protocol: string): boolean => MNEMON_EMBEDDING_PROTOCOLS.includes(protocol as typeof MNEMON_EMBEDDING_PROTOCOLS[number])

type Translate = ReturnType<typeof useT>

function embeddingProblem(draft: EmbeddingDraft, t: Translate): string | null {
  if (!validEmbeddingEndpoint(draft.endpoint)) return t('config.embeddingEndpointInvalid')
  if (!validEmbeddingModel(draft.model)) return t('config.embeddingModelInvalid')
  if (!validEmbeddingApiKey(draft.apiKey)) return t('config.embeddingApiKeyInvalid')
  if (!validProtocol(draft.protocol)) return t('config.embeddingProtocolInvalid')
  return null
}

/** The stored value: a switched-off override keeps only the fields that are valid. */
function embeddingValue(enabled: boolean, draft: EmbeddingDraft): MemoryJsonValue {
  const endpoint = draft.endpoint.trim().replace(/\/+$/u, '')
  if (enabled) return { enabled: true, endpoint, model: draft.model.trim(), protocol: draft.protocol, apiKey: draft.apiKey.trim() }
  return {
    enabled: false,
    ...(validEmbeddingEndpoint(draft.endpoint) ? { endpoint } : {}),
    ...(validEmbeddingModel(draft.model) ? { model: draft.model.trim() } : {}),
    ...(validProtocol(draft.protocol) ? { protocol: draft.protocol } : {}),
    ...(validEmbeddingApiKey(draft.apiKey) ? { apiKey: draft.apiKey.trim() } : {}),
  }
}

/**
 * Memory Spaces' own settings: the Providers that store its spaces, Mnemon
 * Native first with the embedding runtime only Native reads. They need what
 * dsh-mnemon lends them; without it they show nothing. With DSH's language
 * service they translate as dsh-mnemon drew them, through its language chain.
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
  const managedSaved = value?.embedding?.enabled === true
  // Whether DSH manages the embedding is a switch: it applies at once, with the saved connection.
  const managed = useLive(managedSaved, async enabled => { await configuration.set('embedding', embeddingValue(enabled, saved)) })
  // The connection is typed, so it waits for its Apply.
  const form = useStaged(saved, async draft => { await configuration.set('embedding', embeddingValue(managedSaved, draft)) })
  const [nativeCliFound, setNativeCliFound] = useState<boolean | undefined>(() => (retained.get(RETAINED_CLI) as { commandFound?: boolean } | undefined)?.commandFound)
  const [status, setStatus] = useState<{ state: 'idle' | 'loading' | 'ready' | 'error'; value?: MnemonEmbeddingStatus; error?: string }>({ state: 'idle' })
  const [fill, setFill] = useState<EmbeddingFillState | undefined>(undefined)
  const statusRequest = useRef(0)
  const on = page.component.enabled

  useEffect(() => {
    if (client === undefined || !on) { setNativeCliFound(undefined); retained.delete(RETAINED_CLI); return }
    let current = true
    void client.statusSummary().then(summary => {
      if (!current) return
      setNativeCliFound(summary.commandFound)
      retained.set(RETAINED_CLI, { commandFound: summary.commandFound })
    }, () => { if (current) { setNativeCliFound(undefined); retained.delete(RETAINED_CLI) } })
    return () => { current = false }
  }, [client, on, retained, snapshot.revision])
  // A page opened again finds out anew, as it always has; only a mount that replaces this one starts from it.
  useEffect(() => () => { retained.delete(RETAINED_CLI) }, [retained])
  useEffect(() => {
    statusRequest.current += 1
    setStatus({ state: 'idle' })
    setFill(undefined)
  }, [client, snapshot.revision])

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
  // As dsh-mnemon's isWorkspaceStorageScope, which lives in its Host protocol, outside its public client.
  const activeScope = value?.storageScope === 'workspace' || value?.storageScope === 'workspaces' ? 'workspace' : 'global'
  const readOnly = value?.writeEnabled === false
  const disabled = !page.writable || snapshot.status === 'loading' || !snapshot.writable
  const cliMissing = nativeCliFound === false
  return <section className={css.panelSection} aria-labelledby="mnemon-spaces-providers">
    <div className={css.panelHeading}><h3 id="mnemon-spaces-providers">{t('config.providersTitle')}</h3><p>{t('config.providersDescription')}</p></div>
    <ProviderSettingsSection
      client={client}
      retained={retained}
      {...(activeScope !== 'workspace' || page.workspace?.label === undefined ? {} : { workspaceLabel: page.workspace.label })}
      activeScope={activeScope}
      refreshKey={snapshot.revision ?? 0}
      disabled={disabled || readOnly}
      scopeChanging={false}
      onChanged={host.changed}
      {...(readOnly ? { notice: <Callout tone="warning" className={css.groupCallout} title={t('config.providersReadOnlyTitle')}>{t('config.providersReadOnlyDetail')}</Callout> } : {})}
      leading={<NativeProviderCard activeScope={activeScope} cliMissing={cliMissing} t={t}>
        <EmbeddingEditor managed={managed.value} draft={form.draft} disabled={disabled} connectionAvailable={client !== undefined} cliMissing={cliMissing} changing={form.dirty}
          status={status} t={t} onEdit={form.edit} onTest={() => { setFill(undefined); test() }}
          canFill={!disabled && !readOnly} fill={fill} onFill={fillSpace}
          onManaged={on => { if (!on) form.discard(); managed.set(on) }}
          actions={<>
            <WriteFailure error={managed.failed} t={t} />
            <PanelActions dirty={form.dirty} saving={form.saving} invalid={embeddingProblem(form.draft, t)} failed={form.failed} applied={form.applied}
              disabled={disabled} t={t} onDiscard={form.discard} onApply={() => { void form.apply() }} />
          </>} />
      </NativeProviderCard>}
    />
  </section>
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
        <IconChevronDownOutlineRegular className={css.providerChevron} size={14} />
      </span>
    </summary>
    <div className={css.providerInlineBody}>{props.children}</div>
  </details>
}

/** Reachability and coverage line; the protocol appears only when the Host reports one. */
function embeddingStatusText(t: Translate, status: MnemonEmbeddingStatus): string {
  const coverage = { embedded: status.embedded, total: status.totalInsights, coverage: status.coverage }
  return status.protocol === undefined
    ? t(status.available ? 'config.embeddingStatusAvailable' : 'config.embeddingStatusUnavailable', { model: status.model, ...coverage })
    : t(status.available ? 'config.embeddingStatusAvailableWithProtocol' : 'config.embeddingStatusUnavailableWithProtocol', { model: status.model, protocol: status.protocol, ...coverage })
}

/** The embedding runtime: the switch applies at once; the connection fields, shown while DSH manages it, wait for Apply. */
function EmbeddingEditor(props: {
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
  const text = (field: 'endpoint' | 'model' | 'apiKey', type: string, label: string, valid: boolean, placeholder: string): JSX.Element => <label>
    {label}
    <input type={type} aria-label={label} aria-invalid={!valid} value={draft[field]} disabled={props.disabled}
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
    {props.managed && <>
      <div className={css.fieldGrid}>
        {text('endpoint', 'url', t('config.embeddingEndpoint'), validEmbeddingEndpoint(draft.endpoint), DEFAULT_EMBEDDING_ENDPOINT)}
        {text('model', 'text', t('config.embeddingModel'), validEmbeddingModel(draft.model), DEFAULT_EMBEDDING_MODEL)}
        <SelectField label={t('config.embeddingProtocol')} value={draft.protocol} disabled={props.disabled} options={[
          { value: 'auto', label: t('config.embeddingProtocolAuto') },
          { value: 'ollama', label: t('config.embeddingProtocolOllama') },
          { value: 'openai', label: t('config.embeddingProtocolOpenai') },
        ]} onChange={protocol => props.onEdit({ protocol })} />
        {text('apiKey', 'password', t('config.embeddingApiKey'), validEmbeddingApiKey(draft.apiKey), 'sk-…')}
      </div>
      <p className={css.editorNote}>{t('config.embeddingSecurity')}</p>
    </>}
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
  // A read-only space takes no vectors from here (#434).
  const fills = (space: MnemonEmbeddingSpaceStatus): boolean => missing(space) && space.writePolicy !== 'read-only'
  const running = fill?.state === 'running' ? fill.memoryBodyId : undefined
  return <div className={css.embeddingSpaces}>
    <small id="mnemon-embedding-spaces">{t('config.embeddingSpaces')}</small>
    <ul aria-labelledby="mnemon-embedding-spaces">
      {props.spaces.map(space => <li key={space.memoryBodyId} data-missing={missing(space) ? '' : undefined} data-failed={space.error === undefined ? undefined : ''}>
        <span className={css.embeddingSpaceName} title={space.name}>{space.name}</span>
        {!space.active && <span className={css.embeddingSpaceState}>{t('common.inactive')}</span>}
        {space.writePolicy === 'read-only' && <span className={css.embeddingSpaceState}>{t('common.readOnlySpace')}</span>}
        <span className={css.embeddingSpaceCount}>{space.error === undefined
          ? t('config.embeddingSpaceCounts', { embedded: space.embedded, total: space.totalInsights, coverage: space.coverage })
          : t('config.embeddingSpaceFailed', { error: space.error })}</span>
        {fillable && fills(space) && <Button variant="ghost" size="sm" disabled={running !== undefined || props.counting} aria-busy={running === space.memoryBodyId}
          aria-label={t(running === space.memoryBodyId ? 'config.embeddingFillingLabel' : 'config.embeddingFillLabel', { name: space.name })}
          onClick={() => props.onFill(space)}>{running === space.memoryBodyId ? t('config.embeddingFilling') : t('config.embeddingFill')}</Button>}
      </li>)}
    </ul>
    {props.spaces.some(missing) && <p>{t(!props.canFill || !props.spaces.some(fills) ? 'config.embeddingMissing' : props.available ? 'config.embeddingMissingFill' : 'config.embeddingMissingOffline')}</p>}
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
