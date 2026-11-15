import { css, sidebarCss, useT } from './presentation.ts'
import type { JSX } from 'react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { MarkdownText, PathLabel, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { type DocumentRecord, type DocumentSnapshot, type DocumentView } from '../contracts.ts'
import type { DocumentsPageClient } from './api.ts'
import { useRequestVersion, appearanceClass, useLocale, humanBytes, message, PageHeader, ProgressiveFooter, Reveal, SectionSpinner, SidebarModal, EmptyState, SearchField } from 'dsh-mnemon/client'

const canRenderMarkdown = typeof MarkdownText === 'function' || (typeof MarkdownText === 'object' && MarkdownText !== null)
const canRenderPathLabel = typeof PathLabel === 'function' || (typeof PathLabel === 'object' && PathLabel !== null)

function PathText(props: { path: string }): JSX.Element {
  return canRenderPathLabel ? <PathLabel path={props.path} /> : <>{props.path}</>
}

/** Render managed Markdown through the official DSH Markdown pipeline without raw HTML or unsafe links. */
function DocumentMarkdown(props: { content: string }): JSX.Element {
  const locale = useLocale()
  const labels = useMemo<MarkdownLabels>(() => {
    const zh = locale.startsWith('zh')
    return {
      code: { copyLabel: zh ? '复制' : 'Copy', copiedLabel: zh ? '已复制' : 'Copied' },
      footnotes: zh ? '脚注' : 'Footnotes',
    }
  }, [locale])
  return (
    <div className={css.markdownBody}>
      {canRenderMarkdown ? <MarkdownText text={props.content} labels={labels} /> : props.content}
    </div>
  )
}

type DocumentListItem = DocumentRecord & { healthy?: boolean; excerpt: string }

export function DocumentsPage(props: { client: DocumentsPageClient; revision: number; writeEnabled: boolean; sessionId?: string; canCreate?: boolean; documentId?: string; onMutate?: () => void }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const documentCreateFormId = useId()
  const documentEditFormId = useId()
  const pageSize = 8
  const readerRef = useRef<HTMLElement | null>(null)
  const [snapshot, setSnapshot] = useState<DocumentSnapshot | null>(null)
  const [loadedRevision, setLoadedRevision] = useState(props.revision)
  const [items, setItems] = useState<DocumentListItem[]>([])
  const [visibleLimit, setVisibleLimit] = useState(pageSize)
  const [selectedId, setSelectedId] = useState<string | null>(props.documentId ?? null)
  const [selected, setSelected] = useState<DocumentView | null>(null)
  const [failedSelectedId, setFailedSelectedId] = useState<string | null>(null)
  const [status, setStatus] = useState<'active' | 'archived'>('active')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ document: DocumentView; revision: string } | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [sources, setSources] = useState('')
  const displayRequests = useRequestVersion()
  const snapshotRef = useRef<DocumentSnapshot | null>(null)
  snapshotRef.current = snapshot
  const selectedRef = useRef<DocumentView | null>(null)
  selectedRef.current = selected
  const revisionRef = useRef(props.revision)
  revisionRef.current = props.revision
  const fetchedSignatureRef = useRef<string | null>(null)
  const queryRef = useRef(query)
  queryRef.current = query
  const statusRef = useRef(status)
  statusRef.current = status
  const activeSearchRef = useRef(false)

  const adoptMutatedDocument = useCallback((candidate: unknown) => {
    if (typeof candidate === 'object' && candidate !== null && 'content' in candidate && typeof (candidate as { content: unknown }).content === 'string') {
      const view = candidate as DocumentView
      selectedRef.current = view
      if (view.fileRevision !== undefined || props.client.deleteDocument === undefined) {
        fetchedSignatureRef.current = `${revisionRef.current}:${view.id}:${view.revision}:${view.contentHash}`
      }
      setSelected(view)
    }
  }, [props.client.deleteDocument])

  const display = useCallback(async (
    nextQuery: string,
    nextStatus: 'active' | 'archived',
    preferred?: { id: string; document?: unknown },
    reloadIndex = false,
  ) => {
    const request = displayRequests.begin()
    activeSearchRef.current = nextQuery.trim() !== ''
    setLoading(true); setError(null); setVisibleLimit(pageSize)
    try {
      let current: DocumentSnapshot
      let records: DocumentListItem[]
      if (nextQuery.trim() === '') {
        current = await props.client.documents()
        records = current.documents
      } else if (snapshotRef.current !== null && !reloadIndex) {
        // Reuse the loaded index and merge searched record metadata/revision in place
        // without issuing a sequential snapshot RPC waterfall.
        const existing = snapshotRef.current
        const searchResponse = await props.client.searchDocuments(nextQuery, nextStatus === 'archived')
        const byId = new Map(searchResponse.results.map(item => [item.id, item]))
        const mergedDocuments: DocumentSnapshot['documents'] = existing.documents.map(document => {
          const hit = byId.get(document.id)
          return hit === undefined ? document : { ...document, ...hit, healthy: document.healthy }
        })
        for (const item of searchResponse.results) {
          if (!existing.documents.some(document => document.id === item.id)) {
            mergedDocuments.push({ ...item, healthy: true })
          }
        }
        current = {
          ...existing,
          ...(typeof searchResponse.revision === 'string' ? { revision: searchResponse.revision } : {}),
          documents: mergedDocuments,
        }
        records = searchResponse.results
      } else {
        const [searchResponse, loadedSnapshot] = await Promise.all([
          props.client.searchDocuments(nextQuery, nextStatus === 'archived'),
          props.client.documents(),
        ])
        current = typeof searchResponse.revision === 'string'
          ? { ...loadedSnapshot, revision: searchResponse.revision }
          : loadedSnapshot
        records = searchResponse.results
      }
      const filtered = records.filter(record => record.status === nextStatus)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      if (!displayRequests.isCurrent(request)) return
      const refreshStamp = revisionRef.current
      snapshotRef.current = current
      setSnapshot(current)
      setLoadedRevision(refreshStamp)
      setItems(filtered)
      if (preferred?.document !== undefined && filtered.some(record => record.id === preferred.id)) {
        adoptMutatedDocument(preferred.document)
      }
      setSelectedId(previous => {
        const candidate = preferred?.id ?? previous
        return candidate !== null && filtered.some(record => record.id === candidate) ? candidate : filtered[0]?.id ?? null
      })
    } catch (reason) {
      if (!displayRequests.isCurrent(request)) return
      snapshotRef.current = null
      setError(message(reason)); setSnapshot(null); setItems([]); setSelectedId(null)
    } finally {
      if (displayRequests.isCurrent(request)) setLoading(false)
    }
  }, [adoptMutatedDocument, displayRequests, pageSize, props.client])

  useEffect(() => { void display(queryRef.current, statusRef.current, undefined, true) }, [display, props.revision])
  useEffect(() => {
    if (selectedId === null) {
      setSelected(null)
      return
    }
    if (snapshot === null) return
    const record = snapshot.documents.find(document => document.id === selectedId)
    if (record === undefined) {
      setSelected(null)
      return
    }
    const currentSelected = selectedRef.current
    const recordSignature = `${loadedRevision}:${record.id}:${record.revision}:${record.contentHash}`
    if (
      currentSelected !== null
      && currentSelected.id === record.id
      && fetchedSignatureRef.current === recordSignature
      && currentSelected.revision === record.revision
      && currentSelected.contentHash === record.contentHash
      && currentSelected.updatedAt === record.updatedAt
      && currentSelected.status === record.status
      && currentSelected.title === record.title
      && currentSelected.description === record.description
    ) {
      return
    }
    let active = true
    const requestRevision = loadedRevision
    setFailedSelectedId(null)
    void props.client.document(selectedId).then(value => {
      if (!active) return
      fetchedSignatureRef.current = `${requestRevision}:${value.id}:${value.revision}:${value.contentHash}`
      selectedRef.current = value
      setSelected(value)
    }).catch(reason => {
      if (!active) return
      setFailedSelectedId(selectedId)
      setError(message(reason))
    })
    return () => { active = false }
  }, [loadedRevision, props.client, selectedId, snapshot])
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
  const changeStatus = (nextStatus: 'active' | 'archived') => {
    if (status === nextStatus) return
    setStatus(nextStatus)
    void display(query, nextStatus)
  }

  const create = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setNotice(null)
    try {
      const result = await props.client.mutateDocument({ action: 'create', title, description, content, sourcePaths: sourcePaths(sources) })
      setNotice(result.maintenance === undefined ? t('documents.created') : t('documents.createdAfterArchive', { count: result.maintenance.archivedDocumentIds.length }))
      setStatus('active'); setQuery(''); resetComposer()
      await display('', 'active', { id: result.document.id, document: result.document })
      props.onMutate?.()
    } catch (reason) { setError(message(reason)) } finally { setSaving(false) }
  }

  const activeSelected = selected !== null && selected.id === selectedId ? selected : null
  const loadingSelected = selectedId !== null && failedSelectedId !== selectedId && (selected === null || selected.id !== selectedId) && items.some(item => item.id === selectedId)

  const beginEdit = () => {
    if (activeSelected === null) return
    setTitle(activeSelected.title); setDescription(activeSelected.description); setContent(activeSelected.content); setSources(activeSelected.sourcePaths.join('\n')); setEditing(true); setComposing(false); setConfirmArchive(false)
  }

  const update = async (event: FormEvent) => {
    event.preventDefault()
    if (activeSelected === null) return
    setSaving(true); setError(null); setNotice(null)
    try {
      const result = await props.client.mutateDocument({ action: 'update', id: activeSelected.id, title, description, content, sourcePaths: sourcePaths(sources) })
      setNotice(result.maintenance === undefined ? t('documents.updated') : t('documents.updatedAfterArchive', { count: result.maintenance.archivedDocumentIds.length }))
      setEditing(false)
      await display(query, status, { id: result.document.id, document: result.document })
      props.onMutate?.()
    } catch (reason) { setError(message(reason)) } finally { setSaving(false) }
  }

  const archive = async () => {
    if (activeSelected === null) return
    setSaving(true); setError(null); setNotice(null)
    try {
      const result = await props.client.archiveDocument(activeSelected.id)
      // A local archive keeps the original without an index in any Memory Space.
      const spaces = result.maintenance?.memoryBodyIds ?? []
      setNotice(spaces.length === 0 ? t('documents.archivedLocally') : t('documents.archived', { spaces: spaces.join(', ') }))
      setConfirmArchive(false); setStatus('archived'); setQuery('')
      await display('', 'archived', { id: result.document.id, document: result.document })
      props.onMutate?.()
    } catch (reason) { setError(message(reason)) } finally { setSaving(false) }
  }

  const remove = async () => {
    if (!props.writeEnabled || deleteTarget?.document.fileRevision === undefined || props.client.deleteDocument === undefined) return
    setSaving(true); setDeleteError(null); setError(null); setNotice(null)
    try {
      await props.client.deleteDocument(deleteTarget.document.id, deleteTarget.revision, deleteTarget.document.fileRevision)
      setDeleteTarget(null); setSelected(null); setSelectedId(null)
      setNotice(t('documents.deleted'))
      await display(query, status)
      props.onMutate?.()
    } catch (reason) { setDeleteError(message(reason)) } finally { setSaving(false) }
  }

  const usage = snapshot === null ? 0 : Math.min(100, snapshot.activeBytes / snapshot.limitBytes * 100)
  const activeCount = snapshot?.activeCount ?? 0
  const archivedCount = snapshot?.archivedCount ?? 0
  const selectedRecord = snapshot?.documents.find(document => document.id === activeSelected?.id)
  const selectedIsCurrent = activeSelected?.fileRevision !== undefined && selectedRecord?.revision === activeSelected.revision
    && selectedRecord.contentHash === activeSelected.contentHash && selectedRecord.status === activeSelected.status
  const composer = <form id={documentCreateFormId} className={css.documentEditor} onSubmit={event => void create(event)}>
    <header><div><h3>{t('documents.newTitle')}</h3><p>{t('documents.editorHint')}</p></div><span>{t('documents.managedCopy')}</span></header>
    <div className={css.documentEditorMeta}><label>{t('documents.name')}<input value={title} onChange={event => setTitle(event.target.value)} required /></label><label>{t('documents.routing')}<input value={description} onChange={event => setDescription(event.target.value)} /></label></div>
    <label>{t('documents.sources')}<input value={sources} onChange={event => setSources(event.target.value)} placeholder={t('documents.sourcesPlaceholder')} /></label>
    <label>{t('documents.markdown')}<textarea value={content} onChange={event => setContent(event.target.value)} rows={10} required /></label>
  </form>
  const editComposer = activeSelected === null ? null : <form id={documentEditFormId} className={css.documentEditor} onSubmit={event => void update(event)}>
    <header><div><h3>{t('documents.editTitle')}</h3><p>{t('documents.editorHint')}</p></div><code>{activeSelected.id}</code></header>
    <div className={css.documentEditorMeta}><label>{t('documents.name')}<input value={title} onChange={event => setTitle(event.target.value)} required /></label><label>{t('documents.routing')}<input value={description} onChange={event => setDescription(event.target.value)} /></label></div>
    <label>{t('documents.sources')}<input value={sources} onChange={event => setSources(event.target.value)} /></label><label>{t('documents.markdown')}<textarea value={content} onChange={event => setContent(event.target.value)} rows={18} required /></label>
  </form>
  const documentEditActionClass = appearanceClass(css.ghostButton, appearanceClass(sidebarCss.itemActionButton, sidebarCss.itemEditAction))
  const documentArchiveActionClass = appearanceClass(css.dangerButton, appearanceClass(sidebarCss.itemActionButton, sidebarCss.itemDangerAction))
  const visibleItems = items.slice(0, visibleLimit)
  const selectDocument = (documentId: string) => {
    if (selectedId === documentId) return
    setSelected(null)
    setFailedSelectedId(null)
    setSelectedId(documentId)
    setEditing(false)
    setConfirmArchive(false)
    setDeleteTarget(null)
  }

  return (
    <div className={css.page}>
      <PageHeader title={t('documents.title')} description={t('documents.description')} meta={snapshot === null ? t('common.loading') : t('documents.capacity', { used: humanBytes(snapshot.activeBytes), limit: humanBytes(snapshot.limitBytes) })} {...(props.writeEnabled && (props.canCreate ?? props.sessionId !== undefined) ? { action: <button type="button" className={css.primaryButton} onClick={startComposer}>{t('documents.new')}</button> } : {})} />
      <Reveal>{error === null ? null : <div className={css.inlineError} role="alert">{error}</div>}</Reveal>
      <Reveal>{notice === null ? null : <div className={css.runtimeNotice} role="status">{notice}</div>}</Reveal>

      <section className={css.documentSummary} aria-label={t('documents.summary')}>
        <article><span>{t('documents.active')}</span><strong>{activeCount}</strong><small>{t('documents.activeHint')}</small></article>
        <article><span>{t('documents.archivedCount')}</span><strong>{archivedCount}</strong><small>{t('documents.archivedHint')}</small></article>
        <article className={css.documentCapacity}><span>{t('documents.activeCapacity')}</span><strong>{snapshot === null ? '—' : `${usage.toFixed(1)}%`}</strong><div><i style={{ width: `${usage}%` }} /></div><small>{t('documents.capacityHint')}</small></article>
      </section>

      <section className={css.documentToolbar}>
        <form onSubmit={event => { event.preventDefault(); void display(query, status) }}><SearchField className={css.documentSearch} label={t('documents.searchAria')} value={query} onChange={event => {
          const next = event.target.value
          const hadQuery = query.trim() !== ''
          setQuery(next)
          if (hadQuery && next === '' && activeSearchRef.current) {
            void display('', status)
          }
        }} placeholder={t('documents.searchPlaceholder')} /><button type="submit" className={css.secondaryButton}>{t('documents.search')}</button></form>
        <div role="group" aria-label={t('documents.scope')}
          style={{ '--dsh-segment-count': 2, '--dsh-segment-index': status === 'active' ? 0 : 1 } as CSSProperties}>
          <button type="button" data-active={status === 'active' || undefined} onClick={() => changeStatus('active')}>{t('documents.active')} <b>{activeCount}</b></button>
          <button type="button" data-active={status === 'archived' || undefined} onClick={() => changeStatus('archived')}>{t('documents.archivedCount')} <b>{archivedCount}</b></button>
        </div>

      </section>



      <div className={css.documentWorkspace}>
        <aside className={css.documentList} aria-label={t('documents.list')}>
          <header><span>{status === 'active' ? t('documents.activeList') : t('documents.archiveList')}</span><code>{items.length}</code></header>
          {visibleItems.map(document => <button type="button" key={document.id} aria-pressed={selectedId === document.id} data-selected={selectedId === document.id || undefined} onClick={() => selectDocument(document.id)}><div><strong>{document.title}</strong><time dateTime={document.createdAt}>{new Date(document.createdAt).toLocaleDateString(locale)}</time></div><p>{document.description || document.excerpt || t('documents.noDescription')}</p><footer><span>{humanBytes(document.sizeBytes)}</span>{document.healthy === false && <em>{t('documents.missing')}</em>}</footer></button>)}
          {!loading && <ProgressiveFooter compact visible={visibleItems.length} total={items.length} pageSize={pageSize} onMore={() => setVisibleLimit(value => value + pageSize)} />}
          {!loading && items.length === 0 && <div className={css.documentListEmpty}><span>▤</span><strong>{status === 'active' ? t('documents.emptyActive') : t('documents.emptyArchived')}</strong><p>{status === 'active' ? t('documents.emptyActiveText') : t('documents.emptyArchivedText')}</p></div>}
          {loading && <div className={css.loading}>{t('common.loading')}</div>}
        </aside>

        <section ref={readerRef} className={css.documentReader} aria-label={t('documents.reader')} data-scroll-region={''}>
          {activeSelected !== null ? (<article className={css.documentDetail}>
            <header><div><span>{activeSelected.status === 'active' ? t('documents.active') : t('documents.coldArchive')}</span><h3>{activeSelected.title}</h3><p>{activeSelected.description || t('documents.noDescription')}</p></div><div className={css.documentActions}>{props.writeEnabled && activeSelected.status === 'active' && <button type="button" className={documentEditActionClass} onClick={beginEdit}>{t('documents.edit')}</button>}{props.writeEnabled && props.client.deleteDocument !== undefined && snapshot !== null && <button type="button" className={documentArchiveActionClass} disabled={!selectedIsCurrent} onClick={() => { setDeleteError(null); setDeleteTarget({ document: activeSelected, revision: snapshot.revision }) }}>{t('documents.delete')}</button>}</div></header>
            <dl><div><dt>{t('documents.path')}</dt><dd><code><PathText path={activeSelected.relativePath} /></code></dd></div><div><dt>{t('documents.revision')}</dt><dd>{activeSelected.revision}</dd></div><div><dt>{t('documents.hash')}</dt><dd><code>{activeSelected.contentHash.slice(0, 16)}</code></dd></div><div><dt>{t('documents.size')}</dt><dd>{humanBytes(activeSelected.sizeBytes)}</dd></div></dl>
            {activeSelected.sourcePaths.length > 0 && <div className={css.documentSources}><span>{t('documents.sources')}</span>{activeSelected.sourcePaths.map(path => <code key={path}><PathText path={path} /></code>)}</div>}
            {activeSelected.status === 'archived' && <div className={css.documentArchiveReceipt}><strong>{t(activeSelected.memoryBodyIds.length === 0 ? 'documents.archiveNote' : 'documents.archiveReceipt')}</strong><p>{activeSelected.archiveSummary}</p><div>{activeSelected.memoryBodyIds.map(id => <code key={id}>{id}</code>)}</div></div>}
            <DocumentMarkdown content={activeSelected.content} />
            {props.writeEnabled && activeSelected.status === 'active' && <footer className={css.documentDanger}>{<><div><strong>{t('documents.archiveTitle')}</strong><p>{t('documents.archiveDescription')}</p></div><button type="button" className={documentArchiveActionClass} onClick={() => setConfirmArchive(true)}>{t('documents.archive')}</button></>}</footer>}
          </article>) : loadingSelected || (loading && items.length === 0) ? (
            <div className={css.loading}><SectionSpinner label={t('common.loading')} /><span>{t('common.loading')}</span></div>
          ) : (
            <EmptyState glyph="▤" title={t('documents.selectTitle')}>{t('documents.selectText')}</EmptyState>
          )}
        </section>
      </div>
      {composing && <SidebarModal title={t('documents.newTitle')} description={t('documents.editorHint')} busy={saving} onClose={resetComposer} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.secondaryButton} disabled={saving} onClick={resetComposer}>{t('common.cancel')}</button><button type="submit" form={documentCreateFormId} className={css.primaryButton} disabled={saving || title.trim() === '' || content.trim() === ''}>{saving ? t('documents.saving') : t('documents.create')}</button></div>}>{composer}</SidebarModal>}
      {editing && activeSelected !== null && <SidebarModal title={t('documents.editTitle')} description={activeSelected.title} busy={saving} onClose={() => setEditing(false)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close className={css.secondaryButton} disabled={saving} onClick={() => setEditing(false)}>{t('common.cancel')}</button><button type="submit" form={documentEditFormId} className={css.primaryButton} disabled={saving}>{saving ? t('documents.saving') : t('documents.save')}</button></div>}>{editComposer}</SidebarModal>}
      {confirmArchive && activeSelected !== null && <SidebarModal title={t('documents.archiveConfirm')} description={activeSelected.title} busy={saving} onClose={() => setConfirmArchive(false)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close data-autofocus className={css.secondaryButton} disabled={saving} onClick={() => setConfirmArchive(false)}>{t('common.cancel')}</button><button type="button" className={css.dangerSolidButton} disabled={saving} onClick={() => void archive()}>{saving ? t('documents.archiving') : t('documents.archiveNow')}</button></div>}><div className={css.bodyDeleteConfirm}><p>{t('documents.archiveDescription')}</p><div className={css.bodyDeleteSummary}><strong>{activeSelected.title}</strong><span>{activeSelected.relativePath} · {humanBytes(activeSelected.sizeBytes)}</span></div></div></SidebarModal>}
      {deleteTarget !== null && props.writeEnabled && <SidebarModal title={t('documents.deleteConfirm')} description={deleteTarget.document.title} busy={saving} onClose={() => setDeleteTarget(null)} footer={<div className={css.modalFooterActions}><button type="button" data-dialog-close data-autofocus className={css.secondaryButton} disabled={saving} onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</button><button type="button" className={css.dangerSolidButton} disabled={saving} onClick={() => void remove()}>{saving ? t('documents.deleting') : t('documents.deleteNow')}</button></div>}><div className={css.bodyDeleteConfirm}>{deleteError !== null && <div className={css.inlineError} role="alert">{deleteError}</div>}<p>{t('documents.deleteDescription')}</p><div className={css.bodyDeleteSummary}><strong>{deleteTarget.document.title}</strong><span>{deleteTarget.document.relativePath} · {humanBytes(deleteTarget.document.sizeBytes)}</span></div></div></SidebarModal>}
    </div>
  )
}
