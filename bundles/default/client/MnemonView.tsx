import { BUILTIN_MEMORY_SOURCE_TYPE_ID_SET, BUILTIN_MEMORY_SOURCE_PAGE_ID_SET, BUILTIN_MEMORY_SOURCE_PAGE_IDS } from './source-pages.tsx'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { IconChevronLeftOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { consumeMnemonAnchor, subscribeMnemonAnchor, type MnemonAnchor } from '../../../src/client/anchor.ts'

import { type ClientConnectionHandle, type ClientSettingsScope, type Config, type Insight, type JsonValue, type MemoryBodyMetadataUpdate, type MemoryBodyView, type MemoryProviderRuntimeStatus, type MemorySourceManagementCatalog, type MemorySourceManagementInstance, type StatusView, type StorageAreaInventory, type StorageScopeInventory, type StorageScopeKind, type VersionComponentStatus, type VersionInstallMode, type VersionStatus, type VersionUpdateResult } from '../../../src/shared/contracts.ts'
import { MnemonClient } from '../../../src/client/api.ts'
import { translateZh, type MnemonKey, type MnemonTranslate } from '../../../src/client/locales.ts'

import { MnemonLogo } from '../../../src/client/MnemonLogo.tsx'
import { ProviderIcon } from '../../../src/client/ProviderIcon.tsx'

import { MNEMON_SOURCE_CONFIGURATION_MUTATE, MNEMON_SOURCE_CONFIGURATION_READ, type MemorySourcePageDirectory, type MemorySourcePageEntry } from '../../../src/client/source-pages.tsx'
import type { MnemonSourceManagementClient } from '../../../src/client/dsh-compat.ts'
import { appearanceClass, MnemonViewAppearanceProvider, resolveMnemonViewAppearance, useMnemonViewAppearance, type MnemonViewSurface } from '../../../src/client/MnemonViewAppearance.tsx'
import css from '../../../src/client/MnemonView.module.css'
import { I18nContext, LocaleContext, useT, useLocale, humanBytes, message, short, PageHeader, SidebarModal, EmptyState } from '../../../src/client/page-kit.tsx'
import { RuntimePage } from 'dsh-mnemon-source-runtime/client'
import { DocumentsPage } from 'dsh-mnemon-source-documents/client'
import { OverviewPage, normalizeMemoryBody, nativeBodyProvider, ExplorePage, EntitiesPage, RememberPage, ListPage, PersistenceStrategyDialog } from 'dsh-mnemon-source-memory-spaces/client'

export interface MnemonViewProps {
  connection: ClientConnectionHandle
  settingsScope: ClientSettingsScope<Config>
  sessionId?: string
  workspaceId?: string
  workspaceSelection?: MnemonWorkspaceSelection
  surface?: MnemonViewSurface
  t?: MnemonTranslate
  locale?: string
  onClose?: () => void
  sourcePageDirectory?: MemorySourcePageDirectory
  renderSlot?: PropsRenderSlots<'mnemon.source.page'>['renderSlot']
}

export interface MnemonWorkspaceSelection {
  options: Array<{ id: string; title: string; path: string }>
  selectedWorkspaceId?: string
  effectiveWorkspaceId?: string
  onSelect(workspaceId: string): void
  onAlign(): void
}

type SourcePage = `source:${string}`

type ManagedSourcePage = `source-management:${string}`

type Page = 'overview' | 'runtime' | 'documents' | 'explore' | 'entities' | 'remember' | 'list' | 'status' | SourcePage | ManagedSourcePage

type SidebarMemoryPage = Extract<Page, 'overview' | 'explore' | 'list' | 'entities'>

type NavEntry = { id: Page; label: MnemonKey; detail: MnemonKey; glyph: string }

type NavGroup = { aria: MnemonKey; entries: NavEntry[] }

/** 系统 → 三层存储 → 读写工具；组间以分隔线呈现。 */
const PAGE_NAV: NavGroup[] = [
  {
    aria: 'nav.group.system',
    entries: [
      { id: 'status', label: 'nav.status', detail: 'nav.status.detail', glyph: '⌘' },
    ],
  },
  {
    aria: 'nav.group.storage',
    entries: [
      { id: 'runtime', label: 'nav.runtime', detail: 'nav.runtime.detail', glyph: '◫' },
      { id: 'documents', label: 'nav.documents', detail: 'nav.documents.detail', glyph: '▤' },
      { id: 'overview', label: 'nav.bodies', detail: 'nav.bodies.detail', glyph: '◇' },
    ],
  },
  {
    aria: 'nav.group.tools',
    entries: [
      { id: 'remember', label: 'nav.remember', detail: 'nav.remember.detail', glyph: '+' },
      { id: 'explore', label: 'nav.search', detail: 'nav.search.detail', glyph: '⌕' },
      { id: 'entities', label: 'nav.entities', detail: 'nav.entities.detail', glyph: '◎' },
      { id: 'list', label: 'nav.content', detail: 'nav.content.detail', glyph: '≡' },
    ],
  },
]

const SIDEBAR_PAGE_TABS: NavEntry[] = [
  { id: 'status', label: 'nav.status', detail: 'nav.status.detail', glyph: '⌘' },
  { id: 'runtime', label: 'nav.runtime', detail: 'nav.runtime.detail', glyph: '◫' },
  { id: 'documents', label: 'nav.documents', detail: 'nav.documents.detail', glyph: '▤' },
  { id: 'overview', label: 'nav.bodies', detail: 'nav.bodies.detail', glyph: '◇' },
]

const MEMORY_PAGE_TABS: Array<{ id: SidebarMemoryPage; label: MnemonKey }> = [
  { id: 'overview', label: 'nav.overview' },
  { id: 'explore', label: 'nav.search' },
  { id: 'list', label: 'nav.content' },
  { id: 'entities', label: 'nav.entities' },
]

const MEMORY_PAGES = new Set<Page>(MEMORY_PAGE_TABS.map(item => item.id))

type ConfigurableMemoryLayerId = 'runtime' | 'documents' | 'memory-spaces'

const EMPTY_SOURCE_PAGE_SNAPSHOT: readonly MemorySourcePageEntry[] = Object.freeze([])

const EMPTY_SOURCE_MANAGEMENT_FIELDS: NonNullable<MemorySourceManagementInstance['management']['fields']> = []

const EMPTY_SOURCE_PAGE_DIRECTORY: MemorySourcePageDirectory = {
  getSnapshot: () => EMPTY_SOURCE_PAGE_SNAPSHOT,
  subscribe: () => () => {},
}

function sourcePage(entryId: string): SourcePage {
  return `source:${entryId}`
}

function sourcePageEntryId(page: Page): string | undefined {
  return page.startsWith('source:') ? page.slice('source:'.length) : undefined
}

function managedSourcePage(sourceTypeId: string): ManagedSourcePage {
  return `source-management:${sourceTypeId}`
}

function managedSourceTypeId(page: Page): string | undefined {
  return page.startsWith('source-management:') ? page.slice('source-management:'.length) : undefined
}

function pageLayer(page: Page): ConfigurableMemoryLayerId | undefined {
  if (page === 'runtime') return 'runtime'
  if (page === 'documents') return 'documents'
  if (isMemoryPage(page) || page === 'remember') return 'memory-spaces'
  return undefined
}

function isMemoryPage(page: Page): page is SidebarMemoryPage {
  return MEMORY_PAGES.has(page)
}

function bindSourceManagementClient(client: MnemonClient, instance: MemorySourceManagementInstance): MnemonSourceManagementClient {
  return {
    sourceInstanceKey: instance.sourceInstanceKey,
    revision: instance.revision,
    read: (operation, input = null) => client.readSourceManagement(instance.sourceInstanceKey, operation, input),
    mutate: (operation, input, options) => client.mutateSourceManagement(
      instance.sourceInstanceKey,
      operation,
      input,
      options.expectedRevision ?? instance.revision,
      options.confirmed,
    ),
  }
}

function jsonRecord(value: JsonValue): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function LayerDisabledPage(props: { title: string }): JSX.Element {
  const t = useT()
  return <div className={css.page}>
    <PageHeader title={props.title} description={t('layers.disabledDescription')} meta={t('layers.disabledBadge')} />
    <EmptyState glyph="⊘" title={t('layers.disabledTitle', { layer: props.title })}>{t('layers.disabledText')}</EmptyState>
  </div>
}

/** Sidebar mirrors the SSH panel's flat tab model; Buildin keeps the grouped navigation unchanged. */
interface SourceNavigationEntry {
  id: string
  page: SourcePage | ManagedSourcePage
  label: string
  detail: string
}

function WorkspaceNavigation(props: { page: Page; onSelect: (page: Page) => void; sourcePages: readonly SourceNavigationEntry[]; activeBodies: number; bodyCount: number; catalogKnown: boolean; activationEnabled: boolean; writeEnabled: boolean; layers: Record<ConfigurableMemoryLayerId, boolean | undefined> }): JSX.Element {
  const t = useT()
  const appearance = useMnemonViewAppearance()
  return (
    <div className={appearanceClass(css.topNavigation, appearance.classes.topNavigation)}>
      {appearance.surface === 'sidebar'
        ? <div className={appearanceClass(css.nav, appearance.classes.nav)} role="tablist" aria-label={t('nav.aria')}>
          {SIDEBAR_PAGE_TABS.map(item => {
            const active = item.id === 'overview' ? isMemoryPage(props.page) : props.page === item.id
            const layer = pageLayer(item.id)
            const disabled = layer !== undefined && props.layers[layer] === false
            const label = t(item.label)
            return <button key={item.id} type="button" role="tab" aria-selected={active} data-active={active ? '' : undefined} data-layer-disabled={disabled ? '' : undefined} aria-label={disabled ? `${label} · ${t('layers.disabledBadge')}` : undefined} onClick={() => props.onSelect(item.id)}><span>{label}</span>{disabled && <em className={css.layerDisabledBadge}>{t('layers.disabledBadge')}</em>}</button>
          })}
          {props.sourcePages.map(item => {
            const active = props.page === item.page
            return <button key={item.id} type="button" role="tab" aria-selected={active} data-active={active ? '' : undefined} onClick={() => props.onSelect(item.page)}><span>{item.label}</span></button>
          })}
        </div>
        : <nav className={appearanceClass(css.nav, appearance.classes.nav)} aria-label={t('nav.aria')}>
          {PAGE_NAV.map((group, groupIndex) => <Fragment key={group.aria}><div className={appearanceClass(css.navGroup, appearance.classes.navGroup)} role="group" aria-label={t(group.aria)}>{group.entries.map(item => <button key={item.id} type="button" aria-current={props.page === item.id ? 'page' : undefined} onClick={() => props.onSelect(item.id)}>{appearance.showNavigationGlyphs && <span className={css.navGlyph} aria-hidden="true">{item.glyph}</span>}<span><strong>{t(item.label)}</strong>{appearance.showNavigationDetails && <small>{t(item.detail)}</small>}</span></button>)}</div>{appearance.showNavigationDividers && groupIndex < PAGE_NAV.length - 1 && <span className={css.navGroupDivider} aria-hidden="true" />}</Fragment>)}
          {props.sourcePages.length > 0 && <><span className={css.navGroupDivider} aria-hidden="true" /><div className={appearanceClass(css.navGroup, appearance.classes.navGroup)} role="group" aria-label={t('nav.group.sources')}>{props.sourcePages.map(item => {
            return <button key={item.id} type="button" aria-current={props.page === item.page ? 'page' : undefined} onClick={() => props.onSelect(item.page)}>{appearance.showNavigationGlyphs && <span className={css.navGlyph} aria-hidden="true">◇</span>}<span><strong>{item.label}</strong>{appearance.showNavigationDetails && <small>{item.detail}</small>}</span></button>
          })}</div></>}
        </nav>}
      {appearance.showSpaceSummary && <div className={css.spaceSummary}><span>{t('sidebar.activeSpaces')}</span><code>{props.catalogKnown ? `${props.activeBodies} / ${props.bodyCount}` : '— / —'}</code><small>{props.writeEnabled ? t('common.agentSupervised') : props.activationEnabled ? t('common.activationOnly') : t('common.readOnly')}</small></div>}
    </div>
  )
}

/** Memory tools become a focused second-level tab set on the Sidebar surface. */
function MemoryNavigation(props: { page: Page; activationEnabled: boolean; writeEnabled: boolean; onSelect: (page: SidebarMemoryPage) => void; onRemember: () => void; onStrategy: () => void }): JSX.Element | null {
  const t = useT()
  const appearance = useMnemonViewAppearance()
  if (appearance.surface !== 'sidebar' || !isMemoryPage(props.page)) return null
  return (
    <section className={appearance.classes.memoryWorkspace}>
      <PageHeader title={t('nav.bodies')} description={t('overview.description')} meta={props.writeEnabled ? t('common.agentSupervised') : props.activationEnabled ? t('common.activationOnly') : t('common.readOnly')} action={<div className={css.memoryHeaderActions}><button type="button" className={appearanceClass(css.primaryButton, appearance.classes.memoryWriteButton)} disabled={!props.writeEnabled} onClick={props.onRemember}>{t('nav.rememberAction')}</button><button type="button" className={css.secondaryButton} onClick={props.onStrategy}>{t('strategy.action')}</button></div>} />
      <div className={appearance.classes.memoryNavigation}>
        <div className={appearance.classes.memoryTabs} role="tablist" aria-label={t('nav.memory.aria')}>
          {MEMORY_PAGE_TABS.map(item => {
            const active = props.page === item.id
            return <button key={item.id} type="button" role="tab" aria-selected={active} data-active={active ? '' : undefined} onClick={() => props.onSelect(item.id)}>{t(item.label)}</button>
          })}
        </div>
      </div>
    </section>
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

/** Fixed descriptor-driven baseline; custom Source pages can only add to it. */
function SourceManagementPage(props: {
  instance: MemorySourceManagementInstance
  instances: readonly MemorySourceManagementInstance[]
  management?: MnemonSourceManagementClient
  onSelect(sourceInstanceKey: string): void
  onMutate(): void
}): JSX.Element {
  const t = useT()
  const fields = props.instance.management.fields ?? EMPTY_SOURCE_MANAGEMENT_FIELDS
  const [draft, setDraft] = useState<Record<string, JsonValue>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true
    setDraft({})
    setError(null)
    setSaved(false)
    if (fields.length === 0 || props.management === undefined) {
      setLoading(false)
      return () => { active = false }
    }
    setLoading(true)
    void props.management.read(MNEMON_SOURCE_CONFIGURATION_READ).then(result => {
      if (!active) return
      const root = jsonRecord(result.value)
      const values = jsonRecord(root?.values ?? result.value) ?? {}
      setDraft(Object.fromEntries(fields.flatMap(field => {
        if (field.secret === true || field.input === 'secret') return []
        const value = values[field.key]
        return value === undefined ? [] : [[field.key, value]]
      })))
    }).catch(reason => {
      if (active) setError(message(reason))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [fields, props.instance.revision, props.instance.sourceInstanceKey, props.management])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (props.management === undefined) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const input = Object.fromEntries(fields.flatMap(field => {
        const value = draft[field.key]
        if ((field.secret === true || field.input === 'secret') && (value === undefined || value === '')) return []
        if (field.input === 'number' && value !== undefined && value !== '') return [[field.key, Number(value)]]
        if (field.input === 'boolean') return [[field.key, value === true]]
        return value === undefined || value === '' ? [] : [[field.key, value]]
      }))
      await props.management.mutate(MNEMON_SOURCE_CONFIGURATION_MUTATE, input, { confirmed: true })
      setSaved(true)
      props.onMutate()
    } catch (reason) {
      setError(message(reason))
    } finally {
      setSaving(false)
    }
  }

  const availability = t(`sourcePage.availability.${props.instance.availability}` as MnemonKey)
  return <div className={css.page} data-source-management={props.instance.sourceTypeId}>
    <PageHeader
      title={props.instance.management.label}
      description={props.instance.management.description}
      meta={props.instance.sourceTypeId}
      {...(loading ? { loadingLabel: t('sourcePage.configLoading') } : {})}
    />
    {props.instances.length > 1 && <label className={css.workspacePicker}><span>{t('sourcePage.instance')}</span><select aria-label={t('sourcePage.instanceAria')} value={props.instance.sourceInstanceKey} onChange={event => props.onSelect(event.target.value)}>{props.instances.map(instance => <option key={instance.sourceInstanceKey} value={instance.sourceInstanceKey}>{instance.management.label} · {instance.sourceInstanceKey}</option>)}</select></label>}
    <section className={css.sourceManagementSummary} data-availability={props.instance.availability} aria-label={t('sourcePage.summaryAria')}>
      <div className={css.sourceManagementIdentity}><span aria-hidden="true" /><div><small>{t('sourcePage.package')}</small><strong>{props.instance.packageName}</strong><code>{props.instance.sourceInstanceKey}</code></div></div>
      <dl>
        <div><dt>{t('sourcePage.availability')}</dt><dd>{availability}</dd></div>
        <div><dt>{t('sourcePage.role')}</dt><dd>{props.instance.role}</dd></div>
        <div><dt>{t('sourcePage.revision')}</dt><dd><code>{short(props.instance.revision, 32)}</code></dd></div>
      </dl>
      <div className={css.sourceManagementCapabilities}><small>{t('sourcePage.permissions')}</small><div>{props.instance.capabilities.map(capability => <span key={capability}>{capability}</span>)}</div></div>
    </section>
    {props.instance.management.diagnostics !== undefined && props.instance.management.diagnostics.length > 0 && <section className={css.sourceManagementDiagnostics} aria-label={t('sourcePage.diagnostics')}><h3>{t('sourcePage.diagnostics')}</h3><ul>{props.instance.management.diagnostics.map((diagnostic, index) => <li key={`${index}:${diagnostic}`}>{diagnostic}</li>)}</ul></section>}
    {fields.length > 0 && <form className={css.sourceManagementForm} onSubmit={event => void submit(event)}>
      <div><h3>{t('sourcePage.configuration')}</h3><p>{t('sourcePage.configurationDescription')}</p></div>
      <div className={css.formGrid}>{fields.map(field => {
        const value = draft[field.key]
        const update = (next: JsonValue): void => setDraft(current => ({ ...current, [field.key]: next }))
        return <label key={field.key}>{field.label}
          {field.input === 'boolean'
            ? <input type="checkbox" checked={value === true} onChange={event => update(event.target.checked)} />
            : field.input === 'select'
              ? <select value={typeof value === 'string' ? value : ''} required={field.required} onChange={event => update(event.target.value)}><option value="">—</option>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
              : <input type={field.input === 'secret' ? 'password' : field.input === 'number' ? 'number' : field.input === 'url' ? 'url' : 'text'} value={typeof value === 'string' || typeof value === 'number' ? value : ''} required={field.required && field.input !== 'secret'} autoComplete={field.input === 'secret' ? 'new-password' : undefined} placeholder={field.input === 'secret' ? t('sourcePage.secretPlaceholder') : undefined} onChange={event => update(event.target.value)} />}
          {field.description !== undefined && <small>{field.description}</small>}
        </label>
      })}</div>
      {error !== null && <div className={css.alert} role="alert">{error}</div>}
      {saved && <div className={css.runtimeNotice} role="status">{t('sourcePage.configSaved')}</div>}
      <div className={css.formActions}><button type="submit" className={css.primaryButton} disabled={saving || loading || props.management === undefined || props.instance.availability === 'unavailable'}>{saving ? t('sourcePage.configSaving') : t('sourcePage.configSave')}</button>{props.management === undefined && <span>{t('sourcePage.unavailable')}</span>}</div>
    </form>}
    {fields.length === 0 && props.instance.availability === 'unavailable' && <div className={css.emptyState}><span className={css.emptyGlyph}>!</span><div><h3>{t('sourcePage.unavailable')}</h3><p>{t('sourcePage.unavailableDescription')}</p></div></div>}
  </div>
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
      <div className={css.asyncStatusBlock}>{status?.providerServices !== undefined && <ProviderHealth services={status.providerServices} />}</div>
      <div className={css.asyncStatusBlock}><StorageDomains catalog={storage} selected={selectedScope} selectedKind={selectedScopeKind} /></div>
      {versionsOpen && <VersionDialog client={props.client} writeEnabled={props.writeEnabled} onClose={() => setVersionsOpen(false)} onRefreshStatus={props.onRefresh} />}
    </div>
  )
}

function NativeProviderHealth({ status }: { status: StatusView }): JSX.Element {
  const t = useT()
  const bodies = (status.memoryBodies ?? []).filter(body => body.provider === undefined || nativeBodyProvider(body.provider))
  const active = bodies.filter(body => body.active)
  const pending = active.filter(body => body.statusLoading === true)
  const failed = active.filter(body => body.statusLoading !== true && !body.healthy)
  const state: MemoryProviderRuntimeStatus['status'] = !status.commandFound || failed.length > 0 ? 'unhealthy' : active.length === 0 || pending.length > 0 ? 'idle' : 'healthy'
  const error = !status.commandFound
    ? t('status.nativeCliMissing')
    : failed.map(body => `${body.name}: ${body.error ?? t('status.engineUnavailable')}`).join('; ')
  return <section className={css.nativeProviderHealth} aria-label={t('status.nativeAria')} data-status={state}>
    <ProviderIcon providerId="mnemon-native" icon={{ kind: 'brand', value: 'mnemon' }} className={css.providerHealthMark} />
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
      <ProviderIcon providerId={service.providerId} icon={service.icon} className={css.providerHealthMark} />
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
  const appearance = resolveMnemonViewAppearance(props.surface ?? 'buildin', t)
  return <I18nContext.Provider value={t}><LocaleContext.Provider value={props.locale ?? 'zh'}><MnemonViewAppearanceProvider value={appearance}><MnemonWorkspace {...props} /></MnemonViewAppearanceProvider></LocaleContext.Provider></I18nContext.Provider>
}

function MnemonWorkspace({ connection, settingsScope, sessionId, workspaceId, workspaceSelection, onClose, sourcePageDirectory = EMPTY_SOURCE_PAGE_DIRECTORY, renderSlot }: MnemonViewProps): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const appearance = useMnemonViewAppearance()
  const settingsSnapshot = useSyncExternalStore(settingsScope.subscribe, settingsScope.getSnapshot, settingsScope.getSnapshot)
  const subscribeSourcePages = useCallback((listener: () => void) => sourcePageDirectory.subscribe(listener), [sourcePageDirectory])
  const getSourcePages = useCallback(() => sourcePageDirectory.getSnapshot(), [sourcePageDirectory])
  const sourcePageEntries = useSyncExternalStore(subscribeSourcePages, getSourcePages, getSourcePages)
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
    selectPage(appearance.surface === 'sidebar' && next === 'overview' ? lastMemoryPage.current : next)
  }, [appearance.surface, selectPage])

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
  const taskClient = useMemo(() => new MnemonClient(connection, undefined, workspaceId), [connection, workspaceId])
  const statusRequest = useRef(0)
  const [revision, setRevision] = useState(0)
  const [sourceCatalogState, setSourceCatalogState] = useState<{ contextKey: string; value: MemorySourceManagementCatalog | null }>(() => ({ contextKey: viewContextKey, value: null }))
  const [selectedSourceInstances, setSelectedSourceInstances] = useState<Record<string, string>>({})
  const [searchSeed, setSearchSeed] = useState('')
  const [rememberSeed, setRememberSeed] = useState('')
  const [rememberOpen, setRememberOpen] = useState(false)
  const [strategyOpen, setStrategyOpen] = useState(false)

  useEffect(() => {
    let active = true
    void client.sourceManagementCatalog().then(value => {
      if (active) setSourceCatalogState({ contextKey: viewContextKey, value })
    }).catch(() => {
      // Rolling upgrades retain the built-in pages while an older Host lacks
      // the composable management catalog. Optional pages remain hidden.
      if (active) setSourceCatalogState({ contextKey: viewContextKey, value: null })
    })
    return () => { active = false }
  }, [client, revision, viewContextKey])

  const sourceCatalog = sourceCatalogState.contextKey === viewContextKey ? sourceCatalogState.value : null
  const sourceInstances = sourceCatalog?.sources ?? []
  const sourceManagementClients = useMemo(() => new Map(sourceInstances
    .filter(source => source.availability !== 'unavailable')
    .map(source => [source.sourceInstanceKey, bindSourceManagementClient(client, source)])), [client, sourceInstances])
  const visibleSourcePages = useMemo(() => {
    const visibleTypes = new Set(sourceInstances.filter(source => source.availability !== 'unavailable').map(source => source.sourceTypeId))
    return sourcePageEntries.filter(entry => !BUILTIN_MEMORY_SOURCE_PAGE_ID_SET.has(entry.id) && visibleTypes.has(entry.sourceTypeId))
  }, [sourceInstances, sourcePageEntries])
  const managedSourceTypes = useMemo(() => {
    const byType = new Map<string, MemorySourceManagementInstance[]>()
    for (const source of sourceInstances) {
      if (BUILTIN_MEMORY_SOURCE_TYPE_ID_SET.has(source.sourceTypeId)) continue
      const current = byType.get(source.sourceTypeId)
      if (current === undefined) byType.set(source.sourceTypeId, [source])
      else current.push(source)
    }
    return [...byType.entries()].sort(([left], [right]) => left.localeCompare(right))
  }, [sourceInstances])
  const sourceNavigationEntries = useMemo<SourceNavigationEntry[]>(() => [
    ...managedSourceTypes.map(([sourceTypeId, instances]) => ({
      id: `management:${sourceTypeId}`,
      page: managedSourcePage(sourceTypeId),
      label: instances[0]!.management.label,
      detail: sourceTypeId,
    })),
    ...visibleSourcePages.map(entry => ({
      id: `custom:${entry.id}`,
      page: sourcePage(entry.id),
      label: entry.label,
      detail: entry.sourceTypeId,
    })),
  ], [managedSourceTypes, visibleSourcePages])

  useEffect(() => {
    const entryId = sourcePageEntryId(page)
    const managedTypeId = managedSourceTypeId(page)
    if (
      (entryId !== undefined && !visibleSourcePages.some(entry => entry.id === entryId))
      || (managedTypeId !== undefined && !managedSourceTypes.some(([sourceTypeId]) => sourceTypeId === managedTypeId))
    ) setPage('status')
  }, [managedSourceTypes, page, visibleSourcePages])

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
    if (anchor.page === 'remember' && appearance.surface === 'sidebar') {
      openRemember(anchor.seed ?? '')
      selectPage(lastMemoryPage.current)
      return
    }
    if (anchor.seed !== undefined && anchor.seed !== '') {
      if (anchor.page === 'explore') setSearchSeed(anchor.seed)
      if (anchor.page === 'remember') setRememberSeed(anchor.seed)
    }
    selectPage(anchor.page)
  }, [appearance.surface, openRemember, selectPage])
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
    if (appearance.surface === 'sidebar') openRemember(insight.content)
    else { setRememberSeed(insight.content); selectPage('remember') }
  }, [appearance.surface, openRemember, selectPage])
  const refreshAll = () => { setRevision(value => value + 1); void loadStatus() }
  const activationEnabled = status?.writeEnabled === true
  const writeEnabled = activationEnabled && settingsSnapshot.status === 'ready' && settingsSnapshot.writable
  const stats = status?.stats
  const catalogKnown = status?.memoryBodies !== undefined
  const memoryBodies = useMemo(() => (status?.memoryBodies ?? []).map(normalizeMemoryBody), [status])
  const activeBodies = memoryBodies.filter(body => body.active).length
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
  const workspacePicker = showWorkspacePicker && <label className={appearanceClass(css.workspacePicker, appearance.classes.workspacePicker)}><span>{t('workspace.viewing')}</span><select aria-label={t('workspace.selectorAria')} value={workspaceSelection.selectedWorkspaceId ?? ''} onChange={event => workspaceSelection.onSelect(event.target.value)}>{workspaceSelection.options.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}</select></label>
  const connectionLabel = status === null && statusLoading
    ? t('header.checking')
    : status?.healthy !== true
      ? t('header.unavailable')
      : appearance.surface === 'sidebar'
        ? t('header.connected')
        : catalogKnown
          ? t('header.connectedWithCount', { count: activeBodies })
          : t('header.directoryPending')
  const allInstancesFor = (sourceTypeId: string): MemorySourceManagementInstance[] => sourceInstances.filter(source => source.sourceTypeId === sourceTypeId)
  const instancesFor = (sourceTypeId: string): MemorySourceManagementInstance[] => allInstancesFor(sourceTypeId).filter(source => source.availability !== 'unavailable')
  const renderSourceContribution = (entryId: string, children?: ReactNode): ReactNode => {
    const separator = entryId.indexOf('/')
    const sourceTypeId = separator < 0 ? entryId : entryId.slice(0, separator)
    const instances = instancesFor(sourceTypeId)
    const isDefaultInstance = (instance: MemorySourceManagementInstance) =>
      instance.sourceInstanceKey === `source:mnemon-source-${sourceTypeId}` || instance.sourceInstanceKey === `source:bundled-${sourceTypeId}`
    const selectedKey = selectedSourceInstances[sourceTypeId]
    const selected = instances.find(instance => instance.sourceInstanceKey === selectedKey) ?? instances.find(isDefaultInstance) ?? instances[0]
    const management = selected === undefined ? undefined : sourceManagementClients.get(selected.sourceInstanceKey)
    // Legacy coordination belongs only to the default bundle's reserved Entries.
    // A separately installed instance must never render the default store's data.
    const compatibleChildren = selected === undefined || isDefaultInstance(selected) ? children : undefined
    if (renderSlot === undefined) return compatibleChildren ?? null
    const rendered = renderSlot('mnemon.source.page', {
      sourceTypeId,
      ...(selected === undefined ? {} : { sourceInstanceKey: selected.sourceInstanceKey }),
      sourceInstances: instances,
      writable: writeEnabled,
      ...(management === undefined ? {} : { management }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      locale,
      ...(compatibleChildren === undefined ? {} : { children: compatibleChildren }),
    }, { only: entryId, fallback: compatibleChildren })
    if (!BUILTIN_MEMORY_SOURCE_TYPE_ID_SET.has(sourceTypeId) || instances.length < 2) return rendered
    return <>
      <label className={css.workspacePicker}><span>{t('sourcePage.instance')}</span><select aria-label={t('sourcePage.instanceAria')} value={selected?.sourceInstanceKey} onChange={event => setSelectedSourceInstances(current => ({ ...current, [sourceTypeId]: event.target.value }))}>{instances.map(instance => <option key={instance.sourceInstanceKey} value={instance.sourceInstanceKey}>{instance.management.label} · {instance.sourceInstanceKey}</option>)}</select></label>
      {rendered}
    </>
  }
  const activeSourcePageId = sourcePageEntryId(page)
  const activeSourcePage = activeSourcePageId === undefined ? undefined : visibleSourcePages.find(entry => entry.id === activeSourcePageId)
  const activeSourceInstances = activeSourcePage === undefined ? [] : instancesFor(activeSourcePage.sourceTypeId)
  const activeSelectedKey = activeSourcePage === undefined ? undefined : selectedSourceInstances[activeSourcePage.sourceTypeId]
  const activeSelectedInstance = activeSourceInstances.find(instance => instance.sourceInstanceKey === activeSelectedKey) ?? activeSourceInstances[0]
  const customSourcePage = activeSourcePage === undefined || activeSelectedInstance === undefined ? null : <div className={css.page} data-source-page={activeSourcePage.id}>
    {activeSourceInstances.length > 1 && <label className={css.workspacePicker}><span>{t('sourcePage.instance')}</span><select aria-label={t('sourcePage.instanceAria')} value={activeSelectedInstance.sourceInstanceKey} onChange={event => setSelectedSourceInstances(current => ({ ...current, [activeSourcePage.sourceTypeId]: event.target.value }))}>{activeSourceInstances.map(instance => <option key={instance.sourceInstanceKey} value={instance.sourceInstanceKey}>{instance.management.label} · {instance.sourceInstanceKey}</option>)}</select></label>}
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

  return (
    <main className={appearanceClass(css.shell, appearance.classes.shell)} data-mnemon-surface={appearance.surface}>
      <header className={appearanceClass(css.masthead, appearance.classes.masthead)}>
        {appearance.surface === 'sidebar' && onClose !== undefined && <button type="button" className={appearanceClass(css.ghostButton, css.backButton)} onClick={onClose} aria-label={t('header.backToConversation')}><IconChevronLeftOutline14 size={14} /><span>{t('header.backToConversation')}</span></button>}
        <div className={appearanceClass(css.brand, appearance.classes.brand)}>
          {appearance.showLogo && <MnemonLogo className={css.brandLogo} />}
          <h1>{appearance.title}</h1>
          {appearance.surface === 'sidebar' && <span className={css.storageMode} aria-label={t('workspace.storageModeAria', { mode: storageModeText })}><span>{t('workspace.storageMode')}</span><strong>{storageModeText}</strong></span>}
          {appearance.surface === 'sidebar' && workspacePicker}
          {appearance.surface === 'sidebar' && canAlignWorkspace && <div className={appearanceClass(css.workspaceMismatch, appearance.classes.workspaceMismatch)} role="status" aria-label={`${t('workspace.mismatchTitle')}. ${workspaceDifference}`} title={workspaceDifference}><span>{t('workspace.mismatchShort')}</span><button type="button" onClick={workspaceSelection.onAlign}>{t('workspace.align')}</button></div>}
        </div>
        {appearance.showTelemetry && <section className={css.telemetry} aria-label={t('telemetry.aria')}><div className={css.telemetryMetric}><span>{t('telemetry.memories')}</span><strong>{stats?.totalInsights ?? '—'}</strong></div><div className={css.telemetryMetric}><span>{t('telemetry.graph')}</span><strong>{stats?.edgeCount ?? '—'}</strong></div><div className={css.telemetryMetric}><span>{t('telemetry.entities')}</span><strong>{stats?.topEntities.length ?? '—'}</strong></div><div className={css.telemetryMetric}><span>{t('telemetry.spaces')}</span><strong>{status === null || !catalogKnown ? '—' : activeBodies}</strong></div></section>}
        <div className={appearanceClass(css.headerActions, appearance.classes.headerActions)}>{appearance.surface === 'buildin' && workspacePicker}<div className={appearanceClass(css.statusCluster, appearance.classes.statusCluster)}><span className={`${css.statusDot} ${statusLoading && status === null ? css.checking : status?.healthy === true ? css.online : css.offline}`} /><span>{connectionLabel}</span><button type="button" className={css.iconButton} disabled={statusLoading} onClick={refreshAll} aria-label={t('common.refresh')}>↻</button></div></div>
      </header>
      {(statusError !== null || status?.healthy === false) && <div className={css.alert} role="alert"><strong>{t('header.notReady')}</strong><span>{statusError ?? status?.error}</span></div>}
      {appearance.surface === 'buildin' && workspaceDiverged && <div className={css.workspaceMismatch} role="status"><div><strong>{t('workspace.mismatchTitle')}</strong><span>{t('workspace.mismatchDescription')}</span><div><code>{t('workspace.selectedRoot', { root: workspaceContext.selectedRoot })}</code><code>{t('workspace.effectiveRoot', { root: workspaceContext.effectiveRoot })}</code></div></div>{canAlignWorkspace && <button type="button" className={css.secondaryButton} onClick={workspaceSelection.onAlign}>{t('workspace.align')}</button>}</div>}
      <div className={css.workspace}>
        <WorkspaceNavigation page={page} onSelect={selectPrimaryPage} sourcePages={sourceNavigationEntries} activeBodies={activeBodies} bodyCount={memoryBodies.length} catalogKnown={catalogKnown} activationEnabled={activationEnabled} writeEnabled={writeEnabled} layers={{ runtime: runtimeLayerEnabled, documents: documentsLayerEnabled, 'memory-spaces': memorySpacesLayerEnabled }} />
        {memorySpacesLayerEnabled !== false && <MemoryNavigation page={page} activationEnabled={activationEnabled} writeEnabled={writeEnabled} onSelect={selectPage} onRemember={() => openRemember()} onStrategy={() => setStrategyOpen(true)} />}
        <section key={viewContextKey} className={appearanceClass(css.canvas, appearance.classes.canvas)} ref={canvasRef} data-testid="mnemon-canvas" data-lock-page-header={!isMemoryPage(page) ? '' : undefined}>
          {page === 'overview' && renderSourceContribution(BUILTIN_MEMORY_SOURCE_PAGE_IDS.overview, memorySpacesLayerEnabled !== false ? <OverviewPage client={client} metadataClient={taskClient} revision={revision} activationEnabled={activationEnabled} writeEnabled={writeEnabled} agentAvailable={taskAgentAvailable} fallbackBodies={memoryBodies} fallbackDirectory={status?.memoryBodyDirectory} catalogKnown={catalogKnown} onMutate={mutate} onAgentRefresh={() => void loadStatus()} onBodyReconnect={bodyReconnected} onBodyMetadata={bodyMetadataUpdated} onExplore={explore} /> : <LayerDisabledPage title={t('overview.title')} />)}
          {page === 'runtime' && renderSourceContribution(BUILTIN_MEMORY_SOURCE_PAGE_IDS.runtime, runtimeLayerEnabled !== false ? <RuntimePage client={client} revision={revision} writeEnabled={writeEnabled} onMutate={mutate} /> : <LayerDisabledPage title={t('runtime.title')} />)}
          {page === 'documents' && renderSourceContribution(BUILTIN_MEMORY_SOURCE_PAGE_IDS.documents, documentsLayerEnabled !== false ? <DocumentsPage client={client} revision={revision} writeEnabled={writeEnabled} {...(sessionId === undefined ? {} : { sessionId })} onMutate={mutate} /> : <LayerDisabledPage title={t('documents.title')} />)}
          {page === 'explore' && renderSourceContribution(BUILTIN_MEMORY_SOURCE_PAGE_IDS.explore, memorySpacesLayerEnabled !== false ? <ExplorePage client={client} agentClient={taskClient} agentAvailable={taskAgentAvailable} status={status} seed={searchSeed} writeEnabled={writeEnabled} onForget={forget} /> : <LayerDisabledPage title={t('overview.title')} />)}
          {page === 'entities' && renderSourceContribution(BUILTIN_MEMORY_SOURCE_PAGE_IDS.entities, memorySpacesLayerEnabled !== false ? <EntitiesPage client={client} revision={revision} writeEnabled={writeEnabled} onForget={forget} onExplore={explore} /> : <LayerDisabledPage title={t('overview.title')} />)}
          {page === 'remember' && appearance.surface === 'buildin' && renderSourceContribution(BUILTIN_MEMORY_SOURCE_PAGE_IDS.remember, memorySpacesLayerEnabled !== false ? <RememberPage client={taskClient} agentAvailable={taskAgentAvailable} memoryBodies={memoryBodies} writeEnabled={writeEnabled} seed={rememberSeed} onMutate={mutate} /> : <LayerDisabledPage title={t('overview.title')} />)}
          {page === 'list' && renderSourceContribution(BUILTIN_MEMORY_SOURCE_PAGE_IDS.list, memorySpacesLayerEnabled !== false ? <ListPage client={client} revision={revision} writeEnabled={writeEnabled} onForget={forget} onClone={clone} onExplore={explore} /> : <LayerDisabledPage title={t('overview.title')} />)}
          {page === 'status' && <StatusPage client={client} status={status} loading={statusLoading} writeEnabled={writeEnabled} onRefresh={() => void loadStatus()} />}
          {activeManagedSourceInstance !== undefined && managedSourcePageContent}
          {activeSourcePage !== undefined && customSourcePage}
        </section>
        {appearance.surface === 'sidebar' && memorySpacesLayerEnabled !== false && rememberOpen && <RememberPage client={taskClient} agentAvailable={taskAgentAvailable} memoryBodies={memoryBodies} writeEnabled={writeEnabled} seed={rememberSeed} onMutate={mutate} onClose={() => setRememberOpen(false)} onComplete={() => setRememberOpen(false)} />}
        {appearance.surface === 'sidebar' && memorySpacesLayerEnabled !== false && strategyOpen && <PersistenceStrategyDialog client={taskClient} settingsScope={settingsScope} config={settingsSnapshot.value} writable={settingsSnapshot.writable} agentAvailable={taskAgentAvailable} onClose={() => setStrategyOpen(false)} />}
      </div>
    </main>
  )
}
