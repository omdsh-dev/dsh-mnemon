import { css, useT } from './presentation.ts'
import type { JSX } from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { normalizeEntityKey, type EntityMemoriesView, type EntityRelatedView, type EntityView, type Insight, type MemorySpaceCatalog, type MemoryReadSource } from '../contracts.ts'
import type { MemorySpacesPageClient } from './api.ts'
import { useRequestVersion, appearanceClass, message, PageHeader, SectionSpinner, ProgressiveFooter, EmptyState, SearchField } from 'dsh-mnemon/client'
import { InsightCard, ReadSourcePanel, insightKey } from './widgets.tsx'

const ENTITY_PLACEHOLDER_DELAY_MS = 160
const ENTITY_RAIL_PAGE = 10
const ENTITY_CARD_PAGE = 6
const ENTITY_MEMORY_BATCH = 48
const ENTITY_RELATED_LIMIT = 20
const RELATED_PREFERENCE_KEY = 'dsh-mnemon.memory-spaces.entities.related'

function readRelatedPreference(): boolean {
  try { return globalThis.sessionStorage?.getItem(RELATED_PREFERENCE_KEY) === 'open' } catch { return false }
}

function writeRelatedPreference(open: boolean): void {
  try {
    if (open) globalThis.sessionStorage?.setItem(RELATED_PREFERENCE_KEY, 'open')
    else globalThis.sessionStorage?.removeItem(RELATED_PREFERENCE_KEY)
  } catch { }
}

function useDelayedFlag(active: boolean, delayMs = ENTITY_PLACEHOLDER_DELAY_MS): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!active) { setShown(false); return }
    const timer = setTimeout(() => setShown(true), delayMs)
    return () => clearTimeout(timer)
  }, [active, delayMs])
  return active && shown
}

function InsightSkeletons(props: { count: number }): JSX.Element {
  return <div aria-hidden="true" data-placeholder="">{Array.from({ length: props.count }, (_, index) => <div key={index} className={css.insightSkeleton}><span /><span /><span /></div>)}</div>
}

function EntityFooter(props: { visible: number; total: number; pageSize: number; busy: boolean; onMore: () => void }): JSX.Element | null {
  const t = useT()
  if (props.total === 0) return null
  const remaining = Math.max(0, props.total - props.visible)
  return <div className={css.listProgress}><span>{t('common.showing', { visible: props.visible, total: props.total })}</span>{remaining > 0 && <button type="button" className={css.secondaryButton} disabled={props.busy} aria-busy={props.busy || undefined} onClick={props.onMore}>{t('common.showMore', { count: Math.min(props.pageSize, remaining) })}</button>}</div>
}

function pendingEntitySources(catalog: MemorySpaceCatalog): MemoryReadSource[] {
  return catalog.items.filter(body => body.active && body.providerEnabled !== false).map(body => ({
    memoryBodyId: body.id,
    memoryBodyName: body.name,
    providerId: body.provider.id,
    providerLabel: body.provider.label,
    mode: body.provider.capabilities.entities ? 'entities' : 'unsupported',
    status: body.provider.capabilities.entities ? 'loading' : 'unsupported',
    itemCount: 0,
  }))
}

export function EntitiesPage(props: { client: MemorySpacesPageClient; revision: number; writeEnabled: boolean; onForget: (insight: Insight) => Promise<void>; onExplore: (query: string) => void }): JSX.Element {
  const t = useT()
  const { client } = props
  const [rail, setRail] = useState<EntityView | null>(null)
  const [railLoading, setRailLoading] = useState(true)
  const [railError, setRailError] = useState<string | null>(null)
  const [pendingSources, setPendingSources] = useState<MemoryReadSource[]>([])
  const [entity, setEntity] = useState('')
  const [entityFilter, setEntityFilter] = useState('')
  const [visibleEntityLimit, setVisibleEntityLimit] = useState(ENTITY_RAIL_PAGE)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [memories, setMemories] = useState<EntityMemoriesView | null>(null)
  const [memoriesLoading, setMemoriesLoading] = useState(false)
  const [memoriesError, setMemoriesError] = useState<string | null>(null)
  const [moreLoading, setMoreLoading] = useState(false)
  const [visibleMemoryLimit, setVisibleMemoryLimit] = useState(ENTITY_CARD_PAGE)
  const [related, setRelated] = useState<EntityRelatedView | null>(null)
  const [relatedLoading, setRelatedLoading] = useState(false)
  const [relatedError, setRelatedError] = useState<string | null>(null)
  const [visibleRelatedLimit, setVisibleRelatedLimit] = useState(ENTITY_CARD_PAGE)
  const [relatedOpen, setRelatedOpen] = useState(readRelatedPreference)
  const relatedOpenRef = useRef(relatedOpen)
  const relatedAutoRef = useRef(false)
  const relatedId = useId()
  const railRequests = useRequestVersion()
  const directoryRequests = useRequestVersion()
  const memoryRequests = useRequestVersion()
  const moreRequests = useRequestVersion()
  const relatedRequests = useRequestVersion()
  const selectedRef = useRef<string | undefined>(undefined)
  const revisionRef = useRef(props.revision)
  const [view] = useState(() => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const split = client.entityMemories !== undefined && client.entityRelated !== undefined

  const loadRail = useCallback(async () => {
    const request = railRequests.begin()
    setRailLoading(true); setRailError(null)
    try {
      const view = await client.entities()
      if (railRequests.isCurrent(request)) setRail(view)
    } catch (reason) {
      if (railRequests.isCurrent(request)) setRailError(message(reason))
    } finally {
      if (railRequests.isCurrent(request)) setRailLoading(false)
    }
  }, [client, railRequests])

  const loadRelated = useCallback((name: string) => {
    if (client.entityRelated === undefined) return
    const request = relatedRequests.begin()
    setRelatedLoading(true); setRelatedError(null)
    void client.entityRelated(name, ENTITY_RELATED_LIMIT, view).then(next => {
      if (relatedRequests.isCurrent(request)) setRelated(next)
    }, (reason: unknown) => {
      if (relatedRequests.isCurrent(request)) setRelatedError(message(reason))
    }).finally(() => {
      if (relatedRequests.isCurrent(request)) setRelatedLoading(false)
    })
  }, [client, relatedRequests, view])

  const loadSelection = useCallback((name: string, refresh: boolean) => {
    const memoryRequest = memoryRequests.begin()
    relatedRequests.begin()
    moreRequests.begin()
    setMoreLoading(false)
    setRelatedLoading(false); setRelatedError(null)
    if (!refresh) {
      setMemories(null)
      setVisibleMemoryLimit(ENTITY_CARD_PAGE); setVisibleRelatedLimit(ENTITY_CARD_PAGE)
      relatedAutoRef.current = false
    }
    if (!refresh || !(relatedOpenRef.current || relatedAutoRef.current)) setRelated(null)
    setMemoriesLoading(true); setMemoriesError(null)
    const memoryRead: Promise<EntityMemoriesView> = split
      ? client.entityMemories!(name, 0, ENTITY_MEMORY_BATCH)
      : client.entities(name, 20).then(view => ({ entity: view.selected ?? name, total: view.insights.length, offset: 0, items: view.insights, complete: view.complete ?? true, sources: view.sources ?? [] }))
    void memoryRead.then(next => {
      if (!memoryRequests.isCurrent(memoryRequest)) return
      setMemories(next)
      const auto = split && next.total === 0
      if (auto && !relatedOpenRef.current) loadRelated(name)
      else if (relatedAutoRef.current && !relatedOpenRef.current) setRelated(null)
      relatedAutoRef.current = auto
    }, (reason: unknown) => {
      if (memoryRequests.isCurrent(memoryRequest)) setMemoriesError(message(reason))
    }).finally(() => {
      if (memoryRequests.isCurrent(memoryRequest)) setMemoriesLoading(false)
    })
    if (split && relatedOpenRef.current) loadRelated(name)
  }, [client, loadRelated, memoryRequests, moreRequests, relatedRequests, split])

  const select = (name: string) => {
    const trimmed = name.trim()
    if (trimmed === '') return
    selectedRef.current = trimmed
    setSelected(trimmed)
    setEntity(trimmed)
    loadSelection(trimmed, false)
  }

  useEffect(() => {
    const request = directoryRequests.begin()
    void client.bodyDirectory().then(catalog => {
      if (directoryRequests.isCurrent(request)) setPendingSources(pendingEntitySources(catalog))
    }, () => undefined)
  }, [client, directoryRequests])
  useEffect(() => { void loadRail() }, [loadRail, props.revision])
  useEffect(() => {
    if (revisionRef.current === props.revision) return
    revisionRef.current = props.revision
    if (selectedRef.current !== undefined) loadSelection(selectedRef.current, true)
  }, [loadSelection, props.revision])

  const showMoreMemories = () => {
    const current = memories
    if (current === null || moreLoading) return
    const nextVisible = visibleMemoryLimit + ENTITY_CARD_PAGE
    if (nextVisible <= current.items.length || current.items.length >= current.total || client.entityMemories === undefined) {
      setVisibleMemoryLimit(nextVisible)
      return
    }
    const request = moreRequests.begin()
    setMoreLoading(true)
    void client.entityMemories(current.entity, current.items.length, ENTITY_MEMORY_BATCH).then(page => {
      if (!moreRequests.isCurrent(request)) return
      setMemories(previous => {
        if (previous === null) return previous
        const seen = new Set(previous.items.map(insightKey))
        return { ...page, offset: 0, items: [...previous.items, ...page.items.filter(item => !seen.has(insightKey(item)))] }
      })
      setVisibleMemoryLimit(nextVisible)
    }, (reason: unknown) => {
      if (moreRequests.isCurrent(request)) setMemoriesError(message(reason))
    }).finally(() => {
      if (moreRequests.isCurrent(request)) setMoreLoading(false)
    })
  }

  const findRelated = () => {
    relatedOpenRef.current = true
    setRelatedOpen(true)
    writeRelatedPreference(true)
    if (selected !== undefined && related === null && !relatedLoading) loadRelated(selected)
  }
  const hideRelated = () => {
    relatedOpenRef.current = false
    setRelatedOpen(false)
    writeRelatedPreference(false)
  }

  const forget = async (insight: Insight) => {
    await props.onForget(insight)
    const key = insightKey(insight)
    setMemories(current => {
      const items = current?.items.filter(item => insightKey(item) !== key)
      return current === null || items === undefined || items.length === current.items.length ? current : { ...current, total: Math.max(0, current.total - 1), items }
    })
    setRelated(current => current === null ? current : { ...current, items: current.items.filter(item => insightKey(item) !== key) })
  }

  const submit = (event: FormEvent) => { event.preventDefault(); select(entity) }
  const items = rail?.items ?? []
  const filterKey = entityFilter.trim().toLocaleLowerCase()
  const filteredItems = useMemo(() => filterKey === '' ? items : items.filter(item => item.entity.toLocaleLowerCase().includes(filterKey)), [items, filterKey])
  const visibleEntities = filteredItems.slice(0, visibleEntityLimit)
  const selectedKey = selected === undefined ? undefined : normalizeEntityKey(selected)
  const railCount = selectedKey === undefined ? undefined : items.find(item => normalizeEntityKey(item.entity) === selectedKey)?.count
  const sources = rail?.sources ?? pendingSources
  const hasEntityProvider = sources.length === 0 || sources.some(source => source.mode === 'entities' && source.status !== 'unavailable')
  const railPlaceholder = useDelayedFlag(rail === null && railLoading)
  const memoryPlaceholder = useDelayedFlag(memories === null && memoriesLoading)
  const relatedAuto = memories !== null && memories.total === 0
  const relatedShown = split && (relatedOpen || relatedAuto)
  const relatedPlaceholder = useDelayedFlag(relatedShown && related === null && relatedLoading)
  const railBusy = useDelayedFlag(railLoading)
  const detailBusy = useDelayedFlag(memoriesLoading || (relatedShown && relatedLoading))
  const memoryTotal = memories?.total ?? railCount
  const visibleMemories = memories?.items.slice(0, visibleMemoryLimit) ?? []
  const visibleRelated = related?.items.slice(0, visibleRelatedLimit) ?? []
  const nothingFound = memories !== null && memories.total === 0 && (!split || (related !== null && related.items.length === 0))
  const card = (insight: Insight) => <InsightCard key={insightKey(insight)} insight={insight} writeEnabled={props.writeEnabled} onForget={forget} onRelated={() => props.onExplore(insight.content)} />

  return (
    <div className={css.page}>
      <PageHeader title={t('entities.title')} description={t('entities.description')} {...(rail === null ? {} : { meta: t('entities.count', { count: rail.total ?? rail.items.length }) })} {...(railBusy ? { loadingLabel: t('entities.railLoading') } : {})} />
      <ReadSourcePanel title={t('entities.sourcesTitle')} sources={sources} />
      {rail !== null && !hasEntityProvider
        ? <EmptyState glyph="◎" title={t('entities.unsupportedTitle')}>{t('entities.unsupportedText')}</EmptyState>
        : <div className={css.entityLayout}>
        <aside className={css.entityRail} aria-busy={rail === null && railLoading ? true : undefined}>
          <form className={css.entitySearch} onSubmit={submit}><SearchField label={t('entities.nameAria')} value={entity} onChange={event => { setEntity(event.target.value); setEntityFilter(event.target.value); setVisibleEntityLimit(ENTITY_RAIL_PAGE) }} onKeyDown={event => { if (event.key === 'Escape' && entityFilter !== '') { event.preventDefault(); setEntityFilter('') } }} placeholder={t('entities.placeholder')} /><button type="submit" className={css.secondaryButton} disabled={entity.trim() === ''}>{t('entities.action')}</button></form>
          <div className={css.entityHeading}><span>{t('entities.top')}</span><small>{entityFilter === '' ? t('entities.frequency') : t('entities.filterHint')}</small></div>
          {railPlaceholder && <div className={css.entityList} aria-hidden="true" data-placeholder="">{Array.from({ length: 8 }, (_, index) => <span key={index} className={css.entityRailSkeleton} />)}</div>}
          <div className={css.entityList}>{visibleEntities.map(item => <button key={item.entity} type="button" aria-pressed={selectedKey === normalizeEntityKey(item.entity)} onClick={() => select(item.entity)}><span>{item.entity}</span><strong>{item.count}</strong></button>)}</div>
          {visibleEntities.length > 0 && filteredItems.length > visibleEntityLimit && <ProgressiveFooter compact visible={visibleEntities.length} total={filteredItems.length} pageSize={ENTITY_RAIL_PAGE} onMore={() => setVisibleEntityLimit(value => value + ENTITY_RAIL_PAGE)} />}
          {rail === null && railError !== null && <div className={appearanceClass(css.inlineError, css.entityRetry)} role="alert"><span>{railError}</span><button type="button" className={css.secondaryButton} onClick={() => void loadRail()}>{t('entities.retry')}</button></div>}
          {rail !== null && items.length === 0 && <p className={css.muted}>{t('entities.emptyRail')}</p>}
          {rail !== null && items.length > 0 && visibleEntities.length === 0 && entityFilter !== '' && <p className={css.muted}>{t('entities.filterEmpty')}</p>}
        </aside>
        <section className={appearanceClass(css.entityResults, css.asyncResults)} aria-busy={memoriesLoading || (relatedShown && relatedLoading) ? true : undefined}>
          {detailBusy && selected !== undefined && <SectionSpinner label={t('entities.loading')} />}
          {selected === undefined && <EmptyState glyph="◎" title={t('entities.selectTitle')}>{t('entities.selectText')}</EmptyState>}
          {selected !== undefined && nothingFound && <EmptyState glyph="0" title={t('entities.emptyTitle')}>{t('entities.emptyText')}</EmptyState>}
          {selected !== undefined && !nothingFound && <>
            <div className={css.entitySection}>
              <div className={css.sectionHeading}><div><h3>{memories?.entity ?? selected}</h3><span>{t('entities.memoriesHint')}</span></div>{memoryTotal !== undefined && <strong>{memoryTotal}</strong>}</div>
              <div className={css.entitySectionBody}>
                {memoriesError !== null && <div className={appearanceClass(css.inlineError, css.entityRetry)} role="alert"><span>{memoriesError}</span><button type="button" className={css.secondaryButton} onClick={() => loadSelection(selected, memories !== null)}>{t('entities.retry')}</button></div>}
                {memoryPlaceholder && <InsightSkeletons count={Math.min(3, Math.max(1, railCount ?? 3))} />}
                {memories !== null && memories.total === 0 && <p className={css.entityQuiet}>{t('entities.noCarrying')}</p>}
                {visibleMemories.map(card)}
                {memories !== null && <EntityFooter visible={visibleMemories.length} total={memories.total} pageSize={ENTITY_CARD_PAGE} busy={moreLoading} onMore={showMoreMemories} />}
              </div>
            </div>
            {split && <div className={css.entitySection}>
              <div className={css.entityRelatedHead}>
                <div className={css.sectionHeading}><div><h3 id={`${relatedId}-title`}>{t('entities.relatedTitle')}</h3><span>{t('entities.relatedHint')}</span></div>{relatedShown && related !== null && <strong>{related.items.length}</strong>}</div>
                {!relatedAuto && <button type="button" className={css.secondaryButton} aria-expanded={relatedShown} aria-controls={`${relatedId}-list`} onClick={relatedShown ? hideRelated : findRelated}>{t(relatedShown ? 'entities.hideRelated' : 'entities.findRelated')}</button>}
              </div>
              <div id={`${relatedId}-list`} role="region" aria-labelledby={`${relatedId}-title`} className={css.entitySectionBody} hidden={!relatedShown}>
                {relatedShown && <>
                  {relatedError !== null && <div className={appearanceClass(css.inlineError, css.entityRetry)} role="alert"><span>{relatedError}</span><button type="button" className={css.secondaryButton} onClick={() => loadRelated(selected)}>{t('entities.retry')}</button></div>}
                  {relatedPlaceholder && <InsightSkeletons count={2} />}
                  {related !== null && related.items.length === 0 && <p className={css.entityQuiet}>{t('entities.noRelated')}</p>}
                  {visibleRelated.map(card)}
                  {related !== null && <ProgressiveFooter visible={visibleRelated.length} total={related.items.length} pageSize={ENTITY_CARD_PAGE} onMore={() => setVisibleRelatedLimit(value => value + ENTITY_CARD_PAGE)} />}
                </>}
              </div>
            </div>}
          </>}
        </section>
      </div>}
    </div>
  )
}
