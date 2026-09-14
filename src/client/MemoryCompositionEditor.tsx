import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button, IconChevronDownOutline14, IconChevronUpOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientConnectionHandle } from '../host/protocol.ts'
import type { MemoryJsonValue } from '../core/contracts/index.ts'
import type { MemoryPluginEntryView, MemoryPluginPreference, MemoryViewConfigurationRequest, MemoryViewDashboard, MemoryViewInspection } from '../host/view-protocol.ts'
import type { MemoryStrategyConfigurationField } from '../sdk/strategy-configuration.ts'
import { MnemonClient } from './api.ts'
import css from './MemoryCompositionEditor.module.css'
import { MemoryAccessSummary, MemoryDecisionList } from './context-access.tsx'

export function MemoryCompositionEditor(props: { connection?: ClientConnectionHandle; sessionId?: string; workspaceId?: string; locale: string; refreshKey?: number; onChange?(): void }) {
  const [open, setOpen] = useState(false), zh = props.locale.startsWith('zh')
  if (!props.connection) return null
  return <details className={css.root} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className={css.summary}>
      <span><strong>{zh ? '组合策略配置' : 'Composition settings'}</strong><small>{zh ? '选择上下文策略，按需开启增强功能。' : 'Choose a context strategy and its optional enhancements.'}</small></span>
      <IconChevronDownOutline14 className={css.chevron} />
    </summary>
    {open && <Editor {...props} connection={props.connection} />}
  </details>
}

function Toggle(props: { label: string; checked: boolean; disabled: boolean; onChange(value: boolean): void }) {
  return <label className={css.toggle}>
    <input type="checkbox" aria-label={props.label} checked={props.checked} disabled={props.disabled} onChange={event => props.onChange(event.target.checked)} />
    <span aria-hidden="true"><i /></span>
  </label>
}

function Field(props: { field: MemoryStrategyConfigurationField; value: MemoryJsonValue | undefined; sources: MemoryViewDashboard['sources']; disabled: boolean; locale: string; onChange(value: MemoryJsonValue | undefined): void }) {
  const { field, value } = props, zh = props.locale.startsWith('zh'), label = field.label[zh ? 'zh-CN' : 'en'], t = (en: string, cn: string) => zh ? cn : en
  const list = Array.isArray(value) ? value as string[] : []
  const isList = field.input === 'source-list' || field.input === 'string-list'
  return <fieldset className={css.field} disabled={props.disabled}>
    <legend>{label}</legend>
    {field.description && <small>{field.description[zh ? 'zh-CN' : 'en']}</small>}
    {isList ? <>
      <div className={css.fieldMode}>
        <span>{value === undefined ? t('Use strategy defaults', '使用策略默认值') : t('Custom selection', '手动选择')}</span>
        <Toggle label={t('Set explicitly ', '手动设置 ') + label} checked={value !== undefined} disabled={props.disabled} onChange={checked => props.onChange(checked ? [] : undefined)} />
      </div>
      {value !== undefined && (field.input === 'string-list'
        ? <StringList label={label} value={list} onChange={props.onChange} />
        : <>
          <div className={css.sourceList}>{props.sources.filter(source => !field.sourceRoles || field.sourceRoles.includes(source.role)).map(source => <label key={source.sourceInstanceKey}>
            <input type="checkbox" checked={list.includes(source.sourceInstanceKey)} onChange={event => props.onChange(event.target.checked ? [...list, source.sourceInstanceKey] : list.filter(key => key !== source.sourceInstanceKey))} />
            <span>{source.label}</span>
          </label>)}</div>
          {list.length > 0 && <ol className={css.sourceOrder}>{list.map((key, index) => <li key={key}>
            <span>{props.sources.find(source => source.sourceInstanceKey === key)?.label ?? key}</span>
            <Button type="button" size="sm" disabled={props.disabled || !index} aria-label={t('Move up ', '上移 ') + key} onClick={() => { const next = [...list]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; props.onChange(next) }}><IconChevronUpOutline14 /></Button>
            <Button type="button" size="sm" disabled={props.disabled || index === list.length - 1} aria-label={t('Move down ', '下移 ') + key} onClick={() => { const next = [...list]; [next[index + 1], next[index]] = [next[index]!, next[index + 1]!]; props.onChange(next) }}><IconChevronDownOutline14 /></Button>
          </li>)}</ol>}
        </>)}
    </> : field.input === 'boolean' ? <Toggle label={label} checked={(value ?? field.defaultValue) === true} disabled={props.disabled} onChange={props.onChange} /> : field.input === 'textarea'
      ? <textarea aria-label={label} value={String(value ?? field.defaultValue ?? '')} maxLength={field.maximum ?? 4000} onChange={event => props.onChange(event.target.value)} />
      : <input className={field.input === 'number' ? css.numberInput : css.textInput} aria-label={label} type={field.input === 'number' ? 'number' : 'text'} value={String(value ?? field.defaultValue ?? '')} {...(field.minimum === undefined ? {} : { min: field.minimum })} {...(field.maximum === undefined ? {} : { max: field.maximum, maxLength: field.maximum })} onChange={event => props.onChange(field.input === 'number' ? event.target.value === '' ? undefined : Number(event.target.value) : event.target.value)} />}
    {value !== undefined && <Button className={css.reset} type="button" size="sm" aria-label={t('Use default', '恢复默认') + ' · ' + label} onClick={() => props.onChange(undefined)}>{t('Use default', '恢复默认')}</Button>}
  </fieldset>
}

function StringList(props: { label: string; value: string[]; onChange(value: string[]): void }) {
  const serialized = JSON.stringify(props.value)
  const [text, setText] = useState(props.value.join('\n'))
  useEffect(() => { setText((JSON.parse(serialized) as string[]).join('\n')) }, [serialized])
  return <textarea aria-label={props.label} value={text} onChange={event => {
    setText(event.target.value)
    props.onChange([...new Set(event.target.value.split('\n').map(value => value.trim()).filter(Boolean))])
  }} />
}
function Editor(props: { connection: ClientConnectionHandle; sessionId?: string; workspaceId?: string; locale: string; refreshKey?: number; onChange?(): void }) {
  const client = useMemo(() => new MnemonClient(props.connection, props.sessionId, props.workspaceId), [props.connection, props.sessionId, props.workspaceId])
  const zh = props.locale.startsWith('zh'), t = (en: string, cn: string) => zh ? cn : en, label = (entry: MemoryPluginEntryView) => entry.label[zh ? 'zh-CN' : 'en']
  const [dashboard, setDashboard] = useState<MemoryViewDashboard>(), [draft, setDraft] = useState<Record<string, MemoryPluginPreference>>({}), [strategy, setStrategy] = useState(''), [editing, setEditing] = useState(''), [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ request: MemoryViewConfigurationRequest; result: MemoryViewInspection }>()
  const epoch = useRef(0), serial = useRef(0), pending = useRef(false)
  const load = async () => {
    const current = ++serial.current, generation = epoch.current
    try { const next = await client.viewDashboard(); if (current !== serial.current || generation !== epoch.current) return; setDashboard(next); setDraft({}); setStrategy(next.strategyTypeId); setPreview(undefined); setError('') }
    catch (error) { if (current === serial.current && generation === epoch.current) setError(String(error)) }
  }
  useEffect(() => { epoch.current++; setDashboard(undefined); setDraft({}); setEditing(''); setPreview(undefined); setBusy(false); pending.current = false; void load(); return () => { epoch.current++; serial.current++ } }, [client])
  useEffect(() => { if (props.refreshKey) void load() }, [props.refreshKey])
  const entries = dashboard?.entries.filter(entry => entry.roles.includes('strategy') || entry.roles.includes('strategy-extension')) ?? []
  const visibleEntries = entries.filter(entry => entry.roles.includes('strategy') ? entry.typeId === strategy : entry.strategyTypeId === strategy)
  const presentedSources = dashboard?.sources.map(source => ({ ...source, label: dashboard.entries.find(entry => entry.packageName === source.packageName && entry.roles.includes('source'))?.label[zh ? 'zh-CN' : 'en'] ?? source.label })) ?? []
  const editorId = useId()
  const strategies = entries.filter(entry => entry.roles.includes('strategy') && entry.typeId)
  const disabled = busy || !dashboard?.writable
  const hasChanges = strategy !== dashboard?.strategyTypeId || Object.keys(draft).length > 0
  const edit = (entry: MemoryPluginEntryView, value: MemoryPluginPreference) => { setDraft(old => ({ ...old, [entry.entryId]: value })); setPreview(undefined); setStatus(''); setError('') }
  const request = (): MemoryViewConfigurationRequest => {
    if (!dashboard) throw new Error('Composition settings are unavailable')
    const edits = structuredClone(draft)
    if (strategy !== dashboard.strategyTypeId) {
      for (const entry of entries) {
        const previous = edits[entry.entryId] ?? entry
        if (entry.roles.includes('strategy')) edits[entry.entryId] = { enabled: entry.typeId === strategy, config: previous.config }
        else if (entry.strategyTypeId !== strategy && previous.enabled) edits[entry.entryId] = { enabled: false, config: previous.config }
      }
    }
    return { expectedRevision: dashboard.revision, strategyTypeId: strategy, entries: edits }
  }
  const inspect = async () => {
    if (pending.current || !dashboard) return
    const generation = epoch.current; pending.current = true; setBusy(true); setError(''); setStatus(''); setPreview(undefined)
    try { const value = request(), result = await client.previewView(value); if (generation === epoch.current) setPreview({ request: value, result }) }
    catch (error) { if (generation === epoch.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (generation === epoch.current) { pending.current = false; setBusy(false) } }
  }
  const apply = async () => {
    if (pending.current || !preview || disabled || JSON.stringify(preview.request) !== JSON.stringify(request())) return
    const generation = epoch.current; pending.current = true; setBusy(true); setError(''); setStatus('')
    let committed = false
    try {
      await client.applyView(preview.request); committed = true
      const next = await client.viewDashboard()
      if (generation !== epoch.current) return
      setDashboard(next); setDraft({}); setPreview(undefined); setStrategy(next.strategyTypeId); setStatus(t('Composition saved. New turns use these settings.', '组合配置已保存，新轮次将使用这些设置。')); props.onChange?.()
    } catch (error) {
      if (generation !== epoch.current) return
      setPreview(undefined)
      if (committed) { setDashboard(old => old ? { ...old, writable: false } : old); setError(t('Saved, but refresh failed. Reload settings before editing again.', '已保存，但状态刷新失败。请重新加载后再编辑。')) }
      else setError(error instanceof Error ? error.message : String(error))
    } finally { if (generation === epoch.current) { pending.current = false; setBusy(false) } }
  }
  return <div className={css.body} aria-label={t('Composition editor', '组合策略编辑器')} aria-busy={busy}>
    {error && <p role="alert" className={css.error}>{error}</p>}
    {status && <p role="status" className={css.success}>{status}</p>}
    {!dashboard ? <Button type="button" variant="outline" disabled={busy} onClick={() => void load()}>{t('Load composition', '加载组合配置')}</Button> : <>
      <div className={css.strategyRow}>
        <label htmlFor={editorId + '-strategy'}>{t('Composition Strategy', '组合策略')}</label>
        <div className={css.selectControl}>
          <select id={editorId + '-strategy'} disabled={disabled} value={strategy} onChange={event => { setStrategy(event.target.value); setEditing(''); setPreview(undefined); setStatus('') }}>
            {!strategies.some(entry => entry.typeId === strategy) && <option value={strategy}>{strategy}</option>}
            {strategies.map(entry => <option key={entry.entryId} value={entry.typeId}>{label(entry)}</option>)}
          </select>
          <IconChevronDownOutline14 />
        </div>
      </div>
      {!dashboard.writable && <p className={css.hint}>{t('These settings are read-only.', '当前设置为只读。')}</p>}
      <div className={css.components} aria-label={t('Strategy and enhancements', '策略与增强')}>
        {visibleEntries.map(entry => {
          const state = draft[entry.entryId] ?? entry, expanded = editing === entry.entryId, enhancement = entry.roles.includes('strategy-extension')
          return <section className={css.component} key={entry.entryId}>
            <div className={css.componentRow}>
              <button className={css.disclosure} type="button" aria-label={t('Configure ', '配置 ') + label(entry)} aria-expanded={expanded} aria-controls={editorId + '-' + entry.entryId} onClick={() => setEditing(expanded ? '' : entry.entryId)}>
                <span><strong>{label(entry)}</strong><small>{entry.description[zh ? 'zh-CN' : 'en']}</small></span>
                <IconChevronDownOutline14 className={css.chevron} />
              </button>
              {enhancement ? <Toggle label={t('Enable ', '启用 ') + label(entry)} checked={state.enabled} disabled={disabled || !entry.writable} onChange={enabled => edit(entry, { enabled, config: structuredClone(state.config) })} /> : <span className={css.current}>{t('Strategy', '主策略')}</span>}
            </div>
            {expanded && <div className={css.componentBody} id={editorId + '-' + entry.entryId}>
              {entry.diagnostic && <p className={css.error}>{entry.diagnostic}</p>}
              {entry.fields.length === 0 && <p className={css.hint}>{t('This strategy has no additional settings.', '此策略没有额外参数。')}</p>}
              <div className={css.fields}>{entry.fields.map(field => <Field key={entry.entryId + '/' + field.key} field={field} value={state.config[field.key]} sources={presentedSources} disabled={disabled || !entry.writable} locale={props.locale} onChange={value => {
                const config = structuredClone(state.config)
                if (value === undefined) delete config[field.key]; else config[field.key] = value
                edit(entry, { enabled: state.enabled, config })
              }} />)}</div>
              <details className={css.metadata}><summary>{t('Plugin details', '插件信息')}</summary><small>{entry.packageName}<br />{entry.entryId}</small></details>
            </div>}
          </section>
        })}
      </div>
      {dashboard.current && <details className={css.operations}>
        <summary>{t('Context used by the current conversation', '当前会话实际使用的上下文')}<IconChevronDownOutline14 className={css.chevron} /></summary>
        <p className={css.hint}>{t('This is the frozen context of the latest generated turn. Changes to these settings take effect on a new turn.', '这里展示最近一次生成轮次固定使用的上下文。配置变更将在新轮次生效。')}</p>
        <p>{dashboard.current.routes.length} {t('read entry points', '个读取入口')} · {dashboard.current.actions.length} {t('available actions', '个可用操作')}</p>
        <MemoryDecisionList decisions={dashboard.current.decisions} sources={presentedSources} locale={props.locale} />
        {!dashboard.current.decisions?.length && <p className={css.hint}>{t('This turn has no enhancement decisions.', '此轮没有增强策略决策。')}</p>}
      </details>}
      {preview && <section className={css.preview} aria-label={t('Composition preview', '组合预览')}>
        <h3>{t('Composition preview', '组合预览')}</h3>
        <dl className={css.metrics}>
          <div><dt>{t('Sources', '来源')}</dt><dd>{new Set([...preview.result.projection, ...preview.result.routes, ...preview.result.actions].map(item => item.sourceInstanceKey)).size}</dd></div>
          <div><dt>{t('Read routes', '读取路由')}</dt><dd>{preview.result.routes.length}</dd></div>
          <div><dt>{t('Actions', '操作')}</dt><dd>{preview.result.actions.length}</dd></div>
          <div><dt>{t('Context characters', '上下文字符')}</dt><dd>{preview.result.projection.reduce((n, fragment) => n + fragment.text.length, 0).toLocaleString(zh ? 'zh-CN' : 'en')}</dd></div>
        </dl>
        <p className={css.hint}>{t('Save to apply to new turns. Preview does not change memory or run actions.', '保存后应用于新轮次。预览不会修改记忆或执行操作。')}</p>
        {preview.result.diagnostics.map((diagnostic, index) => <p key={index} className={css.error}>{diagnostic}</p>)}
        <MemoryDecisionList decisions={preview.result.decisions} sources={presentedSources} locale={props.locale} />
        <details className={css.operations}><summary>{t('Sources and available operations', '参与来源和可用操作')}<IconChevronDownOutline14 className={css.chevron} /></summary>
          {[...new Set([...preview.result.projection, ...preview.result.routes, ...preview.result.actions].map(item => item.sourceInstanceKey))].map(key => {
            const routes = preview.result.routes.filter(route => route.sourceInstanceKey === key), actions = preview.result.actions.filter(action => action.sourceInstanceKey === key)
            return <details className={css.sourcePreview} key={key}>
              <summary><span>{presentedSources.find(source => source.sourceInstanceKey === key)?.label ?? key}</span><small>{routes.length} {t('reads', '读取')} · {actions.length} {t('actions', '操作')}</small><IconChevronDownOutline14 className={css.chevron} /></summary>
              <MemoryAccessSummary locale={props.locale} inventory={{ reads: routes.map(route => ({ ...route, id: route.operationId })), actions: actions.map(action => ({ ...action, id: action.operationId, requiresApproval: action.requiresApproval ?? false })) }} />
            </details>
          })}
        </details>
      </section>}
      <footer className={css.actions}>
        <span className={css.hint}>{preview ? t('Preview ready', '预览已就绪') : hasChanges ? t('Unsaved changes', '有未保存的更改') : t('Preview before saving', '保存前先预览')}</span>
        <div>
          <Button type="button" size="sm" disabled={busy} onClick={() => { setStatus(''); setEditing(''); void load() }}>{t('Reload configuration', '重新加载配置')}</Button>
          {preview ? <Button type="button" variant="primary" disabled={disabled} onClick={() => void apply()}>{t('Save this composition', '保存这份组合')}</Button> : <Button type="button" variant="outline" disabled={busy} onClick={() => void inspect()}>{t('Preview composition', '预览组合')}</Button>}
        </div>
      </footer>
    </>}
  </div>
}
