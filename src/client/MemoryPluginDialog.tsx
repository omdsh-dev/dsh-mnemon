import { useCallback, useId, useRef, useState, useEffect } from 'react'
import type { MemoryJsonValue } from '../core/contracts/index.ts'
import type { MemoryLocalizedText, MemoryStrategyConfigurationField } from '../sdk/strategy-configuration.ts'
import type { MemoryPluginInspection, MemoryStrategyEntryView, MemoryStrategyPreference, MemoryViewConfigurationRequest, MemoryViewDashboard } from '../host/view-protocol.ts'
import type { MnemonClient } from './api.ts'
import type { MnemonTranslate } from './locales.ts'
import { message, SidebarModal, useLocale, useT } from './page-kit.tsx'
import { appearanceClass } from './view-styles.ts'
import common from './MnemonView.module.css'
import css from './MemoryPluginDialog.module.css'

type Draft = Omit<MemoryViewConfigurationRequest, 'expectedRevision'>
type Source = MemoryViewDashboard['sources'][number]
type PluginClient = Pick<MnemonClient, 'viewDashboard' | 'applyView' | 'inspectMemoryPlugin' | 'installMemoryPlugin' | 'setSourceMemoryPluginEnabled'>

const serialize = (value: unknown): string => JSON.stringify(value)
const initial = (dashboard: MemoryViewDashboard): Draft => ({ strategyTypeId: dashboard.strategyTypeId,
  entries: Object.fromEntries(dashboard.entries.filter(entry => entry.writable).map(entry => [entry.entryId, { enabled: entry.enabled, config: structuredClone(entry.config) }])) })
const localized = (value: MemoryLocalizedText, locale: string): string => locale.startsWith('zh') ? value['zh-CN'] : value.en
function sourceLabel(source: Source | undefined, key: string, t: MnemonTranslate, packageName = source?.packageName): string {
  const typeId = source?.sourceTypeId ?? packageName?.split('/').at(-1)?.replace(/^dsh-mnemon-source-/u, '')
  if (typeId === 'runtime') return t('nav.runtime')
  if (typeId === 'documents') return t('nav.documents')
  if (typeId === 'memory-spaces') return t('nav.bodies')
  if (source?.label) return source.label
  return typeId?.split(/[._-]+/u).filter(Boolean).map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ') || key
}

function StringList(props: { value: MemoryJsonValue; label: string; disabled: boolean; onChange(value: MemoryJsonValue): void }): JSX.Element {
  const serial = serialize(props.value)
  const [draft, setDraft] = useState({ serial, text: Array.isArray(props.value) ? props.value.join('\n') : '' })
  return <textarea aria-label={props.label} disabled={props.disabled} value={draft.serial === serial ? draft.text : Array.isArray(props.value) ? props.value.join('\n') : ''} onChange={event => {
    const text = event.target.value
    const values = text.split('\n').map(value => value.trim()).filter(Boolean)
    setDraft({ serial: serialize(values), text }); props.onChange(values)
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
  const move = (key: string, offset: number): void => {
    const values = [...selected], index = values.indexOf(key)
    if (index < 0 || index + offset < 0 || index + offset >= values.length) return
    ;[values[index], values[index + offset]] = [values[index + offset]!, values[index]!]
    onChange(field.key, values)
  }
  return <div className={css.field}>
    <span className={css.fieldLabel}>{label}</span>
    {field.description && <p className={css.caption}>{localized(field.description, locale)}</p>}
    <label className={css.check}><input type="checkbox" checked={inherited} disabled={disabled} aria-label={`${label} · ${t('plugins.defaultValue')}`} onChange={event => onChange(field.key, event.target.checked ? undefined : structuredClone(field.defaultValue ?? (field.input.endsWith('list') ? [] : '')))} />{t('plugins.defaultValue')}</label>
    {field.input === 'source-list' ? inherited ? <p className={css.caption}>{t('plugins.defaultSources')}</p> : <div className={css.sourceList}>
      {selected.length === 0 && <p className={css.caption}>{t('plugins.emptySelection')}</p>}
      {list.map(key => {
        const source = sources.find(item => item.sourceInstanceKey === key), name = sourceLabel(source, key, t), index = selected.indexOf(key)
        return <div className={css.sourceChoice} key={key}><label className={css.check}><input type="checkbox" checked={index >= 0} disabled={disabled} aria-label={`${label} · ${name}`} onChange={event => onChange(field.key, event.target.checked ? [...selected, key] : selected.filter(item => item !== key))} /><span>{name}<small>{key}{source === undefined ? ' · ' + t('plugins.sourceUnavailable') : ''}</small></span></label>
          {index >= 0 && <div className={css.reorder}><button type="button" disabled={disabled || index === 0} aria-label={t('plugins.moveUp', { name })} onClick={() => move(key, -1)}>↑</button><button type="button" disabled={disabled || index === selected.length - 1} aria-label={t('plugins.moveDown', { name })} onClick={() => move(key, 1)}>↓</button></div>}
        </div>
      })}
    </div> : field.input === 'string-list' ? <><StringList value={value} label={label} disabled={disabled || inherited} onChange={value => onChange(field.key, value)} /><p className={css.caption}>{t('plugins.listHint')}</p></>
      : field.input === 'textarea' ? <textarea aria-label={label} value={typeof value === 'string' ? value : ''} maxLength={field.maximum ?? 4000} disabled={disabled || inherited} onChange={event => onChange(field.key, event.target.value)} />
        : <input aria-label={label} type={field.input === 'number' ? 'number' : 'text'} value={typeof value === 'string' || typeof value === 'number' ? value : ''} min={field.minimum} max={field.maximum} step={field.input === 'number' ? 1 : undefined} required={field.input === 'number' && !inherited} disabled={disabled || inherited} onChange={event => onChange(field.key, field.input === 'number' ? event.target.value === '' ? null : Number(event.target.value) : event.target.value)} />}
  </div>
}

function StrategyCard({ entry, preference, sources, disabled, selectedStrategy, onChange }: {
  entry: MemoryStrategyEntryView; preference: MemoryStrategyPreference; sources: Source[]; disabled: boolean; selectedStrategy: string
  onChange(value: MemoryStrategyPreference): void
}): JSX.Element {
  const t = useT(), locale = useLocale()
  return <section className={css.pluginCard} aria-label={localized(entry.label, locale)}>
    <div className={css.cardBody}>
      <div className={css.cardTop}><div><strong>{localized(entry.label, locale)}</strong><code>{entry.packageName}</code></div>{entry.kind === 'strategy-extension' && <button type="button" role="switch" aria-label={localized(entry.label, locale)} aria-checked={preference.enabled} className={css.switch} disabled={disabled || !entry.writable} onClick={() => onChange({ ...preference, enabled: !preference.enabled })} />}</div>
      <p className={css.caption}>{localized(entry.description, locale)}</p>
      <div className={css.statusLine}><span data-active={entry.active || undefined}>{entry.active ? t('plugins.running') : entry.enabled ? t('plugins.notReady') : t('plugins.registered')}</span>{entry.kind === 'strategy-extension' && <span>{preference.enabled ? t('plugins.enabled') : t('plugins.disabled')}</span>}</div>
      {entry.kind === 'strategy-extension' && preference.enabled && entry.strategyTypeId !== selectedStrategy && <p className={css.caption}>{t('plugins.otherStrategy', { strategy: entry.strategyTypeId })}</p>}
      {entry.diagnostic && <p className={css.caption}>{entry.diagnostic}</p>}
    </div>
    {entry.fields.length > 0 && <details className={css.details}><summary>{t('plugins.configure')}</summary><div className={css.detailsBody}>{entry.fields.map(field => <ConfigurationField key={field.key} field={field} config={preference.config} sources={sources} disabled={disabled || !entry.writable} onChange={(key, value) => {
      const config = { ...preference.config }; if (value === undefined) delete config[key]; else config[key] = value
      onChange({ ...preference, config })
    }} />)}</div></details>}
  </section>
}

export function MemoryPluginDialog({ client, canConfigure, refreshKey = 0, onConfigured, onClose }: {
  client: PluginClient; canConfigure: boolean; refreshKey?: number; onConfigured?(): void; onClose(): void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const formId = useId()
  const [section, setSection] = useState<'composition' | 'discover'>('composition')
  const [dashboard, setDashboard] = useState<MemoryViewDashboard | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<'apply' | 'source' | 'inspect' | 'install' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [stale, setStale] = useState(false)
  const [packageName, setPackageName] = useState('')
  const [inspection, setInspection] = useState<MemoryPluginInspection | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [installed, setInstalled] = useState(false)
  const version = useRef(0), latest = useRef({ dashboard, draft })
  latest.current = { dashboard, draft }
  const refresh = useCallback(async (discard = false) => {
    const request = ++version.current; setLoading(true)
    try {
      const next = await client.viewDashboard()
      if (request !== version.current) return
      const previous = latest.current
      const dirty = previous.dashboard !== null && previous.draft !== null && serialize(previous.draft) !== serialize(initial(previous.dashboard))
      if (dirty && !discard) { setStale(next.revision !== previous.dashboard!.revision); setDashboard({ ...previous.dashboard!, registeredPlugins: next.registeredPlugins, pluginInstallation: next.pluginInstallation }) }
      else { setDashboard(next); setDraft(initial(next)); setStale(false); setError(null) }
    } catch (reason) { if (request === version.current) setError(message(reason)) }
    finally { if (request === version.current) setLoading(false) }
  }, [client])
  useEffect(() => { void refresh() }, [refresh, refreshKey])
  useEffect(() => () => { version.current += 1 }, [])
  const edit = (next: Draft): void => { setDraft(next); setSaved(false); setError(null) }
  const dirty = dashboard !== null && draft !== null && serialize(draft) !== serialize(initial(dashboard))
  const readonly = !canConfigure || dashboard?.writable !== true
  const bases = dashboard?.entries.filter(entry => entry.kind === 'strategy') ?? []
  const selected = bases.find(entry => entry.typeId === draft?.strategyTypeId)
  const additions = dashboard?.entries.filter(entry => entry.kind === 'strategy-extension') ?? []
  const strategyActive = dashboard?.entries.filter(entry => entry.enabled).length ?? 0
  const registeredSources = dashboard?.registeredPlugins.filter(entry => entry.kind === 'source') ?? []
  const activeSourcePackages = [...new Set(dashboard?.sources.map(source => source.packageName) ?? [])]
  const sourceRows = [...registeredSources, ...activeSourcePackages.filter(name => !registeredSources.some(entry => entry.packageName === name)).map(packageName => ({ entryId: packageName, packageName, kind: 'source' as const, enabled: true, active: true, writable: false }))]
  const busy = loading || working !== null
  const apply = async (): Promise<void> => {
    if (dashboard === null || draft === null || readonly || !dirty || stale) return
    const request = ++version.current; setWorking('apply'); setError(null); setSaved(false)
    try {
      await client.applyView({ ...draft, expectedRevision: dashboard.revision })
      if (request !== version.current) return
      const next = await client.viewDashboard()
      if (request !== version.current) return
      setDashboard(next); setDraft(initial(next)); setStale(false); setSaved(true); onConfigured?.()
    } catch (reason) { if (request === version.current) setError(message(reason)) }
    finally { if (request === version.current) setWorking(null) }
  }
  const toggleSource = async (entryId: string, enabled: boolean): Promise<void> => {
    setWorking('source'); setError(null)
    try { await client.setSourceMemoryPluginEnabled(entryId, enabled); await refresh(true); onConfigured?.() }
    catch (reason) { setError(message(reason)) }
    finally { setWorking(null) }
  }
  const inspect = async (name = packageName): Promise<void> => {
    const normalized = name.trim(); if (normalized === '') return
    setPackageName(normalized); setWorking('inspect'); setError(null); setInspection(null); setConfirming(false); setInstalled(false)
    try { setInspection(await client.inspectMemoryPlugin(normalized)) } catch (reason) { setError(message(reason)) }
    finally { setWorking(null) }
  }
  const install = async (): Promise<void> => {
    if (inspection === null) return
    setWorking('install'); setError(null)
    try { await client.installMemoryPlugin(inspection.packageName, inspection.version); setInstalled(true); setConfirming(false) }
    catch (reason) { setError(message(reason)) }
    finally { setWorking(null) }
  }
  const card = (entry: MemoryStrategyEntryView) => <StrategyCard key={entry.entryId} entry={entry} preference={draft?.entries[entry.entryId] ?? { enabled: entry.enabled, config: entry.config }} sources={dashboard!.sources} disabled={readonly || busy} selectedStrategy={draft!.strategyTypeId} onChange={value => edit({ ...draft!, entries: { ...draft!.entries, [entry.entryId]: value } })} />
  const footer = <><span className={appearanceClass(common.modalFooterMeta, css.footerMeta)}>{dashboard?.pluginInstallation.profileName === undefined ? '' : t('plugins.profile', { name: dashboard.pluginInstallation.profileName })}</span><div className={appearanceClass(common.modalFooterActions, css.footerActions)}><button type="button" data-dialog-close className={common.ghostButton} disabled={busy} onClick={onClose}>{t('common.cancel')}</button>{section === 'composition' && <><button type="button" className={common.secondaryButton} disabled={busy || !dirty} onClick={() => void refresh(true)}>{t('plugins.reset')}</button><button type="submit" form={formId} className={common.primaryButton} disabled={readonly || busy || !dirty || stale}>{t(working === 'apply' ? 'plugins.saving' : 'plugins.apply')}</button></>}</div></>
  return <SidebarModal wide title={t('plugins.title')} description={t('plugins.description')} busy={busy} contentReady={!loading} onClose={onClose} footer={footer}>
    <div className={css.dialogBody}>
      <div className={css.segmented} role="tablist" aria-label={t('plugins.tabs')}><button type="button" role="tab" aria-selected={section === 'composition'} onClick={() => setSection('composition')}>{t('plugins.composition')}</button><button type="button" role="tab" aria-selected={section === 'discover'} onClick={() => setSection('discover')}>{t('plugins.discover')}</button></div>
      {dashboard && <div className={css.summary}><strong>{t('plugins.summary', { sources: dashboard.sources.length, active: strategyActive, total: dashboard.entries.length })}</strong>{dashboard.pluginInstallation.profileName && <span>{t('plugins.profile', { name: dashboard.pluginInstallation.profileName })}</span>}</div>}
      {error && <div className={common.inlineError} role="alert">{error}</div>}
      {saved && <div className={css.notice} role="status">{t('plugins.saved')}</div>}
      {stale && <div className={css.notice} role="alert">{t('plugins.externalChange')}</div>}
      {section === 'composition' && dashboard && draft && <form id={formId} className={css.composition} aria-label={t('plugins.composition')} onSubmit={event => { event.preventDefault(); void apply() }}>
        <header className={css.sectionHeader}><div><h3>{t('plugins.sources')}</h3><p>{t('plugins.sourcesHint')}</p></div><span>{dashboard.sources.length}</span></header>
        <div className={css.sourceGrid}>{sourceRows.map(entry => {
          const instances = dashboard.sources.filter(source => source.packageName === entry.packageName)
          return <article className={css.sourceCard} key={entry.entryId}><div><strong>{sourceLabel(instances[0], entry.entryId, t, entry.packageName)}</strong><code>{entry.packageName}</code></div><div className={css.sourceState}><span data-active={entry.active || undefined}>{entry.active ? t('plugins.running') : t('plugins.registered')}</span>{instances.length > 0 && <small>{t('plugins.sourceInstances', { count: instances.length })}</small>}{entry.writable && <button type="button" role="switch" aria-label={entry.packageName} aria-checked={entry.enabled} className={css.switch} disabled={readonly || busy} onClick={() => void toggleSource(entry.entryId, !entry.enabled)} />}</div></article>
        })}</div>
        <header className={css.sectionHeader}><div><h3>{t('plugins.base')}</h3><p>{t('plugins.profileHint')}</p></div>{dirty && <span data-draft="">{t('plugins.draft')}</span>}</header>
        {bases.length > 1 && <select className={css.select} aria-label={t('plugins.baseSelect')} disabled={readonly || busy} value={draft.strategyTypeId} onChange={event => {
          const base = bases.find(entry => entry.typeId === event.target.value)
          edit({ ...draft, strategyTypeId: event.target.value, entries: base?.writable ? { ...draft.entries, [base.entryId]: { enabled: true, config: draft.entries[base.entryId]?.config ?? base.config } } : draft.entries })
        }}>{bases.map(entry => <option key={entry.entryId} value={entry.typeId}>{localized(entry.label, locale)}</option>)}</select>}
        {selected && card(selected)}
        <header className={css.sectionHeader}><div><h3>{t('plugins.extensions')}</h3><p>{t('plugins.extensionsHint')}</p></div><span>{additions.length}</span></header>
        {readonly && <p className={css.caption}>{t('plugins.readOnly')}</p>}
        {additions.length === 0 ? <p className={css.caption}>{t('plugins.noExtensions')}</p> : <div className={css.strategyGrid}>{additions.map(card)}</div>}
        {!dirty && <p className={css.unchanged}>{t('plugins.unchanged')}</p>}
      </form>}
      {section === 'discover' && dashboard && <div className={css.discovery}>
        <header className={css.sectionHeader}><div><h3>{t('plugins.suggestions')}</h3><p>{t('plugins.suggestionsHint')}</p></div></header>
        <div className={css.suggestionList}>{dashboard.pluginInstallation.suggestions.map(name => {
          const entry = dashboard.registeredPlugins.find(item => item.packageName === name) ?? dashboard.entries.find(item => item.packageName === name)
          return <article key={name}><div><strong>{name}</strong>{entry && <span data-active={entry.active || undefined}>{entry.enabled ? t('plugins.enabled') : t('plugins.registered')}</span>}</div>{entry === undefined && <button type="button" className={common.secondaryButton} disabled={busy} onClick={() => void inspect(name)}>{t('plugins.inspect')}</button>}</article>
        })}</div>
        <form className={css.inspectForm} onSubmit={event => { event.preventDefault(); void inspect() }}><label><span>{t('plugins.exactPackage')}</span><input value={packageName} maxLength={214} placeholder={t('plugins.packagePlaceholder')} onChange={event => { setPackageName(event.target.value); setInspection(null); setConfirming(false); setInstalled(false) }} /></label><button type="submit" className={common.secondaryButton} disabled={busy || packageName.trim() === ''}>{working === 'inspect' ? t('plugins.inspecting') : t('plugins.inspect')}</button></form>
        {!dashboard.pluginInstallation.supported && <div className={css.notice}><strong>{t('plugins.installUnavailable')}</strong>{dashboard.pluginInstallation.reason && <span>{t(`plugins.reason.${dashboard.pluginInstallation.reason}`)}</span>}</div>}
        {inspection && <article className={css.inspection}><header><div><span>{inspection.kind === 'source' ? 'Source' : 'Strategy'}</span><h3>{inspection.packageName}</h3></div><code>{inspection.version}</code></header><p>{inspection.description ?? t('plugins.noDescription')}</p><small>{t('plugins.compatibility', { range: inspection.mnemonPeerRange })}</small>
          {installed ? <div className={css.restartNotice} role="status">{t('plugins.installedRestart')}</div> : inspection.installed ? <div className={css.restartNotice}>{t('plugins.installedRestart')}</div> : confirming ? <div className={css.confirmInstall}><p>{t('plugins.installWarning')}</p><button type="button" className={common.primaryButton} disabled={busy} onClick={() => void install()}>{working === 'install' ? t('plugins.installing') : t('plugins.confirmInstall', { name: inspection.packageName, version: inspection.version })}</button></div> : <button type="button" className={common.primaryButton} disabled={!canConfigure || !dashboard.pluginInstallation.supported || busy} onClick={() => setConfirming(true)}>{dashboard.pluginInstallation.profileName === undefined ? t('plugins.install') : t('plugins.installTo', { profile: dashboard.pluginInstallation.profileName })}</button>}
        </article>}
      </div>}
    </div>
  </SidebarModal>
}
