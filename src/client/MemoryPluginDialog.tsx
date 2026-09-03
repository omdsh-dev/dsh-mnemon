import { useCallback, useId, useRef, useState, useEffect } from 'react'
import type { MemoryJsonValue } from '../core/contracts/index.ts'
import type { MemoryLocalizedText, MemoryStrategyConfigurationField } from '../sdk/strategy-configuration.ts'
import type { MemoryPluginEntryView, MemoryPluginInspection, MemoryPluginPreference, MemoryViewConfigurationRequest, MemoryViewDashboard } from '../host/view-protocol.ts'
import type { MnemonClient } from './api.ts'
import type { MnemonTranslate } from './locales.ts'
import { message, SidebarModal, useLocale, useT } from './page-kit.tsx'
import { appearanceClass } from './view-styles.ts'
import common from './MnemonView.module.css'
import css from './MemoryPluginDialog.module.css'

type Draft = Omit<MemoryViewConfigurationRequest, 'expectedRevision'>
type Source = MemoryViewDashboard['sources'][number]
type PluginClient = Pick<MnemonClient, 'viewDashboard' | 'applyView' | 'inspectMemoryPlugin' | 'installMemoryPlugin'>

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

function preference(entry: MemoryPluginEntryView, draft: Draft): MemoryPluginPreference {
  return draft.entries[entry.entryId] ?? { enabled: entry.enabled, config: entry.config }
}

function graphIssues(entries: MemoryPluginEntryView[], draft: Draft): Map<string, { missing: string[]; conflicts: string[] }> {
  const active = entries.filter(entry => preference(entry, draft).enabled)
  const providers = new Map<string, MemoryPluginEntryView[]>()
  for (const entry of active) for (const capability of entry.provides) providers.set(capability.id, [...providers.get(capability.id) ?? [], entry])
  return new Map(entries.map(entry => {
    if (!preference(entry, draft).enabled) return [entry.entryId, { missing: [], conflicts: [] }]
    const missing = entry.requires.filter(requirement => !providers.has(requirement))
    const conflicts = entry.provides.flatMap(capability => {
      const values = providers.get(capability.id) ?? []
      return capability.exclusive && values.length > 1 ? values.filter(value => value.entryId !== entry.entryId).map(value => value.entryId) : []
    })
    return [entry.entryId, { missing, conflicts: [...new Set(conflicts)] }]
  }))
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

function PluginCard({ entry, value, sources, disabled, selectedStrategy, issues, names, onToggle, onSelect, onChange }: {
  entry: MemoryPluginEntryView; value: MemoryPluginPreference; sources: Source[]; disabled: boolean; selectedStrategy: string
  issues: { missing: string[]; conflicts: string[] }; names: Map<string, string>
  onToggle(): void; onSelect(): void; onChange(value: MemoryPluginPreference): void
}): JSX.Element {
  const t = useT(), locale = useLocale()
  return <section className={css.pluginCard} aria-label={localized(entry.label, locale)}>
    <div className={css.cardBody}>
      <div className={css.cardTop}><div><div className={css.titleLine}><strong>{localized(entry.label, locale)}</strong>{entry.roles.map(role => <span className={css.role} key={role}>{role === 'strategy-extension' ? t('plugins.rolePolicy') : role === 'strategy' ? t('plugins.roleStrategy') : t('plugins.roleSource')}</span>)}</div><code>{entry.packageName}</code></div><button type="button" role="switch" aria-label={localized(entry.label, locale)} aria-checked={value.enabled} className={css.switch} disabled={disabled || !entry.writable} onClick={onToggle} /></div>
      {localized(entry.description, locale) && <p className={css.caption}>{localized(entry.description, locale)}</p>}
      <div className={css.statusLine}><span data-active={entry.active || undefined}>{entry.active ? t('plugins.running') : entry.enabled ? t('plugins.notReady') : t('plugins.registered')}</span><span>{value.enabled ? t('plugins.enabled') : t('plugins.disabled')}</span>{entry.roles.includes('strategy') && value.enabled && entry.typeId && <button type="button" className={css.viewChoice} data-selected={entry.typeId === selectedStrategy || undefined} onClick={onSelect}>{entry.typeId === selectedStrategy ? t('plugins.viewOwner') : t('plugins.useForView')}</button>}</div>
      {value.enabled && entry.strategyTypeId && entry.strategyTypeId !== selectedStrategy && <p className={css.relation} data-warning="">{t('plugins.otherStrategy', { strategy: entry.strategyTypeId })}</p>}
      {value.enabled && entry.requires.length > 0 && <p className={css.relation}>{t('plugins.dependsOn', { names: entry.requires.map(requirement => names.get(requirement) ?? requirement).join(' · ') })}</p>}
      {issues.missing.length > 0 && <p className={css.relation} data-warning="">{t('plugins.missingDependency', { names: issues.missing.map(requirement => names.get(requirement) ?? requirement).join(' · ') })}</p>}
      {issues.conflicts.length > 0 && <p className={css.relation} data-warning="">{t('plugins.conflictsWith', { names: issues.conflicts.map(entryId => names.get(entryId) ?? entryId).join(' · ') })}</p>}
      {entry.diagnostic && <p className={css.caption}>{entry.diagnostic}</p>}
    </div>
    {entry.fields.length > 0 && value.enabled && <details className={css.details}><summary>{t('plugins.configure')}</summary><div className={css.detailsBody}>{entry.fields.map(field => <ConfigurationField key={field.key} field={field} config={value.config} sources={sources} disabled={disabled || !entry.writable} onChange={(key, next) => {
      const config = { ...value.config }; if (next === undefined) delete config[key]; else config[key] = next
      onChange({ ...value, config })
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
  const [working, setWorking] = useState<'apply' | 'inspect' | 'install' | null>(null)
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
      if (dirty && !discard) { setStale(next.revision !== previous.dashboard!.revision); setDashboard({ ...previous.dashboard!, pluginInstallation: next.pluginInstallation }) }
      else { setDashboard(next); setDraft(initial(next)); setStale(false); setError(null) }
    } catch (reason) { if (request === version.current) setError(message(reason)) }
    finally { if (request === version.current) setLoading(false) }
  }, [client])
  useEffect(() => { void refresh() }, [refresh, refreshKey])
  useEffect(() => () => { version.current += 1 }, [])
  const edit = (next: Draft): void => { setDraft(next); setSaved(false); setError(null) }
  const dirty = dashboard !== null && draft !== null && serialize(draft) !== serialize(initial(dashboard))
  const readonly = !canConfigure || dashboard?.writable !== true
  const enabledPlugins = dashboard && draft ? dashboard.entries.filter(entry => preference(entry, draft).enabled).length : 0
  const issues = dashboard && draft ? graphIssues(dashboard.entries, draft) : new Map<string, { missing: string[]; conflicts: string[] }>()
  const selectedReady = dashboard && draft ? dashboard.entries.some(entry => entry.roles.includes('strategy') && entry.typeId === draft.strategyTypeId && preference(entry, draft).enabled) : false
  const hasSource = dashboard && draft ? dashboard.entries.some(entry => entry.roles.includes('source') && preference(entry, draft).enabled) : false
  const invalid = !selectedReady || !hasSource || [...issues.values()].some(value => value.missing.length > 0 || value.conflicts.length > 0)
  const names = new Map<string, string>()
  const providers = new Map<string, string[]>()
  for (const entry of dashboard?.entries ?? []) {
    const label = localized(entry.label, locale)
    names.set(entry.entryId, label)
    for (const capability of entry.provides) providers.set(capability.id, [...providers.get(capability.id) ?? [], label])
  }
  for (const [capability, labels] of providers) {
    const unique = [...new Set(labels)]
    names.set(capability, unique.length === 1 ? unique[0]! : capability === 'source' ? t('plugins.anySource') : unique.join(' / '))
  }
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
  const toggle = (target: MemoryPluginEntryView): void => {
    if (dashboard === null || draft === null) return
    const entries = { ...draft.entries }
    const state = (entry: MemoryPluginEntryView) => entries[entry.entryId] ?? { enabled: entry.enabled, config: entry.config }
    const setEnabled = (entry: MemoryPluginEntryView, enabled: boolean) => { entries[entry.entryId] = { ...state(entry), enabled } }
    const enabling = !state(target).enabled
    setEnabled(target, enabling)
    if (enabling) {
      const visit = (entry: MemoryPluginEntryView, seen = new Set<string>()): void => {
        if (seen.has(entry.entryId)) return
        seen.add(entry.entryId)
        for (const requirement of entry.requires) {
          const providers = dashboard.entries.filter(candidate => candidate.provides.some(capability => capability.id === requirement))
          if (providers.length === 1 && providers[0]!.writable) { setEnabled(providers[0]!, true); visit(providers[0]!, seen) }
        }
      }
      visit(target)
      for (const capability of target.provides.filter(value => value.exclusive)) {
        for (const candidate of dashboard.entries) if (candidate.entryId !== target.entryId && state(candidate).enabled
          && candidate.provides.some(value => value.id === capability.id) && candidate.writable) setEnabled(candidate, false)
      }
    }
    if (!enabling) {
      let changed = true
      while (changed) {
        changed = false
        const provided = new Set(dashboard.entries.filter(entry => state(entry).enabled).flatMap(entry => entry.provides.map(capability => capability.id)))
        for (const entry of dashboard.entries) if (state(entry).enabled && entry.requires.some(requirement => !provided.has(requirement)) && entry.writable) {
          setEnabled(entry, false); changed = true
        }
      }
    }
    let strategyTypeId = draft.strategyTypeId
    if (target.roles.includes('strategy') && target.typeId) {
      if (enabling) strategyTypeId = target.typeId
      else if (strategyTypeId === target.typeId) strategyTypeId = dashboard.entries.find(entry => entry.roles.includes('strategy') && entry.typeId && state(entry).enabled)?.typeId ?? strategyTypeId
    }
    edit({ strategyTypeId, entries })
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
  const card = (entry: MemoryPluginEntryView) => <PluginCard key={entry.entryId} entry={entry} value={preference(entry, draft!)} sources={dashboard!.sources} disabled={readonly || busy} selectedStrategy={draft!.strategyTypeId}
    issues={issues.get(entry.entryId) ?? { missing: [], conflicts: [] }} names={names} onToggle={() => toggle(entry)}
    onSelect={() => entry.typeId && edit({ ...draft!, strategyTypeId: entry.typeId })}
    onChange={value => edit({ ...draft!, entries: { ...draft!.entries, [entry.entryId]: value } })} />
  const footer = <><span className={appearanceClass(common.modalFooterMeta, css.footerMeta)}>{dashboard?.pluginInstallation.profileName === undefined ? '' : t('plugins.profile', { name: dashboard.pluginInstallation.profileName })}</span><div className={appearanceClass(common.modalFooterActions, css.footerActions)}><button type="button" data-dialog-close className={common.ghostButton} disabled={busy} onClick={onClose}>{t('common.cancel')}</button>{section === 'composition' && <><button type="button" className={common.secondaryButton} disabled={busy || !dirty} onClick={() => void refresh(true)}>{t('plugins.reset')}</button><button type="submit" form={formId} className={common.primaryButton} disabled={readonly || busy || !dirty || stale || invalid}>{t(working === 'apply' ? 'plugins.saving' : 'plugins.apply')}</button></>}</div></>
  return <SidebarModal wide title={t('plugins.title')} description={t('plugins.description')} busy={busy} contentReady={!loading} onClose={onClose} footer={footer}>
    <div className={css.dialogBody}>
      <div className={css.segmented} role="tablist" aria-label={t('plugins.tabs')}><button type="button" role="tab" aria-selected={section === 'composition'} onClick={() => setSection('composition')}>{t('plugins.composition')}</button><button type="button" role="tab" aria-selected={section === 'discover'} onClick={() => setSection('discover')}>{t('plugins.discover')}</button></div>
      {dashboard && <div className={css.summary}><strong>{t('plugins.summary', { active: enabledPlugins, total: dashboard.entries.length })}</strong>{dashboard.pluginInstallation.profileName && <span>{t('plugins.profile', { name: dashboard.pluginInstallation.profileName })}</span>}</div>}
      {error && <div className={common.inlineError} role="alert">{error}</div>}
      {saved && <div className={css.notice} role="status">{t('plugins.saved')}</div>}
      {stale && <div className={css.notice} role="alert">{t('plugins.externalChange')}</div>}
      {section === 'composition' && dashboard && draft && <form id={formId} className={css.composition} aria-label={t('plugins.composition')} onSubmit={event => { event.preventDefault(); void apply() }}>
        <header className={css.sectionHeader}><div><h3>{t('plugins.graph')}</h3><p>{t('plugins.graphHint')}</p></div>{dirty && <span data-draft="">{t('plugins.draft')}</span>}</header>
        {readonly && <p className={css.caption}>{t('plugins.readOnly')}</p>}
        {invalid && <div className={css.notice} role="alert">{t('plugins.invalidGraph')}</div>}
        <div className={css.pluginGrid}>{dashboard.entries.map(card)}</div>
        {!dirty && <p className={css.unchanged}>{t('plugins.unchanged')}</p>}
      </form>}
      {section === 'discover' && dashboard && <div className={css.discovery}>
        <header className={css.sectionHeader}><div><h3>{t('plugins.suggestions')}</h3><p>{t('plugins.suggestionsHint')}</p></div></header>
        <div className={css.suggestionList}>{dashboard.pluginInstallation.suggestions.map(name => {
          const entry = dashboard.entries.find(item => item.packageName === name)
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
