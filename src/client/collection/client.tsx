import { managementError } from './action-client.tsx'
import { collectionStyles as styles } from './collection-styles.ts'
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { MemorySourcePageProps } from '../source-pages.tsx'
import { MemorySourcePageFrame } from '../page-client.tsx'
import type { MemoryJsonValue } from '../../core/contracts/index.ts'
import type { RecordSnapshot, RecordValue, RecordScope, RecordState } from '../../sdk/source/records.ts'

export type Localized = { en: string; 'zh-CN': string }
export interface CollectionField {
  key: string; label: Localized; type: 'text' | 'textarea' | 'date' | 'number' | 'select' | 'boolean' | 'list'
  readOnly?: boolean
  options?: Array<{ value: string; label: Localized }>; defaultValue?: MemoryJsonValue
}
export interface CollectionPageOptions {
  title: Localized; description: Localized
  kinds: Array<{ value: string; label: Localized }>
  scopes: RecordScope[]; defaultScope: RecordScope
  scopeForKind?: Readonly<Record<string, RecordScope>>
  reviewedRevisions?: boolean
  editable?(record: RecordValue): boolean
  fields?: CollectionField[]
  renderExtras?(props: MemorySourcePageProps, snapshot: RecordSnapshot, reload: () => Promise<void>): ReactNode
  renderRecords?(context: { props: MemorySourcePageProps; records: RecordValue[]; renderRecord(record: RecordValue): ReactNode }): ReactNode
  recordActions?: Array<{ label: Localized; operation: string; available?(record: RecordValue): boolean; data?(record: RecordValue): { [key: string]: MemoryJsonValue } }>
}

const copy = {
  en: { add: 'Add', proposal: 'Save for review', create: 'Save', cancel: 'Cancel', title: 'Title', content: 'Content', kind: 'Type', scope: 'Scope', query: 'Search records', active: 'Active', pending: 'Needs review', archived: 'Archived', rejected: 'Rejected', deleted: 'Removed', all: 'All', empty: 'No records in this view.', edit: 'Edit', approve: 'Approve', reject: 'Reject', archive: 'Archive', restore: 'Restore', remove: 'Remove', history: 'History', refresh: 'Refresh', global: 'Global', project: 'Project', session: 'Session', daily: 'Daily', date: 'Date', readOnly: 'Read only', saved: 'Saved', signals: 'signals', unavailable: 'Enable this Source to use this page.', busy: 'Saving…', activeNote: 'Approved records can participate in context. Proposals remain inactive until reviewed.' },
  'zh-CN': { add: '添加', proposal: '提交审核', create: '保存', cancel: '取消', title: '标题', content: '内容', kind: '类型', scope: '范围', query: '搜索条目', active: '已生效', pending: '待审核', archived: '已归档', rejected: '已拒绝', deleted: '已移除', all: '全部', empty: '当前视图暂无条目。', edit: '编辑', approve: '采纳', reject: '拒绝', archive: '归档', restore: '恢复', remove: '移除', history: '历史记录', refresh: '刷新', global: '全局', project: '项目', session: '会话', daily: '每日', date: '日期', readOnly: '只读', saved: '已保存', signals: '次建议', unavailable: '启用此 Source 后即可使用此页面。', busy: '保存中…', activeNote: '已采纳条目可参与上下文。待审核建议在采纳前不会生效。' },
}


export function createCollectionPage(options: CollectionPageOptions): (props: MemorySourcePageProps) => ReactNode {
  return function CollectionPage(props) {
    const language = props.locale.startsWith('zh') ? 'zh-CN' : 'en'
    const t = copy[language]
    const label = (value: Localized) => value[language]
    const epoch = useRef(0), serial = useRef(0), pending = useRef(false)
    const [snapshot, setSnapshot] = useState<RecordSnapshot>({ revision: '', records: [] })
    const [filter, setFilter] = useState<RecordState | 'all'>('active')
    const [query, setQuery] = useState('')
    const [limit, setLimit] = useState(25)
    const [selected, setSelected] = useState<string[]>([]), [revisionDraft, setRevisionDraft] = useState(false)
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const [busy, setBusy] = useState(false)
    const [editing, setEditing] = useState<RecordValue | 'new' | null>(null)
    const [title, setTitle] = useState('')
    const [content, setContent] = useState('')
    const [kind, setKind] = useState(options.kinds[0]!.value)
    const [scope, setScope] = useState(options.defaultScope)
    const [date, setDate] = useState('')
    const [data, setData] = useState<{ [key: string]: MemoryJsonValue }>({})
    const load = useCallback(async () => {
      if (!props.management || pending.current) return
      const generation = epoch.current, request = ++serial.current
      try {
        const result = await props.management.read('snapshot')
        if (generation !== epoch.current || request !== serial.current) return
        setSnapshot({ ...(result.value as unknown as RecordSnapshot), records: (result.value as unknown as RecordSnapshot).records.filter(record => options.kinds.some(kind => kind.value === record.kind)) }); setError('')
      } catch (reason) { if (generation === epoch.current && request === serial.current) setError(managementError(reason, props.locale.startsWith('zh'))) }
    }, [props.management])
    useEffect(() => {
      epoch.current++; serial.current++; pending.current = false
      setSnapshot({ revision: '', records: [] }); setEditing(null); setSelected([]); setRevisionDraft(false); setBusy(false); setError(''); setNotice(''); setQuery(''); setFilter('active')
      return () => { epoch.current++; serial.current++ }
    }, [props.management?.sourceInstanceKey, props.workspaceId, props.sessionId])
    useEffect(() => { void load() }, [load])
    useEffect(() => { setLimit(25); setSelected([]) }, [filter, query])
    const write = async (operation: string, input: { [key: string]: MemoryJsonValue }): Promise<boolean> => {
      if (!props.management || !props.writable || pending.current) return false
      const generation = epoch.current; pending.current = true; serial.current++
      setBusy(true); setError(''); setNotice('')
      try {
        const result = await props.management.mutate(operation, input, { confirmed: true, expectedRevision: snapshot.revision })
        if (generation !== epoch.current) return false
        setSnapshot({ ...(result.value as unknown as RecordSnapshot), records: (result.value as unknown as RecordSnapshot).records.filter(record => options.kinds.some(kind => kind.value === record.kind)) })
        setNotice(t.saved); setSelected([])
        return true
      } catch (reason) { if (generation === epoch.current) setError(managementError(reason, props.locale.startsWith('zh'))); return false }
      finally { if (generation === epoch.current) { pending.current = false; setBusy(false) } }
    }
    const edit = (record: RecordValue | 'new', proposeRevision = false) => {
      setRevisionDraft(proposeRevision)
      setEditing(record); setNotice('')
      setTitle(record === 'new' ? '' : record.title); setContent(record === 'new' ? '' : record.content)
      setKind(record === 'new' ? options.kinds[0]!.value : record.kind); setScope(record === 'new' ? options.defaultScope : record.scope)
      setDate(record === 'new' ? '' : record.date ?? '')
      setData(record === 'new' ? Object.fromEntries((options.fields ?? []).filter(field => field.defaultValue !== undefined).map(field => [field.key, field.defaultValue!])) : structuredClone(record.data))
    }
    const save = async (event: FormEvent, proposal = false) => {
      event.preventDefault()
      const normalized = { ...data }
      for (const field of options.fields ?? []) if (field.type === 'list' && typeof normalized[field.key] === 'string') normalized[field.key] = (normalized[field.key] as string).split(',').map(value => value.trim()).filter(Boolean)
      if (revisionDraft) for (const key of ['mnemonTransfer', 'mnemonSupersedes', 'mnemonSupersededBy']) delete normalized[key]
      const input = { title, content, kind, scope, data: normalized, ...(date ? { date } : {}) }
      const original = editing && editing !== 'new' ? editing : undefined
      const ok = await write(revisionDraft ? 'propose' : editing === 'new' ? proposal ? 'propose' : 'create' : 'update', { ...input, ...(original ? revisionDraft ? { supersedes: { id: original.id, version: original.version } } : { id: original.id, version: original.version } : {}) })
      if (ok) { setEditing(null); if (proposal || revisionDraft) setFilter('pending'); setRevisionDraft(false) }
    }
    const fieldValue = (field: CollectionField) => data[field.key] ?? field.defaultValue ?? ''
    const setField = (key: string, value: MemoryJsonValue) => setData(current => ({ ...current, [key]: value }))
    const visible = snapshot.records.filter(record => (filter === 'all' || record.state === filter) && (!query || (record.title + '\n' + record.content + '\n' + (record.date ?? '') + '\n' + record.kind + '\n' + JSON.stringify(record.data)).toLocaleLowerCase().includes(query.toLocaleLowerCase())))
      .sort((a, b) => filter === 'pending' ? b.signals - a.signals || b.updatedAt.localeCompare(a.updatedAt) : b.updatedAt.localeCompare(a.updatedAt))
    const selectedRecords = visible.filter(record => selected.includes(record.id))
    const original = (record: RecordValue) => {
      const reference = record.data.mnemonSupersedes
      return reference && typeof reference === 'object' && !Array.isArray(reference) ? snapshot.records.find(item => item.id === reference.id) : undefined
    }
    const reviewInput = (record: RecordValue) => ({ id: record.id, version: record.version, ...(original(record) ? { supersededVersion: original(record)!.version } : {}) })
    const batch = (operation: string) => write(operation, { recordIds: selectedRecords.map(record => record.id), versions: Object.fromEntries(selectedRecords.map(record => [record.id, record.version])), supersededVersions: Object.fromEntries(selectedRecords.filter(record => original(record)).map(record => [record.id, original(record)!.version])) })
    const renderRecord = (record: RecordValue) => <article key={record.id} data-record-id={record.id}>
        {props.writable && ['active', 'pending'].includes(record.state) && <label className="mc-selection"><input type="checkbox" aria-label={(language === 'zh-CN' ? '选择 ' : 'Select ') + record.title} checked={selected.includes(record.id)} disabled={busy || !selected.includes(record.id) && selected.length >= 50} onChange={event => setSelected(values => event.target.checked ? [...values, record.id] : values.filter(id => id !== record.id))} />{language === 'zh-CN' ? '选择条目' : 'Select record'}</label>}
        <h3>{record.title}</h3><div className="mc-meta"><span className="mc-badge">{options.kinds.find(item => item.value === record.kind)?.label[language] ?? record.kind}</span>{record.kind !== record.scope && <span className="mc-badge">{t[record.scope]}</span>}<span className="mc-badge">{t[record.state]}</span><time dateTime={record.updatedAt}>{new Date(record.updatedAt).toLocaleString(props.locale)}</time>{record.date && <span>{record.date}</span>}{record.signals > 1 && <span>{record.signals} {t.signals}</span>}</div>
        {record.content && <p className="mc-content">{record.content}</p>}
        {original(record) && <details><summary>{language === 'zh-CN' ? '对照原版本' : 'Compare with the original'}</summary><div><small>{original(record)!.title} · v{original(record)!.version}</small><p className="mc-content">{original(record)!.content}</p><small>{language === 'zh-CN' ? '采纳此修订会归档原版；原版在审核前继续生效。' : 'Approval archives the original, which stays active until this revision is reviewed.'}</small></div></details>}
        <div className="mc-meta">{(options.fields ?? []).filter(field => record.data[field.key] !== undefined && record.data[field.key] !== '' && record.data[field.key] !== false).map(field => <span key={field.key} className="mc-badge">{label(field.label)}{field.type !== 'boolean' && <>: {field.options?.find(option => option.value === record.data[field.key])?.label[language] ?? (Array.isArray(record.data[field.key]) ? (record.data[field.key] as string[]).join(', ') : String(record.data[field.key]))}</>}</span>)}</div>
        {props.writable && <footer>{(options.editable?.(record) ?? true) && <button disabled={busy} onClick={() => edit(record)}>{t.edit}</button>}{record.state === 'pending' && <><button data-primary="true" disabled={busy} onClick={() => void write('approve', reviewInput(record))}>{t.approve}</button><button disabled={busy} onClick={() => void write('reject', { id: record.id, version: record.version })}>{t.reject}</button></>}
          {['active', 'pending'].includes(record.state) ? <button disabled={busy} onClick={() => void write('archive', { id: record.id, version: record.version })}>{t.archive}</button> : <button disabled={busy || !!record.data.mnemonSupersededBy} onClick={() => void write('restore', { id: record.id, version: record.version })}>{t.restore}</button>}
          {options.reviewedRevisions && record.state === 'active' && <button disabled={busy} onClick={() => edit(record, true)}>{language === 'zh-CN' ? '提出修订' : 'Propose revision'}</button>}
          {options.recordActions?.filter(action => action.available?.(record) ?? true).map(action => <button key={action.operation} disabled={busy} onClick={() => void write(action.operation, { id: record.id, version: record.version, ...action.data?.(record) })}>{label(action.label)}</button>)}
        </footer>}
        {record.history.length > 0 && <details><summary>{t.history} ({record.history.length})</summary>{record.history.slice().reverse().map((entry, index) => <div key={index}><small>{new Date(entry.at).toLocaleString(props.locale)} · {entry.operation}</small><p className="mc-content">{entry.title}<br />{entry.content}</p></div>)}</details>}
      </article>
    return <MemorySourcePageFrame locale={props.locale}><section data-mnemon-collection={props.sourceTypeId} aria-label={label(options.title)}><style>{styles}</style>
      <header><div><h2>{label(options.title)}</h2><p>{label(options.description)}</p><small>{t.activeNote}</small></div><div><button disabled={busy} onClick={() => void load()}>{t.refresh}</button>{' '}<button data-primary="true" disabled={!props.writable || !props.management || busy} onClick={() => edit('new')}>{t.add}</button></div></header>
      {!props.management && <p>{t.unavailable}</p>}{props.management && !props.writable && <p>{t.readOnly}</p>}
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      {editing && <form aria-label={editing === 'new' ? t.add : t.edit} onSubmit={event => void save(event)}>
        {revisionDraft && <p role="status">{language === 'zh-CN' ? '这是一份修订建议，保存后进入待审核；原内容继续生效。' : 'This revision will be saved for review. The original stays active.'}</p>}
        <label>{t.title}<input required maxLength={300} value={title} onChange={event => setTitle(event.target.value)} /></label>
        <label>{t.content}<textarea rows={5} value={content} onChange={event => setContent(event.target.value)} /></label>
        <div className="mc-fields"><label>{t.kind}<select disabled={editing !== 'new'} value={kind} onChange={event => { setKind(event.target.value); if (options.scopeForKind?.[event.target.value]) setScope(options.scopeForKind[event.target.value]!) }}>{options.kinds.map(item => <option key={item.value} value={item.value}>{label(item.label)}</option>)}</select></label>
        <label>{t.scope}<select disabled={editing !== 'new' || options.scopeForKind !== undefined} value={scope} onChange={event => setScope(event.target.value as RecordScope)}>{options.scopes.map(value => <option key={value} value={value}>{t[value]}</option>)}</select></label>
        {scope === 'daily' && <label>{t.date}<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>}
        {(options.fields ?? []).filter(field => !field.readOnly).map(field => <label key={field.key}>{label(field.label)}{field.type === 'boolean' ? <input type="checkbox" checked={fieldValue(field) === true} onChange={event => setField(field.key, event.target.checked)} />
          : field.type === 'select' ? <select value={String(fieldValue(field))} onChange={event => setField(field.key, event.target.value)}>{field.options?.map(option => <option key={option.value} value={option.value}>{label(option.label)}</option>)}</select>
          : field.type === 'textarea' ? <textarea rows={3} value={String(fieldValue(field))} onChange={event => setField(field.key, event.target.value)} />
          : <input type={field.type === 'date' || field.type === 'number' ? field.type : 'text'} value={Array.isArray(fieldValue(field)) ? (fieldValue(field) as string[]).join(', ') : String(fieldValue(field))}
            onChange={event => setField(field.key, field.type === 'number' ? Number(event.target.value) : event.target.value)} />}</label>)}
        </div><footer><button data-primary="true" disabled={busy || !props.writable}>{busy ? t.busy : t.create}</button>{editing === 'new' && <button type="button" disabled={busy || !title.trim()} onClick={event => void save(event, true)}>{t.proposal}</button>}<button type="button" disabled={busy} onClick={() => setEditing(null)}>{t.cancel}</button></footer>
      </form>}
      <div className="mc-toolbar" aria-label={label(options.title) + ' filters'}>{(['active', 'pending', 'archived', 'all'] as const).map(state => <button key={state} aria-pressed={filter === state} onClick={() => setFilter(state)}>{t[state]} {state === 'all' ? snapshot.records.length : snapshot.records.filter(record => record.state === state).length}</button>)}<input aria-label={t.query} placeholder={t.query} value={query} onChange={event => setQuery(event.target.value)} /></div>
      {props.writable && <div className="mc-selection" aria-label={language === 'zh-CN' ? '批量审核' : 'Batch review'}>
        {!options.renderRecords && <button disabled={busy || !visible.some(record => ['active', 'pending'].includes(record.state))} onClick={() => setSelected(visible.slice(0, limit).filter(record => ['active', 'pending'].includes(record.state)).slice(0, 50).map(record => record.id))}>{language === 'zh-CN' ? '选择当前页' : 'Select this page'}</button>}
        {selectedRecords.length > 0 && <><span>{language === 'zh-CN' ? '已选' : 'Selected'} {selectedRecords.length}</span><button disabled={busy} onClick={() => setSelected([])}>{language === 'zh-CN' ? '清除选择' : 'Clear selection'}</button><button data-primary disabled={busy || selectedRecords.some(record => record.state !== 'pending')} onClick={() => void batch('batch-approve')}>{language === 'zh-CN' ? '采纳所选' : 'Approve selected'}</button><button disabled={busy || selectedRecords.some(record => record.state !== 'pending')} onClick={() => void batch('batch-reject')}>{language === 'zh-CN' ? '拒绝所选' : 'Reject selected'}</button><button disabled={busy} onClick={() => void batch('batch-archive')}>{language === 'zh-CN' ? '归档所选' : 'Archive selected'}</button></>}
      </div>}
      {options.renderExtras?.(props, snapshot, load)}
      {options.renderRecords ? <div key={[props.sourceInstanceKey, props.workspaceId, props.sessionId].join(':')}>{options.renderRecords({ props, records: visible, renderRecord })}</div> : <><div className="mc-list">{visible.slice(0, limit).map(renderRecord)}</div>{visible.length === 0 && <p className="mc-empty">{t.empty}</p>}
      {visible.length > limit && <button onClick={() => setLimit(current => current + 25)}>{language === 'zh-CN' ? '加载更多' : 'Load more'}</button>}</>}
    </section></MemorySourcePageFrame>
  }
}

export { LookupPanel, type LookupPanelOptions } from './lookup-client.tsx'
export { collectionStyles } from './collection-styles.ts'
export { RecordActionPanel, managementError, type RecordActionPanelOptions } from './action-client.tsx'
