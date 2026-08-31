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
  return <>
    <div className={css.content}>
      <div className={css.meta}><span className={`${css.badge} ${view.state === 'active' ? css.positive : ''}`}>{t(view.state === 'preview' ? 'view.previewBadge' : view.state === 'active' ? 'view.active' : 'view.recent')}</span>{view.turn !== undefined && <span>{t('view.turn', { turn: view.turn })}</span>}<time dateTime={view.createdAt}>{new Date(view.createdAt).toLocaleString(locale)}</time></div>
      <div className={css.metrics}><strong>{t('view.characters', { count: number(view.projection.reduce((sum, fragment) => sum + fragment.text.length, 0)) })}</strong><span>{t('view.fragments', { count: view.projection.length })}</span><span>{t('view.routesCount', { count: view.routes.length })}</span><span>{t('view.actionsCount', { count: view.actions.length })}</span></div>
      <div className={css.meta}><span className={css.badge}>{view.strategyTypeId}</span>{view.extensions.map(extension => <span key={extension.instanceKey} className={css.badge}>{extension.typeId}</span>)}</div>
      <h4 className={css.heading}>{t('view.projection')}</h4>
      {view.projection.length === 0 && <p className={css.caption}>{t('view.emptyProjection')}</p>}
      {view.projection.map(fragment => <section key={fragment.id} className={css.fragment}>
        <header className={css.fragmentHeader}><strong>{sourceLabel(dashboard.sources.find(source => source.sourceInstanceKey === fragment.sourceInstanceKey), fragment.sourceInstanceKey, t)}</strong><div className={css.meta}><span>{t(fragment.mode === 'eager' ? 'view.eager' : 'view.routed')}</span><span>{t('view.characters', { count: number(fragment.text.length) })}</span></div></header>
        {text(fragment.text)}
      </section>)}
    </div>
    <details className={css.details}><summary>{t('view.operations')} <span>{view.routes.length + view.actions.length}</span></summary><div className={css.detailsBody}>
      {([['view.reads', view.routes], ['view.writes', view.actions]] as const).map(([label, values]) => <div className={css.operations} key={label}><h4 className={css.heading}>{t(label)}</h4>{values.length === 0 ? <p className={css.caption}>{t('view.noOperations')}</p> : values.map(value => <div className={css.operation} key={value.id}><code>{value.sourceInstanceKey} / {value.operationId}</code><p>{value.description}</p></div>)}</div>)}
    </div></details>
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
    <PageHeader title={t('view.title')} description={t('view.description')} {...(loading ? { loadingLabel: t('common.loading') } : {})} action={<button type="button" className={common.secondaryButton} disabled={busy} onClick={() => void refresh()}>{t('view.refresh')}</button>} />
    {error && <div className={common.inlineError} role="alert">{error}</div>}
    {saved && <p className={css.notice} role="status">{t('view.saved')}</p>}
    {stale && <p className={css.notice} role="alert">{t('view.externalChange')}</p>}
    {dashboard?.diagnostics.map((value, index) => <p key={index} className={css.notice} role="status">{value}</p>)}
    <div className={css.layout}>
      <section className={css.panel} aria-label={t('view.current')}>
        <header className={css.panelHeader}><div className={css.segmented} role="tablist" aria-label={t('view.inspectTabs')}><button type="button" role="tab" aria-selected={mode === 'current'} onClick={() => setMode('current')}>{t('view.current')}</button><button type="button" role="tab" aria-selected={mode === 'preview'} onClick={() => setMode('preview')}>{t('view.preview')}</button></div></header>
        {shown && dashboard ? <Snapshot view={shown} dashboard={dashboard} /> : <div className={css.content}><div className={css.empty}><h3>{t(mode === 'preview' ? 'view.previewEmpty' : 'view.emptyTitle')}</h3><p className={css.caption}>{t(mode === 'preview' ? 'view.previewHint' : dashboard?.currentUnavailable === 'unaligned' ? 'view.unaligned' : dashboard?.currentUnavailable === 'no-session' ? 'view.noSession' : 'view.notGenerated')}</p>{mode === 'preview' && <button type="button" className={common.secondaryButton} disabled={busy || !draft || stale} onClick={() => void perform('preview')}>{t(working === 'preview' ? 'view.previewing' : 'view.previewAction')}</button>}</div></div>}
      </section>
      <form ref={form} className={css.panel} aria-label={t('view.strategies')} onSubmit={event => { event.preventDefault(); if (!readonly && dirty && !busy && !stale) void perform('apply') }}>
        <header className={css.panelHeader}><h3>{t('view.strategies')}</h3>{dirty && <span className={`${css.badge} ${css.draft}`}>{t('view.draft')}</span>}</header>
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
