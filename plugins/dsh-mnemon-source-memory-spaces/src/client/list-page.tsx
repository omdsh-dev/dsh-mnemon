import { css, useT } from './presentation.ts'
import type { JSX } from 'react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { CATEGORIES, type Category, type Insight, type MemoryListView } from '../contracts.ts'
import type { MemorySpacesPageClient } from './api.ts'
import { message, PageHeader, SectionSpinner, ProgressiveFooter, EmptyState, SearchField, SelectField } from 'dsh-mnemon/client'
import { InsightCard, ReadSourcePanel, categoryLabel, insightKey } from './widgets.tsx'

export function ListPage(props: { client: MemorySpacesPageClient; revision: number; writeEnabled: boolean; onForget: (insight: Insight) => Promise<void>; onClone: (insight: Insight) => void; onExplore: (query: string) => void }): JSX.Element {
  const t = useT()
  const pageSize = 12
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category | ''>('')
  const [view, setView] = useState<MemoryListView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [visibleLimit, setVisibleLimit] = useState(pageSize)
  const [selectedBodyId, setSelectedBodyId] = useState<string | undefined>()

  const load = useCallback(async (overrideQuery?: string) => {
    const effectiveQuery = overrideQuery ?? query
    setLoading(true); setError(null)
    try { setView(await props.client.list({ ...(effectiveQuery.trim() === '' ? {} : { query: effectiveQuery }), ...(category === '' ? {} : { category }), limit: 1000 })) } catch (reason) { setError(message(reason)) } finally { setLoading(false) }
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
      <form className={css.listToolbar} onSubmit={submit}><SearchField label={t('content.filterAria')} value={query} onChange={event => {
        const next = event.target.value
        const hadQuery = query !== ''
        setQuery(next)
        if (hadQuery && next === '') {
          setVisibleLimit(pageSize)
          void load('')
        }
      }} placeholder={t('content.filterPlaceholder')} /><SelectField hideLabel label={t('content.categoryAria')} value={category} options={[{ value: '' as Category | '', label: t('common.allCategories') }, ...CATEGORIES.map(value => ({ value, label: categoryLabel(t, value) }))]} onChange={setCategory} /><button type="submit" className={css.secondaryButton} disabled={loading}>{loading ? t('common.loading') : t('content.apply')}</button></form>
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
