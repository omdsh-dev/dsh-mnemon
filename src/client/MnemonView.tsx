import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { IconChevronLeftOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { consumeMnemonAnchor, subscribeMnemonAnchor, type MnemonAnchor } from './anchor.ts'
import Markdown from 'markdown-to-jsx'
import {
  CATEGORIES,
  type Category,
  type ClientConnectionHandle,
  type ClientSettingsScope,
  type Config,
  type DocumentRecord,
  type DocumentSnapshot,
  type DocumentView,
  type EntityView,
  type Insight,
  type MemoryBodyCatalog,
  type MemoryBodyMetadataUpdate,
  type MemoryBodyProvider,
  type MemoryBodyView,
  type MemoryGraphNode,
  type MemoryGraphSnapshot,
  type MemoryPlacementCapability,
  type MemoryPlacementPreference,
  type MemoryListView,
  type MemoryProviderConfigField,
  type MemoryProviderConnection,
  type MemoryProviderDescriptor,
  type MemoryProviderId,
  type MemoryProviderRuntimeStatus,
  type MemoryReadSource,
  type RuntimeMemoryEntry,
  type RuntimeMemoryImportance,
  type RuntimeMemorySnapshot,
  type RuntimeMemoryTarget,
  type StatusView,
  type StorageAreaInventory,
  type StorageScopeInventory,
  type StorageScopeKind,
  type VersionComponentStatus,
  type VersionInstallMode,
  type VersionStatus,
  type VersionUpdateResult,
} from '../shared/contracts.ts'
import { MnemonClient } from './api.ts'
import { translateZh, type MnemonKey, type MnemonTranslate } from './locales.ts'
import { MnemonDialog, type MnemonDialogProps } from './MnemonDialog.tsx'
import { ProviderIcon } from './ProviderIcon.tsx'
import { useRequestVersion } from './use-request-version.ts'
import { appearanceClass } from './view-styles.ts'
import css from './MnemonView.module.css'
import sidebarCss from './MnemonSidebarView.module.css'

export interface MnemonViewProps {
  connection: ClientConnectionHandle
  settingsScope: ClientSettingsScope<Config>
  sessionId?: string
  workspaceId?: string
  workspaceSelection?: MnemonWorkspaceSelection
  /** Placement affects the scope header, never the shared pages or skin. */
  surface?: Config['displayMode']
  t?: MnemonTranslate
  locale?: string
  onClose?: () => void
}

export interface MnemonWorkspaceSelection {
  options: Array<{ id: string; title: string; path: string }>
  selectedWorkspaceId?: string
  effectiveWorkspaceId?: string
  onSelect(workspaceId: string): void
  onAlign(): void
}

type Page = Exclude<MnemonAnchor['page'], 'remember'>
type SidebarMemoryPage = Extract<Page, 'overview' | 'explore' | 'list' | 'entities'>
type MemoryPlacementMode = 'manual' | 'automatic'
type ProviderDrafts = Partial<Record<MemoryProviderId, MemoryProviderConnection>>

const LEGACY_NATIVE_CAPABILITIES: MemoryBodyProvider['capabilities'] = {
  search: true,
  browse: true,
  graph: true,
  entities: true,
  related: true,
  remember: true,
  link: true,
  forget: true,
  writeMode: 'exact',
  deletionMode: 'soft',
}

const MEMORY_PROVIDER_LABELS: Record<MemoryProviderId, string> = {
  'mnemon-native': 'mnemon',
  openviking: 'OpenViking',
  honcho: 'Honcho',
  mem0: 'Mem0',
  hindsight: 'Hindsight',
  holographic: 'Holographic',
  retaindb: 'RetainDB',
  byterover: 'ByteRover',
  supermemory: 'Supermemory',
}

const LEGACY_PROVIDER_CATALOG: MemoryProviderDescriptor[] = [
  {
    id: 'mnemon-native', label: 'mnemon', kind: 'local', origin: 'native',
    workspaceBinding: 'automatic',
    summary: 'Official local-first memory.', capabilities: LEGACY_NATIVE_CAPABILITIES, fields: [],
  },
  {
    id: 'openviking', label: 'OpenViking', kind: 'remote', origin: 'third-party',
    workspaceBinding: 'provider-global',
    serviceConfigured: true,
    summary: 'Filesystem-shaped shared memory.',
    capabilities: { ...LEGACY_NATIVE_CAPABILITIES, graph: false, entities: false, related: false, link: false, writeMode: 'async-extracting', deletionMode: 'hard' },
    fields: [
      { key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'http://127.0.0.1:1933', placeholder: 'http://127.0.0.1:1933' },
      { key: 'targetUri', label: 'Memory URI', scope: 'memory', input: 'text', required: true, defaultValue: 'viking://user/memories', placeholder: 'viking://user/memories' },
      { key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: false },
      { key: 'account', label: 'Account', scope: 'service', input: 'text', required: false },
      { key: 'user', label: 'User', scope: 'memory', input: 'text', required: false },
      { key: 'actorPeerId', label: 'Agent peer', scope: 'memory', input: 'text', required: false, defaultValue: 'dsh' },
    ],
  },
]

/** Preserve the pre-provider Host contract during a rolling Web/Host restart. */
function normalizeMemoryBody(body: MemoryBodyView): MemoryBodyView {
  if (body.provider !== undefined) return body
  return {
    ...body,
    provider: {
      id: 'mnemon-native',
      label: 'mnemon',
      kind: 'local',
      location: body.dbPath,
      apiKeyConfigured: false,
      settings: {},
      configuredSecrets: [],
      capabilities: LEGACY_NATIVE_CAPABILITIES,
    },
  }
}

function memoryProviderFields(provider: MemoryProviderDescriptor): MemoryProviderConfigField[] {
  return provider.fields.filter(field => field.scope !== 'service')
}

function providerDefaults(provider: MemoryProviderDescriptor): MemoryProviderConnection {
  return Object.fromEntries(memoryProviderFields(provider).flatMap(field => field.defaultValue === undefined ? [] : [[field.key, field.defaultValue]]))
}

function mergeProviderDefaults(providers: readonly MemoryProviderDescriptor[], current: ProviderDrafts): ProviderDrafts {
  return Object.fromEntries(providers.map(provider => [provider.id, { ...providerDefaults(provider), ...(current[provider.id] ?? {}) }]))
}

function providerDraftComplete(provider: MemoryProviderDescriptor | undefined, connection: MemoryProviderConnection | undefined): boolean {
  if (provider === undefined || provider.id === 'mnemon-native') return true
  return provider.serviceConfigured !== false && memoryProviderFields(provider).every(field => !field.required || String(connection?.[field.key] ?? '').trim() !== '')
}

function providerSummary(t: MnemonTranslate, provider: MemoryProviderDescriptor): string {
  return t(`overview.providerSummary.${provider.id}` as MnemonKey)
}

function providerFieldLabel(t: MnemonTranslate, provider: MemoryProviderDescriptor, field: MemoryProviderConfigField): string {
  const labels: Record<string, MnemonKey> = {
    endpoint: 'overview.providerEndpoint', apiKey: 'overview.providerApiKey', targetUri: 'overview.providerTargetUri', account: 'overview.providerAccount', user: 'overview.providerUser', actorPeerId: 'overview.providerActorPeer',
    workspace: 'overview.providerField.workspace', userId: 'overview.providerField.userId', agentId: 'overview.providerField.agentId', mode: 'overview.providerField.mode', rerank: 'overview.providerField.rerank',
    bankId: 'overview.providerField.bankId', budget: 'overview.providerField.budget', dataPath: 'overview.providerField.dataPath', defaultTrust: 'overview.providerField.defaultTrust', minTrust: 'overview.providerField.minTrust',
    project: 'overview.providerField.project', cliPath: 'overview.providerField.cliPath', workingDirectory: 'overview.providerField.workingDirectory', containerTag: 'overview.providerField.containerTag', searchMode: 'overview.providerField.searchMode',
  }
  return labels[field.key] === undefined ? field.label : t(labels[field.key]!)
}

/** Shared memory-level Provider form used by manual creation, editing, and distillation policy. */
function ProviderMemoryFields(props: {
  provider: MemoryProviderDescriptor
  connection: MemoryProviderConnection
  onChange: (key: string, value: string | number | boolean) => void
  body?: MemoryBodyView
  clearSecrets?: string[]
  onClearSecretsChange?: (keys: string[]) => void
}): JSX.Element {
  const t = useT()
  return <div className={css.providerFields} data-provider={props.provider.id}>
    <div className={css.providerFieldHeading}><div className={css.providerFieldIdentity}><ProviderIcon providerId={props.provider.id} className={css.providerFieldIcon} /><div><strong>{props.provider.label}</strong><small>{providerSummary(t, props.provider)}</small></div></div><span>{props.provider.kind === 'local' ? t('overview.providerKindLocal') : t('overview.providerKindRemote')} · {t(`overview.workspaceBinding.${props.provider.workspaceBinding}`)}</span></div>
    <div className={css.providerAdvancedGrid}>{memoryProviderFields(props.provider).map(field => {
      const label = providerFieldLabel(t, props.provider, field)
      const value = props.connection[field.key] ?? ''
      const savedSecret = props.body?.provider.configuredSecrets.includes(field.key) === true
      const clearingSecret = props.clearSecrets?.includes(field.key) === true
      const required = field.required && (!savedSecret || clearingSecret)
      const input = field.input === 'boolean'
        ? <input aria-label={label} type="checkbox" checked={Boolean(value)} onChange={event => props.onChange(field.key, event.target.checked)} />
        : field.input === 'select'
          ? <select aria-label={label} value={String(value)} required={required} onChange={event => props.onChange(field.key, event.target.value)}>{field.options?.map(option => <option key={option.value} value={option.value}>{t(`overview.providerOption.${option.value}` as MnemonKey)}</option>)}</select>
          : <input aria-label={label} type={field.input === 'secret' ? 'password' : field.input === 'number' ? 'number' : field.input === 'url' ? 'url' : 'text'} value={String(value)} required={required} autoComplete={field.input === 'secret' ? 'new-password' : undefined} placeholder={savedSecret ? t('overview.providerApiKeyKeep') : field.placeholder ?? (field.input === 'secret' ? t('overview.providerApiKeyOptional') : undefined)} maxLength={field.input === 'secret' ? 8000 : 2000} step={field.input === 'number' ? 'any' : undefined} onChange={event => props.onChange(field.key, event.target.value)} />
      return <div key={field.key} className={css.providerFieldControl}><label>{label}{input}</label>{props.body !== undefined && field.input === 'secret' && savedSecret && props.onClearSecretsChange !== undefined && <label className={css.providerSecretClear}><input type="checkbox" checked={clearingSecret} onChange={event => props.onClearSecretsChange!(event.target.checked ? [...new Set([...(props.clearSecrets ?? []), field.key])] : (props.clearSecrets ?? []).filter(key => key !== field.key))} />{t('overview.providerSecretClear')}</label>}</div>
    })}</div>
    <small className={css.providerWriteHint}>{props.provider.capabilities.writeMode === 'exact' ? t('overview.providerWriteExact') : t('overview.providerWriteAsync')} · {props.provider.capabilities.graph ? t('overview.providerGraphReady') : t('overview.providerSearchReady')}</small>
  </div>
}

type NavEntry = { id: Page; label: MnemonKey }
const SIDEBAR_PAGE_TABS: NavEntry[] = [
  { id: 'status', label: 'nav.status' },
  { id: 'runtime', label: 'nav.runtime' },
  { id: 'documents', label: 'nav.documents' },
  { id: 'overview', label: 'nav.bodies' },
]

const MEMORY_PAGE_TABS: Array<{ id: SidebarMemoryPage; label: MnemonKey }> = [
  { id: 'overview', label: 'nav.overview' },
  { id: 'explore', label: 'nav.search' },
  { id: 'list', label: 'nav.content' },
  { id: 'entities', label: 'nav.entities' },
]

const MEMORY_PAGES = new Set<Page>(MEMORY_PAGE_TABS.map(item => item.id))
type ConfigurableMemoryLayerId = 'runtime' | 'documents' | 'memory-spaces'

function pageLayer(page: Page): ConfigurableMemoryLayerId | undefined {
  if (page === 'runtime') return 'runtime'
  if (page === 'documents') return 'documents'
  if (isMemoryPage(page)) return 'memory-spaces'
  return undefined
}

function isMemoryPage(page: Page): page is SidebarMemoryPage {
  return MEMORY_PAGES.has(page)
}

const CATEGORY_KEYS: Record<string, MnemonKey> = {
  decision: 'category.decision',
  preference: 'category.preference',
  fact: 'category.fact',
  insight: 'category.insight',
  context: 'category.context',
  general: 'category.general',
}

const I18nContext = createContext<MnemonTranslate>(translateZh)
const LocaleContext = createContext<string>('zh')
function useT(): MnemonTranslate { return useContext(I18nContext) }
function useLocale(): string {
  const locale = useContext(LocaleContext)
  return locale === 'en' ? 'en-US' : locale === 'zh' ? 'zh-CN' : locale
}
function categoryLabel(t: MnemonTranslate, category: string): string { return CATEGORY_KEYS[category] === undefined ? category : t(CATEGORY_KEYS[category]!) }

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseBranchesInput(raw: string): string[] | undefined {
  const parsed = raw.split(',').map(value => value.trim()).filter(value => value !== '')
  return parsed.length === 0 ? undefined : parsed
}

function short(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function insightKey(insight: Insight): string {
  return `${insight.memoryBodyId ?? 'memory'}:${insight.id}`
}

function PageHeader(props: { title: string; description: string; meta?: string; loadingLabel?: string; action?: JSX.Element }): JSX.Element {
  return (
    <div className={appearanceClass(css.pageHeader, sidebarCss.pageHeader)}>
      <div><h2>{props.title}</h2><p>{props.description}</p></div>
      <div className={css.pageHeaderMeta}>{props.loadingLabel !== undefined && <PageSpinner label={props.loadingLabel} />}{props.meta !== undefined && <code>{props.meta}</code>}{props.action}</div>
    </div>
  )
}

function PageSpinner({ label }: { label: string }): JSX.Element {
  return <span className={css.pageSpinner} role="status" aria-label={label} title={label}><i aria-hidden="true" /></span>
}

function SectionSpinner({ label }: { label: string }): JSX.Element {
  return <span className={css.sectionSpinner} role="status" aria-label={label} title={label}><i aria-hidden="true" /></span>
}

function ProgressiveFooter(props: { visible: number; total: number; pageSize: number; compact?: boolean; onMore: () => void }): JSX.Element | null {
  const t = useT()
  if (props.total === 0) return null
  const remaining = Math.max(0, props.total - props.visible)
  return <div className={props.compact === true ? css.compactListProgress : css.listProgress}><span>{t('common.showing', { visible: props.visible, total: props.total })}</span>{remaining > 0 && <button type="button" className={css.secondaryButton} onClick={props.onMore}>{t('common.showMore', { count: Math.min(props.pageSize, remaining) })}</button>}</div>
}

/** DSH-style action dialog shared by Sidebar add/write flows. */
function SidebarModal(props: Omit<MnemonDialogProps, 'closeLabel'>): JSX.Element {
  const t = useT()
  return <MnemonDialog {...props} closeLabel={t('common.cancel')} />
}

function EmptyState(props: { glyph: string; title: string; children: string }): JSX.Element {
  return (
    <div className={css.emptyState}>
      <div className={css.emptyGlyph} aria-hidden="true"><span>{props.glyph}</span></div>
      <div><h3>{props.title}</h3><p>{props.children}</p></div>
    </div>
  )
}

function LayerDisabledPage(props: { title: string }): JSX.Element {
  const t = useT()
  return <div className={css.page}>
    <PageHeader title={props.title} description={t('layers.disabledDescription')} meta={t('layers.disabledBadge')} />
    <EmptyState glyph="⊘" title={t('layers.disabledTitle', { layer: props.title })}>{t('layers.disabledText')}</EmptyState>
  </div>
}

function MemoryProviderBadge(props: { providerId: MemoryProviderId; label: string }): JSX.Element {
  const compactLabel = props.providerId === 'mnemon-native' ? 'mnemon' : props.label
  return <span className={css.providerBadge} data-provider={props.providerId} title={compactLabel}>{compactLabel}</span>
}

function ReadSourcePanel(props: {
  title: string
  hint?: string
  sources: readonly MemoryReadSource[]
  selectedBodyId?: string | undefined
  onSelect?: (memoryBodyId: string | undefined) => void
}): JSX.Element | null {
  const t = useT()
  if (props.sources.length === 0) return null
  const content = (source: MemoryReadSource) => <>
    <span className={css.readSourceSignal} aria-hidden="true" />
    <span className={css.readSourceIdentity}><strong>{source.memoryBodyName}</strong><span className={css.readSourceMeta}><MemoryProviderBadge providerId={source.providerId} label={source.providerLabel} /><small>{t(`readSources.model.${source.providerId}` as MnemonKey)}</small></span></span>
    <span className={css.readSourceState}><em>{t(`readSources.mode.${source.mode}` as MnemonKey)}</em><small>{t(`readSources.status.${source.status}` as MnemonKey, { count: source.itemCount })}{source.edgeCount === undefined || source.edgeCount === 0 ? '' : ` · ${t('readSources.edges', { count: source.edgeCount })}`}</small></span>
  </>
  return <section className={css.readSources} aria-label={props.title}>
    <header><div><strong>{props.title}</strong>{props.hint !== undefined && <p>{props.hint}</p>}</div>{props.onSelect !== undefined && <button type="button" aria-pressed={props.selectedBodyId === undefined} data-selected={props.selectedBodyId === undefined ? '' : undefined} onClick={() => props.onSelect?.(undefined)}>{t('readSources.all')}</button>}</header>
    <div>{props.sources.map(source => props.onSelect === undefined
      ? <article key={source.memoryBodyId} className={css.readSourceCard} data-provider={source.providerId} data-mode={source.mode} data-status={source.status} title={source.hint}>{content(source)}</article>
      : <button key={source.memoryBodyId} type="button" className={css.readSourceCard} data-provider={source.providerId} data-mode={source.mode} data-status={source.status} aria-pressed={props.selectedBodyId === source.memoryBodyId} data-selected={props.selectedBodyId === source.memoryBodyId || undefined} title={source.hint} onClick={() => props.onSelect?.(props.selectedBodyId === source.memoryBodyId ? undefined : source.memoryBodyId)}>{content(source)}</button>,
    )}</div>
  </section>
}

/** The memory workspace mirrors the SSH panel's flat tab model. */
function WorkspaceNavigation(props: { page: Page; onSelect: (page: Page) => void; layers: Record<ConfigurableMemoryLayerId, boolean | undefined> }): JSX.Element {
  const t = useT()
  return (
    <div className={appearanceClass(css.topNavigation, sidebarCss.topNavigation)}>
      <div className={appearanceClass(css.nav, sidebarCss.nav)} role="tablist" aria-label={t('nav.aria')}>
        {SIDEBAR_PAGE_TABS.map(item => {
          const active = item.id === 'overview' ? isMemoryPage(props.page) : props.page === item.id
          const layer = pageLayer(item.id)
          const disabled = layer !== undefined && props.layers[layer] === false
          const label = t(item.label)
          return <button key={item.id} type="button" role="tab" aria-selected={active} data-active={active ? '' : undefined} data-layer-disabled={disabled ? '' : undefined} aria-label={disabled ? `${label} · ${t('layers.disabledBadge')}` : undefined} onClick={() => props.onSelect(item.id)}><span>{label}</span>{disabled && <em className={css.layerDisabledBadge}>{t('layers.disabledBadge')}</em>}</button>
        })}
      </div>
    </div>
  )
}

/** Memory tools become a focused second-level tab set on the Sidebar surface. */
function MemoryNavigation(props: { page: Page; activationEnabled: boolean; writeEnabled: boolean; onSelect: (page: SidebarMemoryPage) => void; onRemember: () => void; onStrategy: () => void }): JSX.Element | null {
  const t = useT()
  if (!isMemoryPage(props.page)) return null
  return (
    <section className={sidebarCss.memoryWorkspace}>
      <PageHeader title={t('nav.bodies')} description={t('overview.description')} meta={props.writeEnabled ? t('common.agentSupervised') : props.activationEnabled ? t('common.activationOnly') : t('common.readOnly')} action={<div className={css.memoryHeaderActions}><button type="button" className={appearanceClass(css.primaryButton, sidebarCss.memoryWriteButton)} disabled={!props.writeEnabled} onClick={props.onRemember}>{t('nav.rememberAction')}</button><button type="button" className={css.secondaryButton} onClick={props.onStrategy}>{t('strategy.action')}</button></div>} />
      <div className={sidebarCss.memoryNavigation}>
        <div className={sidebarCss.memoryTabs} role="tablist" aria-label={t('nav.memory.aria')}>
          {MEMORY_PAGE_TABS.map(item => {
            const active = props.page === item.id
            return <button key={item.id} type="button" role="tab" aria-selected={active} data-active={active ? '' : undefined} onClick={() => props.onSelect(item.id)}>{t(item.label)}</button>
          })}
        </div>
      </div>
    </section>
  )
}

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

const SAFE_LINK_PATTERN = /^(?:https?:|mailto:|#|\/)/iu

function safeLink(href: string | null | undefined): string | undefined {
  if (href == null) return undefined
  const value = href.trim()
  return SAFE_LINK_PATTERN.test(value) ? value : undefined
}

/** Render managed Markdown without raw HTML and with a deliberately small link surface. */
function DocumentMarkdown(props: { content: string }): JSX.Element {
  return (
    <div className={css.markdownBody}>
      <Markdown options={{
        disableParsingRawHTML: true,
        forceBlock: true,
        overrides: {
          a: {
            component: ({ href, children, ...rest }: { href?: string; children?: JSX.Element | string }) => {
              const target = safeLink(href)
              return target === undefined
                ? <span>{children}</span>
                : <a {...rest} href={target} target={target.startsWith('http') ? '_blank' : undefined} rel={target.startsWith('http') ? 'noreferrer noopener' : undefined}>{children}</a>
            },
          },
        },
      }}>{props.content}</Markdown>
    </div>
  )
}

function InsightCard(props: {
  insight: Insight
  writeEnabled: boolean
  onForget: (insight: Insight) => Promise<void>
  onRelated?: (insight: Insight) => void
  onClone?: (insight: Insight) => void
}): JSX.Element {
  const t = useT()
  const [confirming, setConfirming] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  const { insight } = props
  const neutralActionClass = appearanceClass(css.ghostButton, sidebarCss.itemActionButton)
  const forgetActionClass = appearanceClass(css.dangerButton, appearanceClass(sidebarCss.itemActionButton, sidebarCss.itemDangerAction))
  const providerLabel = insight.memoryProviderId === undefined ? undefined : MEMORY_PROVIDER_LABELS[insight.memoryProviderId]
  const supportsRelated = insight.memoryCapabilities?.related ?? (insight.memoryProviderId === undefined || insight.memoryProviderId === 'mnemon-native')
  const supportsForget = insight.memoryCapabilities?.forget ?? (insight.memoryProviderId === undefined || insight.memoryProviderId === 'mnemon-native')
  const meta = [
    insight.memoryBodyName,
    providerLabel,
    insight.category !== undefined ? categoryLabel(t, insight.category) : undefined,
    insight.importance !== undefined ? t('common.importance', { value: insight.importance }) : undefined,
    insight.score !== undefined ? `score ${insight.score.toFixed(3)}` : undefined,
    insight.depth !== undefined ? t('common.hops', { count: insight.depth }) : undefined,
  ].filter((entry): entry is string => entry !== undefined)

  const forget = async () => {
    setForgetting(true)
    try {
      await props.onForget(insight)
    } finally {
      setForgetting(false)
      setConfirming(false)
    }
  }

  return (
    <>
    <article className={css.insightCard}>
      <div className={css.cardTop}>
        <div className={css.badges}>{meta.map(entry => <span key={entry} className={css.badge}>{entry}</span>)}</div>
        <code className={css.id} title={insight.id}>{insight.id.slice(0, 8)}</code>
      </div>
      <p className={css.content}>{insight.content}</p>
      {(insight.tags?.length ?? 0) > 0 && <div className={css.tags}>{insight.tags!.map(tag => <span key={tag}>#{tag}</span>)}</div>}
      {(insight.entities?.length ?? 0) > 0 && <div className={css.entities}>{insight.entities!.map(entity => <span key={entity}>{entity}</span>)}</div>}
      <div className={css.cardActions}>
        {props.onRelated !== undefined && supportsRelated && <button type="button" className={neutralActionClass} onClick={() => props.onRelated?.(insight)}>{t('card.related')}</button>}
        {props.onClone !== undefined && <button type="button" className={neutralActionClass} onClick={() => props.onClone?.(insight)}>{t('card.clone')}</button>}
        <button type="button" className={neutralActionClass} onClick={() => void navigator.clipboard?.writeText(insight.id)}>{t('common.copyId')}</button>
        {props.writeEnabled && supportsForget && <button type="button" className={forgetActionClass} onClick={() => setConfirming(true)}>{t('card.forget')}</button>}
      </div>
    </article>
    {confirming && <SidebarModal title={t('card.confirmText')} description={`${insight.memoryBodyName ?? insight.memoryBodyId ?? ''}${insight.memoryBodyName === undefined && insight.memoryBodyId === undefined ? '' : ' · '}${insight.id}`} busy={forgetting} onClose={() => setConfirming(false)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close data-autofocus className={css.ghostButton} disabled={forgetting} onClick={() => setConfirming(false)}>{t('common.cancel')}</button><button type="button" className={css.dangerSolidButton} disabled={forgetting} onClick={() => void forget()}>{forgetting ? t('card.processing') : t('card.confirmForget')}</button></div>}><div className={css.bodyDeleteConfirm}><div className={css.bodyDeleteSummary}><p className={css.bodyDeleteContent}>{insight.content}</p><span>{meta.join(' · ')}</span></div></div></SidebarModal>}
    </>
  )
}

const GRAPH_WIDTH = 930
const GRAPH_HEIGHT = 520
const GRAPH_MARGIN_X = 58
const GRAPH_MARGIN_Y = 58
const CATEGORY_ORDER = ['space', 'entity', 'preference', 'decision', 'fact', 'insight', 'context', 'general']

interface GraphPosition { x: number; y: number }
type GraphPositions = Map<string, GraphPosition>
type GraphLayoutMode = 'natural' | 'uniform' | 'custom'

function hash(value: string): number {
  let result = 2166136261
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619)
  return result >>> 0
}

function graphNodeKey(node: MemoryGraphNode): string {
  return node.graphId ?? node.id
}

function graphNodeKind(node: MemoryGraphNode): NonNullable<MemoryGraphNode['kind']> {
  return node.kind ?? 'memory'
}

function spaceGraphId(id: string): string {
  return `space:${id}`
}

function entityGraphId(entity: string): string {
  return `entity:${encodeURIComponent(normalizeEntity(entity))}`
}

function normalizeEntity(entity: string): string {
  return entity.normalize('NFKC').trim().toLocaleLowerCase()
}

/** Add routing scopes and entity indexes without issuing another recall. */
function enrichMultiSpaceGraph(graph: MemoryGraphSnapshot, bodies: MemoryBodyView[]): MemoryGraphSnapshot {
  if (graph.nodes.length === 0) return graph
  const memories = graph.nodes.map(node => ({ ...node, kind: 'memory' as const }))
  const memoriesByBody = new Map<string, MemoryGraphNode[]>()
  for (const node of memories) {
    if (node.memoryBodyId === undefined) continue
    memoriesByBody.set(node.memoryBodyId, [...(memoriesByBody.get(node.memoryBodyId) ?? []), node])
  }

  const activeBodies = bodies.filter(body => body.active && ((memoriesByBody.get(body.id)?.length ?? 0) > 0 || (body.stats?.topEntities.length ?? 0) > 0))
  const spaceNodes: MemoryGraphNode[] = activeBodies.map(body => ({
    id: body.id,
    graphId: spaceGraphId(body.id),
    kind: 'space',
    category: 'space',
    content: body.name,
    color: '#22a879',
    memoryBodyId: body.id,
    memoryBodyName: body.name,
    memoryProviderId: body.provider.id,
    occurrenceCount: body.stats?.totalInsights ?? memoriesByBody.get(body.id)?.length ?? 0,
  }))

  // Native Mnemon entity edges connect two memories. This overview renders
  // entities as first-class nodes, so retaining those edges would falsely make
  // a memory-to-memory edge look like an entity-to-memory association.
  const edges: MemoryGraphSnapshot['edges'] = graph.edges.filter(edge => edge.type !== 'entity')
  for (const body of activeBodies) {
    for (const memory of memoriesByBody.get(body.id) ?? []) {
      edges.push({ sourceId: spaceGraphId(body.id), targetId: graphNodeKey(memory), label: 'scope', color: '#708199', type: 'scope' })
    }
  }

  const bodiesById = new Map(activeBodies.map(body => [body.id, body]))
  const indexedEntities = new Map<string, { entity: string; memories: MemoryGraphNode[]; bodies: MemoryBodyView[] }>()
  for (const memory of memories) {
    const body = memory.memoryBodyId === undefined ? undefined : bodiesById.get(memory.memoryBodyId)
    if (body === undefined) continue
    const seen = new Set<string>()
    for (const rawEntity of memory.entities ?? []) {
      const entity = rawEntity.trim()
      const key = normalizeEntity(entity)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      const current = indexedEntities.get(key)
      if (current === undefined) indexedEntities.set(key, { entity, memories: [memory], bodies: [body] })
      else {
        current.memories.push(memory)
        if (!current.bodies.some(candidate => candidate.id === body.id)) current.bodies.push(body)
      }
    }
  }
  const entities = [...indexedEntities.values()].sort((left, right) => right.memories.length - left.memories.length || left.entity.localeCompare(right.entity)).slice(0, 24)
  const entityNodes: MemoryGraphNode[] = entities.map(item => ({
    id: item.entity,
    graphId: entityGraphId(item.entity),
    kind: 'entity',
    category: 'entity',
    content: item.entity,
    color: '#2b9db9',
    occurrenceCount: item.memories.length,
    memoryBodyIds: item.bodies.map(body => body.id),
    memoryBodyNames: item.bodies.map(body => body.name),
  }))
  for (const item of entities) {
    const key = entityGraphId(item.entity)
    for (const memory of item.memories) edges.push({ sourceId: key, targetId: graphNodeKey(memory), label: item.entity, color: '#22a879', type: 'entity' })
  }

  return { ...graph, nodes: [...spaceNodes, ...entityNodes, ...memories], edges }
}

function graphKindLabel(t: MnemonTranslate, node: MemoryGraphNode): string {
  const kind = graphNodeKind(node)
  return kind === 'space' ? t('graph.kindSpace') : kind === 'entity' ? t('graph.kindEntity') : categoryLabel(t, node.category ?? 'general')
}

function activeCategoryAnchors(grouped: Map<string, MemoryGraphNode[]>): Map<string, GraphPosition> {
  const categories = [...grouped.keys()].sort((left, right) => {
    const leftIndex = CATEGORY_ORDER.indexOf(left)
    const rightIndex = CATEGORY_ORDER.indexOf(right)
    return (leftIndex < 0 ? CATEGORY_ORDER.length : leftIndex) - (rightIndex < 0 ? CATEGORY_ORDER.length : rightIndex)
  })
  const anchors = new Map<string, GraphPosition>()
  if (categories.length === 1) {
    anchors.set(categories[0]!, { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 })
    return anchors
  }
  categories.forEach((category, index) => {
    const angle = -Math.PI / 2 + (index / categories.length) * Math.PI * 2
    anchors.set(category, {
      x: GRAPH_WIDTH / 2 + Math.cos(angle) * Math.min(250, 115 + categories.length * 23),
      y: GRAPH_HEIGHT / 2 + Math.sin(angle) * Math.min(165, 78 + categories.length * 15),
    })
  })
  return anchors
}

function clampGraphPosition(position: GraphPosition): GraphPosition {
  return {
    x: Math.min(GRAPH_WIDTH - GRAPH_MARGIN_X, Math.max(GRAPH_MARGIN_X, position.x)),
    y: Math.min(GRAPH_HEIGHT - GRAPH_MARGIN_Y, Math.max(GRAPH_MARGIN_Y, position.y)),
  }
}

function naturalGraphPositions(nodes: MemoryGraphNode[], edges: MemoryGraphSnapshot['edges']): GraphPositions {
  const positions: GraphPositions = new Map()
  const grouped = new Map<string, MemoryGraphNode[]>()
  for (const node of nodes) {
    const category = node.category ?? 'general'
    grouped.set(category, [...(grouped.get(category) ?? []), node])
  }
  const anchors = activeCategoryAnchors(grouped)
  for (const [category, items] of grouped) {
    const anchor = anchors.get(category) ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }
    items.forEach((node, index) => {
      const seed = hash(graphNodeKey(node))
      const angle = index * 2.399963 + ((seed % 37) / 37) * .4
      const radius = items.length === 1 ? 0 : 24 + Math.sqrt(index + 1) * 35
      positions.set(graphNodeKey(node), clampGraphPosition({ x: anchor.x + Math.cos(angle) * radius, y: anchor.y + Math.sin(angle) * radius }))
    })
  }

  const velocities = new Map(nodes.map(node => [graphNodeKey(node), { x: 0, y: 0 }]))
  const visibleIds = new Set(nodes.map(graphNodeKey))
  const visibleEdges = edges.filter(edge => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId))
  for (let iteration = 0; iteration < 150; iteration += 1) {
    const cooling = 1 - iteration / 180
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      const left = nodes[leftIndex]!
      const leftPosition = positions.get(graphNodeKey(left))!
      const leftVelocity = velocities.get(graphNodeKey(left))!
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const right = nodes[rightIndex]!
        const rightPosition = positions.get(graphNodeKey(right))!
        const rightVelocity = velocities.get(graphNodeKey(right))!
        let dx = leftPosition.x - rightPosition.x
        let dy = leftPosition.y - rightPosition.y
        if (dx === 0 && dy === 0) { dx = ((hash(graphNodeKey(left)) % 13) - 6) || 1; dy = ((hash(graphNodeKey(right)) % 11) - 5) || -1 }
        const distanceSquared = Math.max(100, dx * dx + dy * dy)
        const distance = Math.sqrt(distanceSquared)
        const repulsion = Math.min(9, 18_000 / distanceSquared) * cooling
        const collision = distance < 66 ? (66 - distance) * .08 : 0
        const force = repulsion + collision
        const forceX = (dx / distance) * force
        const forceY = (dy / distance) * force
        leftVelocity.x += forceX; leftVelocity.y += forceY
        rightVelocity.x -= forceX; rightVelocity.y -= forceY
      }
    }
    for (const edge of visibleEdges) {
      const source = positions.get(edge.sourceId)!
      const target = positions.get(edge.targetId)!
      const sourceVelocity = velocities.get(edge.sourceId)!
      const targetVelocity = velocities.get(edge.targetId)!
      const dx = target.x - source.x
      const dy = target.y - source.y
      const distance = Math.max(1, Math.hypot(dx, dy))
      const sparseScale = nodes.length <= 3 ? 2 : nodes.length <= 8 ? 1.45 : 1
      const desired = (edge.type === 'scope' ? 138 : edge.type === 'entity' ? 94 : edge.type === 'semantic' ? 118 : 106) * sparseScale
      const spring = (distance - desired) * .018 * cooling
      const forceX = (dx / distance) * spring
      const forceY = (dy / distance) * spring
      sourceVelocity.x += forceX; sourceVelocity.y += forceY
      targetVelocity.x -= forceX; targetVelocity.y -= forceY
    }
    for (const node of nodes) {
      const key = graphNodeKey(node)
      const position = positions.get(key)!
      const velocity = velocities.get(key)!
      const anchor = anchors.get(node.category ?? 'general') ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }
      velocity.x += (anchor.x - position.x) * .0035 * cooling + (GRAPH_WIDTH / 2 - position.x) * .0008
      velocity.y += (anchor.y - position.y) * .0035 * cooling + (GRAPH_HEIGHT / 2 - position.y) * .0008
      velocity.x = Math.max(-12, Math.min(12, velocity.x * .76))
      velocity.y = Math.max(-12, Math.min(12, velocity.y * .76))
      positions.set(key, clampGraphPosition({ x: position.x + velocity.x, y: position.y + velocity.y }))
    }
  }
  return positions
}

function uniformGraphPositions(nodes: MemoryGraphNode[]): GraphPositions {
  const positions: GraphPositions = new Map()
  const ordered = [...nodes].sort((left, right) => {
    const categoryDifference = CATEGORY_ORDER.indexOf(left.category ?? 'general') - CATEGORY_ORDER.indexOf(right.category ?? 'general')
    return categoryDifference === 0 ? left.id.localeCompare(right.id) : categoryDifference
  })
  const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length * 1.65)))
  const rows = Math.max(1, Math.ceil(ordered.length / columns))
  const cellWidth = (GRAPH_WIDTH - GRAPH_MARGIN_X * 2) / columns
  const cellHeight = (GRAPH_HEIGHT - GRAPH_MARGIN_Y * 2) / rows
  ordered.forEach((node, index) => {
    const row = Math.floor(index / columns)
    const column = index % columns
    const rowLength = Math.min(columns, ordered.length - row * columns)
    const rowOffset = (columns - rowLength) * cellWidth / 2
    positions.set(graphNodeKey(node), {
      x: GRAPH_MARGIN_X + rowOffset + cellWidth * (column + .5),
      y: GRAPH_MARGIN_Y + cellHeight * (row + .5),
    })
  })
  return positions
}

function graphPoint(svg: SVGSVGElement, clientX: number, clientY: number): GraphPosition {
  const matrix = svg.getScreenCTM?.()
  if (matrix !== null && matrix !== undefined && typeof svg.createSVGPoint === 'function') {
    const point = svg.createSVGPoint()
    point.x = clientX; point.y = clientY
    return clampGraphPosition(point.matrixTransform(matrix.inverse()))
  }
  const bounds = svg.getBoundingClientRect()
  const width = bounds.width || GRAPH_WIDTH
  const height = bounds.height || GRAPH_HEIGHT
  return clampGraphPosition({ x: (clientX - bounds.left) * GRAPH_WIDTH / width, y: (clientY - bounds.top) * GRAPH_HEIGHT / height })
}

function MemoryGraph(props: { graph: MemoryGraphSnapshot; selectedId?: string | undefined; onSelect: (node: MemoryGraphNode) => void }): JSX.Element {
  const t = useT()
  const visibleNodes = useMemo(() => {
    const spaces = props.graph.nodes.filter(node => graphNodeKind(node) === 'space')
    const entities = props.graph.nodes.filter(node => graphNodeKind(node) === 'entity').slice(0, 20)
    const memories = props.graph.nodes.filter(node => graphNodeKind(node) === 'memory').slice(0, Math.max(0, 60 - spaces.length - entities.length))
    return [...spaces, ...entities, ...memories].slice(0, 60)
  }, [props.graph.nodes])
  const visibleIds = useMemo(() => new Set(visibleNodes.map(graphNodeKey)), [visibleNodes])
  const visibleKinds = useMemo(() => new Map(visibleNodes.map(node => [graphNodeKey(node), graphNodeKind(node)])), [visibleNodes])
  const edges = useMemo(() => {
    const priority = new Map<string, number>([['entity', 0], ['scope', 1], ['causal', 2], ['semantic', 3], ['temporal', 4]])
    return props.graph.edges
      .filter(edge => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId))
      .map((edge, index) => ({ edge, index }))
      .sort((left, right) => (priority.get(left.edge.type ?? 'temporal') ?? 5) - (priority.get(right.edge.type ?? 'temporal') ?? 5) || left.index - right.index)
      .slice(0, 180)
      .map(({ edge }) => edge)
  }, [props.graph.edges, visibleIds])
  const curvedEdges = useMemo(() => {
    const groups = new Map<string, number[]>()
    edges.forEach((edge, index) => {
      const key = [edge.sourceId, edge.targetId].sort().join('::')
      groups.set(key, [...(groups.get(key) ?? []), index])
    })
    return edges.map((edge, index) => {
      const key = [edge.sourceId, edge.targetId].sort().join('::')
      const group = groups.get(key) ?? [index]
      const groupIndex = group.indexOf(index)
      return { edge, offset: (groupIndex - (group.length - 1) / 2) * 12 }
    })
  }, [edges])
  const layoutKey = `${visibleNodes.map(node => `${graphNodeKey(node)}:${graphNodeKind(node)}:${node.category ?? 'general'}`).join('|')}::${edges.map(edge => `${edge.sourceId}>${edge.targetId}:${edge.type ?? 'temporal'}`).join('|')}`
  const naturalLayout = useMemo(() => naturalGraphPositions(visibleNodes, edges), [layoutKey])
  const [positions, setPositions] = useState<GraphPositions>(() => naturalLayout)
  const [layoutMode, setLayoutMode] = useState<GraphLayoutMode>('natural')
  const positionsRef = useRef(positions)
  const animationRef = useRef<number | null>(null)
  const dragRef = useRef<{ nodeId: string; pointerId: number; startX: number; startY: number; moved: boolean } | null>(null)

  const commitPositions = useCallback((next: GraphPositions) => {
    positionsRef.current = next
    setPositions(next)
  }, [])

  const cancelAnimation = useCallback(() => {
    if (animationRef.current !== null && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(animationRef.current)
    animationRef.current = null
  }, [])

  const animateTo = useCallback((target: GraphPositions, mode: Exclude<GraphLayoutMode, 'custom'>) => {
    cancelAnimation()
    setLayoutMode(mode)
    if (typeof window.requestAnimationFrame !== 'function') { commitPositions(target); return }
    const start = new Map(positionsRef.current)
    const startedAt = performance.now()
    const tick = (time: number) => {
      const progress = Math.min(1, (time - startedAt) / 620)
      const eased = 1 - Math.pow(1 - progress, 3)
      const next: GraphPositions = new Map()
      for (const [id, destination] of target) {
        const origin = start.get(id) ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }
        next.set(id, { x: origin.x + (destination.x - origin.x) * eased, y: origin.y + (destination.y - origin.y) * eased })
      }
      commitPositions(next)
      if (progress < 1) animationRef.current = window.requestAnimationFrame(tick)
      else animationRef.current = null
    }
    animationRef.current = window.requestAnimationFrame(tick)
  }, [cancelAnimation, commitPositions])

  useEffect(() => { animateTo(naturalLayout, 'natural') }, [layoutKey])
  useEffect(() => () => cancelAnimation(), [cancelAnimation])

  const beginDrag = (event: ReactPointerEvent<SVGGElement>, nodeId: string) => {
    cancelAnimation()
    dragRef.current = { nodeId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const moveDrag = (event: ReactPointerEvent<SVGGElement>) => {
    const drag = dragRef.current
    const svg = event.currentTarget.ownerSVGElement
    if (drag === null || svg === null || drag.pointerId !== event.pointerId) return
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return
    drag.moved = true
    const point = graphPoint(svg, event.clientX, event.clientY)
    const next = new Map(positionsRef.current)
    next.set(drag.nodeId, point)
    commitPositions(next)
    setLayoutMode('custom')
  }
  const endDrag = (event: ReactPointerEvent<SVGGElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const svg = event.currentTarget.ownerSVGElement
    if (drag.moved && svg !== null) {
      const next = new Map(positionsRef.current)
      next.set(drag.nodeId, graphPoint(svg, event.clientX, event.clientY))
      commitPositions(next)
    }
    dragRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (!drag.moved) {
      const node = visibleNodes.find(candidate => graphNodeKey(candidate) === drag.nodeId)
      if (node !== undefined) props.onSelect(node)
    }
  }
  const cancelDrag = (event: ReactPointerEvent<SVGGElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
  }
  const nudge = (nodeId: string, dx: number, dy: number) => {
    cancelAnimation()
    const current = positionsRef.current.get(nodeId)
    if (current === undefined) return
    const next = new Map(positionsRef.current)
    next.set(nodeId, clampGraphPosition({ x: current.x + dx, y: current.y + dy }))
    commitPositions(next)
    setLayoutMode('custom')
  }
  const layoutLabel = t(layoutMode === 'natural' ? 'graph.layoutNatural' : layoutMode === 'uniform' ? 'graph.layoutUniform' : 'graph.layoutCustom')
  return (
    <>
      <div className={css.graphCanvasControls} role="toolbar" aria-label={t('graph.layoutAria')}>
        <span role="status" aria-label={t('graph.layoutStatus', { layout: layoutLabel })}><i />{t('graph.draggable', { layout: layoutLabel })}</span>
        <button type="button" data-active={layoutMode === 'natural' || undefined} onClick={() => animateTo(naturalGraphPositions(visibleNodes, edges), 'natural')}>{t('graph.naturalAction')}</button>
        <button type="button" data-active={layoutMode === 'uniform' || undefined} onClick={() => animateTo(uniformGraphPositions(visibleNodes), 'uniform')}>{t('graph.uniformAction')}</button>
      </div>
      <svg className={css.graphSvg} viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`} role="img" data-layout={layoutMode} data-density={visibleNodes.length <= 12 ? 'sparse' : 'dense'} aria-label={t('graph.aria', { nodes: props.graph.nodes.length, edges: props.graph.edges.length })}>
      <defs>
        <pattern id="mnemon-grid" width="26" height="26" patternUnits="userSpaceOnUse"><path d="M 26 0 L 0 0 0 26" className={css.graphGridLine} fill="none" /></pattern>
        <filter id="mnemon-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      <rect width={GRAPH_WIDTH} height={GRAPH_HEIGHT} className={css.graphBackdrop} />
      <rect width={GRAPH_WIDTH} height={GRAPH_HEIGHT} fill="url(#mnemon-grid)" />
      {curvedEdges.map(({ edge, offset }, index) => {
        const source = positions.get(edge.sourceId) ?? naturalLayout.get(edge.sourceId) ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }
        const target = positions.get(edge.targetId) ?? naturalLayout.get(edge.targetId) ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }
        const dx = target.x - source.x
        const dy = target.y - source.y
        const distance = Math.max(1, Math.hypot(dx, dy))
        const direction = edge.sourceId.localeCompare(edge.targetId) <= 0 ? 1 : -1
        const controlX = (source.x + target.x) / 2 - (dy / distance) * offset * direction
        const controlY = (source.y + target.y) / 2 + (dx / distance) * offset * direction
        return <path key={`${edge.sourceId}-${edge.targetId}-${index}`} d={`M ${source.x} ${source.y} Q ${controlX} ${controlY} ${target.x} ${target.y}`} className={css.graphEdge} data-edge={edge.type ?? 'temporal'} data-source-id={edge.sourceId} data-target-id={edge.targetId} data-source-kind={visibleKinds.get(edge.sourceId)} data-target-kind={visibleKinds.get(edge.targetId)} />
      })}
      {visibleNodes.map((node, index) => {
        const nodeKey = graphNodeKey(node)
        const position = positions.get(nodeKey) ?? naturalLayout.get(nodeKey) ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }
        const selected = props.selectedId === nodeKey
        const showLabel = selected || visibleNodes.length < 22 || index % 3 === 0
        return (
          <g key={nodeKey} className={css.graphNode} data-node-id={nodeKey} data-provider={node.memoryProviderId} data-category={node.category ?? 'general'} data-kind={graphNodeKind(node)} data-selected={selected || undefined}
            transform={`translate(${position.x} ${position.y})`} role="button" tabIndex={0} aria-label={`${graphKindLabel(t, node)}: ${short(node.content, 80)}`}
            data-dragging={dragRef.current?.nodeId === nodeKey || undefined}
            onPointerDown={event => beginDrag(event, nodeKey)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
            onClick={() => props.onSelect(node)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') props.onSelect(node)
              else if (event.key === 'ArrowLeft') { event.preventDefault(); nudge(nodeKey, -12, 0) }
              else if (event.key === 'ArrowRight') { event.preventDefault(); nudge(nodeKey, 12, 0) }
              else if (event.key === 'ArrowUp') { event.preventDefault(); nudge(nodeKey, 0, -12) }
              else if (event.key === 'ArrowDown') { event.preventDefault(); nudge(nodeKey, 0, 12) }
            }}>
            {graphNodeKind(node) === 'space'
              ? <><rect x={selected ? -20 : -17} y={selected ? -15 : -13} width={selected ? 40 : 34} height={selected ? 30 : 26} rx="9" className={css.nodeHalo} filter={selected ? 'url(#mnemon-glow)' : undefined} /><circle r={selected ? 6 : 5} className={css.nodeCore} /></>
              : graphNodeKind(node) === 'entity'
                ? <><path d={selected ? 'M 0 -18 L 18 0 L 0 18 L -18 0 Z' : 'M 0 -14 L 14 0 L 0 14 L -14 0 Z'} className={css.nodeHalo} filter={selected ? 'url(#mnemon-glow)' : undefined} /><circle r={selected ? 5 : 4} className={css.nodeCore} /></>
                : <><circle r={selected ? 17 : visibleNodes.length <= 12 ? 14 : 11} className={css.nodeHalo} filter={selected ? 'url(#mnemon-glow)' : undefined} /><circle r={selected ? 7 : visibleNodes.length <= 12 ? 6 : 4.5} className={css.nodeCore} /></>}
            {(selected || visibleNodes.length <= 12) && graphNodeKind(node) === 'memory' && node.memoryBodyName !== undefined && <text x="0" y="-18" textAnchor="middle" className={css.nodeBodyLabel}>{short(node.memoryBodyName, 12)}</text>}
            {showLabel && <text x={visibleNodes.length <= 12 ? 19 : 15} y="4" className={css.nodeLabel}>{short(node.content.replace(/\s+/gu, ' '), selected ? 34 : visibleNodes.length <= 12 ? 26 : 19)}</text>}
          </g>
        )
      })}
      </svg>
    </>
  )
}

function OverviewPage(props: { client: MnemonClient; metadataClient: MnemonClient; revision: number; activationEnabled: boolean; writeEnabled: boolean; agentAvailable: boolean; fallbackBodies: MemoryBodyView[]; fallbackDirectory: string | undefined; catalogKnown: boolean; onMutate: () => void; onAgentRefresh: () => void; onBodyReconnect: (body: MemoryBodyView) => void; onBodyMetadata: (updates: readonly MemoryBodyMetadataUpdate[]) => void; onExplore: (query: string) => void }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const bodyCreateFormId = useId()
  const bodyEditFormId = useId()
  const [graph, setGraph] = useState<MemoryGraphSnapshot | null>(null)
  const [catalog, setCatalog] = useState<MemoryBodyCatalog | null>(null)
  const [selected, setSelected] = useState<MemoryGraphNode | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [healthLoading, setHealthLoading] = useState(true)
  const [graphLoading, setGraphLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [changing, setChanging] = useState<string | null>(null)
  const [reconnectingBody, setReconnectingBody] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [creatingBodyOpen, setCreatingBodyOpen] = useState(false)
  const [bodyName, setBodyName] = useState('')
  const [bodyDescription, setBodyDescription] = useState('')
  const [bodyProviderId, setBodyProviderId] = useState<MemoryProviderId>('mnemon-native')
  const [providerDrafts, setProviderDrafts] = useState<ProviderDrafts>({})
  const [catalogUnavailable, setCatalogUnavailable] = useState(false)
  const [editingBody, setEditingBody] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editConnection, setEditConnection] = useState<MemoryProviderConnection>({})
  const [editClearSecrets, setEditClearSecrets] = useState<string[]>([])
  const [savingBody, setSavingBody] = useState<string | null>(null)
  const [confirmingDeleteBody, setConfirmingDeleteBody] = useState<string | null>(null)
  const [deletingBody, setDeletingBody] = useState<string | null>(null)
  const [preview, setPreview] = useState<MemoryGraphNode | null>(null)
  const [metadataOpen, setMetadataOpen] = useState(false)
  const [metadataSelection, setMetadataSelection] = useState<string[]>([])
  const [metadataTasks, setMetadataTasks] = useState<Record<string, { status: 'running' | 'success' | 'error'; error?: string }>>({})
  const [lastFullSyncAt, setLastFullSyncAt] = useState<number | null>(null)
  const [syncClock, setSyncClock] = useState(() => Date.now())
  const loadRequest = useRef(0)
  const initialSyncStarted = useRef(false)
  const compatibilityRetryStarted = useRef(false)
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
      const normalizedProviders = Array.isArray(nextCatalog.providers) && nextCatalog.providers.length > 0 ? nextCatalog.providers : LEGACY_PROVIDER_CATALOG
      const normalizedCatalog = { ...nextCatalog, providers: normalizedProviders, items: nextCatalog.items.map(normalizeMemoryBody) }
      if (request !== loadRequest.current) return
      setProviderDrafts(current => mergeProviderDefaults(normalizedCatalog.providers, current))
      setCatalog(normalizedCatalog)
      setCatalogLoading(false)
      void props.client.bodies().then(next => {
        if (request !== loadRequest.current) return
        const full = { ...next, providers: Array.isArray(next.providers) && next.providers.length > 0 ? next.providers : normalizedProviders, items: next.items.map(normalizeMemoryBody) }
        setCatalog(full)
      }).catch(reason => {
        if (request === loadRequest.current && !quiet && !directoryUnavailable) setError(message(reason))
      }).finally(() => { if (request === loadRequest.current) setHealthLoading(false) })
      void props.client.graph().then(next => {
        if (request !== loadRequest.current) return
        const enriched = enrichMultiSpaceGraph(next, normalizedCatalog.items)
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
  useEffect(() => {
    if (!catalogUnavailable || !props.catalogKnown || compatibilityRetryStarted.current) return
    compatibilityRetryStarted.current = true
    void load(true)
  }, [catalogUnavailable, load, props.catalogKnown])
  useEffect(() => {
    const timer = window.setInterval(() => setSyncClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const toggle = async (body: MemoryBodyView) => {
    setChanging(body.id); setError(null)
    try {
      await props.client.updateBody(body.id, { active: !body.active })
      await load(true)
      props.onMutate()
    } catch (reason) { setError(message(reason)) } finally { setChanging(null) }
  }

  const reconnect = async (body: MemoryBodyView) => {
    if (reconnectingBody !== null || editingBody !== null || deletingBody !== null) return
    setReconnectingBody(body.id); setError(null)
    setCatalog(current => current === null ? current : {
      ...current,
      items: current.items.map(item => item.id === body.id ? { ...item, statusLoading: true } : item),
    })
    try {
      const next = normalizeMemoryBody(await props.client.reconnectBody(body.id))
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
      setReconnectingBody(null)
    }
  }

  const beginEdit = (body: MemoryBodyView) => {
    setEditingBody(body.id); setEditName(body.name); setEditDescription(body.description ?? ''); setError(null)
    setEditConnection(body.provider.id === 'mnemon-native' ? {} : { ...body.provider.settings })
    setEditClearSecrets([])
  }

  const saveEdit = async (event: FormEvent, body: MemoryBodyView) => {
    event.preventDefault()
    if (editName.trim() === '') return
    setSavingBody(body.id); setError(null)
    try {
      const descriptor = catalog?.providers.find(provider => provider.id === body.provider.id)
      const connection = descriptor === undefined ? {} : Object.fromEntries(Object.entries(editConnection).filter(([key, value]) => {
        const field = descriptor.fields.find(candidate => candidate.key === key)
        return field?.input !== 'secret' || String(value) !== ''
      }))
      await props.client.updateBody(body.id, {
        name: editName,
        description: editDescription,
        ...(body.provider.id === 'mnemon-native' ? {} : { connection, ...(editClearSecrets.length === 0 ? {} : { clearSecrets: editClearSecrets }) }),
      })
      setEditingBody(null)
      await load(true)
      props.onMutate()
    } catch (reason) { setError(message(reason)) } finally { setSavingBody(null) }
  }

  const create = async (event: FormEvent) => {
    event.preventDefault()
    const providers = catalog?.providers ?? []
    const manualProvider = providers.find(provider => provider.id === bodyProviderId)
    if (bodyName.trim() === '' || bodyDescription.trim() === '' || !providerDraftComplete(manualProvider, providerDrafts[bodyProviderId])) return
    setCreating(true); setError(null)
    try {
      await props.client.createBody({
        name: bodyName,
        description: bodyDescription,
        providerId: bodyProviderId,
        ...(bodyProviderId === 'mnemon-native' ? {} : { connection: providerDrafts[bodyProviderId] ?? {} }),
      })
      setBodyName(''); setBodyDescription(''); setBodyProviderId('mnemon-native')
      setProviderDrafts(current => Object.fromEntries(providers.map(provider => [provider.id, Object.fromEntries(Object.entries(current[provider.id] ?? {}).map(([key, value]) => [key, provider.fields.some(field => field.key === key && field.input === 'secret') ? '' : value]))])))
      setCreatingBodyOpen(false)
      await load(true)
      props.onMutate()
    } catch (reason) { setError(message(reason)) } finally { setCreating(false) }
  }

  const deleteBody = async (body: MemoryBodyView) => {
    setDeletingBody(body.id); setError(null)
    try {
      await props.client.deleteBody(body.id)
      setConfirmingDeleteBody(null)
      await load(true)
      props.onMutate()
    } catch (reason) { setError(message(reason)) } finally { setDeletingBody(null) }
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
  const editingBodyView = editingBody === null ? undefined : catalog?.items.find(body => body.id === editingBody)
  const deletingBodyView = confirmingDeleteBody === null ? undefined : catalog?.items.find(body => body.id === confirmingDeleteBody)
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
  const selectedProvider = providers.find(provider => provider.id === bodyProviderId)
  const nativeBodyCount = catalog?.items.filter(body => body.provider.id === 'mnemon-native').length ?? 0
  const canDeleteBody = (body: MemoryBodyView): boolean => body.provider.id !== 'mnemon-native' || nativeBodyCount > 1
  const updateProviderDraft = (providerId: MemoryProviderId, key: string, value: string | number | boolean) => setProviderDrafts(current => ({ ...current, [providerId]: { ...(current[providerId] ?? {}), [key]: value } }))
  const placementReceipt = (body: MemoryBodyView) => body.placement === undefined ? null : <div className={css.placementReceipt} title={body.placement.reason}><span aria-hidden="true">✦</span><div><strong>{t(body.placement.decidedBy === 'llm' ? 'overview.placementByLlm' : 'overview.placementByRules')}</strong><small>{t('overview.placementConfidence', { confidence: t(`overview.confidence.${body.placement.confidence}`) })}</small><p>{body.placement.reason}</p></div></div>
  const bodyEditForm = (body: MemoryBodyView) => <form id={bodyEditFormId} className={css.bodyEdit} onSubmit={event => void saveEdit(event, body)}>
    <label>{t('overview.editName')}<input aria-label={t('overview.editName')} value={editName} onChange={event => setEditName(event.target.value)} maxLength={100} required /></label>
    <label>{t('overview.editDescription')}<textarea aria-label={t('overview.editDescription')} value={editDescription} onChange={event => setEditDescription(event.target.value)} rows={4} maxLength={1000} /></label>
    {body.provider.id !== 'mnemon-native' && (() => { const descriptor = providers.find(provider => provider.id === body.provider.id); return descriptor === undefined ? null : <ProviderMemoryFields provider={descriptor} connection={editConnection} onChange={(key, value) => setEditConnection(current => ({ ...current, [key]: value }))} body={body} clearSecrets={editClearSecrets} onClearSecretsChange={setEditClearSecrets} /> })()}
  </form>
  const bodyCreateForm = <form id={bodyCreateFormId} className={appearanceClass(css.bodyEdit, css.bodyCreateForm)} onSubmit={event => void create(event)}>
    <section className={css.createSection}>
      <div className={css.createSectionHeading}><span>01</span><div><strong>{t('overview.createIdentityTitle')}</strong><small>{t('overview.createIdentityHint')}</small></div></div>
      <div className={css.createIdentityGrid}>
        <label>{t('overview.createName')}<input data-autofocus aria-label={t('overview.createName')} value={bodyName} onChange={event => setBodyName(event.target.value)} placeholder={t('overview.createNamePlaceholder')} maxLength={100} required /></label>
        <label>{t('overview.createDescription')}<textarea aria-label={t('overview.createDescription')} value={bodyDescription} onChange={event => setBodyDescription(event.target.value)} placeholder={t('overview.createDescriptionPlaceholder')} rows={3} maxLength={1000} required /></label>
      </div>
    </section>
    <section className={css.createSection}>
      <div className={css.createSectionHeading}><span>02</span><div><strong>{t('overview.createPlacementTitle')}</strong><small>{t('overview.createPlacementHint')}</small></div></div>
      <fieldset className={css.providerChoice}><legend>{t('overview.providerLabel')}</legend>{providers.map(provider => {
        const serviceMissing = provider.id !== 'mnemon-native' && provider.serviceConfigured === false
        return <label key={provider.id} data-selected={bodyProviderId === provider.id || undefined} data-native={provider.id === 'mnemon-native' || undefined} data-disabled={serviceMissing || undefined}>
          <input type="radio" name="memory-provider" value={provider.id} checked={bodyProviderId === provider.id} disabled={serviceMissing} onChange={() => setBodyProviderId(provider.id)} />
          <ProviderIcon providerId={provider.id} className={css.providerChoiceIcon} />
          <span><strong>{provider.label}{provider.id === 'mnemon-native' && <em>{t('overview.nativeOfficial')}</em>}</strong><small>{serviceMissing ? t('overview.providerServiceRequired') : `${t(`overview.workspaceBinding.${provider.workspaceBinding}`)} · ${providerSummary(t, provider)}`}</small></span>
          <i className={css.choiceControl} data-kind="radio" aria-hidden="true" />
        </label>
      })}</fieldset>
      {selectedProvider !== undefined && selectedProvider.id !== 'mnemon-native' && <ProviderMemoryFields provider={selectedProvider} connection={providerDrafts[selectedProvider.id] ?? {}} onChange={(key, value) => updateProviderDraft(selectedProvider.id, key, value)} />}
    </section>
  </form>
  const bodyToggle = (body: MemoryBodyView) => <button type="button" className={css.bodySwitch} role="switch" aria-checked={body.active} aria-label={t('overview.toggleAria', { name: body.name })} disabled={!props.activationEnabled || changing === body.id || deletingBody === body.id} onClick={() => void toggle(body)}><span className={css.bodySwitchTrack} aria-hidden="true"><i /></span><span>{changing === body.id ? t('overview.toggling') : body.active ? t('common.active') : t('common.inactive')}</span></button>
  const bodyEditActionClass = appearanceClass(css.ghostButton, appearanceClass(sidebarCss.itemActionButton, sidebarCss.itemEditAction))
  const bodyDeleteActionClass = appearanceClass(css.dangerButton, appearanceClass(sidebarCss.itemActionButton, sidebarCss.itemDangerAction))
  return (
    <div className={css.page}>
      <PageHeader title={t('nav.overview')} description={t('overview.pageDescription')} meta={fullSyncAge} {...(loading ? { loadingLabel: catalogLoading ? t('overview.directoryLoading') : graphLoading ? t('overview.snapshotLoading') : t('overview.healthLoading') } : {})}
        action={<button type="button" className={css.secondaryButton} disabled={loading} onClick={() => void load()}>{loading ? t('overview.syncing') : t('overview.syncNow')}</button>} />
      {error !== null && <div className={css.inlineError} role="alert">{error}</div>}
      <section className={css.bodyDirectory} aria-label={t('overview.directory')}>
        <div className={css.bodyDirectoryHeader}>
          <div><h3>{t('overview.directory')}</h3><p>{t('overview.directory.description')}</p><code className={css.bodyDirectoryPath}>{catalogUnavailable ? t('overview.directory.unsynced') : catalog?.directory || props.fallbackDirectory || t('overview.directory.waiting')}</code></div>
          <div className={appearanceClass(css.bodyDirectoryControls, sidebarCss.bodyDirectoryActions)}>
            <strong>{catalogUnavailable ? t('overview.directory.unsyncedBadge') : `${catalog?.activeCount ?? '—'} / ${catalog?.total ?? '—'} ${t('common.active')}`}</strong>
            {props.writeEnabled && !catalogUnavailable && <button type="button" className={bodyEditActionClass} title={!props.agentAvailable ? t('overview.metadataUnavailable') : undefined} onClick={() => { setMetadataSelection([]); setMetadataTasks({}); setMetadataOpen(true); if (!props.agentAvailable) props.onAgentRefresh() }}>{t('overview.metadataAction')}</button>}
            {props.writeEnabled && !catalogUnavailable && <button type="button" className={bodyEditActionClass} onClick={() => setCreatingBodyOpen(true)}>{t('overview.createTitle')}</button>}
          </div>
        </div>
        <div className={css.bodyGrid}>
          {catalog?.items.map(body => (
            <article key={body.id} className={css.bodyCard} data-provider={body.provider.id} data-active={body.active || undefined} data-healthy={!body.statusLoading && body.healthy || undefined} data-status-loading={body.statusLoading || undefined} data-reconnectable="" data-reconnecting={reconnectingBody === body.id || undefined} data-mnemon-default={body.mnemonDefault || undefined} tabIndex={0} aria-label={t('overview.reconnectAria', { name: body.name })} title={reconnectingBody === body.id ? t('overview.reconnecting') : body.error ?? t('overview.reconnectHint')} onClick={event => {
              if (event.target instanceof Element && event.target.closest('button, input, textarea, select, label, a, [role="switch"]') !== null) return
              void reconnect(body)
            }} onKeyDown={event => {
              if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
              event.preventDefault(); void reconnect(body)
            }}>
              <div className={sidebarCss.bodyCardHeader}><div className={sidebarCss.bodyCardIdentity}><span className={css.bodySignal} /><div><strong>{body.name}</strong><div className={sidebarCss.bodyCardMeta}><code>{body.id}</code><MemoryProviderBadge providerId={body.provider.id} label={body.provider.label} /><small className={css.bodyHealth}>{reconnectingBody === body.id ? t('overview.reconnecting') : body.statusLoading ? t('overview.storageChecking') : body.healthy ? t('overview.storageHealthy') : t('overview.storageUnhealthy')}</small>{body.mnemonDefault && <small className={css.mnemonDefaultBadge}>{t('overview.mnemonDefault')}</small>}</div></div></div>{bodyToggle(body)}</div><p title={body.description || t('overview.noDescription')}>{body.description || t('overview.noDescription')}</p>{placementReceipt(body)}<footer className={sidebarCss.bodyCardFooter}><div className={sidebarCss.bodyCardStats}>{body.provider.id !== 'mnemon-native' ? <><span className={css.bodyFooterBlock} title={t(body.provider.kind === 'remote' ? 'overview.providerRemote' : 'overview.providerLocal')}>{t(body.provider.kind === 'remote' ? 'overview.providerRemote' : 'overview.providerLocal')}</span><span className={`${css.bodyFooterBlock} ${css.bodyFooterGrow}`} title={body.provider.location || body.provider.label}>{body.provider.location || body.provider.label}</span></> : <><span className={css.bodyFooterBlock} title={t('common.memories', { count: body.stats?.totalInsights ?? 0 })}>{t('common.memories', { count: body.stats?.totalInsights ?? 0 })}</span><span className={css.bodyFooterBlock} title={t('common.edges', { count: body.stats?.edgeCount ?? 0 })}>{t('common.edges', { count: body.stats?.edgeCount ?? 0 })}</span><span className={css.bodyFooterBlock} title={humanBytes(body.stats?.dbSizeBytes ?? 0)}>{humanBytes(body.stats?.dbSizeBytes ?? 0)}</span></>}</div><div className={css.bodyCardActions}><button type="button" className={bodyEditActionClass} aria-label={t('overview.editBodyAria', { name: body.name })} disabled={!props.writeEnabled || deletingBody === body.id} onClick={() => beginEdit(body)}>{t('overview.editBody')}</button><button type="button" className={bodyDeleteActionClass} aria-label={t(body.provider.id !== 'mnemon-native' ? 'overview.disconnectBodyAria' : 'overview.deleteBodyAria', { name: body.name })} title={canDeleteBody(body) ? undefined : t('overview.lastStoreDeleteHint')} disabled={!props.writeEnabled || deletingBody === body.id || !canDeleteBody(body)} onClick={() => setConfirmingDeleteBody(body.id)}>{body.provider.id !== 'mnemon-native' ? t('overview.disconnectBody') : t('overview.deleteBody')}</button></div></footer>
            </article>
          ))}
          {catalog?.total === 0 && <div className={css.bodyDirectoryEmpty}><span>◇</span><div><strong>{catalogUnavailable ? t('overview.unsyncedTitle') : t('overview.emptyTitle')}</strong><p>{catalogUnavailable ? t('overview.unsyncedShort') : t('overview.emptyShort')}</p></div></div>}
        </div>
      </section>
      <div className={css.asyncRegion}><ReadSourcePanel title={t('overview.snapshotSources')} hint={t('overview.snapshotSourcesHint')} sources={graphSources} /></div>
      {creatingBodyOpen && <SidebarModal title={t('overview.createTitle')} description={t('overview.createDialogHint')} busy={creating} wide onClose={() => setCreatingBodyOpen(false)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.ghostButton} disabled={creating} onClick={() => setCreatingBodyOpen(false)}>{t('common.cancel')}</button><button type="submit" form={bodyCreateFormId} className={css.primaryButton} disabled={creating || bodyName.trim() === '' || bodyDescription.trim() === '' || !providerDraftComplete(selectedProvider, providerDrafts[bodyProviderId])}>{creating ? t('overview.creating') : t('overview.createAction')}</button></div>}>{bodyCreateForm}</SidebarModal>}
      {metadataOpen && <SidebarModal title={t('overview.metadataTitle')} description={t('overview.metadataDescription')} busy={metadataBusy} wide onClose={() => setMetadataOpen(false)} footer={<><p className={css.modalFooterNote}>{t('overview.metadataSafety')}</p><div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.ghostButton} disabled={metadataBusy} onClick={() => setMetadataOpen(false)}>{t('common.cancel')}</button><button type="button" className={css.primaryButton} disabled={!props.agentAvailable || metadataSelection.length === 0} title={!props.agentAvailable ? t('overview.metadataUnavailable') : undefined} onClick={maintainMetadata}>{t('overview.metadataGenerate', { count: metadataSelection.length })}</button></div></>}><div className={css.metadataDialog}>
        {!props.agentAvailable && <div className={css.inlineError} role="status">{t('overview.metadataUnavailable')}</div>}
        <div className={css.metadataToolbar}><span>{t('overview.metadataSelected', { count: metadataSelection.length })}{metadataRunningCount > 0 && <em>{t('overview.metadataRunningCount', { count: metadataRunningCount })}</em>}</span><button type="button" className={css.ghostButton} disabled={metadataSelectable.length === 0} onClick={() => setMetadataSelection(metadataAllSelected ? [] : metadataSelectable.map(body => body.id))}>{metadataAllSelected ? t('overview.metadataClear') : t('overview.metadataSelectAll')}</button></div>
        <div className={css.metadataList} aria-live="polite">{metadataCandidates.length === 0 && <div className={css.metadataEmpty}>{catalogLoading ? t('overview.metadataLoading') : t('overview.metadataEmpty')}</div>}{metadataCandidates.map(body => {
          const selected = metadataSelection.includes(body.id)
          const task = metadataTasks[body.id]
          return <label key={body.id} data-provider={body.provider.id} data-selected={selected || undefined} data-refreshing={task?.status === 'running' || undefined} data-refreshed={task?.status === 'success' || undefined} data-failed={task?.status === 'error' || undefined}><input type="checkbox" checked={selected} disabled={task?.status === 'running'} onChange={event => setMetadataSelection(current => event.target.checked ? [...new Set([...current, body.id])] : current.filter(id => id !== body.id))} /><i className={css.choiceControl} data-kind="check" aria-hidden="true" /><span><strong>{body.name}</strong><small>{body.description || t('overview.noDescription')}</small><span><MemoryProviderBadge providerId={body.provider.id} label={body.provider.label} />{task === undefined ? <code>{body.id}</code> : <small className={css.metadataTaskStatus} data-status={task.status} title={task.error}>{task.status === 'running' ? t('overview.metadataTaskRunning') : task.status === 'success' ? t('overview.metadataTaskSuccess') : t('overview.metadataTaskError', { error: task.error ?? t('overview.metadataTaskUnknown') })}</small>}</span></span></label>
        })}</div>
      </div></SidebarModal>}
      {editingBodyView !== undefined && <SidebarModal title={t('overview.editBodyAria', { name: editingBodyView.name })} description={editingBodyView.id} busy={savingBody === editingBodyView.id} onClose={() => setEditingBody(null)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.ghostButton} disabled={savingBody === editingBodyView.id} onClick={() => setEditingBody(null)}>{t('common.cancel')}</button><button type="submit" form={bodyEditFormId} className={css.primaryButton} disabled={savingBody === editingBodyView.id || editName.trim() === ''}>{savingBody === editingBodyView.id ? t('overview.savingBody') : t('overview.saveBody')}</button></div>}>{bodyEditForm(editingBodyView)}</SidebarModal>}
      {deletingBodyView !== undefined && <SidebarModal title={t(deletingBodyView.provider.id !== 'mnemon-native' ? 'overview.disconnectTitle' : 'overview.deleteTitle', { name: deletingBodyView.name })} description={deletingBodyView.id} busy={deletingBody === deletingBodyView.id} onClose={() => setConfirmingDeleteBody(null)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close data-autofocus className={css.ghostButton} disabled={deletingBody === deletingBodyView.id} onClick={() => setConfirmingDeleteBody(null)}>{t('common.cancel')}</button><button type="button" className={css.dangerSolidButton} title={canDeleteBody(deletingBodyView) ? undefined : t('overview.lastStoreDeleteHint')} disabled={deletingBody === deletingBodyView.id || !canDeleteBody(deletingBodyView)} onClick={() => void deleteBody(deletingBodyView)}>{deletingBody === deletingBodyView.id ? t('overview.deletingBody') : t(deletingBodyView.provider.id !== 'mnemon-native' ? 'overview.disconnectAction' : 'overview.deleteAction')}</button></div>}><div className={css.bodyDeleteConfirm}><p>{t(deletingBodyView.provider.id !== 'mnemon-native' ? 'overview.disconnectWarning' : 'overview.deleteWarning', { provider: deletingBodyView.provider.label })}</p><div className={css.bodyDeleteSummary}><strong>{deletingBodyView.name}</strong><span>{deletingBodyView.provider.label} · {deletingBodyView.provider.location || t('common.memories', { count: deletingBodyView.stats?.totalInsights ?? 0 })}</span></div></div></SidebarModal>}
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
                <div className={css.inspectorChips}><span className={css.categoryChip}>{graphKindLabel(t, selected)}</span>{selected.memoryProviderId !== undefined && <MemoryProviderBadge providerId={selected.memoryProviderId} label={MEMORY_PROVIDER_LABELS[selected.memoryProviderId]} />}</div>
                <div className={css.inspectorTitleRow}><h3 className={css.inspectorTitle}>{selected.content}</h3>{selectedKind === 'memory' && selected.content.length > 140 && <button type="button" className={css.inspectorEye} onClick={() => setPreview(selected)} aria-label={t('overview.previewAria')} title={t('overview.previewAria')}><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1 8s2.6-4.4 7-4.4S15 8 15 8s-2.6 4.4-7 4.4S1 8 1 8z" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="8" cy="8" r="2.1" fill="currentColor" /></svg></button>}</div>
                {selectedKind === 'space'
                  ? <dl className={css.inspectorMeta}><div><dt>{t('overview.spaceId')}</dt><dd><code>{selected.memoryBodyId ?? selected.id}</code></dd></div><div><dt>{t('overview.containedMemories')}</dt><dd>{selected.occurrenceCount ?? 0}</dd></div></dl>
                  : selectedKind === 'entity'
                    ? <dl className={css.inspectorMeta}><div><dt>{t('overview.entityMentions')}</dt><dd>{selected.occurrenceCount ?? 0}</dd></div><div><dt>{t('term.spaces')}</dt><dd>{selected.memoryBodyNames?.join(' · ') || '—'}</dd></div></dl>
                    : <dl className={css.inspectorMeta}><div><dt>{t('term.space')}</dt><dd>{selected.memoryBodyName ?? '—'} <code>{selected.memoryBodyId ?? ''}</code></dd></div><div><dt>{t('overview.memoryId')}</dt><dd><code>{selected.id}</code></dd></div><div><dt>{t('common.category')}</dt><dd>{categoryLabel(t, selected.category ?? 'general')}</dd></div></dl>}
                <div className={css.inspectorActions}>{selectedKind !== 'space' && <button type="button" className={css.primaryButton} onClick={() => props.onExplore(selected.content)}>{t('overview.exploreNode')}</button>}<button type="button" className={css.secondaryButton} onClick={() => void navigator.clipboard?.writeText(selected.id)}>{t('common.copyId')}</button></div>
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

function ExplorePage(props: { client: MnemonClient; agentClient: MnemonClient; agentAvailable: boolean; status: StatusView | null; seed: string; writeEnabled: boolean; onForget: (insight: Insight) => Promise<void> }): JSX.Element {
  const t = useT()
  const pageSize = 6
  const [query, setQuery] = useState(props.seed)
  const [mode, setMode] = useState<'smart' | 'keyword' | 'basic'>('smart')
  const [category, setCategory] = useState<Category | ''>('')
  const [results, setResults] = useState<Insight[]>([])
  const [sources, setSources] = useState<MemoryReadSource[]>([])
  const [searchKind, setSearchKind] = useState<'direct' | 'agent' | null>(null)
  const [agentAnswer, setAgentAnswer] = useState<{ answer: string; citations: string[]; runId: string } | null>(null)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [relatedTo, setRelatedTo] = useState<Insight | null>(null)
  const [related, setRelated] = useState<Insight[]>([])
  const [relatedLoading, setRelatedLoading] = useState(false)
  const [visibleResultLimit, setVisibleResultLimit] = useState(pageSize)
  const [visibleRelatedLimit, setVisibleRelatedLimit] = useState(pageSize)
  const relatedRequests = useRequestVersion()

  useEffect(() => { if (props.seed !== '') setQuery(props.seed) }, [props.seed])

  const runSearch = async (withAgent: boolean) => {
    if (query.trim() === '') return
    relatedRequests.begin()
    setSearchKind(withAgent ? 'agent' : 'direct'); setSearched(true); setError(null); setRelatedTo(null); setAgentAnswer(null); setVisibleResultLimit(pageSize); setVisibleRelatedLimit(pageSize)
    try {
      const request = { query, mode, ...(category === '' ? {} : { category }), limit: props.status?.defaultRecallLimit ?? 10 }
      if (withAgent) {
        const response = await props.agentClient.agentSearch(request)
        setResults(response.results)
        setSources(response.sources ?? [])
        setAgentAnswer({ answer: response.answer, citations: response.citations, runId: response.delegation.runId })
      } else {
        const response = await props.client.search(request)
        setResults(response.results)
        setSources(response.sources ?? [])
      }
    } catch (reason) {
      setError(message(reason)); setResults([]); setSources([]); setAgentAnswer(null)
    } finally {
      setSearchKind(null)
    }
  }

  const search = (event: FormEvent) => { event.preventDefault(); void runSearch(false) }
  const searching = searchKind !== null

  const showRelated = async (insight: Insight) => {
    const request = relatedRequests.begin()
    setRelatedTo(insight); setRelated([]); setRelatedLoading(true); setError(null); setVisibleRelatedLimit(pageSize)
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => document.getElementById('mnemon-related-pane')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }))
    try {
      const response = await props.client.related(insight.id, insight.memoryBodyId)
      if (relatedRequests.isCurrent(request)) setRelated(response)
    } catch (reason) {
      if (relatedRequests.isCurrent(request)) setError(message(reason))
    } finally {
      if (relatedRequests.isCurrent(request)) setRelatedLoading(false)
    }
  }

  const forget = async (insight: Insight) => {
    await props.onForget(insight)
    setResults(items => items.filter(item => insightKey(item) !== insightKey(insight)))
    setRelated(items => items.filter(item => insightKey(item) !== insightKey(insight)))
    if (relatedTo !== null && insightKey(relatedTo) === insightKey(insight)) setRelatedTo(null)
  }
  const visibleResults = results.slice(0, visibleResultLimit)
  const visibleRelated = related.slice(0, visibleRelatedLimit)

  return (
    <div className={css.page}>
      <PageHeader title={t('search.title')} description={t('search.description')} meta={t('search.maxResults', { count: props.status?.defaultRecallLimit ?? '—' })} />
      <form className={css.searchBar} onSubmit={event => void search(event)}>
        <div className={css.queryField}><span aria-hidden="true">⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('search.placeholder')} aria-label={t('search.queryAria')} /><kbd>↵</kbd></div>
        <div className={css.searchControls}>
          <label>{t('common.category')}<select value={category} onChange={event => setCategory(event.target.value as Category | '')} aria-label={t('search.categoryAria')}><option value="">{t('common.allCategories')}</option>{CATEGORIES.map(value => <option key={value} value={value}>{categoryLabel(t, value)}</option>)}</select></label>
          <label>{t('search.strategy')}<select value={mode} onChange={event => setMode(event.target.value as 'smart' | 'keyword' | 'basic')} aria-label={t('search.modeAria')}><option value="smart">{t('search.modeSmart')}</option><option value="keyword">{t('search.modeKeyword')}</option><option value="basic">{t('search.modeBasic')}</option></select></label>
          <div className={css.searchActions}><button type="submit" className={css.secondaryButton} disabled={searching || query.trim() === ''}>{searchKind === 'direct' ? t('search.searching') : t('search.action')}</button><button type="button" className={css.primaryButton} disabled={searching || query.trim() === '' || !props.agentAvailable} onClick={() => void runSearch(true)}>{searchKind === 'agent' ? t('search.agentSearching') : t('search.agentAction')}</button></div>
        </div>
      </form>
      <ReadSourcePanel title={t('search.sourcesTitle')} sources={sources} />
      <div className={css.asyncResults}>
      {searching && <SectionSpinner label={searchKind === 'agent' ? t('search.agentSearching') : t('search.searching')} />}
      {agentAnswer !== null && <section className={css.agentAnswer} aria-label={t('search.agentAnswer')}><div className={css.agentAnswerHeading}><div><span>{t('search.agentAnswerHint')}</span><h3>{t('search.agentAnswer')}</h3></div><code>{agentAnswer.runId.slice(0, 8)}</code></div><p>{agentAnswer.answer}</p>{agentAnswer.citations.length > 0 && <div className={css.agentCitations}>{agentAnswer.citations.map(citation => <code key={citation}>{citation}</code>)}</div>}</section>}
      {error !== null && <div className={css.inlineError} role="alert">{error}</div>}
      {!searched && <EmptyState glyph="⌕" title={t('search.startTitle')}>{t('search.startText')}</EmptyState>}
      {searched && !searching && results.length === 0 && error === null && <EmptyState glyph="0" title={t('search.emptyTitle')}>{t('search.emptyText')}</EmptyState>}
      {results.length > 0 && (
        <div className={relatedTo === null ? css.singleColumn : css.resultLayout}>
          <section className={css.results}><div className={css.sectionHeading}><div><h3>{t('search.results')}</h3></div><strong>{results.length}</strong></div>{visibleResults.map(insight => <InsightCard key={insightKey(insight)} insight={insight} writeEnabled={props.writeEnabled} onForget={forget} onRelated={item => void showRelated(item)} />)}<ProgressiveFooter visible={visibleResults.length} total={results.length} pageSize={pageSize} onMore={() => setVisibleResultLimit(value => value + pageSize)} /></section>
          {relatedTo !== null && <aside id="mnemon-related-pane" className={css.relatedPane}><div className={css.sectionHeading}><div><h3>{t('search.related')}</h3></div><button type="button" onClick={() => { relatedRequests.begin(); setRelatedTo(null); setRelatedLoading(false) }} aria-label={t('search.closeRelated')}>×</button></div><p className={css.relatedSource}>{relatedTo.content}</p>{relatedLoading && <div className={css.loading}>{t('search.traversing')}</div>}{!relatedLoading && related.length === 0 && <div className={css.muted}>{t('search.noRelated')}</div>}{visibleRelated.map(insight => <InsightCard key={insightKey(insight)} insight={insight} writeEnabled={props.writeEnabled} onForget={forget} onRelated={item => void showRelated(item)} />)}{!relatedLoading && <ProgressiveFooter visible={visibleRelated.length} total={related.length} pageSize={pageSize} onMore={() => setVisibleRelatedLimit(value => value + pageSize)} />}</aside>}
        </div>
      )}
      </div>
    </div>
  )
}

function EntitiesPage(props: { client: MnemonClient; revision: number; writeEnabled: boolean; onForget: (insight: Insight) => Promise<void>; onExplore: (query: string) => void }): JSX.Element {
  const t = useT()
  const entityPageSize = 10
  const insightPageSize = 6
  const [view, setView] = useState<EntityView>({ items: [], insights: [] })
  const [entity, setEntity] = useState('')
  const [entityFilter, setEntityFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [visibleEntityLimit, setVisibleEntityLimit] = useState(entityPageSize)
  const [visibleInsightLimit, setVisibleInsightLimit] = useState(insightPageSize)
  const entityRequests = useRequestVersion()

  const load = useCallback(async (selected?: string) => {
    const request = entityRequests.begin()
    setLoading(true); setError(null); setVisibleInsightLimit(insightPageSize)
    if (selected === undefined) setVisibleEntityLimit(entityPageSize)
    try {
      const response = await props.client.entities(selected, 20)
      if (entityRequests.isCurrent(request)) setView(response)
    } catch (reason) {
      if (entityRequests.isCurrent(request)) setError(message(reason))
    } finally {
      if (entityRequests.isCurrent(request)) setLoading(false)
    }
  }, [entityPageSize, entityRequests, insightPageSize, props.client])

  useEffect(() => { void load() }, [load, props.revision])
  const submit = (event: FormEvent) => { event.preventDefault(); if (entity.trim() !== '') void load(entity) }
  const visibleEntities = useMemo(() => {
    const query = entityFilter.trim().toLocaleLowerCase()
    const source = query === '' ? view.items : view.items.filter(item => item.entity.toLocaleLowerCase().includes(query))
    return source.slice(0, visibleEntityLimit)
  }, [view.items, visibleEntityLimit, entityFilter])
  const filteredTotal = useMemo(() => {
    const query = entityFilter.trim().toLocaleLowerCase()
    return query === '' ? view.items.length : view.items.filter(item => item.entity.toLocaleLowerCase().includes(query)).length
  }, [view.items, entityFilter])
  const visibleInsights = view.insights.slice(0, visibleInsightLimit)
  const sources = view.sources ?? []
  const hasEntityProvider = sources.length === 0 || sources.some(source => source.mode === 'entities' && source.status !== 'unavailable')

  return (
    <div className={css.page}>
      <PageHeader title={t('entities.title')} description={t('entities.description')} meta={t('entities.count', { count: view.items.length })} />
      <ReadSourcePanel title={t('entities.sourcesTitle')} sources={sources} />
      {!loading && !hasEntityProvider
        ? <EmptyState glyph="◎" title={t('entities.unsupportedTitle')}>{t('entities.unsupportedText')}</EmptyState>
        : <div className={css.entityLayout}>
        <aside className={css.entityRail}>
          <form className={css.entitySearch} onSubmit={submit}><input aria-label={t('entities.nameAria')} value={entity} onChange={event => { setEntity(event.target.value); setEntityFilter(event.target.value) }} onKeyDown={event => { if (event.key === 'Escape' && entityFilter !== '') { event.preventDefault(); setEntityFilter('') } }} placeholder={t('entities.placeholder')} /><button type="submit" className={css.primaryButton} disabled={loading || entity.trim() === ''}>{t('entities.action')}</button></form>
          <div className={css.entityHeading}><span>{t('entities.top')}</span><small>{entityFilter === '' ? t('entities.frequency') : t('entities.filterHint')}</small></div>
          <div className={css.entityList}>{visibleEntities.map(item => <button key={item.entity} type="button" aria-pressed={view.selected === item.entity} onClick={() => { setEntity(item.entity); void load(item.entity) }}><span>{item.entity}</span><strong>{item.count}</strong></button>)}</div>
          {visibleEntities.length > 0 && filteredTotal > visibleEntityLimit && <ProgressiveFooter compact visible={visibleEntities.length} total={filteredTotal} pageSize={entityPageSize} onMore={() => setVisibleEntityLimit(value => value + entityPageSize)} />}
          {!loading && view.items.length === 0 && <p className={css.muted}>{t('entities.emptyRail')}</p>}
          {!loading && view.items.length > 0 && visibleEntities.length === 0 && entityFilter !== '' && <p className={css.muted}>{t('entities.filterEmpty')}</p>}
        </aside>
        <section className={appearanceClass(css.entityResults, css.asyncResults)}>
          {loading && <SectionSpinner label={t('entities.loading')} />}
          {error !== null && <div className={css.inlineError} role="alert">{error}</div>}
          {!loading && view.selected === undefined && <EmptyState glyph="◎" title={t('entities.selectTitle')}>{t('entities.selectText')}</EmptyState>}
          {view.selected !== undefined && <><div className={css.sectionHeading}><div><h3>{view.selected}</h3></div><strong>{view.insights.length}</strong></div>{!loading && view.insights.length === 0 ? <EmptyState glyph="0" title={t('entities.emptyTitle')}>{t('entities.emptyText')}</EmptyState> : <>{visibleInsights.map(insight => <InsightCard key={insightKey(insight)} insight={insight} writeEnabled={props.writeEnabled} onForget={props.onForget} onRelated={() => props.onExplore(insight.content)} />)}{!loading && <ProgressiveFooter visible={visibleInsights.length} total={view.insights.length} pageSize={insightPageSize} onMore={() => setVisibleInsightLimit(value => value + insightPageSize)} />}</>}</>}
        </section>
      </div>}
    </div>
  )
}

function RuntimePage(props: { client: MnemonClient; revision: number; writeEnabled: boolean; onMutate: () => void }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const runtimeAddFormId = useId()
  const runtimeEditFormId = useId()
  const pageSize = 10
  const [snapshot, setSnapshot] = useState<RuntimeMemorySnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [target, setTarget] = useState<RuntimeMemoryTarget>('memory')
  const [importance, setImportance] = useState<RuntimeMemoryImportance>('normal')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editImportance, setEditImportance] = useState<RuntimeMemoryImportance>('normal')
  const [branches, setBranches] = useState('')
  const [editBranches, setEditBranches] = useState('')
  const [editBranchesOriginal, setEditBranchesOriginal] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [filterTarget, setFilterTarget] = useState<'all' | RuntimeMemoryTarget>('all')
  const [filterQuery, setFilterQuery] = useState('')
  const [visibleLimit, setVisibleLimit] = useState(pageSize)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setSnapshot(await props.client.runtimeMemory()) } catch (reason) { setError(message(reason)) } finally { setLoading(false) }
  }, [props.client])
  useEffect(() => { void load() }, [load, props.revision])
  useEffect(() => { setVisibleLimit(pageSize) }, [filterQuery, filterTarget])

  const entryKey = (entry: RuntimeMemoryEntry) => `${entry.target}:${entry.created_at}:${entry.content}`
  const mutate = async (request: Parameters<MnemonClient['mutateRuntimeMemory']>[0]) => {
    setNotice(null); setError(null)
    const result = await props.client.mutateRuntimeMemory(request)
    setNotice(result.maintenance === undefined
      ? t(`runtime.result.${request.action}` as MnemonKey, { target: t(`runtime.target.${request.target}` as MnemonKey), count: result.entryCount })
      : result.maintenance.kind === 'local-compaction'
        ? t('runtime.result.localCompaction', { target: t(`runtime.target.${request.target}` as MnemonKey), count: result.entryCount })
        : t('runtime.result.maintenance', { target: t(`runtime.target.${request.target}` as MnemonKey), count: result.entryCount, spaces: result.maintenance.memoryBodyIds.join(', ') || '—' }))
    await load()
    props.onMutate()
  }
  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (content.trim() === '') return
    setSaving(true)
    try {
      const branchInput = target === 'memory' ? parseBranchesInput(branches) : undefined
      await mutate({ action: 'add', target, content, importance, ...(branchInput === undefined ? {} : { branches: branchInput }) })
      setContent(''); setBranches('')
      setAdding(false)
    } catch (reason) { setError(message(reason)) } finally { setSaving(false) }
  }
  const beginEdit = (entry: RuntimeMemoryEntry) => {
    const branchText = entry.branches?.join(', ') ?? ''
    setEditing(entryKey(entry)); setEditContent(entry.content); setEditImportance(entry.importance); setEditBranches(branchText); setEditBranchesOriginal(branchText); setRemoving(null)
  }
  const replace = async (entry: RuntimeMemoryEntry) => {
    if (editContent.trim() === '') return
    setSaving(true)
    try {
      const rawBranches = editBranches.trim()
      const branchDelta = entry.target !== 'memory' || rawBranches === editBranchesOriginal.trim() ? undefined : rawBranches === '' ? [] : parseBranchesInput(editBranches)
      await mutate({ action: 'replace', target: entry.target, old_text: entry.content, content: editContent, importance: editImportance, ...(branchDelta === undefined ? {} : { branches: branchDelta }) })
      setEditing(null)
    } catch (reason) { setError(message(reason)) } finally { setSaving(false) }
  }
  const remove = async (entry: RuntimeMemoryEntry) => {
    setSaving(true)
    try {
      await mutate({ action: 'remove', target: entry.target, old_text: entry.content })
      setRemoving(null)
    } catch (reason) { setError(message(reason)) } finally { setSaving(false) }
  }
  const runtimeEditActionClass = appearanceClass(css.ghostButton, appearanceClass(sidebarCss.itemActionButton, sidebarCss.itemEditAction))
  const runtimeRemoveActionClass = appearanceClass(css.dangerButton, appearanceClass(sidebarCss.itemActionButton, sidebarCss.itemDangerAction))

  const runtimeEntry = (entry: RuntimeMemoryEntry) => {
    const key = entryKey(entry)
    const isRemoving = removing === key
    return <article key={key} className={css.runtimeEntry} data-importance={entry.importance} data-target={entry.target}>
      <div className={css.runtimeEntryMeta}>
        <div className={css.runtimeEntryBadges}>
          <span className={css.runtimeEntryTarget}>{entry.target === 'user' ? 'USER.md' : 'MEMORY.md'}</span>
          <span>{t(`runtime.importance.${entry.importance}` as MnemonKey)}</span>
          {entry.branches !== undefined && entry.branches.length > 0 && <span className={css.runtimeEntryBranch} title={t('runtime.branchBadge')}>{entry.branches.join(', ')}</span>}
        </div>
        <time dateTime={entry.updated_at}>{new Date(entry.updated_at).toLocaleString(locale)}</time>
      </div>
      <p>{entry.content}</p>

      <footer>
        {props.writeEnabled ? <><button type="button" className={runtimeEditActionClass} disabled={saving && isRemoving} onClick={() => beginEdit(entry)}>{t('runtime.editAction')}</button><button type="button" className={runtimeRemoveActionClass} disabled={saving && isRemoving} onClick={() => { setRemoving(key); setEditing(null) }}>{t('runtime.removeAction')}</button></> : null}
      </footer>
    </article>
  }

  const targetSummary = (value: RuntimeMemoryTarget) => {
    const view = snapshot?.targets[value]
    const percentage = view === undefined || view.limit === 0 ? 0 : Math.min(100, Math.round(view.used / view.limit * 100))
    return <section className={css.runtimeSummaryCard} aria-label={t(`runtime.target.${value}` as MnemonKey)}><header className={css.runtimeTargetHeader}><div><span>{value === 'user' ? 'USER.md' : 'MEMORY.md'}</span><h3>{t(`runtime.target.${value}` as MnemonKey)}</h3></div><strong>{view?.entryCount ?? 0}</strong></header><div className={css.capacityLine}><div><i style={{ width: `${percentage}%` }} /></div><span>{view === undefined ? '—' : `${humanBytes(view.used)} / ${humanBytes(view.limit)}`}</span></div><p className={css.runtimeTargetDescription}>{t(`runtime.target.${value}.description` as MnemonKey)}</p></section>
  }
  const normalizedQuery = filterQuery.trim().toLocaleLowerCase()
  const filteredEntries = (snapshot?.entries ?? []).filter(entry => (filterTarget === 'all' || entry.target === filterTarget) && (normalizedQuery === '' || entry.content.toLocaleLowerCase().includes(normalizedQuery)))
  const visibleEntries = filteredEntries.slice(0, visibleLimit)

  const closeComposer = () => {
    setContent('')
    setAdding(false)
  }
  const composer = <form id={runtimeAddFormId} className={css.runtimeComposer} onSubmit={event => void add(event)}>
    <div className={css.runtimeComposerHeading}><div><h3>{t('runtime.addTitle')}</h3><p>{t('runtime.addDescription')}</p></div><span>{t('runtime.hotContext')}</span></div>
    <textarea aria-label={t('runtime.content')} value={content} onChange={event => setContent(event.target.value)} rows={3} placeholder={t('runtime.placeholder')} />
    <div className={css.runtimeComposerActions}><label>{t('runtime.target')}<select value={target} onChange={event => setTarget(event.target.value as RuntimeMemoryTarget)}><option value="memory">{t('runtime.target.memory')}</option><option value="user">{t('runtime.target.user')}</option></select></label><label>{t('runtime.importance')}<select value={importance} onChange={event => setImportance(event.target.value as RuntimeMemoryImportance)}><option value="critical">{t('runtime.importance.critical')}</option><option value="normal">{t('runtime.importance.normal')}</option><option value="low">{t('runtime.importance.low')}</option></select></label>{target === 'memory' && <label className={css.runtimeComposerBranch}>{t('runtime.branches')}<input value={branches} onChange={event => setBranches(event.target.value)} placeholder={t('runtime.branchesPlaceholder')} aria-label={t('runtime.branches')} /></label>}</div>
  </form>
  const editingEntry = editing === null ? undefined : snapshot?.entries.find(entry => entryKey(entry) === editing)
  const removingEntry = removing === null ? undefined : snapshot?.entries.find(entry => entryKey(entry) === removing)
  const editForm = editingEntry === undefined ? null : <form id={runtimeEditFormId} className={css.bodyEdit} onSubmit={event => { event.preventDefault(); void replace(editingEntry) }}>
    <label>{t('runtime.editContent')}<textarea aria-label={t('runtime.editContent')} value={editContent} onChange={event => setEditContent(event.target.value)} rows={7} /></label>
    <label>{t('runtime.importance')}<select aria-label={t('runtime.importance')} value={editImportance} onChange={event => setEditImportance(event.target.value as RuntimeMemoryImportance)}><option value="critical">{t('runtime.importance.critical')}</option><option value="normal">{t('runtime.importance.normal')}</option><option value="low">{t('runtime.importance.low')}</option></select></label>
    {editingEntry.target === 'memory' && <label className={css.bodyEditBranch}>{t('runtime.branches')}<input value={editBranches} onChange={event => setEditBranches(event.target.value)} placeholder={t('runtime.branchesPlaceholder')} aria-label={t('runtime.branches')} /><small>{t('runtime.branchesHint')}</small></label>}
  </form>

  return (
    <div className={css.page}>
      <PageHeader title={t('runtime.title')} description={t('runtime.description')} meta={snapshot === null ? t('common.loading') : t('runtime.total', { count: snapshot.entries.length })} action={<><button type="button" className={css.secondaryButton} disabled={loading} onClick={() => void load()}>{t('runtime.refresh')}</button>{props.writeEnabled && <button type="button" className={css.primaryButton} onClick={() => setAdding(true)}>{t('runtime.addButton')}</button>}</>} />
      {error !== null && <div className={css.inlineError} role="alert">{error}</div>}
      {notice !== null && <div className={css.runtimeNotice} role="status">{notice}</div>}
      {!props.writeEnabled && <div className={css.runtimeReadOnly}>{t('runtime.readOnly')}</div>}
      <div className={css.runtimeSummaryGrid}>{targetSummary('user')}{targetSummary('memory')}</div>
      <section className={css.runtimeBrowser} aria-label={t('runtime.entriesAria')}>
        <div className={css.runtimeBrowserToolbar}>
          <div className={css.runtimeScopeFilter} role="group" aria-label={t('runtime.scopeAria')}><button type="button" data-active={filterTarget === 'all' || undefined} onClick={() => setFilterTarget('all')}>{t('runtime.scopeAll')} <b>{snapshot?.entries.length ?? 0}</b></button><button type="button" data-active={filterTarget === 'user' || undefined} onClick={() => setFilterTarget('user')}>{t('runtime.target.user')} <b>{snapshot?.targets.user.entryCount ?? 0}</b></button><button type="button" data-active={filterTarget === 'memory' || undefined} onClick={() => setFilterTarget('memory')}>{t('runtime.target.memory')} <b>{snapshot?.targets.memory.entryCount ?? 0}</b></button></div>
          <div className={css.runtimeFilterQuery}><span aria-hidden="true">⌕</span><input aria-label={t('runtime.filterAria')} value={filterQuery} onChange={event => setFilterQuery(event.target.value)} placeholder={t('runtime.filterPlaceholder')} /></div>
        </div>
        <div className={css.runtimeUnifiedList}>{visibleEntries.map(runtimeEntry)}{!loading && filteredEntries.length === 0 && <div className={css.runtimeEmpty}><span>○</span><p>{t('runtime.noMatch')}</p></div>}</div>
        {!loading && <ProgressiveFooter visible={visibleEntries.length} total={filteredEntries.length} pageSize={pageSize} onMore={() => setVisibleLimit(value => value + pageSize)} />}
      </section>
      <p className={css.runtimeFootnote}>{t('runtime.footnote')}</p>
      {adding && <SidebarModal title={t('runtime.addTitle')} description={t('runtime.addDescription')} busy={saving} onClose={closeComposer} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.ghostButton} disabled={saving} onClick={closeComposer}>{t('common.cancel')}</button><button type="submit" form={runtimeAddFormId} className={css.primaryButton} disabled={saving || content.trim() === ''}>{saving ? t('runtime.saving') : t('runtime.addAction')}</button></div>}>{composer}</SidebarModal>}
      {editingEntry !== undefined && <SidebarModal title={t('runtime.editContent')} description={t(`runtime.target.${editingEntry.target}` as MnemonKey)} busy={saving} onClose={() => setEditing(null)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.ghostButton} disabled={saving} onClick={() => setEditing(null)}>{t('common.cancel')}</button><button type="submit" form={runtimeEditFormId} className={css.primaryButton} disabled={saving || editContent.trim() === ''}>{t('runtime.saveEdit')}</button></div>}>{editForm}</SidebarModal>}
      {removingEntry !== undefined && <SidebarModal title={t('runtime.removeTitle')} description={t(`runtime.target.${removingEntry.target}` as MnemonKey)} busy={saving} onClose={() => setRemoving(null)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close data-autofocus className={css.ghostButton} disabled={saving} onClick={() => setRemoving(null)}>{t('common.cancel')}</button><button type="button" className={css.dangerSolidButton} disabled={saving} onClick={() => void remove(removingEntry)}>{t('runtime.removeAction')}</button></div>}><div className={css.bodyDeleteConfirm}><p>{t('runtime.removeWarning')}</p><div className={css.bodyDeleteSummary}><p className={css.bodyDeleteContent}>{removingEntry.content}</p><span>{t(`runtime.importance.${removingEntry.importance}` as MnemonKey)}</span></div></div></SidebarModal>}
    </div>
  )
}

function PersistenceStrategyDialog(props: {
  client: MnemonClient
  settingsScope: ClientSettingsScope<Config>
  config: Config | undefined
  writable: boolean
  agentAvailable: boolean
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const strategyFormId = useId()
  const configured = props.config?.persistenceStrategy
  const [mode, setMode] = useState<MemoryPlacementMode>(configured?.mode ?? 'manual')
  const [providerId, setProviderId] = useState<MemoryProviderId>(configured?.providerId ?? 'mnemon-native')
  const [prompt, setPrompt] = useState(configured?.prompt ?? '')
  const [dataBoundary, setDataBoundary] = useState<'allow-remote' | 'local-only'>(configured?.rules?.dataBoundary ?? 'allow-remote')
  const [preference, setPreference] = useState<MemoryPlacementPreference>(configured?.rules?.preference ?? 'balanced')
  const [requiredCapabilities, setRequiredCapabilities] = useState<MemoryPlacementCapability[]>(configured?.rules?.requiredCapabilities ?? [])
  const [automaticProviderIds, setAutomaticProviderIds] = useState<MemoryProviderId[]>(configured?.rules?.allowedProviderIds ?? ['mnemon-native'])
  const [providerDrafts, setProviderDrafts] = useState<ProviderDrafts>(configured?.providerConnections ?? {})
  const [providers, setProviders] = useState<MemoryProviderDescriptor[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void props.client.bodyDirectory().then(catalog => {
      if (!current) return
      const next = Array.isArray(catalog.providers) && catalog.providers.length > 0 ? catalog.providers : LEGACY_PROVIDER_CATALOG
      setProviders(next)
      setProviderDrafts(previous => mergeProviderDefaults(next, previous))
      setProviderId(currentProviderId => next.some(provider => provider.id === currentProviderId && (provider.id === 'mnemon-native' || provider.serviceConfigured !== false)) ? currentProviderId : 'mnemon-native')
    }).catch(reason => { if (current) setError(message(reason)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [props.client])

  const selectedProvider = providers.find(provider => provider.id === providerId)
  const selectedAutomaticProviders = automaticProviderIds.map(id => providers.find(provider => provider.id === id)).filter((provider): provider is MemoryProviderDescriptor => provider !== undefined)
  const selectedProvidersValid = mode === 'manual'
    ? providerDraftComplete(selectedProvider, providerDrafts[providerId])
    : automaticProviderIds.length > 0 && selectedAutomaticProviders.length === automaticProviderIds.length && selectedAutomaticProviders.every(provider => providerDraftComplete(provider, providerDrafts[provider.id]))
  const updateDraft = (id: MemoryProviderId, key: string, value: string | number | boolean) => setProviderDrafts(current => ({ ...current, [id]: { ...(current[id] ?? {}), [key]: value } }))
  const toggleCapability = (capability: MemoryPlacementCapability) => setRequiredCapabilities(current => current.includes(capability) ? current.filter(value => value !== capability) : [...current, capability])
  const toggleProvider = (id: MemoryProviderId, selected: boolean) => setAutomaticProviderIds(current => selected ? [...new Set([...current, id])] : current.filter(value => value !== id))

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (loading || saving || !props.writable || !selectedProvidersValid) return
    const selectedIds = mode === 'manual' ? [providerId] : automaticProviderIds
    const connections = Object.fromEntries(selectedIds.filter(id => id !== 'mnemon-native').map(id => [id, providerDrafts[id] ?? {}])) as ProviderDrafts
    setSaving(true); setError(null)
    try {
      await props.settingsScope.setPath(['persistenceStrategy'], {
        mode,
        providerId,
        prompt,
        rules: {
          allowedProviderIds: automaticProviderIds,
          dataBoundary,
          requiredCapabilities,
          preference,
        },
        providerConnections: connections,
      })
      props.onClose()
    } catch (reason) { setError(message(reason)) } finally { setSaving(false) }
  }

  return <SidebarModal title={t('strategy.title')} description={t('strategy.description')} busy={saving} contentReady={!loading} wide onClose={props.onClose} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.ghostButton} disabled={saving} onClick={props.onClose}>{t('common.cancel')}</button><button type="submit" form={strategyFormId} className={css.primaryButton} disabled={loading || saving || !props.writable || !selectedProvidersValid}>{saving ? t('strategy.saving') : t('strategy.save')}</button></div>}>
    <form id={strategyFormId} className={appearanceClass(css.bodyEdit, css.strategyForm)} onSubmit={event => void save(event)}>
      {loading && <div className={css.strategyLoading}><SectionSpinner label={t('strategy.loading')} /><span>{t('strategy.loading')}</span></div>}
      {error !== null && <div className={css.inlineError} role="alert">{error}</div>}
      {!loading && <>
        <section className={css.createSection}>
          <div className={css.createSectionHeading}><span>01</span><div><strong>{t('strategy.modeTitle')}</strong><small>{t('strategy.modeHint')}</small></div></div>
          <fieldset className={css.placementMode}><legend>{t('overview.placementMode')}</legend>
            <label data-selected={mode === 'manual' || undefined}><input type="radio" name="persistence-mode" value="manual" checked={mode === 'manual'} data-autofocus={mode === 'manual' || undefined} onChange={() => setMode('manual')} /><i className={css.choiceControl} data-kind="radio" aria-hidden="true" /><span><strong>{t('overview.placementManual')}</strong><small>{t('strategy.manualHint')}</small></span></label>
            <label data-selected={mode === 'automatic' || undefined}><input type="radio" name="persistence-mode" value="automatic" checked={mode === 'automatic'} data-autofocus={mode === 'automatic' || undefined} onChange={() => setMode('automatic')} /><i className={css.choiceControl} data-kind="radio" aria-hidden="true" /><span><strong>{t('overview.placementAutomatic')} <em>{t('overview.recommended')}</em></strong><small>{t('strategy.automaticHint')}</small></span></label>
          </fieldset>
        </section>
        <section className={css.createSection}>
          <div className={css.createSectionHeading}><span>02</span><div><strong>{t(mode === 'manual' ? 'strategy.manualTitle' : 'strategy.automaticTitle')}</strong><small>{t(mode === 'manual' ? 'strategy.manualDescription' : 'strategy.automaticDescription')}</small></div></div>
          {mode === 'manual' ? <>
            <fieldset className={css.providerChoice}><legend>{t('overview.providerLabel')}</legend>{providers.map(provider => {
              const disabled = provider.id !== 'mnemon-native' && provider.serviceConfigured === false
              return <label key={provider.id} data-selected={providerId === provider.id || undefined} data-native={provider.id === 'mnemon-native' || undefined} data-disabled={disabled || undefined}>
                <input type="radio" name="strategy-provider" value={provider.id} checked={providerId === provider.id} disabled={disabled} onChange={() => setProviderId(provider.id)} />
                <ProviderIcon providerId={provider.id} className={css.providerChoiceIcon} />
                <span><strong>{provider.label}{provider.id === 'mnemon-native' && <em>{t('overview.nativeOfficial')}</em>}</strong><small>{disabled ? t('overview.providerServiceRequired') : `${t(`overview.workspaceBinding.${provider.workspaceBinding}`)} · ${providerSummary(t, provider)}`}</small></span>
                <i className={css.choiceControl} data-kind="radio" aria-hidden="true" />
              </label>
            })}</fieldset>
            {selectedProvider !== undefined && selectedProvider.id !== 'mnemon-native' && <ProviderMemoryFields provider={selectedProvider} connection={providerDrafts[selectedProvider.id] ?? {}} onChange={(key, value) => updateDraft(selectedProvider.id, key, value)} />}
          </> : <section className={css.placementPolicy} aria-label={t('overview.placementPolicy')}>
            <div className={css.placementPolicyHeading}><div><strong>{t('overview.placementPolicy')}</strong><small>{t('overview.placementPolicyHint')}</small></div><span>{props.agentAvailable ? t('strategy.taskAgentReady') : t('strategy.taskAgentUnavailable')}</span></div>
            <label>{t('overview.placementPrompt')}<textarea aria-label={t('overview.placementPrompt')} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={t('overview.placementPromptPlaceholder')} rows={3} maxLength={4000} /></label>
            <div className={css.placementRuleGrid}><label>{t('overview.dataBoundary')}<select aria-label={t('overview.dataBoundary')} value={dataBoundary} onChange={event => { const value = event.target.value as 'allow-remote' | 'local-only'; setDataBoundary(value); if (value === 'local-only') setAutomaticProviderIds(current => current.filter(id => providers.find(provider => provider.id === id)?.kind === 'local')) }}><option value="allow-remote">{t('overview.dataBoundaryRemote')}</option><option value="local-only">{t('overview.dataBoundaryLocal')}</option></select></label><label>{t('overview.preference')}<select aria-label={t('overview.preference')} value={preference} onChange={event => setPreference(event.target.value as MemoryPlacementPreference)}><option value="balanced">{t('overview.preferenceBalanced')}</option><option value="local-first">{t('overview.preferenceLocal')}</option><option value="shared-first">{t('overview.preferenceShared')}</option></select></label></div>
            <fieldset className={css.capabilityRules}><legend>{t('overview.requiredCapabilities')}</legend>{(['graph', 'exact-write', 'forget'] as const).map(capability => {
              const selected = requiredCapabilities.includes(capability)
              return <label key={capability} data-selected={selected || undefined}><input type="checkbox" checked={selected} onChange={() => toggleCapability(capability)} /><i className={css.choiceControl} data-kind="check" aria-hidden="true" /><span>{t(`overview.capability.${capability}`)}</span></label>
            })}</fieldset>
            <div className={css.placementCandidates}>{providers.map(provider => {
              const disabled = provider.serviceConfigured === false || (dataBoundary === 'local-only' && provider.kind === 'remote')
              const selected = automaticProviderIds.includes(provider.id)
              return <label key={provider.id} data-selected={selected || undefined} data-disabled={disabled || undefined}><input type="checkbox" checked={selected} disabled={disabled} onChange={event => toggleProvider(provider.id, event.target.checked)} /><ProviderIcon providerId={provider.id} className={css.candidateIcon} /><span><strong>{provider.label}</strong><small>{provider.serviceConfigured === false ? t('overview.providerServiceRequired') : provider.id === 'mnemon-native' ? t('overview.candidateNativeReady') : provider.kind === 'local' ? t('overview.candidateLocal') : t('overview.candidateRemote')}</small></span><i className={css.choiceControl} data-kind="check" aria-hidden="true" /></label>
            })}</div>
            {automaticProviderIds.map(id => { const provider = providers.find(candidate => candidate.id === id); return provider === undefined || provider.id === 'mnemon-native' ? null : <ProviderMemoryFields key={id} provider={provider} connection={providerDrafts[id] ?? {}} onChange={(key, value) => updateDraft(id, key, value)} /> })}
          </section>}
        </section>
      </>}
    </form>
  </SidebarModal>
}

function RememberDialog(props: { client: MnemonClient; agentAvailable: boolean; memoryBodies: MemoryBodyView[]; writeEnabled: boolean; seed: string; onMutate: () => void; onClose: () => void; onComplete?: () => void }): JSX.Element {
  const t = useT()
  const rememberFormId = useId()
  const [content, setContent] = useState(props.seed)
  const [category, setCategory] = useState<Category>('general')
  const [importance, setImportance] = useState(3)
  const [tags, setTags] = useState('')
  const [entities, setEntities] = useState('')
  const [memoryBodyId, setMemoryBodyId] = useState('')
  const [supervising, setSupervising] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  useEffect(() => { if (props.seed !== '') setContent(props.seed) }, [props.seed])
  useEffect(() => {
    if (memoryBodyId === '' && props.memoryBodies.length > 0) setMemoryBodyId((props.memoryBodies.find(body => body.active) ?? props.memoryBodies[0])!.id)
  }, [memoryBodyId, props.memoryBodies])
  const selectedMemoryBody = props.memoryBodies.find(body => body.id === memoryBodyId)

  const supervise = async (event: FormEvent) => {
    event.preventDefault()
    if (content.trim() === '' || !props.agentAvailable) return
    setSupervising(true); setResult(null)
    try {
      const response = await props.client.supervise(content)
      setResult(`${t(response.action === 'skipped' ? 'remember.skipped' : 'remember.completed')}${response.memoryBodyIds.length === 0 ? '' : ` · ${response.memoryBodyIds.join(', ')}`}${response.summary === '' ? '' : ` · ${response.summary}`}`)
      props.onMutate()
      if (response.action !== 'skipped') {
        setContent('')
        props.onComplete?.()
      }
    } catch (reason) { setResult(t('remember.dispatchFailed', { error: message(reason) })) } finally { setSupervising(false) }
  }

  const manualSave = async (event: FormEvent) => {
    event.preventDefault(); if (content.trim() === '') return
    setSaving(true); setResult(null)
    try {
      const response = await props.client.remember({ content, category, importance, tags: tags.split(',').map(value => value.trim()).filter(Boolean), entities: entities.split(',').map(value => value.trim()).filter(Boolean), source: 'user', ...(memoryBodyId === '' ? {} : { memoryBodyId }) })
      const action = typeof response.action === 'string' ? response.action : 'saved'
      const summary = typeof response.summary === 'string' ? response.summary : ''
      setResult(action === 'skipped' ? `${t('remember.skipped')}${summary === '' ? '' : ` · ${summary}`}` : `${t('remember.processed', { action })}${summary === '' ? '' : ` · ${summary}`}`)
      if (action !== 'skipped') { setContent(''); setTags(''); setEntities(''); props.onMutate(); props.onComplete?.() }
    } catch (reason) { setResult(t('remember.saveFailed', { error: message(reason) })) } finally { setSaving(false) }
  }

  const composer = <section className={css.supervisedComposer}>
    <form id={rememberFormId} className={css.supervisedForm} onSubmit={event => void supervise(event)}>
      <div className={css.supervisedHeading}><div><h3>{t('remember.delegateTitle')}</h3></div><span className={!props.agentAvailable ? css.sessionMissing : css.sessionReady}>{!props.agentAvailable ? t('remember.noTaskAgent') : t('remember.taskAgentReady')}</span></div>
      <label className={css.fieldWide}>{t('remember.candidate')}<textarea aria-label={t('remember.candidateAria')} value={content} onChange={event => setContent(event.target.value)} maxLength={8000} rows={8} placeholder={t('remember.placeholder')} /></label>
      {!props.agentAvailable && <p className={css.sessionHint}>{t('remember.taskAgentHint')}</p>}
      {result !== null && <p className={css.modalInlineStatus} role="status">{result}</p>}
    </form>
    <details className={css.advancedWrite}>
      <summary><span><strong>{t('remember.advanced')}</strong><small>{t('remember.advancedHint')}</small></span><span>{t('remember.expand')}</span></summary>
      <form className={css.manualForm} onSubmit={event => void manualSave(event)}>
        <div className={css.formGrid}><label className={css.fieldWide}>{t('remember.target')}<select aria-label={t('remember.target')} value={memoryBodyId} onChange={event => setMemoryBodyId(event.target.value)}>{props.memoryBodies.map(body => <option key={body.id} value={body.id}>{body.name} · {body.provider.label}{body.active ? ` · ${t('common.active')}` : ''}</option>)}</select>{selectedMemoryBody?.provider.capabilities.writeMode === 'async-extracting' && <small className={css.providerWriteHint}>{t('remember.asyncProviderHint')}</small>}</label><label>{t('common.category')}<select value={category} onChange={event => setCategory(event.target.value as Category)}>{CATEGORIES.map(value => <option key={value} value={value}>{categoryLabel(t, value)}</option>)}</select></label><label>{t('common.importanceLabel')}<select value={importance} onChange={event => setImportance(Number(event.target.value))}>{[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value} / 5</option>)}</select></label><label className={css.fieldWide}>{t('remember.entities')}<input value={entities} onChange={event => setEntities(event.target.value)} placeholder="SQLite, DSH" /></label><label className={css.fieldWide}>{t('remember.tags')}<input value={tags} onChange={event => setTags(event.target.value)} placeholder="architecture, local-first" /></label></div>
        <div className={css.manualActions}><p>{t('remember.advancedText')}</p><button type="submit" className={css.secondaryButton} disabled={saving || content.trim() === '' || memoryBodyId === ''}>{saving ? t('remember.saving') : t('remember.advancedAction')}</button></div>
      </form>
    </details>
  </section>

  return <SidebarModal title={t('remember.title')} description={t('remember.description')} busy={supervising || saving} onClose={props.onClose} footer={props.writeEnabled ? <div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.ghostButton} disabled={supervising || saving} onClick={props.onClose}>{t('common.cancel')}</button><button type="submit" form={rememberFormId} className={css.primaryButton} disabled={supervising || content.trim() === '' || !props.agentAvailable}>{supervising ? t('remember.processing') : t('remember.action')}</button></div> : undefined}>{props.writeEnabled ? composer : <EmptyState glyph="⊘" title={t('remember.readOnlyTitle')}>{t('remember.readOnlyText')}</EmptyState>}</SidebarModal>
}

function ListPage(props: { client: MnemonClient; revision: number; writeEnabled: boolean; onForget: (insight: Insight) => Promise<void>; onClone: (insight: Insight) => void; onExplore: (query: string) => void }): JSX.Element {
  const t = useT()
  const pageSize = 12
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category | ''>('')
  const [view, setView] = useState<MemoryListView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [visibleLimit, setVisibleLimit] = useState(pageSize)
  const [selectedBodyId, setSelectedBodyId] = useState<string | undefined>()

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setView(await props.client.list({ ...(query.trim() === '' ? {} : { query }), ...(category === '' ? {} : { category }), limit: 1000 })) } catch (reason) { setError(message(reason)) } finally { setLoading(false) }
  }, [category, props.client, query])
  useEffect(() => { setVisibleLimit(pageSize); void load() }, [pageSize, props.revision])
  const submit = (event: FormEvent) => { event.preventDefault(); setVisibleLimit(pageSize); void load() }
  const forget = async (insight: Insight) => { await props.onForget(insight); setView(current => current === null ? current : { ...current, total: Math.max(0, current.total - 1), items: current.items.filter(item => insightKey(item) !== insightKey(insight)) }) }
  const filteredItems = view?.items.filter(item => selectedBodyId === undefined || item.memoryBodyId === selectedBodyId) ?? []
  const visibleItems = filteredItems.slice(0, visibleLimit)
  const sources = view?.sources ?? []
  const waitingForQuery = query.trim() === '' && sources.some(source => source.status === 'query-required' && (selectedBodyId === undefined || source.memoryBodyId === selectedBodyId))
  const selectBody = (memoryBodyId: string | undefined) => { setSelectedBodyId(memoryBodyId); setVisibleLimit(pageSize) }

  return (
    <div className={css.page}>
      <PageHeader title={t('content.title')} description={t('content.description')} meta={t('content.count', { count: view === null ? '—' : selectedBodyId === undefined ? view.total : filteredItems.length })} />
      <form className={css.listToolbar} onSubmit={submit}><input aria-label={t('content.filterAria')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('content.filterPlaceholder')} /><select aria-label={t('content.categoryAria')} value={category} onChange={event => setCategory(event.target.value as Category | '')}><option value="">{t('common.allCategories')}</option>{CATEGORIES.map(value => <option key={value} value={value}>{categoryLabel(t, value)}</option>)}</select><button type="submit" className={css.primaryButton} disabled={loading}>{loading ? t('common.loading') : t('content.apply')}</button></form>
      <div className={css.listNotice}>{t('content.notice')}</div>
      <ReadSourcePanel title={t('content.sourcesTitle')} sources={sources} selectedBodyId={selectedBodyId} onSelect={selectBody} />
      {error !== null && <div className={css.inlineError} role="alert">{error}</div>}
      <div className={css.asyncResults}>
        {loading && <SectionSpinner label={t('common.loading')} />}
        {!loading && filteredItems.length === 0 && <EmptyState glyph="≡" title={t(waitingForQuery ? 'content.queryRequiredTitle' : 'content.emptyTitle')}>{t(waitingForQuery ? 'content.queryRequiredText' : 'content.emptyText')}</EmptyState>}
        <div className={css.memoryList}>{visibleItems.map(insight => <InsightCard key={insightKey(insight)} insight={insight} writeEnabled={props.writeEnabled} onForget={forget} onClone={props.onClone} onRelated={() => props.onExplore(insight.content)} />)}</div>
        {view !== null && !loading && <ProgressiveFooter visible={visibleItems.length} total={filteredItems.length} pageSize={pageSize} onMore={() => setVisibleLimit(value => value + pageSize)} />}
      </div>
    </div>
  )
}

type DocumentListItem = DocumentRecord & { healthy?: boolean; excerpt: string }

function DocumentsPage(props: { client: MnemonClient; revision: number; writeEnabled: boolean; sessionId?: string; onMutate: () => void }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const documentCreateFormId = useId()
  const documentEditFormId = useId()
  const pageSize = 8
  const readerRef = useRef<HTMLElement | null>(null)
  const [snapshot, setSnapshot] = useState<DocumentSnapshot | null>(null)
  const [items, setItems] = useState<DocumentListItem[]>([])
  const [visibleLimit, setVisibleLimit] = useState(pageSize)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<DocumentView | null>(null)
  const [status, setStatus] = useState<'active' | 'archived'>('active')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [sources, setSources] = useState('')
  const displayRequests = useRequestVersion()

  const display = useCallback(async (nextQuery: string, nextStatus: 'active' | 'archived') => {
    const request = displayRequests.begin()
    setLoading(true); setError(null); setVisibleLimit(pageSize)
    try {
      const current = await props.client.documents()
      const records = nextQuery.trim() === ''
        ? current.documents
        : (await props.client.searchDocuments(nextQuery, nextStatus === 'archived')).results
      const filtered = records.filter(record => record.status === nextStatus)
      if (!displayRequests.isCurrent(request)) return
      setSnapshot(current)
      setItems(filtered)
      setSelectedId(previous => previous !== null && filtered.some(record => record.id === previous) ? previous : filtered[0]?.id ?? null)
    } catch (reason) {
      if (!displayRequests.isCurrent(request)) return
      setError(message(reason)); setSnapshot(null); setItems([]); setSelectedId(null)
    } finally {
      if (displayRequests.isCurrent(request)) setLoading(false)
    }
  }, [displayRequests, pageSize, props.client])

  useEffect(() => { void display(query, status) }, [display, props.revision, status])
  useEffect(() => {
    setSelected(null)
    if (selectedId === null) return
    let active = true
    void props.client.document(selectedId).then(value => { if (active) setSelected(value) }).catch(reason => { if (active) setError(message(reason)) })
    return () => { active = false }
  }, [props.client, selectedId, props.revision])
  useLayoutEffect(() => {
    if (readerRef.current !== null) readerRef.current.scrollTop = 0
  }, [selectedId])
  useEffect(() => {
    if (selectedId === null) return
    const index = items.findIndex(item => item.id === selectedId)
    if (index >= visibleLimit) setVisibleLimit(Math.ceil((index + 1) / pageSize) * pageSize)
  }, [items, pageSize, selectedId, visibleLimit])

  const resetComposer = () => { setTitle(''); setDescription(''); setContent(''); setSources(''); setComposing(false) }
  const startComposer = () => { setTitle(''); setDescription(''); setContent(''); setSources(''); setEditing(false); setComposing(true) }
  const sourcePaths = (value: string) => value.split(/\r?\n|,/gu).map(path => path.trim()).filter(Boolean)

  const create = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null)
    try {
      const result = await props.client.mutateDocument({ action: 'create', title, description, content, sourcePaths: sourcePaths(sources) })
      setNotice(result.maintenance === undefined ? t('documents.created') : t('documents.createdAfterArchive', { count: result.maintenance.archivedDocumentIds.length }))
      setStatus('active'); setQuery(''); resetComposer(); props.onMutate(); await display('', 'active'); setSelectedId(result.document.id)
    } catch (reason) { setError(message(reason)) } finally { setSaving(false) }
  }

  const beginEdit = () => {
    if (selected === null) return
    setTitle(selected.title); setDescription(selected.description); setContent(selected.content); setSources(selected.sourcePaths.join('\n')); setEditing(true); setComposing(false); setConfirmArchive(false)
  }

  const update = async (event: FormEvent) => {
    event.preventDefault()
    if (selected === null) return
    setSaving(true); setError(null); setNotice(null)
    try {
      const result = await props.client.mutateDocument({ action: 'update', id: selected.id, title, description, content, sourcePaths: sourcePaths(sources) })
      setNotice(result.maintenance === undefined ? t('documents.updated') : t('documents.updatedAfterArchive', { count: result.maintenance.archivedDocumentIds.length }))
      setEditing(false); props.onMutate(); await display(query, status); setSelectedId(result.document.id)
    } catch (reason) { setError(message(reason)) } finally { setSaving(false) }
  }

  const archive = async () => {
    if (selected === null) return
    setSaving(true); setError(null); setNotice(null)
    try {
      const result = await props.client.archiveDocument(selected.id)
      setNotice(t('documents.archived', { spaces: result.maintenance?.memoryBodyIds.join(', ') || '—' }))
      setConfirmArchive(false); setStatus('archived'); setQuery(''); props.onMutate(); await display('', 'archived'); setSelectedId(result.document.id)
    } catch (reason) { setError(message(reason)) } finally { setSaving(false) }
  }

  const usage = snapshot === null ? 0 : Math.min(100, snapshot.activeBytes / snapshot.limitBytes * 100)
  const activeCount = snapshot?.activeCount ?? 0
  const archivedCount = snapshot?.archivedCount ?? 0
  const composer = <form id={documentCreateFormId} className={css.documentEditor} onSubmit={event => void create(event)}>
    <header><div><h3>{t('documents.newTitle')}</h3><p>{t('documents.editorHint')}</p></div><span>{t('documents.managedCopy')}</span></header>
    <div className={css.documentEditorMeta}><label>{t('documents.name')}<input value={title} onChange={event => setTitle(event.target.value)} required /></label><label>{t('documents.routing')}<input value={description} onChange={event => setDescription(event.target.value)} /></label></div>
    <label>{t('documents.sources')}<input value={sources} onChange={event => setSources(event.target.value)} placeholder={t('documents.sourcesPlaceholder')} /></label>
    <label>{t('documents.markdown')}<textarea value={content} onChange={event => setContent(event.target.value)} rows={10} required /></label>
  </form>
  const editComposer = selected === null ? null : <form id={documentEditFormId} className={css.documentEditor} onSubmit={event => void update(event)}>
    <header><div><h3>{t('documents.editTitle')}</h3><p>{t('documents.editorHint')}</p></div><code>{selected.id}</code></header>
    <div className={css.documentEditorMeta}><label>{t('documents.name')}<input value={title} onChange={event => setTitle(event.target.value)} required /></label><label>{t('documents.routing')}<input value={description} onChange={event => setDescription(event.target.value)} /></label></div>
    <label>{t('documents.sources')}<input value={sources} onChange={event => setSources(event.target.value)} /></label><label>{t('documents.markdown')}<textarea value={content} onChange={event => setContent(event.target.value)} rows={18} required /></label>
  </form>
  const documentEditActionClass = appearanceClass(css.ghostButton, appearanceClass(sidebarCss.itemActionButton, sidebarCss.itemEditAction))
  const documentArchiveActionClass = appearanceClass(css.dangerButton, appearanceClass(sidebarCss.itemActionButton, sidebarCss.itemDangerAction))
  const visibleItems = items.slice(0, visibleLimit)
  const selectDocument = (documentId: string) => {
    if (selectedId === documentId) return
    setSelected(null)
    setSelectedId(documentId)
    setEditing(false)
    setConfirmArchive(false)
  }

  return (
    <div className={css.page}>
      <PageHeader title={t('documents.title')} description={t('documents.description')} meta={snapshot === null ? t('common.loading') : t('documents.capacity', { used: humanBytes(snapshot.activeBytes), limit: humanBytes(snapshot.limitBytes) })} action={<><button type="button" className={css.secondaryButton} disabled={loading} onClick={() => void display(query, status)}>{t('documents.refresh')}</button>{props.writeEnabled && props.sessionId !== undefined && <button type="button" className={css.primaryButton} onClick={startComposer}>{t('documents.new')}</button>}</>} />
      {error !== null && <div className={css.inlineError} role="alert">{error}</div>}
      {notice !== null && <div className={css.runtimeNotice} role="status">{notice}</div>}

      <section className={css.documentSummary} aria-label={t('documents.summary')}>
        <article><span>{t('documents.active')}</span><strong>{activeCount}</strong><small>{t('documents.activeHint')}</small></article>
        <article><span>{t('documents.archivedCount')}</span><strong>{archivedCount}</strong><small>{t('documents.archivedHint')}</small></article>
        <article className={css.documentCapacity}><span>{t('documents.activeCapacity')}</span><strong>{snapshot === null ? '—' : `${usage.toFixed(1)}%`}</strong><div><i style={{ width: `${usage}%` }} /></div><small>{t('documents.capacityHint')}</small></article>
      </section>

      <section className={css.documentToolbar}>
        <form onSubmit={event => { event.preventDefault(); void display(query, status) }}><span aria-hidden="true">⌕</span><input aria-label={t('documents.searchAria')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('documents.searchPlaceholder')} /><button type="submit" className={css.secondaryButton}>{t('documents.search')}</button></form>
        <div role="group" aria-label={t('documents.scope')}><button type="button" data-active={status === 'active' || undefined} onClick={() => setStatus('active')}>{t('documents.active')} <b>{activeCount}</b></button><button type="button" data-active={status === 'archived' || undefined} onClick={() => setStatus('archived')}>{t('documents.archivedCount')} <b>{archivedCount}</b></button></div>
      </section>

      <div className={css.documentWorkspace}>
        <aside className={css.documentList} aria-label={t('documents.list')}>
          <header><span>{status === 'active' ? t('documents.activeList') : t('documents.archiveList')}</span><code>{items.length}</code></header>
          {visibleItems.map(document => <button type="button" key={document.id} aria-pressed={selectedId === document.id} data-selected={selectedId === document.id || undefined} onClick={() => selectDocument(document.id)}><div><strong>{document.title}</strong><time dateTime={document.updatedAt}>{new Date(document.updatedAt).toLocaleDateString(locale)}</time></div><p>{document.description || document.excerpt || t('documents.noDescription')}</p><footer><span>{humanBytes(document.sizeBytes)}</span><code>{document.id.slice(0, 8)}</code>{document.healthy === false && <em>{t('documents.missing')}</em>}</footer></button>)}
          {!loading && <ProgressiveFooter compact visible={visibleItems.length} total={items.length} pageSize={pageSize} onMore={() => setVisibleLimit(value => value + pageSize)} />}
          {!loading && items.length === 0 && <div className={css.documentListEmpty}><span>▤</span><strong>{status === 'active' ? t('documents.emptyActive') : t('documents.emptyArchived')}</strong><p>{status === 'active' ? t('documents.emptyActiveText') : t('documents.emptyArchivedText')}</p></div>}
          {loading && <div className={css.loading}>{t('common.loading')}</div>}
        </aside>

        <section ref={readerRef} className={css.documentReader} aria-label={t('documents.reader')} data-scroll-region="">
          {selected === null ? <EmptyState glyph="▤" title={t('documents.selectTitle')}>{t('documents.selectText')}</EmptyState> : <article className={css.documentDetail}>
            <header><div><span>{selected.status === 'active' ? t('documents.active') : t('documents.coldArchive')}</span><h3>{selected.title}</h3><p>{selected.description || t('documents.noDescription')}</p></div><div>{props.writeEnabled && selected.status === 'active' && <button type="button" className={documentEditActionClass} onClick={beginEdit}>{t('documents.edit')}</button>}</div></header>
            <dl><div><dt>{t('documents.path')}</dt><dd><code>{selected.relativePath}</code></dd></div><div><dt>{t('documents.revision')}</dt><dd>{selected.revision}</dd></div><div><dt>{t('documents.hash')}</dt><dd><code>{selected.contentHash.slice(0, 16)}</code></dd></div><div><dt>{t('documents.size')}</dt><dd>{humanBytes(selected.sizeBytes)}</dd></div></dl>
            {selected.sourcePaths.length > 0 && <div className={css.documentSources}><span>{t('documents.sources')}</span>{selected.sourcePaths.map(path => <code key={path}>{path}</code>)}</div>}
            {selected.status === 'archived' && <div className={css.documentArchiveReceipt}><strong>{t('documents.archiveReceipt')}</strong><p>{selected.archiveSummary}</p><div>{selected.memoryBodyIds.map(id => <code key={id}>{id}</code>)}</div></div>}
            <DocumentMarkdown content={selected.content} />
            {props.writeEnabled && selected.status === 'active' && <footer className={css.documentDanger}><div><strong>{t('documents.archiveTitle')}</strong><p>{t('documents.archiveDescription')}</p></div><button type="button" className={documentArchiveActionClass} onClick={() => setConfirmArchive(true)}>{t('documents.archive')}</button></footer>}
          </article>}
        </section>
      </div>
      <p className={css.runtimeFootnote}>{t('documents.footnote')}</p>
      {composing && <SidebarModal title={t('documents.newTitle')} description={t('documents.editorHint')} busy={saving} onClose={resetComposer} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.ghostButton} disabled={saving} onClick={resetComposer}>{t('common.cancel')}</button><button type="submit" form={documentCreateFormId} className={css.primaryButton} disabled={saving || title.trim() === '' || content.trim() === ''}>{saving ? t('documents.saving') : t('documents.create')}</button></div>}>{composer}</SidebarModal>}
      {editing && selected !== null && <SidebarModal title={t('documents.editTitle')} description={selected.title} busy={saving} onClose={() => setEditing(false)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.ghostButton} disabled={saving} onClick={() => setEditing(false)}>{t('common.cancel')}</button><button type="submit" form={documentEditFormId} className={css.primaryButton} disabled={saving}>{saving ? t('documents.saving') : t('documents.save')}</button></div>}>{editComposer}</SidebarModal>}
      {confirmArchive && selected !== null && <SidebarModal title={t('documents.archiveConfirm')} description={selected.title} busy={saving} onClose={() => setConfirmArchive(false)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close data-autofocus className={css.ghostButton} disabled={saving} onClick={() => setConfirmArchive(false)}>{t('common.cancel')}</button><button type="button" className={css.dangerSolidButton} disabled={saving} onClick={() => void archive()}>{saving ? t('documents.archiving') : t('documents.archiveNow')}</button></div>}><div className={css.bodyDeleteConfirm}><p>{t('documents.archiveDescription')}</p><div className={css.bodyDeleteSummary}><strong>{selected.title}</strong><span>{selected.relativePath} · {humanBytes(selected.sizeBytes)}</span></div></div></SidebarModal>}
    </div>
  )
}

function versionModeLabel(t: MnemonTranslate, mode: VersionInstallMode): string {
  if (mode === 'homebrew') return t('versions.modeHomebrew')
  if (mode === 'go') return t('versions.modeGo')
  if (mode === 'npm') return t('versions.modeNpm')
  if (mode === 'link') return t('versions.modeLink')
  if (mode === 'missing') return t('versions.modeMissing')
  return t('versions.modeManual')
}

function versionHint(t: MnemonTranslate, component: VersionComponentStatus): string {
  if (component.checkError !== undefined) return t('versions.latestUnavailable')
  if (component.updateHint === 'brew') return t('versions.hintHomebrew')
  if (component.updateHint === 'brew-missing') return t('versions.hintBrewMissing')
  if (component.updateHint === 'go') return t('versions.hintGo')
  if (component.updateHint === 'pnpm') return t('versions.hintPnpm')
  if (component.updateHint === 'pnpm-missing') return t('versions.hintPnpmMissing')
  if (component.updateHint === 'link') return t('versions.hintLink')
  if (component.updateHint === 'install') return t('versions.hintInstall')
  return t('versions.hintManual')
}

function dshInstallLabel(t: MnemonTranslate, component: VersionComponentStatus): string {
  if (component.installMode === 'npm') return t('versions.profileLocation', { name: component.installProfile ?? '—' })
  if (component.installMode === 'link') return component.installProfile === undefined
    ? t('versions.sourceLocation')
    : t('versions.linkSourceLocation', { name: component.installProfile })
  return t('versions.packageLocation')
}

function VersionDialog(props: { client: MnemonClient; writeEnabled: boolean; onClose: () => void; onRefreshStatus: () => void }): JSX.Element {
  const t = useT()
  const [snapshot, setSnapshot] = useState<VersionStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [updating, setUpdating] = useState<VersionComponentStatus['id'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<VersionUpdateResult | null>(null)
  const checkRequestRef = useRef(0)
  const checkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const check = useCallback(async () => {
    const requestVersion = ++checkRequestRef.current
    setChecking(true)
    setError(null)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(t('versions.timeout'))), 15_000)
        checkTimeoutRef.current = timeout
      })
      const next = await Promise.race([props.client.versions(), deadline])
      if (checkRequestRef.current === requestVersion) setSnapshot(next)
    }
    catch (reason) { if (checkRequestRef.current === requestVersion) setError(message(reason)) }
    finally {
      if (timeout !== undefined) clearTimeout(timeout)
      if (checkTimeoutRef.current === timeout) checkTimeoutRef.current = null
      if (checkRequestRef.current === requestVersion) setChecking(false)
    }
  }, [props.client, t])
  useEffect(() => {
    void check()
    return () => {
      checkRequestRef.current += 1
      if (checkTimeoutRef.current !== null) clearTimeout(checkTimeoutRef.current)
      checkTimeoutRef.current = null
    }
  }, [check])
  const update = async (component: VersionComponentStatus) => {
    setUpdating(component.id)
    setError(null)
    setResult(null)
    try {
      const next = await props.client.updateVersion(component.id)
      setResult(next)
      await check()
      props.onRefreshStatus()
    } catch (reason) {
      setError(message(reason))
    } finally {
      setUpdating(null)
    }
  }
  const updatingBusy = updating !== null
  const controlsBusy = checking || updatingBusy
  return <SidebarModal title={t('versions.title')} description={t('versions.description')} busy={updatingBusy} contentReady={!checking} onClose={props.onClose} footer={<><span className={css.modalFooterMeta}>{snapshot === null ? '' : t('versions.checkedAt', { time: new Date(snapshot.checkedAt).toLocaleTimeString() })}</span><div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.ghostButton} disabled={updatingBusy} onClick={props.onClose}>{t('common.cancel')}</button><button type="button" data-autofocus className={css.secondaryButton} disabled={controlsBusy} onClick={() => void check()}>{checking ? t('versions.checkingShort') : t('versions.recheck')}</button></div></>}>
    <div className={css.versionDialogBody}>
      {checking && snapshot === null && <div className={css.versionChecking} role="status"><span />{t('versions.checking')}</div>}
      {error !== null && <div className={css.versionError} role="alert"><strong>{t('versions.failed')}</strong><p>{error}</p></div>}
      {result !== null && <div className={css.versionResult} role="status"><strong>{result.updated ? t('versions.updated', { name: result.component === 'mnemon' ? 'Mnemon CLI' : 'dsh-mnemon' }) : t('versions.alreadyCurrent')}</strong>{result.restartRequired && <p>{t('versions.restartRequired')}</p>}</div>}
      {snapshot !== null && <div className={css.versionList}>{snapshot.components.map(component => {
        const canUpdate = props.writeEnabled && component.outdated && component.updateSupported && component.checkError === undefined
        const state = component.checkError !== undefined ? t('versions.unknown') : component.outdated ? t('versions.available') : t('versions.current')
        return <article key={component.id} data-outdated={component.outdated || undefined}>
          <header><div><strong>{component.name}</strong><span>{versionModeLabel(t, component.installMode)}</span></div><em>{state}</em></header>
          <div className={css.versionNumbers}><div><small>{t('versions.installed')}</small><code>{component.current ?? '—'}</code></div><span>→</span><div><small>{t('versions.latest')}</small><code>{component.latest ?? '—'}</code></div></div>
          {component.id === 'mnemon' && component.executablePath !== undefined && <small className={css.versionLocation} title={component.executablePath}><span>{t('versions.executable')}</span><code>{component.executablePath}</code></small>}
          {component.id === 'dsh-mnemon' && component.installPath !== undefined && <small className={css.versionLocation} title={component.installPath}><span>{dshInstallLabel(t, component)}</span><code>{component.installPath}</code></small>}
          <footer><p>{versionHint(t, component)}</p>{canUpdate && <button type="button" className={css.primaryButton} disabled={controlsBusy} onClick={() => void update(component)}>{updating === component.id ? t('versions.updating') : t('versions.update')}</button>}</footer>
        </article>
      })}</div>}
    </div>
  </SidebarModal>
}

function StatusPage(props: { client: MnemonClient; status: StatusView | null; loading: boolean; writeEnabled: boolean; onRefresh: () => void }): JSX.Element {
  const t = useT()
  const [versionsOpen, setVersionsOpen] = useState(false)
  const status = props.status
  const documents = status?.documents
  const catalogKnown = status?.memoryBodies !== undefined
  const memoryBodies = useMemo(() => (status?.memoryBodies ?? []).map(normalizeMemoryBody), [status])
  const activeBodies = memoryBodies.filter(body => body.active).length
  const storage = status?.storage
  const selectedScopeKind = storage?.activeKind ?? 'global'
  const selectedScope = storage?.scopes.find(scope => scope.kind === selectedScopeKind)
  const runtimeArea = selectedScope?.areas.find(area => area.kind === 'runtime')
  const runtimeUserEntries = runtimeArea === undefined ? 0 : Number(runtimeArea.details.userEntries ?? 0)
  const runtimeMemoryEntries = runtimeArea === undefined ? 0 : Number(runtimeArea.details.memoryEntries ?? 0)
  return (
    <div className={css.page}>
      <PageHeader title={t('status.title')} description={t('status.description')} meta={status === null && props.loading ? t('common.loading') : status === null ? t('status.checkRequired') : t('status.nominal')} {...(props.loading ? { loadingLabel: t('status.rechecking') } : {})} action={<div className={css.statusHeaderActions}><button type="button" className={css.ghostButton} disabled={props.loading} onClick={props.onRefresh}>{props.loading ? t('status.rechecking') : t('status.recheck')}</button><button type="button" className={css.secondaryButton} onClick={() => setVersionsOpen(true)}>{t('versions.checkAction')}</button></div>} />

      <section className={css.healthStrip} aria-label={t('status.aria')}>
        <article><span className={`${css.healthIndicator} ${status === null ? css.healthMuted : css.healthGood}`} /><div><small>{t('status.engine')}</small><strong>{status?.dshMnemonVersion === undefined ? 'dsh-mnemon' : `dsh-mnemon ${status.dshMnemonVersion}`}</strong><p>{status === null ? t('status.pluginChecking') : t('status.pluginReady')}</p></div></article>
        <article><span className={`${css.healthIndicator} ${runtimeArea === undefined ? css.healthMuted : runtimeArea.status === 'invalid' ? css.healthBad : css.healthGood}`} /><div><small>{t('status.runtime')}</small><strong>{runtimeArea === undefined ? t('status.runtimeWaiting') : t('status.runtimeRatio', { user: runtimeUserEntries, memory: runtimeMemoryEntries })}</strong><p>{runtimeArea === undefined ? t('status.runtimeWaitingDetail') : t('status.runtimeBytes', { bytes: humanBytes(runtimeArea.bytes) })}</p></div></article>
        <article><span className={`${css.healthIndicator} ${activeBodies > 0 ? css.healthGood : css.healthMuted}`} /><div><small>{t('status.spaces')}</small><strong>{catalogKnown ? t('status.activeRatio', { active: activeBodies, total: memoryBodies.length }) : t('status.directoryUnsynced')}</strong><p>{t('status.activeMemories', { count: status?.stats?.totalInsights ?? 0 })}</p></div></article>
        <article><span className={`${css.healthIndicator} ${documents === undefined ? css.healthMuted : css.healthGood}`} /><div><small>{t('status.documents')}</small><strong>{documents === undefined ? t('status.documentsWaiting') : t('status.documentRatio', { active: documents.activeCount, archived: documents.archivedCount })}</strong><p>{documents === undefined ? t('status.documentsSession') : t('status.documentUsage', { used: humanBytes(documents.activeBytes), limit: humanBytes(documents.limitBytes) })}</p></div></article>
      </section>

      <div className={css.asyncStatusBlock}>{status !== null && <NativeProviderHealth status={status} />}</div>
      <div className={css.asyncStatusBlock}>{status?.providerServices !== undefined && <ProviderHealth services={status.providerServices.filter(service => service.providerId !== 'mnemon-native')} />}</div>
      <div className={css.asyncStatusBlock}><StorageDomains catalog={storage} selected={selectedScope} selectedKind={selectedScopeKind} /></div>
      {versionsOpen && <VersionDialog client={props.client} writeEnabled={props.writeEnabled} onClose={() => setVersionsOpen(false)} onRefreshStatus={props.onRefresh} />}
    </div>
  )
}

function NativeProviderHealth({ status }: { status: StatusView }): JSX.Element {
  const t = useT()
  const bodies = (status.memoryBodies ?? []).filter(body => body.provider?.id === undefined || body.provider.id === 'mnemon-native')
  const active = bodies.filter(body => body.active)
  const pending = active.filter(body => body.statusLoading === true)
  const failed = active.filter(body => body.statusLoading !== true && !body.healthy)
  const state: MemoryProviderRuntimeStatus['status'] = !status.commandFound || failed.length > 0 ? 'unhealthy' : active.length === 0 || pending.length > 0 ? 'idle' : 'healthy'
  const error = !status.commandFound
    ? t('status.nativeCliMissing')
    : failed.map(body => `${body.name}: ${body.error ?? t('status.engineUnavailable')}`).join('; ')
  return <section className={css.nativeProviderHealth} aria-label={t('status.nativeAria')} data-status={state}>
    <ProviderIcon providerId="mnemon-native" className={css.providerHealthMark} />
    <div className={css.nativeProviderCopy}>
      <small>{t('status.nativeLabel')}</small>
      <strong>mnemon</strong>
      {error !== '' && <p title={error}>{error}</p>}
    </div>
    <div className={css.nativeProviderMeta}>
      <span><i aria-hidden="true" />{t(`status.providerState.${state}` as MnemonKey)}</span>
      <small><span>{status.version === undefined ? t('status.versionWaiting') : `Mnemon ${status.version}`}</span><span> · {t('status.providerSpaces', { active: active.length, total: bodies.length })}</span></small>
    </div>
  </section>
}

function ProviderHealth({ services }: { services: MemoryProviderRuntimeStatus[] }): JSX.Element {
  const t = useT()
  const enabled = services.filter(service => service.enabled).length
  return <section className={css.providerHealth} aria-label={t('status.providersAria')}>
    <div className={css.statusSectionHeader}>
      <div><h3>{t('status.providersTitle')}</h3><p>{t('status.providersDescription')}</p></div>
      <span className={css.phaseBadge}>{t('status.providersEnabled', { enabled, total: services.length })}</span>
    </div>
    <div className={css.providerHealthList}>{services.map(service => <article key={service.providerId} data-status={service.status}>
      <ProviderIcon providerId={service.providerId} className={css.providerHealthMark} />
      <div className={css.providerHealthCopy}>
        <strong>{service.label}</strong>
        <small>{t(`status.providerState.${service.status}` as MnemonKey)}</small>
        {service.error !== undefined && <p title={service.error}>{service.error}</p>}
      </div>
      <div className={css.providerHealthMeta}>
        <span className={css.providerHealthSignal} aria-hidden="true" />
        <small>{t('status.providerSpaces', { active: service.activeMemoryBodyCount, total: service.memoryBodyCount })}</small>
      </div>
    </article>)}</div>
  </section>
}

function storageScopeLabel(t: MnemonTranslate, kind: StorageScopeKind): string {
  return t(kind === 'global' ? 'status.storageGlobal' : kind === 'workspace' ? 'status.storageWorkspace' : 'status.storageCustom')
}

/** Resolve the configured scope before the first status round-trip to keep the Sidebar header stable. */
function configuredStorageScope(config: Config | undefined): StorageScopeKind {
  return config?.storageScope ?? (config?.dataDir?.trim() ? 'custom' : 'global')
}

function storageAreaLabel(t: MnemonTranslate, kind: StorageAreaInventory['kind']): string {
  return t(kind === 'runtime' ? 'status.storageRuntime' : kind === 'memory-bodies' ? 'status.storageBodies' : kind === 'documents' ? 'status.storageDocuments' : 'status.storageState')
}

function storageAreaDetails(t: MnemonTranslate, area: StorageAreaInventory): string {
  if (area.kind === 'runtime') return t('status.storageRuntimeDetail', { user: area.details.userEntries ?? 0, memory: area.details.memoryEntries ?? 0 })
  if (area.kind === 'memory-bodies') return t('status.storageBodiesDetail', { active: area.details.activeBodies ?? 0, databases: area.details.databases ?? 0 })
  if (area.kind === 'documents') return t('status.storageDocumentsDetail', { active: area.details.activeDocuments ?? 0, archived: area.details.archivedDocuments ?? 0 })
  return area.details.reviewLedger === true ? t('status.storageStateReady') : t('status.storageStateVolatile')
}

function StorageDomains(props: {
  catalog: StatusView['storage']
  selected: StorageScopeInventory | undefined
  selectedKind: StorageScopeKind
}): JSX.Element {
  const t = useT()
  const areaStatus = (status: StorageAreaInventory['status']) => t(status === 'ready' ? 'status.storageReady' : status === 'empty' ? 'status.storageEmpty' : status === 'missing' ? 'status.storageMissing' : 'status.storageInvalid')
  return (
    <section className={css.storageDomains} aria-label={t('status.storageDomains')}>
      <div className={css.statusSectionHeader}>
        <div><h3>{t('status.storageDomains')}</h3><p>{t('status.storageDomainsText')}</p></div>
        <span className={css.phaseBadge}>{storageScopeLabel(t, props.selectedKind)}</span>
      </div>
      {props.catalog === undefined ? <div className={css.storageUnavailable}>{t('status.storageWaiting')}</div> : props.selected?.root === undefined ? <div className={css.storageUnavailable}><strong>{storageScopeLabel(t, props.selectedKind)}</strong><p>{props.selectedKind === 'custom' ? t('status.storageCustomUnset') : t('status.storageWorkspaceUnavailable')}</p></div> : <>
        <div className={css.storageRoot}>
          <div><span>{storageScopeLabel(t, props.selectedKind)} · {t('status.storageActiveRoot')}</span><code>{props.selected.root}</code></div>
          <div><strong>{humanBytes(props.selected.totalBytes)}</strong><small>{props.selected.available ? t('status.storageAvailable') : t('status.storageNotCreated')}</small></div>
        </div>
        <div className={css.storageAreaGrid}>
          {props.selected.areas.filter(area => area.kind !== 'state').map(area => <article key={area.kind} data-status={area.status}>
            <header><div><span /> <strong>{storageAreaLabel(t, area.kind)}</strong></div><em>{areaStatus(area.status)}</em></header>
            <div className={css.storageAreaMetric}><strong>{area.itemCount}</strong><span>{t('status.storageItems')}</span><code>{humanBytes(area.bytes)}</code></div>
            <p>{storageAreaDetails(t, area)}</p>
            <code className={css.storagePath}>{area.path}</code>
            {area.issue !== undefined && <small>{area.issue}</small>}
          </article>)}
        </div>
      </>}
      {props.catalog !== undefined && <p className={css.storageFootnote}>{t('status.storageFootnote', { root: props.catalog.activeRoot })}</p>}
    </section>
  )
}

export function MnemonView(props: MnemonViewProps): JSX.Element {
  const t = props.t ?? translateZh
  return <I18nContext.Provider value={t}><LocaleContext.Provider value={props.locale ?? 'zh'}><MnemonWorkspace {...props} /></LocaleContext.Provider></I18nContext.Provider>
}

function MnemonWorkspace({ connection, settingsScope, sessionId, workspaceId, workspaceSelection, surface = 'sidebar', onClose }: MnemonViewProps): JSX.Element {
  const t = useT()
  const subscribeSettings = useCallback((listener: () => void) => settingsScope.subscribe(listener), [settingsScope])
  const getSettingsSnapshot = useCallback(() => settingsScope.getSnapshot(), [settingsScope])
  const settingsSnapshot = useSyncExternalStore(subscribeSettings, getSettingsSnapshot, getSettingsSnapshot)
  const client = useMemo(() => new MnemonClient(connection, sessionId, workspaceId), [connection, sessionId, workspaceId])
  const clientContextKey = `${sessionId ?? ''}\u0000${workspaceId ?? ''}`
  const viewContextKey = `${clientContextKey}\u0000${settingsSnapshot.revision ?? 'loading'}`
  const [page, setPage] = useState<Page>('status')
  const lastMemoryPage = useRef<SidebarMemoryPage>('overview')
  const canvasRef = useRef<HTMLElement | null>(null)

  const selectPage = useCallback((next: Page) => {
    if (isMemoryPage(next)) lastMemoryPage.current = next
    setPage(next)
  }, [])
  const selectPrimaryPage = useCallback((next: Page) => {
    selectPage(next === 'overview' ? lastMemoryPage.current : next)
  }, [selectPage])

  /** Pages share one plugin-owned scroll container; never mutate DSH ancestor scrollports. */
  const resetViewportScroll = useCallback(() => {
    const canvas = canvasRef.current
    if (canvas !== null) canvas.scrollTop = 0
  }, [])

  // Reset before paint so a newly selected page never flashes at the previous
  // page's scroll offset for one frame. The host still owns every ancestor.
  useLayoutEffect(() => { resetViewportScroll() }, [viewContextKey, page, resetViewportScroll])
  const [statusState, setStatusState] = useState<{ contextKey: string; value: StatusView | null; loading: boolean; error: string | null }>(() => ({ contextKey: viewContextKey, value: null, loading: true, error: null }))
  const currentStatusState = statusState.contextKey === viewContextKey
    ? statusState
    : { contextKey: viewContextKey, value: null, loading: true, error: null }
  const status = currentStatusState.value
  const statusLoading = currentStatusState.loading
  const statusError = currentStatusState.error
  const layerEnabled = useCallback((id: ConfigurableMemoryLayerId): boolean | undefined => {
    if (status === null) return undefined
    return status.memorySystem?.topology.layers.find(layer => layer.id === id)?.enabled ?? true
  }, [status])
  const runtimeLayerEnabled = layerEnabled('runtime')
  const documentsLayerEnabled = layerEnabled('documents')
  const memorySpacesLayerEnabled = layerEnabled('memory-spaces')
  const metadataSessionId = status?.lifecycle?.current?.sessionId
  // Sidebar tasks follow the inspected workspace; embedded tasks follow their
  // owning session. Both still use the same independent task-Agent endpoints.
  const taskClient = useMemo(() => surface === 'buildin' ? client : new MnemonClient(connection, undefined, workspaceId), [client, connection, surface, workspaceId])
  const statusRequest = useRef(0)
  const [revision, setRevision] = useState(0)
  const [searchSeed, setSearchSeed] = useState('')
  const [rememberSeed, setRememberSeed] = useState('')
  const [rememberOpen, setRememberOpen] = useState(false)
  const [strategyOpen, setStrategyOpen] = useState(false)

  // A newly inspected workspace must never inherit visible cards, open editors,
  // search seeds, or scroll position from the previous workspace.
  useLayoutEffect(() => {
    setRememberOpen(false)
    setStrategyOpen(false)
    setRememberSeed('')
    setSearchSeed('')
  }, [viewContextKey])

  const openRemember = useCallback((seed = '') => {
    if (memorySpacesLayerEnabled === false) return
    setRememberSeed(seed)
    setRememberOpen(true)
  }, [memorySpacesLayerEnabled])

  useEffect(() => {
    if (memorySpacesLayerEnabled !== false) return
    setRememberOpen(false)
    setStrategyOpen(false)
  }, [memorySpacesLayerEnabled])

  /** Conversation surfaces ask this view to open a page (optionally with a seed). */
  const applyAnchor = useCallback((anchor: MnemonAnchor) => {
    if (anchor.page === 'remember') {
      openRemember(anchor.seed ?? '')
      selectPage(lastMemoryPage.current)
      return
    }
    if (anchor.seed !== undefined && anchor.seed !== '') {
      if (anchor.page === 'explore') setSearchSeed(anchor.seed)
    }
    selectPage(anchor.page)
  }, [openRemember, selectPage])
  useEffect(() => {
    const held = consumeMnemonAnchor(sessionId)
    if (held !== null) applyAnchor(held)
    return subscribeMnemonAnchor(sessionId, applyAnchor)
  }, [sessionId, applyAnchor])

  const loadStatus = useCallback(async () => {
    const request = ++statusRequest.current
    setStatusState(current => ({ contextKey: viewContextKey, value: current.contextKey === viewContextKey ? current.value : null, loading: true, error: null }))
    try {
      const summary = await client.statusSummary()
      if (request !== statusRequest.current) return
      const needsDeepStatus = summary.memoryBodies?.some(body => body.statusLoading === true) === true
      setStatusState({ contextKey: viewContextKey, value: summary, loading: needsDeepStatus, error: null })
      if (!needsDeepStatus) return
      try {
        const next = await client.status()
        if (request === statusRequest.current) setStatusState({ contextKey: viewContextKey, value: next, loading: false, error: null })
      } catch (reason) {
        if (request === statusRequest.current) setStatusState({ contextKey: viewContextKey, value: summary, loading: false, error: message(reason) })
      }
    } catch (reason) {
      if (request === statusRequest.current) setStatusState({ contextKey: viewContextKey, value: null, loading: false, error: message(reason) })
    }
  }, [client, viewContextKey])
  useEffect(() => { void loadStatus() }, [loadStatus])

  const mutate = useCallback(() => { setRevision(value => value + 1); void loadStatus() }, [loadStatus])
  const bodyReconnected = useCallback((next: MemoryBodyView) => {
    setStatusState(current => {
      if (current.contextKey !== viewContextKey || current.value === null) return current
      const providerServices = current.value.providerServices?.map(service => {
        if (service.providerId !== next.provider.id) return service
        const { error: _error, ...withoutError } = service
        return { ...withoutError, status: next.healthy ? 'healthy' as const : 'unhealthy' as const, ...(next.error === undefined ? {} : { error: next.error }) }
      })
      return {
        ...current,
        value: {
          ...current.value,
          memoryBodies: current.value.memoryBodies.map(body => body.id === next.id ? next : body),
          ...(providerServices === undefined ? {} : { providerServices }),
        },
      }
    })
  }, [viewContextKey])
  const bodyMetadataUpdated = useCallback((updates: readonly MemoryBodyMetadataUpdate[]) => {
    const byId = new Map(updates.map(update => [update.memoryBodyId, update]))
    setStatusState(current => {
      if (current.contextKey !== viewContextKey || current.value === null) return current
      return {
        ...current,
        value: {
          ...current.value,
          memoryBodies: current.value.memoryBodies.map(body => {
            const update = byId.get(body.id)
            return update === undefined ? body : { ...body, name: update.title, description: update.description }
          }),
        },
      }
    })
  }, [viewContextKey])
  const forget = useCallback(async (insight: Insight) => { await client.forget(insight.id, insight.memoryBodyId); mutate() }, [client, mutate])
  const explore = useCallback((query: string) => { setSearchSeed(query); selectPage('explore') }, [selectPage])
  const clone = useCallback((insight: Insight) => {
    openRemember(insight.content)
  }, [openRemember])
  const refreshAll = () => { setRevision(value => value + 1); void loadStatus() }
  const activationEnabled = status?.writeEnabled === true
  const writeEnabled = activationEnabled && settingsSnapshot.status === 'ready' && settingsSnapshot.writable
  const catalogKnown = status?.memoryBodies !== undefined
  const memoryBodies = useMemo(() => (status?.memoryBodies ?? []).map(normalizeMemoryBody), [status])
  const workspaceContext = status?.workspaceContext
  const storageMode = workspaceContext?.mode ?? status?.storage?.activeKind ?? configuredStorageScope(settingsSnapshot.value)
  const storageModeText = storageScopeLabel(t, storageMode)
  const showWorkspacePicker = storageMode === 'workspace' && workspaceSelection !== undefined && workspaceSelection.options.length > 0
  const workspaceDiverged = workspaceContext?.mode === 'workspace' && !workspaceContext.aligned
  const taskAgentAvailable = status?.lifecycle?.taskAgentAvailable === true
    || (status?.lifecycle?.taskAgentAvailable === undefined && metadataSessionId !== undefined && status?.lifecycle?.sessionAvailable === true && !workspaceDiverged)
  const canAlignWorkspace = workspaceDiverged && workspaceSelection?.effectiveWorkspaceId !== undefined
  const workspaceDifference = workspaceContext === undefined
    ? ''
    : `${t('workspace.selectedRoot', { root: workspaceContext.selectedRoot })}; ${t('workspace.effectiveRoot', { root: workspaceContext.effectiveRoot })}`
  const workspacePicker = showWorkspacePicker && <label className={appearanceClass(css.workspacePicker, sidebarCss.workspacePicker)}><span>{t('workspace.viewing')}</span><select aria-label={t('workspace.selectorAria')} value={workspaceSelection.selectedWorkspaceId ?? ''} onChange={event => workspaceSelection.onSelect(event.target.value)}>{workspaceSelection.options.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}</select></label>
  const connectionLabel = status === null && statusLoading
    ? t('header.checking')
    : status?.healthy !== true
      ? t('header.unavailable')
      : t('header.connected')

  return (
    <main className={appearanceClass(css.shell, sidebarCss.shell)} data-mnemon-surface={surface}>
      <header className={appearanceClass(css.masthead, sidebarCss.masthead)}>
        {onClose !== undefined && <button type="button" className={appearanceClass(css.ghostButton, css.backButton)} onClick={onClose} aria-label={t('header.backToConversation')}><IconChevronLeftOutline14 size={14} /><span>{t('header.backToConversation')}</span></button>}
        <div className={appearanceClass(css.brand, sidebarCss.brand)}>
          <h1>{t('tab.label')}</h1>
          {surface === 'sidebar' && <>
            <span className={css.storageMode} aria-label={t('workspace.storageModeAria', { mode: storageModeText })}><span>{t('workspace.storageMode')}</span><strong>{storageModeText}</strong></span>
            {workspacePicker}
            {canAlignWorkspace && <div className={appearanceClass(css.workspaceMismatch, sidebarCss.workspaceMismatch)} role="status" aria-label={`${t('workspace.mismatchTitle')}. ${workspaceDifference}`} title={workspaceDifference}><span>{t('workspace.mismatchShort')}</span><button type="button" onClick={workspaceSelection.onAlign}>{t('workspace.align')}</button></div>}
          </>}
        </div>
        <div className={appearanceClass(css.headerActions, sidebarCss.headerActions)}><div className={appearanceClass(css.statusCluster, sidebarCss.statusCluster)}><span className={`${css.statusDot} ${statusLoading && status === null ? css.checking : status?.healthy === true ? css.online : css.offline}`} /><span>{connectionLabel}</span><button type="button" className={css.iconButton} disabled={statusLoading} onClick={refreshAll} aria-label={t('common.refresh')}>↻</button></div></div>
      </header>
      {(statusError !== null || status?.healthy === false) && <div className={css.alert} role="alert"><strong>{t('header.notReady')}</strong><span>{statusError ?? status?.error}</span></div>}
      <div className={css.workspace}>
        <WorkspaceNavigation page={page} onSelect={selectPrimaryPage} layers={{ runtime: runtimeLayerEnabled, documents: documentsLayerEnabled, 'memory-spaces': memorySpacesLayerEnabled }} />
        {memorySpacesLayerEnabled !== false && <MemoryNavigation page={page} activationEnabled={activationEnabled} writeEnabled={writeEnabled} onSelect={selectPage} onRemember={() => openRemember()} onStrategy={() => setStrategyOpen(true)} />}
        <section key={viewContextKey} className={appearanceClass(css.canvas, sidebarCss.canvas)} ref={canvasRef} data-testid="mnemon-canvas" data-lock-page-header={!isMemoryPage(page) ? '' : undefined}>
          {page === 'overview' && (memorySpacesLayerEnabled !== false ? <OverviewPage client={client} metadataClient={taskClient} revision={revision} activationEnabled={activationEnabled} writeEnabled={writeEnabled} agentAvailable={taskAgentAvailable} fallbackBodies={memoryBodies} fallbackDirectory={status?.memoryBodyDirectory} catalogKnown={catalogKnown} onMutate={mutate} onAgentRefresh={() => void loadStatus()} onBodyReconnect={bodyReconnected} onBodyMetadata={bodyMetadataUpdated} onExplore={explore} /> : <LayerDisabledPage title={t('overview.title')} />)}
          {page === 'runtime' && (runtimeLayerEnabled !== false ? <RuntimePage client={client} revision={revision} writeEnabled={writeEnabled} onMutate={mutate} /> : <LayerDisabledPage title={t('runtime.title')} />)}
          {page === 'documents' && (documentsLayerEnabled !== false ? <DocumentsPage client={client} revision={revision} writeEnabled={writeEnabled} {...(sessionId === undefined ? {} : { sessionId })} onMutate={mutate} /> : <LayerDisabledPage title={t('documents.title')} />)}
          {page === 'explore' && (memorySpacesLayerEnabled !== false ? <ExplorePage client={client} agentClient={taskClient} agentAvailable={taskAgentAvailable} status={status} seed={searchSeed} writeEnabled={writeEnabled} onForget={forget} /> : <LayerDisabledPage title={t('overview.title')} />)}
          {page === 'entities' && (memorySpacesLayerEnabled !== false ? <EntitiesPage client={client} revision={revision} writeEnabled={writeEnabled} onForget={forget} onExplore={explore} /> : <LayerDisabledPage title={t('overview.title')} />)}
          {page === 'list' && (memorySpacesLayerEnabled !== false ? <ListPage client={client} revision={revision} writeEnabled={writeEnabled} onForget={forget} onClone={clone} onExplore={explore} /> : <LayerDisabledPage title={t('overview.title')} />)}
          {page === 'status' && <StatusPage client={client} status={status} loading={statusLoading} writeEnabled={writeEnabled} onRefresh={() => void loadStatus()} />}
        </section>
        {memorySpacesLayerEnabled !== false && rememberOpen && <RememberDialog client={taskClient} agentAvailable={taskAgentAvailable} memoryBodies={memoryBodies} writeEnabled={writeEnabled} seed={rememberSeed} onMutate={mutate} onClose={() => setRememberOpen(false)} onComplete={() => setRememberOpen(false)} />}
        {memorySpacesLayerEnabled !== false && strategyOpen && <PersistenceStrategyDialog client={taskClient} settingsScope={settingsScope} config={settingsSnapshot.value} writable={settingsSnapshot.writable} agentAvailable={taskAgentAvailable} onClose={() => setStrategyOpen(false)} />}
      </div>
    </main>
  )
}
