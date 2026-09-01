import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryJsonValue } from '../core/contracts/index.ts'
import type { MemoryLocalizedText, MemoryStrategyConfigurationField } from '../sdk/strategy-configuration.ts'
import type { MemoryStrategyEntryView, MemoryStrategyPreference, MemoryViewConfigurationRequest, MemoryViewDashboard, MemoryViewInspection } from '../host/view-protocol.ts'
import type { MnemonClient } from './api.ts'
import { message, PageHeader, useLocale, useT } from './page-kit.tsx'
import type { MnemonTranslate } from './locales.ts'
import common from './MnemonView.module.css'
import css from './MemoryViewPage.module.css'

type Draft = Omit<MemoryViewConfigurationRequest, 'expectedRevision'>
type Source = MemoryViewDashboard['sources'][number]
const serialize = (value: unknown) => JSON.stringify(value)
const initial = (dashboard: MemoryViewDashboard): Draft => ({ strategyTypeId: dashboard.strategyTypeId,
  entries: Object.fromEntries(dashboard.entries.filter(entry => entry.writable).map(entry => [entry.entryId, { enabled: entry.enabled, config: structuredClone(entry.config) }])) })
const localized = (value: MemoryLocalizedText, locale: string) => locale.startsWith('zh') ? value['zh-CN'] : value.en
function sourceLabel(source: Source | undefined, key: string, t: MnemonTranslate): string {
  return source?.sourceTypeId === 'runtime' ? t('nav.runtime') : source?.sourceTypeId === 'documents' ? t('nav.documents')
    : source?.sourceTypeId === 'memory-spaces' ? t('nav.bodies') : source?.label ?? key
}
function sourceGlyph(source: Source | undefined): string {
  return source?.sourceTypeId === 'runtime' ? '◫' : source?.sourceTypeId === 'documents' ? '▤' : source?.sourceTypeId === 'memory-spaces' ? '◇' : '○'
}
function excerpt(value: string, maximum = 104): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maximum ? normalized.slice(0, maximum - 1) + '…' : normalized
}

function semanticItems(value: string, source: Source | undefined, t: MnemonTranslate, maximum = 3): string[] {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (source?.sourceTypeId === 'documents') {
    const match = normalized.match(/(\d+)\s+active project Documents/i)
    if (match?.[1]) return [t('view.documentsAvailable', { count: match[1] })]
  }
  if (source?.sourceTypeId === 'memory-spaces') {
    const match = normalized.match(/(\d+)\s+active of\s+(\d+)\s+configured Memory Spaces/i)
    if (match?.[1] && match[2]) return [t('view.spacesAvailable', { active: match[1], total: match[2] })]
  }
  const candidates = value
    .replace(/\r/g, '')
    .replace(/<\/?runtime-memory-file[^>]*>/gi, '\n')
    .split(/\n+|\s+§\s+/)
    .map(item => item.replace(/^[\s#>*-]+/, '').replace(/^“|”$/g, '').trim())
    .filter(item => item.length > 2
      && !/^MNEMON RUNTIME MEMORY SNAPSHOT(?:\s+Revision:.*)?$/i.test(item)
      && !/^Revision:\s*\S+$/i.test(item)
      && !/^Contents of\s+.+\(.*\)$/i.test(item))
    .map(item => excerpt(item, 92))
  return [...new Set(candidates)].slice(0, maximum)
}

function StringList(props: { value: MemoryJsonValue; label: string; disabled: boolean; onChange(value: MemoryJsonValue): void }): JSX.Element {
  const serial = serialize(props.value)
  const [draft, setDraft] = useState({ serial, text: Array.isArray(props.value) ? props.value.join('\n') : '' })
  return <textarea aria-label={props.label} disabled={props.disabled} value={draft.serial === serial ? draft.text : Array.isArray(props.value) ? props.value.join('\n') : ''} onChange={event => {
    const text = event.target.value
    const values = text.split('\n').map(value => value.trim()).filter(Boolean)
    setDraft({ serial: serialize(values), text })
    props.onChange(values)
  }} />
}

function ConfigurationField({ field, config, sources, disabled, onChange }: {
  field: MemoryStrategyConfigurationField; config: Record<string, MemoryJsonValue>; sources: Source[]; disabled: boolean
  onChange(key: string, value: MemoryJsonValue | undefined): void
}): JSX.Element {
  const t = useT(), locale = useLocale()
  const label = localized(field.label, locale)
  const inherited = !Object.hasOwn(config, field.key)
  const value = config[field.key] ?? field.defaultValue ?? (field.input.endsWith('list') ? [] : '')
  const choices = sources.filter(source => !field.sourceRoles || field.sourceRoles.includes(source.role))
  const selected = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  const list = [...selected, ...choices.map(source => source.sourceInstanceKey).filter(key => !selected.includes(key))]
  const move = (key: string, offset: number) => {
    const values = [...selected], index = values.indexOf(key)
    if (index < 0 || index + offset < 0 || index + offset >= values.length) return
    ;[values[index], values[index + offset]] = [values[index + offset]!, values[index]!]
    onChange(field.key, values)
  }
  return <div className={css.field}>
    <span className={css.fieldLabel}>{label}</span>
    {field.description && <p className={css.caption}>{localized(field.description, locale)}</p>}
    <label className={css.check}><input type="checkbox" checked={inherited} disabled={disabled} aria-label={`${label} · ${t('view.defaultValue')}`} onChange={event => onChange(field.key, event.target.checked ? undefined : structuredClone(field.defaultValue ?? (field.input.endsWith('list') ? [] : '')))} />{t('view.defaultValue')}</label>
    {field.input === 'source-list' ? inherited ? <p className={css.caption}>{t('view.defaultSources')}</p> : <div className={css.sourceList}>
      {selected.length === 0 && <p className={css.caption}>{t('view.emptySelection')}</p>}
      {list.map(key => {
        const source = sources.find(source => source.sourceInstanceKey === key), name = sourceLabel(source, key, t)
        const index = selected.indexOf(key)
        return <div className={css.source} key={key}><label className={css.check}><input type="checkbox" checked={index >= 0} disabled={disabled} aria-label={`${label} · ${name}`} onChange={event => onChange(field.key, event.target.checked ? [...selected, key] : selected.filter(item => item !== key))} /><span>{name}<small>{key}{source === undefined ? ' · ' + t('view.sourceUnavailable') : ''}</small></span></label>
          {index >= 0 && <div className={css.reorder}><button type="button" disabled={disabled || index === 0} aria-label={t('view.moveUp', { name })} onClick={() => move(key, -1)}>↑</button><button type="button" disabled={disabled || index === selected.length - 1} aria-label={t('view.moveDown', { name })} onClick={() => move(key, 1)}>↓</button></div>}
        </div>
      })}
    </div> : field.input === 'string-list' ? <><StringList value={value} label={label} disabled={disabled || inherited} onChange={value => onChange(field.key, value)} /><p className={css.caption}>{t('view.listHint')}</p></>
      : field.input === 'textarea' ? <textarea aria-label={label} value={typeof value === 'string' ? value : ''} maxLength={field.maximum ?? 4000} disabled={disabled || inherited} onChange={event => onChange(field.key, event.target.value)} />
        : <input aria-label={label} type={field.input === 'number' ? 'number' : 'text'} value={typeof value === 'string' || typeof value === 'number' ? value : ''} min={field.minimum} max={field.maximum} step={field.input === 'number' ? 1 : undefined} required={field.input === 'number' && !inherited} disabled={disabled || inherited} onChange={event => onChange(field.key, field.input === 'number' ? event.target.value === '' ? null : Number(event.target.value) : event.target.value)} />}
  </div>
}

function StrategyCard({ entry, preference, sources, disabled, selectedStrategy, onChange }: {
  entry: MemoryStrategyEntryView; preference: MemoryStrategyPreference; sources: Source[]; disabled: boolean; selectedStrategy: string
  onChange(value: MemoryStrategyPreference): void
}): JSX.Element {
  const t = useT(), locale = useLocale()
  return <section className={css.strategy} aria-label={localized(entry.label, locale)}>
    <div className={css.strategyBody}>
      <div className={css.strategyTop}><strong>{localized(entry.label, locale)}</strong>{entry.kind === 'strategy-extension' && <button type="button" role="switch" aria-label={localized(entry.label, locale)} aria-checked={preference.enabled} className={css.switch} disabled={disabled || !entry.writable} onClick={() => onChange({ ...preference, enabled: !preference.enabled })} />}</div>
      <span className={css.package}>{entry.packageName}</span>
      <p className={css.caption}>{localized(entry.description, locale)}</p>
      {entry.kind === 'strategy-extension' && preference.enabled && entry.strategyTypeId !== selectedStrategy && <p className={css.caption}>{t('view.otherStrategy', { strategy: entry.strategyTypeId })}</p>}
      {entry.enabled && !entry.active && <p className={css.caption}>{t('view.notReady')}</p>}
      {entry.diagnostic && <p className={css.caption}>{entry.diagnostic}</p>}
    </div>
    {entry.fields.length > 0 && <details className={css.details}><summary>{t('view.configure')}</summary><div className={css.detailsBody}>
      {entry.fields.map(field => <ConfigurationField key={field.key} field={field} config={preference.config} sources={sources} disabled={disabled || !entry.writable} onChange={(key, value) => {
        const config = { ...preference.config }
        if (value === undefined) delete config[key]
        else config[key] = value
        onChange({ ...preference, config })
      }} />)}
    </div></details>}
  </section>
}

function Snapshot({ view, dashboard }: { view: MemoryViewInspection; dashboard: MemoryViewDashboard }): JSX.Element {
  const t = useT(), locale = useLocale()
  const number = (value: number) => new Intl.NumberFormat(locale).format(value)
  const text = (value: string) => <pre className={css.text}>{value || t('view.emptyText')}</pre>
  const sourceKeys = [...new Set([
    ...dashboard.sources.map(source => source.sourceInstanceKey),
    ...view.projection.map(fragment => fragment.sourceInstanceKey),
    ...view.routes.map(route => route.sourceInstanceKey),
    ...view.actions.map(action => action.sourceInstanceKey),
  ])]
  const groups = sourceKeys.map(key => ({
    key,
    source: dashboard.sources.find(source => source.sourceInstanceKey === key),
    fragments: view.projection.filter(fragment => fragment.sourceInstanceKey === key),
    routes: view.routes.filter(route => route.sourceInstanceKey === key),
    actions: view.actions.filter(action => action.sourceInstanceKey === key),
  })).filter(group => group.fragments.length + group.routes.length + group.actions.length > 0)
  const [selection, setSelection] = useState<string | null>(null)
  const selectedFragment = view.projection.find(fragment => selection === `fragment:${fragment.id}`)
  const selectedSourceKey = selectedFragment?.sourceInstanceKey ?? groups.find(group => selection === `source:${group.key}`)?.key
  const selectedGroup = groups.find(group => group.key === selectedSourceKey)
  const selectedSourceName = selectedGroup ? sourceLabel(selectedGroup.source, selectedGroup.key, t) : t('view.overview')
  const selectedContent = selectedGroup?.fragments.filter(fragment => fragment.mode === 'eager') ?? []
  const selectionExists = selection === null || selectedFragment !== undefined || selectedGroup !== undefined
  useEffect(() => { if (!selectionExists) setSelection(null) }, [selectionExists])
  const select = (key: string) => ({ 'aria-pressed': selection === key, onClick: () => setSelection(key) } as const)
  const injected = groups.map(group => ({ ...group, visibleFragments: group.fragments.filter(fragment => fragment.mode === 'eager') }))
    .filter(group => group.visibleFragments.length > 0)
  const available = groups.map(group => ({ ...group, visibleFragments: group.fragments.filter(fragment => fragment.mode !== 'eager') }))
    .filter(group => group.visibleFragments.length > 0 || group.routes.length > 0)
  const writeOnly = groups.filter(group => group.actions.length > 0
    && !injected.some(item => item.key === group.key) && !available.some(item => item.key === group.key))
  const items = (group: typeof injected[number] | typeof available[number]): string[] => [...new Set(group.visibleFragments
    .flatMap(fragment => semanticItems(fragment.text, group.source, t, 2)))].slice(0, 3)
  const selectedKind = selectedFragment ? t('view.injected') : t('view.source')
  const selectedTitle = selectedSourceName
  const characters = view.projection.reduce((sum, fragment) => sum + fragment.text.length, 0)
  return <>
    <div className={css.snapshotLayout} data-inspector-open={selection === null ? undefined : ''}>
      <div className={css.snapshotStage}>
        <section className={css.turnFocus} aria-label={t('view.snapshot')}>
          <div className={css.turnIdentity}><span className={`${css.badge} ${view.state === 'active' ? css.positive : ''}`}>{t(view.state === 'preview' ? 'view.previewBadge' : view.state === 'active' ? 'view.active' : 'view.recent')}</span>
            <h3>{view.turn === undefined ? view.strategyTypeId : t('view.turn', { turn: view.turn })}</h3><span>{view.strategyTypeId}</span>
            {view.extensions.map(extension => <span key={extension.instanceKey}>{extension.typeId}</span>)}
          </div>
          <div className={css.metrics} aria-label={t('view.snapshotMetrics')}><strong>{t('view.characters', { count: number(characters) })}</strong><span aria-label={t('view.routesCount', { count: view.routes.length })}><i aria-hidden="true">↙</i>{number(view.routes.length)}</span><span aria-label={t('view.actionsCount', { count: view.actions.length })}><i aria-hidden="true">↗</i>{number(view.actions.length)}</span></div>
        </section>

        <div className={css.semanticCanvas}>
          <section className={css.canvasBand} aria-label={t('view.injected')}>
            <header className={css.bandHeader}><h3>{t('view.injected')}</h3><span>{injected.length}</span></header>
            {injected.length === 0 ? <p className={css.layerEmpty}>{t('view.injectedEmpty')}</p> : <div className={css.nodeGrid}>
              {injected.map(group => {
                const summaries = items(group)
                const count = group.visibleFragments.reduce((sum, fragment) => sum + fragment.text.length, 0)
                return <button key={group.key} type="button" className={css.canvasNode} data-source-type={group.source?.sourceTypeId ?? 'other'} {...select(`source:${group.key}`)}>
                  <span className={css.nodeTop}><i aria-hidden="true">{sourceGlyph(group.source)}</i><strong>{sourceLabel(group.source, group.key, t)}</strong><span className={css.nodeSignals}>{group.actions.length > 0 && <span aria-label={t('view.actionsCount', { count: group.actions.length })}><b aria-hidden="true">↗</b>{number(group.actions.length)}</span>}</span></span>
                  <span className={css.semanticList}>{summaries.map(value => <span key={value}>{value}</span>)}</span>
                  <span className={css.nodeFoot}>{t('view.characters', { count: number(count) })}{group.visibleFragments.length > 1 && <em>+{number(group.visibleFragments.length - 1)}</em>}</span>
                </button>
              })}
            </div>}
          </section>

          <section className={`${css.canvasBand} ${css.availableBand}`} aria-label={t('view.available')}>
            <header className={css.bandHeader}><h3>{t('view.available')}</h3><span>{available.length}</span></header>
            {available.length === 0 ? <p className={css.layerEmpty}>{t('view.availableEmpty')}</p> : <div className={css.nodeGrid}>
              {available.map(group => {
                const summaries = items(group)
                const operations = group.routes.map(route => route.operationId)
                return <button key={group.key} type="button" className={`${css.canvasNode} ${css.availableNode}`} data-source-type={group.source?.sourceTypeId ?? 'other'} {...select(`source:${group.key}`)}>
                  <span className={css.nodeTop}><i aria-hidden="true">{sourceGlyph(group.source)}</i><strong>{sourceLabel(group.source, group.key, t)}</strong><span className={css.nodeSignals}>{group.routes.length > 0 && <span aria-label={t('view.routesCount', { count: group.routes.length })}><b aria-hidden="true">↙</b>{number(group.routes.length)}</span>}{group.actions.length > 0 && <span aria-label={t('view.actionsCount', { count: group.actions.length })}><b aria-hidden="true">↗</b>{number(group.actions.length)}</span>}</span></span>
                  {summaries.length > 0 && <span className={css.semanticList}>{summaries.map(value => <span key={value}>{value}</span>)}</span>}
                  <span className={css.operationChips}>{operations.slice(0, 3).map(operation => <code key={operation}>{operation}</code>)}{operations.length > 3 && <em>+{number(operations.length - 3)}</em>}</span>
                </button>
              })}
            </div>}
          </section>

          {writeOnly.length > 0 && <div className={css.writeTargets}><span>{t('view.writeTargets')}</span>{writeOnly.map(group => <button type="button" key={group.key} data-source-type={group.source?.sourceTypeId ?? 'other'} {...select(`source:${group.key}`)}><i aria-hidden="true">{sourceGlyph(group.source)}</i>{sourceLabel(group.source, group.key, t)}<b aria-hidden="true">↗</b>{number(group.actions.length)}</button>)}</div>}
        </div>
      </div>

      {selection !== null && <aside className={css.inspector} aria-label={t('view.details')}>
        <header className={css.inspectorHeader}><div><span>{selectedKind}</span><h3>{selectedTitle}</h3></div><button type="button" className={css.closePanel} aria-label={t('view.closeDetails')} onClick={() => setSelection(null)}>×</button></header>
        <div className={css.inspectorBody}>
          {selectedFragment && text(selectedFragment.text)}
          {selectedGroup && <><div className={css.relatedCounts}><span>{t('view.injectedFragments', { count: selectedContent.length })}</span><span>{t('view.routesCount', { count: selectedGroup.routes.length })}</span><span>{t('view.actionsCount', { count: selectedGroup.actions.length })}</span></div>
            <div className={css.detailCapabilities}>
              {selectedGroup.routes.length > 0 && <div aria-label={t('view.reads')}><b aria-hidden="true">↙</b><span className={css.operationChips}>{selectedGroup.routes.slice(0, 3).map(route => <code key={route.id}>{route.operationId}</code>)}{selectedGroup.routes.length > 3 && <em>+{number(selectedGroup.routes.length - 3)}</em>}</span></div>}
              {selectedGroup.actions.length > 0 && <div aria-label={t('view.writes')}><b aria-hidden="true">↗</b><span className={css.operationChips}>{selectedGroup.actions.slice(0, 3).map(action => <code key={action.id}>{action.operationId}</code>)}{selectedGroup.actions.length > 3 && <em>+{number(selectedGroup.actions.length - 3)}</em>}</span></div>}
            </div>
            {!selectedFragment && selectedContent.length > 0 && <section className={css.related}><h4>{t('view.currentContent')}</h4>{selectedContent.map(value => <button type="button" key={value.id} {...select(`fragment:${value.id}`)}><span aria-hidden="true">●</span>{excerpt(value.text, 78) || t('view.emptyText')}</button>)}</section>}
          </>}
        </div>
      </aside>}
    </div>
    {view.guidance && <details className={css.details}><summary>{t('view.guidance')}</summary><div className={css.detailsBody}><p className={css.caption}>{t('view.guidanceHint')}</p>
      {([['view.systemGuidance', view.guidance.system], ['view.bothReminder', view.guidance.reminders?.both], ['view.readReminder', view.guidance.reminders?.read], ['view.writeReminder', view.guidance.reminders?.write]] as const).map(([label, value]) => value ? <section key={label}><h4 className={css.heading}>{t(label)}</h4>{text(value)}</section> : null)}
    </div></details>}
    <details className={css.details}><summary>{t('view.raw')}</summary><div className={css.detailsBody}><p className={css.caption}>{t('view.rawHint')}</p>{text(view.memoryText)}</div></details>
    <details className={css.details}><summary>{t('view.identities')}</summary><div className={`${css.detailsBody} ${css.identity}`}><code>{view.id}</code><code>{view.digest}</code><code>{view.generationId}</code><code>{view.strategyInstanceKey}</code></div></details>
    {view.diagnostics.length > 0 && <details className={css.details} open><summary>{t('view.diagnostics')}</summary><div className={css.detailsBody}>{view.diagnostics.map((value, index) => <p className={css.caption} key={index}>{value}</p>)}</div></details>}
  </>
}

/** A human management surface. It never runs a model or invokes a View Action. */
export function MemoryViewPage({ client, active = true, canConfigure = true, refreshKey = 0, onConfigured }: {
  client: Pick<MnemonClient, 'viewDashboard' | 'previewView' | 'applyView'>; active?: boolean; canConfigure?: boolean; refreshKey?: number; onConfigured?(): void
}): JSX.Element {
  const t = useT()
  const [dashboard, setDashboard] = useState<MemoryViewDashboard | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [mode, setMode] = useState<'current' | 'preview'>('current')
  const [preview, setPreview] = useState<MemoryViewInspection | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<'preview' | 'apply' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [stale, setStale] = useState(false)
  const [strategyOpen, setStrategyOpen] = useState(false)
  const version = useRef(0), form = useRef<HTMLFormElement>(null)
  const latest = useRef({ dashboard, draft })
  latest.current = { dashboard, draft }
  const refresh = useCallback(async (discard = false) => {
    const request = ++version.current
    setLoading(true)
    setWorking(null)
    try {
      const next = await client.viewDashboard()
      if (request !== version.current) return
      const previous = latest.current
      const dirty = previous.dashboard && previous.draft && serialize(previous.draft) !== serialize(initial(previous.dashboard))
      if (dirty && !discard) {
        setStale(next.revision !== previous.dashboard!.revision)
        setDashboard({ ...previous.dashboard!, current: next.current, currentUnavailable: next.currentUnavailable } as MemoryViewDashboard)
      } else {
        setDashboard(next); setDraft(initial(next)); setStale(false); setError(null); setPreview(null)
      }
    } catch (reason) { if (request === version.current) setError(message(reason)) }
    finally { if (request === version.current) setLoading(false) }
  }, [client])
  useEffect(() => { if (active) void refresh() }, [active, refresh, refreshKey])
  useEffect(() => () => { version.current += 1 }, [client])
  const edit = (next: Draft) => { version.current += 1; setDraft(next); setPreview(null); setSaved(false); setError(null); setWorking(null); setLoading(false) }
  const dirty = dashboard !== null && draft !== null && serialize(draft) !== serialize(initial(dashboard))
  const readonly = !canConfigure || dashboard?.writable !== true
  const perform = async (operation: 'preview' | 'apply') => {
    if (!dashboard || !draft || !form.current?.reportValidity()) return
    const request = ++version.current
    setWorking(operation); setError(null); setSaved(false)
    if (operation === 'preview') { setMode('preview'); setPreview(null) }
    const configuration: MemoryViewConfigurationRequest = { ...draft, expectedRevision: dashboard.revision }
    try {
      if (operation === 'preview') {
        const result = await client.previewView(configuration)
        if (request === version.current) setPreview(result)
      } else {
        await client.applyView(configuration)
        if (request !== version.current) return
        const next = await client.viewDashboard()
        if (request !== version.current) return
        setDashboard(next); setDraft(initial(next)); setPreview(null); setMode('current'); setStale(false); setSaved(true)
        onConfigured?.()
      }
    } catch (reason) { if (request === version.current) setError(message(reason)) }
    finally { if (request === version.current) setWorking(null) }
  }
  const shown = mode === 'current' ? dashboard?.current : preview
  const bases = dashboard?.entries.filter(entry => entry.kind === 'strategy') ?? []
  const selected = bases.find(entry => entry.typeId === draft?.strategyTypeId)
  const additions = dashboard?.entries.filter(entry => entry.kind === 'strategy-extension') ?? []
  const busy = loading || working !== null
  const card = (entry: MemoryStrategyEntryView) => <StrategyCard key={entry.entryId} entry={entry} preference={draft?.entries[entry.entryId] ?? { enabled: entry.enabled, config: entry.config }} sources={dashboard!.sources} disabled={readonly || busy} selectedStrategy={draft!.strategyTypeId} onChange={value => edit({ ...draft!, entries: { ...draft!.entries, [entry.entryId]: value } })} />
  return <div className={`${common.page} ${css.page}`}>
    <PageHeader title={t('view.title')} description={t('view.description')} {...(loading ? { loadingLabel: t('common.loading') } : {})} action={<div className={css.pageActions}><button type="button" className={common.secondaryButton} aria-expanded={strategyOpen} onClick={() => setStrategyOpen(value => !value)}>{t(strategyOpen ? 'view.closeStrategies' : 'view.openStrategies')}</button><button type="button" className={common.ghostButton} disabled={busy} onClick={() => void refresh()}>{t('view.refresh')}</button></div>} />
    {error && <div className={common.inlineError} role="alert">{error}</div>}
    {saved && <p className={css.notice} role="status">{t('view.saved')}</p>}
    {stale && <p className={css.notice} role="alert">{t('view.externalChange')}</p>}
    {dashboard?.diagnostics.map((value, index) => <p key={index} className={css.notice} role="status">{value}</p>)}
    <div className={css.layout} data-editor-open={strategyOpen ? '' : undefined}>
      <section className={css.panel} aria-label={t('view.current')}>
        <header className={css.panelHeader}><div className={css.segmented} role="tablist" aria-label={t('view.inspectTabs')}><button type="button" role="tab" aria-selected={mode === 'current'} onClick={() => setMode('current')}>{t('view.current')}</button><button type="button" role="tab" aria-selected={mode === 'preview'} onClick={() => setMode('preview')}>{t('view.preview')}</button></div></header>
        {shown && dashboard ? <Snapshot key={`${shown.id}:${shown.digest}`} view={shown} dashboard={dashboard} /> : <div className={css.content}><div className={css.empty}><h3>{t(mode === 'preview' ? 'view.previewEmpty' : 'view.emptyTitle')}</h3><p className={css.caption}>{t(mode === 'preview' ? 'view.previewHint' : dashboard?.currentUnavailable === 'unaligned' ? 'view.unaligned' : dashboard?.currentUnavailable === 'no-session' ? 'view.noSession' : 'view.notGenerated')}</p>{mode === 'preview' && <button type="button" className={common.secondaryButton} disabled={busy || !draft || stale} onClick={() => void perform('preview')}>{t(working === 'preview' ? 'view.previewing' : 'view.previewAction')}</button>}</div></div>}
      </section>
      <form ref={form} hidden={!strategyOpen} className={`${css.panel} ${css.strategyPanel}`} aria-label={t('view.strategies')} onSubmit={event => { event.preventDefault(); if (!readonly && dirty && !busy && !stale) void perform('apply') }}>
        <header className={css.panelHeader}><h3>{t('view.strategies')}</h3><div className={css.panelHeaderActions}>{dirty && <span className={`${css.badge} ${css.draft}`}>{t('view.draft')}</span>}<button type="button" className={css.closePanel} aria-label={t('view.closeStrategies')} onClick={() => setStrategyOpen(false)}>×</button></div></header>
        <div className={`${css.content} ${css.editor}`}><p className={css.caption}>{t('view.profileHint')}</p>
          {readonly && <p className={css.caption}>{t('view.readOnly')}</p>}
          <h4 className={css.heading}>{t('view.base')}</h4>
          {bases.length > 1 && draft && <select className={css.select} aria-label={t('view.baseSelect')} disabled={readonly || busy} value={draft.strategyTypeId} onChange={event => {
            const base = bases.find(entry => entry.typeId === event.target.value)
            edit({ ...draft, strategyTypeId: event.target.value, entries: base?.writable ? { ...draft.entries, [base.entryId]: { enabled: true, config: draft.entries[base.entryId]?.config ?? base.config } } : draft.entries })
          }}>{bases.map(entry => <option key={entry.entryId} value={entry.typeId}>{entry.typeId}</option>)}</select>}
          {selected && draft && card(selected)}
          <h4 className={css.heading}>{t('view.extensions')}</h4><p className={css.caption}>{t('view.extensionsHint')}</p>
          {additions.length === 0 ? <p className={css.caption}>{t('view.noExtensions')}</p> : additions.map(card)}
        </div>
        <footer className={css.footer}><div className={css.buttons}><button type="button" className={common.secondaryButton} disabled={busy || !draft || stale} onClick={() => void perform('preview')}>{t(working === 'preview' ? 'view.previewing' : 'view.previewAction')}</button><button type="submit" className={common.primaryButton} disabled={readonly || busy || !dirty || stale}>{t(working === 'apply' ? 'view.saving' : 'view.apply')}</button></div>
          {dirty ? <button type="button" className={common.ghostButton} disabled={busy} onClick={() => { setSaved(false); void refresh(true) }}>{t('view.reset')}</button> : <p className={css.caption}>{t('view.unchanged')}</p>}
        </footer>
      </form>
    </div>
  </div>
}
