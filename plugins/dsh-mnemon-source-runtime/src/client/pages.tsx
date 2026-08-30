import type { JSX } from 'react'
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { type RuntimeMemoryEntry, type RuntimeMemoryImportance, type RuntimeMemorySnapshot, type RuntimeMemoryTarget } from '../contracts.ts'
import type { RuntimePageClient } from './api.ts'
import { type MnemonKey, appearanceClass, useMnemonViewAppearance, memoryPageStyles as css, useT, useLocale, humanBytes, message, parseBranchesInput, PageHeader, ProgressiveFooter, SidebarModal } from 'dsh-mnemon/client'

export function RuntimePage(props: { client: RuntimePageClient; revision: number; writeEnabled: boolean; onMutate: () => void }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const appearance = useMnemonViewAppearance()
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
  const mutate = async (request: Parameters<RuntimePageClient['mutateRuntimeMemory']>[0]) => {
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
      if (appearance.surface === 'sidebar') setAdding(false)
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
  const runtimeEditActionClass = appearance.surface === 'sidebar'
    ? appearanceClass(css.ghostButton, appearanceClass(appearance.classes.itemActionButton, appearance.classes.itemEditAction))
    : css.ghostButton
  const runtimeRemoveActionClass = appearance.surface === 'sidebar'
    ? appearanceClass(css.dangerButton, appearanceClass(appearance.classes.itemActionButton, appearance.classes.itemDangerAction))
    : css.dangerButton

  const runtimeEntry = (entry: RuntimeMemoryEntry, showTarget = false) => {
    const key = entryKey(entry)
    const isEditing = editing === key
    const isInlineEditing = appearance.surface === 'buildin' && isEditing
    const isRemoving = removing === key
    const isInlineRemoving = appearance.surface === 'buildin' && isRemoving
    return <article key={key} className={css.runtimeEntry} data-importance={entry.importance} data-target={entry.target}>
      <div className={css.runtimeEntryMeta}>{showTarget ? <div className={css.runtimeEntryBadges}><span className={css.runtimeEntryTarget}>{entry.target === 'user' ? 'USER.md' : 'MEMORY.md'}</span><span>{t(`runtime.importance.${entry.importance}` as MnemonKey)}</span>{entry.branches !== undefined && entry.branches.length > 0 && <span className={css.runtimeEntryBranch} title={t('runtime.branchBadge')}>{entry.branches.join(', ')}</span>}</div> : <><span>{t(`runtime.importance.${entry.importance}` as MnemonKey)}</span>{entry.branches !== undefined && entry.branches.length > 0 && <span className={css.runtimeEntryBranch} title={t('runtime.branchBadge')}>{entry.branches.join(', ')}</span>}</>}<time dateTime={entry.updated_at}>{new Date(entry.updated_at).toLocaleString(locale)}</time></div>
      {isInlineEditing ? <textarea aria-label={t('runtime.editContent')} value={editContent} onChange={event => setEditContent(event.target.value)} rows={4} /> : <p>{entry.content}</p>}
      {isInlineEditing && <select aria-label={t('runtime.importance')} value={editImportance} onChange={event => setEditImportance(event.target.value as RuntimeMemoryImportance)}><option value="critical">{t('runtime.importance.critical')}</option><option value="normal">{t('runtime.importance.normal')}</option><option value="low">{t('runtime.importance.low')}</option></select>}
      <footer>
        {isInlineRemoving ? <><span>{t('runtime.removeConfirm')}</span><button type="button" className={css.dangerSolidButton} disabled={saving} onClick={() => void remove(entry)}>{t('runtime.removeAction')}</button><button type="button" className={css.ghostButton} onClick={() => setRemoving(null)}>{t('common.cancel')}</button></> : isInlineEditing ? <><button type="button" className={css.primaryButton} disabled={saving || editContent.trim() === ''} onClick={() => void replace(entry)}>{t('runtime.saveEdit')}</button><button type="button" className={css.ghostButton} onClick={() => setEditing(null)}>{t('common.cancel')}</button></> : props.writeEnabled ? <><button type="button" className={runtimeEditActionClass} disabled={saving && isRemoving} onClick={() => beginEdit(entry)}>{t('runtime.editAction')}</button><button type="button" className={runtimeRemoveActionClass} disabled={saving && isRemoving} onClick={() => { setRemoving(key); setEditing(null) }}>{t('runtime.removeAction')}</button></> : null}
      </footer>
    </article>
  }

  const targetPanel = (value: RuntimeMemoryTarget) => {
    const view = snapshot?.targets[value]
    const entries = snapshot?.entries.filter(entry => entry.target === value) ?? []
    const percentage = view === undefined || view.limit === 0 ? 0 : Math.min(100, Math.round(view.used / view.limit * 100))
    return (
      <section className={css.runtimeTarget} aria-label={t(`runtime.target.${value}` as MnemonKey)}>
        <header className={css.runtimeTargetHeader}>
          <div><span>{value === 'user' ? 'USER.md' : 'MEMORY.md'}</span><h3>{t(`runtime.target.${value}` as MnemonKey)}</h3></div>
          <strong>{view?.entryCount ?? 0}</strong>
        </header>
        <div className={css.capacityLine}><div><i style={{ width: `${percentage}%` }} /></div><span>{view === undefined ? '—' : `${humanBytes(view.used)} / ${humanBytes(view.limit)}`}</span></div>
        <p className={css.runtimeTargetDescription}>{t(`runtime.target.${value}.description` as MnemonKey)}</p>
        <div className={css.runtimeEntries}>
          {entries.map(entry => runtimeEntry(entry))}
          {!loading && entries.length === 0 && <div className={css.runtimeEmpty}><span>○</span><p>{t('runtime.empty')}</p></div>}
        </div>
      </section>
    )
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
    <div className={css.runtimeComposerActions}><label>{t('runtime.target')}<select value={target} onChange={event => setTarget(event.target.value as RuntimeMemoryTarget)}><option value="memory">{t('runtime.target.memory')}</option><option value="user">{t('runtime.target.user')}</option></select></label><label>{t('runtime.importance')}<select value={importance} onChange={event => setImportance(event.target.value as RuntimeMemoryImportance)}><option value="critical">{t('runtime.importance.critical')}</option><option value="normal">{t('runtime.importance.normal')}</option><option value="low">{t('runtime.importance.low')}</option></select></label>{target === 'memory' && <label className={css.runtimeComposerBranch}>{t('runtime.branches')}<input value={branches} onChange={event => setBranches(event.target.value)} placeholder={t('runtime.branchesPlaceholder')} aria-label={t('runtime.branches')} /></label>}{appearance.surface === 'buildin' && <button type="submit" className={css.primaryButton} disabled={saving || content.trim() === ''}>{saving ? t('runtime.saving') : t('runtime.addAction')}</button>}</div>
  </form>
  const editingEntry = editing === null ? undefined : snapshot?.entries.find(entry => entryKey(entry) === editing)
  const removingEntry = removing === null ? undefined : snapshot?.entries.find(entry => entryKey(entry) === removing)
  const editForm = editingEntry === undefined ? null : <form id={runtimeEditFormId} className={css.bodyEdit} onSubmit={event => { event.preventDefault(); void replace(editingEntry) }}>
    <label>{t('runtime.editContent')}<textarea aria-label={t('runtime.editContent')} value={editContent} onChange={event => setEditContent(event.target.value)} rows={7} /></label>
    <label>{t('runtime.importance')}<select aria-label={t('runtime.importance')} value={editImportance} onChange={event => setEditImportance(event.target.value as RuntimeMemoryImportance)}><option value="critical">{t('runtime.importance.critical')}</option><option value="normal">{t('runtime.importance.normal')}</option><option value="low">{t('runtime.importance.low')}</option></select></label>
    {editingEntry.target === 'memory' && <label className={css.bodyEditBranch}>{t('runtime.branches')}<input value={editBranches} onChange={event => setEditBranches(event.target.value)} placeholder={t('runtime.branchesPlaceholder')} aria-label={t('runtime.branches')} /><small>{t('runtime.branchesHint')}</small></label>}
    {appearance.surface === 'buildin' && <div className={css.bodyEditActions}><button type="button" className={css.ghostButton} disabled={saving} onClick={() => setEditing(null)}>{t('common.cancel')}</button><button type="submit" className={css.primaryButton} disabled={saving || editContent.trim() === ''}>{t('runtime.saveEdit')}</button></div>}
  </form>

  return (
    <div className={css.page}>
      <PageHeader title={t('runtime.title')} description={t('runtime.description')} meta={snapshot === null ? t('common.loading') : t('runtime.total', { count: snapshot.entries.length })} action={<><button type="button" className={css.secondaryButton} disabled={loading} onClick={() => void load()}>{t('runtime.refresh')}</button>{appearance.surface === 'sidebar' && props.writeEnabled && <button type="button" className={css.primaryButton} onClick={() => setAdding(true)}>{t('runtime.addButton')}</button>}</>} />
      {error !== null && <div className={css.inlineError} role="alert">{error}</div>}
      {notice !== null && <div className={css.runtimeNotice} role="status">{notice}</div>}
      {props.writeEnabled && appearance.surface === 'buildin' && composer}
      {!props.writeEnabled && <div className={css.runtimeReadOnly}>{t('runtime.readOnly')}</div>}
      {appearance.surface === 'buildin' ? <div className={css.runtimeGrid}>{targetPanel('user')}{targetPanel('memory')}</div> : <>
        <div className={css.runtimeSummaryGrid}>{targetSummary('user')}{targetSummary('memory')}</div>
        <section className={css.runtimeBrowser} aria-label={t('runtime.entriesAria')}>
          <div className={css.runtimeBrowserToolbar}>
            <div className={css.runtimeScopeFilter} role="group" aria-label={t('runtime.scopeAria')}><button type="button" data-active={filterTarget === 'all' || undefined} onClick={() => setFilterTarget('all')}>{t('runtime.scopeAll')} <b>{snapshot?.entries.length ?? 0}</b></button><button type="button" data-active={filterTarget === 'user' || undefined} onClick={() => setFilterTarget('user')}>{t('runtime.target.user')} <b>{snapshot?.targets.user.entryCount ?? 0}</b></button><button type="button" data-active={filterTarget === 'memory' || undefined} onClick={() => setFilterTarget('memory')}>{t('runtime.target.memory')} <b>{snapshot?.targets.memory.entryCount ?? 0}</b></button></div>
            <div className={css.runtimeFilterQuery}><span aria-hidden="true">⌕</span><input aria-label={t('runtime.filterAria')} value={filterQuery} onChange={event => setFilterQuery(event.target.value)} placeholder={t('runtime.filterPlaceholder')} /></div>
          </div>
          <div className={css.runtimeUnifiedList}>{visibleEntries.map(entry => runtimeEntry(entry, true))}{!loading && filteredEntries.length === 0 && <div className={css.runtimeEmpty}><span>○</span><p>{t('runtime.noMatch')}</p></div>}</div>
          {!loading && <ProgressiveFooter visible={visibleEntries.length} total={filteredEntries.length} pageSize={pageSize} onMore={() => setVisibleLimit(value => value + pageSize)} />}
        </section>
      </>}
      <p className={css.runtimeFootnote}>{t('runtime.footnote')}</p>
      {appearance.surface === 'sidebar' && adding && <SidebarModal title={t('runtime.addTitle')} description={t('runtime.addDescription')} busy={saving} onClose={closeComposer} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.ghostButton} disabled={saving} onClick={closeComposer}>{t('common.cancel')}</button><button type="submit" form={runtimeAddFormId} className={css.primaryButton} disabled={saving || content.trim() === ''}>{saving ? t('runtime.saving') : t('runtime.addAction')}</button></div>}>{composer}</SidebarModal>}
      {appearance.surface === 'sidebar' && editingEntry !== undefined && <SidebarModal title={t('runtime.editContent')} description={t(`runtime.target.${editingEntry.target}` as MnemonKey)} busy={saving} onClose={() => setEditing(null)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.ghostButton} disabled={saving} onClick={() => setEditing(null)}>{t('common.cancel')}</button><button type="submit" form={runtimeEditFormId} className={css.primaryButton} disabled={saving || editContent.trim() === ''}>{t('runtime.saveEdit')}</button></div>}>{editForm}</SidebarModal>}
      {appearance.surface === 'sidebar' && removingEntry !== undefined && <SidebarModal title={t('runtime.removeTitle')} description={t(`runtime.target.${removingEntry.target}` as MnemonKey)} busy={saving} onClose={() => setRemoving(null)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close data-autofocus className={css.ghostButton} disabled={saving} onClick={() => setRemoving(null)}>{t('common.cancel')}</button><button type="button" className={css.dangerSolidButton} disabled={saving} onClick={() => void remove(removingEntry)}>{t('runtime.removeAction')}</button></div>}><div className={css.bodyDeleteConfirm}><p>{t('runtime.removeWarning')}</p><div className={css.bodyDeleteSummary}><p className={css.bodyDeleteContent}>{removingEntry.content}</p><span>{t(`runtime.importance.${removingEntry.importance}` as MnemonKey)}</span></div></div></SidebarModal>}
    </div>
  )
}
