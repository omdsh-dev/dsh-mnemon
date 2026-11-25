import { css, MnemonTooltip, useT } from './presentation.ts'
import type { JSX } from 'react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CATEGORIES, type Category, type Insight, type MemoryReadSource } from '../contracts.ts'
import type { MemorySpacesPageClient } from './api.ts'
import { useRequestVersion, message, short, PageHeader, SectionSpinner, ProgressiveFooter, EmptyState, SearchField, SelectField } from 'dsh-mnemon/client'
import { InsightCard, ReadSourcePanel, categoryLabel, insightKey } from './widgets.tsx'

export interface MemorySpacesPageStatus { defaultRecallLimit?: number }

export function ExplorePage(props: { client: MemorySpacesPageClient; agentClient: MemorySpacesPageClient; agentAvailable: boolean; status: MemorySpacesPageStatus | null; seed: string; writeEnabled: boolean; onForget: (insight: Insight) => Promise<void>; onRevealElement?(element: HTMLElement): void }): JSX.Element {
  const t = useT()
  const pageSize = 6
  const [query, setQuery] = useState(props.seed)
  const [mode, setMode] = useState<'smart' | 'keyword' | 'basic'>('smart')
  const [category, setCategory] = useState<Category | ''>('')
  const [results, setResults] = useState<Insight[]>([])
  const [sources, setSources] = useState<MemoryReadSource[]>([])
  const [searchKind, setSearchKind] = useState<'direct' | 'agent' | null>(null)
  const [agentAnswer, setAgentAnswer] = useState<{ answer: string; citations: string[]; runId: string } | null>(null)
  const citationLabel = (citation: string): string => {
    const cited = results.find(result => `${result.memoryBodyId}/${result.id}` === citation || result.id === citation)
    return cited === undefined ? short(citation.split('/').at(-1) ?? citation, 12) : short(cited.content, 40)
  }
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [relatedTo, setRelatedTo] = useState<{ insight: Insight; request: number } | null>(null)
  const relatedPaneRef = useRef<HTMLElement | null>(null)
  const [related, setRelated] = useState<Insight[]>([])
  const [relatedLoading, setRelatedLoading] = useState(false)
  const [visibleResultLimit, setVisibleResultLimit] = useState(pageSize)
  const [visibleRelatedLimit, setVisibleRelatedLimit] = useState(pageSize)
  const relatedRequests = useRequestVersion()

  useEffect(() => { if (props.seed !== '') setQuery(props.seed) }, [props.seed])
  const ranSeed = useRef('')
  useEffect(() => {
    if (props.seed === '' || props.status === null || ranSeed.current === props.seed) return
    ranSeed.current = props.seed
    void runSearch(false, props.seed)
  }, [props.seed, props.status])
  useEffect(() => {
    if (relatedTo === null || props.onRevealElement === undefined) return
    const reveal = () => {
      if (relatedPaneRef.current !== null && relatedRequests.isCurrent(relatedTo.request)) props.onRevealElement?.(relatedPaneRef.current)
    }
    if (typeof window.requestAnimationFrame !== 'function') { reveal(); return }
    const frame = window.requestAnimationFrame(reveal)
    return () => { if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame) }
  }, [relatedTo, relatedRequests, props.onRevealElement])

  const runSearch = async (withAgent: boolean, text = query) => {
    if (text.trim() === '') return
    relatedRequests.begin()
    setSearchKind(withAgent ? 'agent' : 'direct'); setSearched(true); setError(null); setRelatedTo(null); setAgentAnswer(null); setVisibleResultLimit(pageSize); setVisibleRelatedLimit(pageSize)
    try {
      const request = { query: text, mode, ...(category === '' ? {} : { category }), limit: props.status?.defaultRecallLimit ?? 10 }
      if (withAgent) {
        const response = await props.agentClient.agentSearch(request)
        setResults(response.results)
        setSources(response.sources ?? [])
        setAgentAnswer({ answer: response.answer, citations: response.citations, runId: response.delegation.runId })
      } else {
        const response = await props.client.search(request)
        setResults(response.results)
        setSources(response.sources ?? [])
      }
    } catch (reason) {
      setError(message(reason)); setResults([]); setSources([]); setAgentAnswer(null)
    } finally {
      setSearchKind(null)
    }
  }

  const search = (event: FormEvent) => { event.preventDefault(); void runSearch(false) }
  const searching = searchKind !== null

  const showRelated = async (insight: Insight) => {
    const request = relatedRequests.begin()
    setRelatedTo({ insight, request }); setRelated([]); setRelatedLoading(true); setError(null); setVisibleRelatedLimit(pageSize)
    try {
      const response = await props.client.related(insight.id, insight.memoryBodyId)
      if (relatedRequests.isCurrent(request)) setRelated(response)
    } catch (reason) {
      if (relatedRequests.isCurrent(request)) setError(message(reason))
    } finally {
      if (relatedRequests.isCurrent(request)) setRelatedLoading(false)
    }
  }

  const forget = async (insight: Insight) => {
    await props.onForget(insight)
    setResults(items => items.filter(item => insightKey(item) !== insightKey(insight)))
    setRelated(items => items.filter(item => insightKey(item) !== insightKey(insight)))
    if (relatedTo !== null && insightKey(relatedTo.insight) === insightKey(insight)) setRelatedTo(null)
  }
  const visibleResults = results.slice(0, visibleResultLimit)
  const visibleRelated = related.slice(0, visibleRelatedLimit)

  return (
    <div className={css.page}>
      <PageHeader title={t('search.title')} description={t('search.description')} meta={t('search.maxResults', { count: props.status?.defaultRecallLimit ?? '—' })} />
      <form className={css.searchBar} onSubmit={event => void search(event)}>
        <SearchField className={css.queryField} label={t('search.queryAria')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('search.placeholder')} />
        <div className={css.searchControls}>
          <div className={css.searchFilters}>
            <SelectField inline className={css.searchChoice} label={t('common.category')} ariaLabel={t('search.categoryAria')} value={category} options={[{ value: '' as Category | '', label: t('common.allCategories') }, ...CATEGORIES.map(value => ({ value, label: categoryLabel(t, value) }))]} onChange={setCategory} />
            <SelectField inline className={css.searchChoice} label={t('search.strategy')} ariaLabel={t('search.modeAria')} value={mode} options={[{ value: 'smart', label: t('search.modeSmart') }, { value: 'keyword', label: t('search.modeKeyword') }, { value: 'basic', label: t('search.modeBasic') }]} onChange={setMode} />
          </div>
          <div className={css.searchActions}><button type="submit" className={css.secondaryButton} disabled={searching || query.trim() === ''}>{searchKind === 'direct' ? t('search.searching') : t('search.action')}</button><button type="button" className={css.primaryButton} disabled={searching || query.trim() === '' || !props.agentAvailable} onClick={() => void runSearch(true)}>{searchKind === 'agent' ? t('search.agentSearching') : t('search.agentAction')}</button></div>
        </div>
      </form>
      <ReadSourcePanel title={t('search.sourcesTitle')} sources={sources} />
      <div className={css.asyncResults}>
      {searching && <SectionSpinner label={searchKind === 'agent' ? t('search.agentSearching') : t('search.searching')} />}
      {agentAnswer !== null && <section className={css.agentAnswer} aria-label={t('search.agentAnswer')}><div className={css.agentAnswerHeading}><div><span>{t('search.agentAnswerHint')}</span><h3>{t('search.agentAnswer')}</h3></div></div><p>{agentAnswer.answer}</p>{agentAnswer.citations.length > 0 && <div className={css.agentCitations}><small>{t('search.citations')}</small>{agentAnswer.citations.map((citation, index) => <MnemonTooltip key={citation} label={citation} side="top"><span>{index + 1}. {citationLabel(citation)}</span></MnemonTooltip>)}</div>}</section>}
      {error !== null && <div className={css.inlineError} role="alert">{error}</div>}
      {!searched && <EmptyState glyph="⌕" title={t('search.startTitle')}>{t('search.startText')}</EmptyState>}
      {searched && !searching && results.length === 0 && error === null && <EmptyState glyph="0" title={t('search.emptyTitle')}>{t('search.emptyText')}</EmptyState>}
      {results.length > 0 && (
        <div className={relatedTo === null ? css.singleColumn : css.resultLayout}>
          <section className={css.results}><div className={css.sectionHeading}><div><h3>{t('search.results')}</h3></div><strong>{results.length}</strong></div>{visibleResults.map(insight => <InsightCard key={insightKey(insight)} insight={insight} writeEnabled={props.writeEnabled} onForget={forget} onRelated={item => void showRelated(item)} />)}{<ProgressiveFooter visible={visibleResults.length} total={results.length} pageSize={pageSize} onMore={() => setVisibleResultLimit(value => value + pageSize)} />}</section>
          {relatedTo !== null && <aside ref={relatedPaneRef} className={css.relatedPane}><div className={css.sectionHeading}><div><h3>{t('search.related')}</h3></div><button type="button" onClick={() => { relatedRequests.begin(); setRelatedTo(null); setRelatedLoading(false) }} aria-label={t('search.closeRelated')}>×</button></div><p className={css.relatedSource}>{relatedTo.insight.content}</p>{relatedLoading && <div className={css.loading}>{t('search.traversing')}</div>}{!relatedLoading && related.length === 0 && <div className={css.muted}>{t('search.noRelated')}</div>}{visibleRelated.map(insight => <InsightCard key={insightKey(insight)} insight={insight} writeEnabled={props.writeEnabled} onForget={forget} onRelated={item => void showRelated(item)} />)}{!relatedLoading && <ProgressiveFooter visible={visibleRelated.length} total={related.length} pageSize={pageSize} onMore={() => setVisibleRelatedLimit(value => value + pageSize)} />}</aside>}
        </div>
      )}
      </div>
    </div>
  )
}
