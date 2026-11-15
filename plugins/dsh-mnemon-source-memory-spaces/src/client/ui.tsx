import { css, SafeReveal, sidebarCss, supportsSettingsSection, useT } from './presentation.ts'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import * as mnemonClient from 'dsh-mnemon/client'
import {
  createMemorySourcePageClient, installMemorySourceUI, MemorySourcePageFrame, translateEn, message, PageHeader,
  appearanceClass, type MemoryComponentUIContext, type MemorySourcePageProps, type MnemonSourceManagementClient, type MnemonTranslate,
} from 'dsh-mnemon/client'
import type { Insight, MemorySpaceMetadataUpdate, MemorySpacesStatus, MemorySpaceView } from '../contracts.ts'
import { OverviewPage, ExplorePage, EntitiesPage, RememberPage, ListPage, PersistenceStrategyDialog, type MemoryPlacementPageConfig } from './pages.tsx'
import type { MemorySpacesPageClient } from './api.ts'
import { cleanJson } from './placement-policy.tsx'
import { installMemorySpacesSettings, yieldsComponentSettings } from './settings.tsx'

/** The adapter never gets a transport or chooses another Source instance. */
export function memorySpacesPageClient(management: MnemonSourceManagementClient): MemorySpacesPageClient & { status(): Promise<MemorySpacesStatus>; canAssist(operation: string): boolean } {
  const client = createMemorySourcePageClient(management)
  const input = cleanJson
  return {
    canAssist: client.canAssist,
    status: () => client.read('status-summary', null, { coalesce: true }),
    bodies: () => client.read('bodies', null, { coalesce: true }),
    bodyDirectory: () => client.read('body-directory', null, { coalesce: true }),
    graph: memoryBodyIds => client.read('graph', input({ memoryBodyIds }), { coalesce: true }),
    list: request => client.read('list', input(request ?? {})),
    entities: (entity, limit) => client.read('entities', input({ entity, limit })),
    entityMemories: (entity, offset, limit) => client.read('entity-memories', input({ entity, offset, limit })),
    entityRelated: (entity, limit, view) => client.read('entity-related', input({ entity, limit, view })),
    // The page's own searches look at memory; Ask Agent below uses it.
    search: request => client.read('search', input({ ...request, inspect: true })),
    related: (id, memoryBodyId) => client.read('related', input({ id, memoryBodyId })),
    reconnectBody: memoryBodyId => client.read('body-reconnect', { memoryBodyId }),
    remember: request => client.mutate('remember', input(request), true),
    forget: (id, memoryBodyId) => client.mutate('forget', input({ id, memoryBodyId }), true),
    createBody: request => request.placement !== undefined && client.canAssist('body-create') ? client.assist('body-create', input(request), true) : client.mutate('body-create', input(request), true),
    updateBody: (memoryBodyId, request) => typeof request.active === 'boolean' && Object.keys(request).every(key => key === 'active') && client.canAssist('activation')
      ? client.assist('activation', { memoryBodyId, active: request.active }, true) : client.mutate('body-update', input({ memoryBodyId, ...request }), true),
    deleteBody: memoryBodyId => client.mutate('body-delete', { memoryBodyId }, true),
    rediscoverBodies: () => client.mutate('provider-rediscover', { trigger: 'manual' }, true),
    agentSearch: request => client.assist('agent-search', input(request), false),
    supervise: (content, idempotencyKey) => client.assist('supervise', input({ content, idempotencyKey }), true),
    maintainBodyMetadata: memoryBodyIds => client.assist('body-metadata-maintain', { memoryBodyIds }, true),
  }
}

const rememberedPages = new WeakMap<MnemonSourceManagementClient, Page>()

type Page = 'spaces' | 'explore' | 'entities' | 'remember' | 'content'
const TABS = [{ id: 'spaces', key: 'nav.overview' }, { id: 'explore', key: 'nav.search' }, { id: 'content', key: 'nav.content' }, { id: 'entities', key: 'nav.entities' }] as const

function MemorySpacesSourceView(props: MemorySourcePageProps & { page: Page }): JSX.Element | null {
  const t = useT()
  const client = useMemo(() => props.management === undefined ? undefined : memorySpacesPageClient(props.management), [props.management])
  const [revision, setRevision] = useState(0)
  const [status, setStatus] = useState<MemorySpacesStatus | null>(null)
  const [page, setPage] = useState<Page>(() => props.management !== undefined ? rememberedPages.get(props.management) ?? (props.page === 'remember' ? 'spaces' : props.page) : props.page)
  const [seed, setSeed] = useState('')
  const [rememberOpen, setRememberOpen] = useState(props.page === 'remember')
  const [strategyOpen, setStrategyOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const headerRef = useRef<HTMLElement | null>(null)
  const revealElement = useCallback((element: HTMLElement) => {
    props.onRevealElement?.(element, (headerRef.current?.getBoundingClientRect().height ?? 0) + 14)
  }, [props.onRevealElement])
  const lastRefreshKey = useRef(props.refreshKey)
  const suppressRefreshEcho = useRef(false)
  const [reloads, setReloads] = useState(0)
  const notifyParentRefresh = useCallback(() => {
    if (props.onRefresh === undefined) return
    suppressRefreshEcho.current = true
    props.onRefresh()
    setTimeout(() => { suppressRefreshEcho.current = false }, 0)
  }, [props.onRefresh])
  const refresh = useCallback(() => {
    setRevision(value => value + 1)
    notifyParentRefresh()
  }, [notifyParentRefresh])
  const handleBodyReconnect = useCallback((body: MemorySpaceView) => {
    setStatus(current => current === null || current.memoryBodies === undefined ? current : {
      ...current,
      memoryBodies: current.memoryBodies.map(item => item.id === body.id ? body : item),
    })
  }, [])
  const handleBodyMetadata = useCallback((updates: readonly MemorySpaceMetadataUpdate[]) => {
    setStatus(current => {
      if (current === null || current.memoryBodies === undefined) return current
      const byId = new Map(updates.map(update => [update.memoryBodyId, update]))
      return {
        ...current,
        memoryBodies: current.memoryBodies.map(item => {
          const update = byId.get(item.id)
          return update === undefined ? item : { ...item, name: update.title, description: update.description }
        }),
      }
    })
    notifyParentRefresh()
  }, [notifyParentRefresh])
  // The workspace's refresh reloads these pages as well, the directory included;
  // a change made here reloads only what it touched without echoing refreshKey.
  useEffect(() => {
    if (lastRefreshKey.current === props.refreshKey) return
    lastRefreshKey.current = props.refreshKey
    if (suppressRefreshEcho.current) {
      suppressRefreshEcho.current = false
      return
    }
    setRevision(value => value + 1)
    setReloads(value => value + 1)
  }, [props.refreshKey])
  useEffect(() => {
    setPage(props.management !== undefined && props.navigationInput === undefined ? rememberedPages.get(props.management) ?? (props.page === 'remember' ? 'spaces' : props.page) : props.page === 'remember' ? 'spaces' : props.page)
    setRememberOpen(props.page === 'remember')
    const value = props.navigationInput
    setSeed(typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.seed === 'string' ? value.seed : '')
  }, [props.page, props.navigationInput])
  useEffect(() => { if (props.management !== undefined) rememberedPages.set(props.management, page) }, [props.management, page])
  useLayoutEffect(() => { props.onResetScroll?.() }, [page, props.onResetScroll])
  useEffect(() => {
    let active = true
    setError(null)
    void client?.status().then(value => { if (active) setStatus(value) }).catch(reason => { if (active) setError(message(reason)) })
    return () => { active = false }
  }, [client, revision])
  if (client === undefined) return null
  const writable = props.writable === true && status?.writeEnabled === true
  const activationEnabled = status?.writeEnabled === true && (writable || client.canAssist('activation'))
  const agentAvailable = client.canAssist('supervise')
  const explore = (query: string) => { setSeed(query); setPage('explore') }
  const remember = (content = '') => { setSeed(content); setRememberOpen(true) }
  const forget = async (insight: Insight) => { await client.forget(insight.id, insight.memoryBodyId); refresh() }
  const bodies = status?.memoryBodies ?? []
  const preferences = props.preferences
  const policySettingsAvailable = props.onOpenSettings !== undefined && supportsSettingsSection('policy')
  const showStrategyAction = policySettingsAvailable || preferences !== undefined
  const openStrategy = () => {
    if (policySettingsAvailable) props.onOpenSettings!('policy')
    else setStrategyOpen(true)
  }
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentIndex = TABS.findIndex(tab => tab.id === page)
    if (currentIndex < 0) return
    let nextIndex = -1
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % TABS.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = TABS.length - 1
    else return
    event.preventDefault()
    const nextTab = TABS[nextIndex]!
    setPage(nextTab.id)
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons[nextIndex]?.focus()
  }
  return <>
    <section className={sidebarCss.memoryWorkspace} ref={headerRef}>
      <PageHeader title={t('nav.spaces')} description={t('overview.description')} {...(writable ? {} : { meta: activationEnabled ? t('common.activationOnly') : t('common.readOnly') })} action={<div className={css.memoryHeaderActions}><button type="button" className={appearanceClass(css.primaryButton, sidebarCss.memoryWriteButton)} disabled={!writable} onClick={() => remember()}>{t('nav.rememberAction')}</button>{showStrategyAction && <button type="button" className={css.secondaryButton} onClick={openStrategy}>{t('strategy.action')}</button>}</div>} />
      <div className={sidebarCss.memoryNavigation}><div className={sidebarCss.memoryTabs} role="tablist" aria-label={t('nav.memory.aria')} onKeyDown={onTabKeyDown}>{TABS.map(tab => <button key={tab.id} type="button" role="tab" tabIndex={page === tab.id ? 0 : -1} aria-selected={page === tab.id} data-active={page === tab.id ? '' : undefined} onClick={() => setPage(tab.id)}>{t(tab.key)}</button>)}</div></div>
    </section>
    <SafeReveal className={css.workspaceErrorReveal}>{error !== null && <div className={css.inlineError} role="alert">{error}</div>}</SafeReveal>
    {page === 'spaces' && <OverviewPage active={props.active ?? true} client={client} metadataClient={client} revision={revision} reloadKey={reloads} activationEnabled={activationEnabled} writeEnabled={writable} agentAvailable={agentAvailable} fallbackBodies={bodies} fallbackDirectory={status?.memoryBodyDirectory} catalogKnown={status?.memoryBodies !== undefined} onMutate={refresh} onAgentRefresh={refresh} onBodyReconnect={handleBodyReconnect} onBodyMetadata={handleBodyMetadata} onExplore={explore} {...(props.onOpenSettings === undefined ? {} : { onOpenSettings: props.onOpenSettings })} />}
    {page === 'explore' && <ExplorePage client={client} agentClient={client} agentAvailable={client.canAssist('agent-search')} status={status} seed={seed} writeEnabled={writable} onForget={forget} onRevealElement={revealElement} />}
    {page === 'entities' && <EntitiesPage client={client} revision={revision} writeEnabled={writable} onForget={forget} onExplore={explore} />}
    {page === 'content' && <ListPage client={client} revision={revision} writeEnabled={writable} onForget={forget} onClone={insight => remember(insight.content)} onExplore={explore} />}
    {rememberOpen && <RememberPage client={client} agentAvailable={agentAvailable} memoryBodies={bodies} writeEnabled={writable} seed={seed} embeddingManaged={status?.embeddingManaged} onMutate={refresh} onClose={() => setRememberOpen(false)} onView={() => { setRememberOpen(false); setPage('content') }} />}
    {strategyOpen && preferences !== undefined && <PersistenceStrategyDialog client={client} settingsScope={{ setPath: async (path, value) => {
      if (path.length !== 1 || path[0] !== 'persistenceStrategy') throw new Error('Preference path is outside this Source')
      await preferences.replace(cleanJson({ persistenceStrategy: value }))
    } }} config={preferences.value as unknown as MemoryPlacementPageConfig} writable={preferences.writable} agentAvailable={agentAvailable} onClose={() => setStrategyOpen(false)} />}
  </>
}

export function MemorySpacesSourcePage(props: MemorySourcePageProps & { page: Page }): ReactNode {
  return <MemorySourcePageFrame locale={props.locale}><MemorySpacesSourceView key={props.sourceInstanceKey} {...props} /></MemorySourcePageFrame>
}

export function installMemorySpacesUI(ctx: Parameters<typeof installMemorySourceUI>[0], t: MnemonTranslate = translateEn): () => void {
  const pages = [
    { id: 'spaces', key: 'nav.spaces', order: 300, glyph: '◇' },
    { id: 'remember', key: 'nav.rememberAction', order: 400, glyph: '+' },
    { id: 'explore', key: 'nav.search', order: 500, glyph: '⌕' },
    { id: 'entities', key: 'nav.entities', order: 600, glyph: '◎' },
    { id: 'content', key: 'nav.content', order: 700, glyph: '≡' },
  ] as const
  return installMemorySourceUI(ctx, { sourceTypeId: 'memory-spaces', pages: pages.map(page => ({
    id: page.id, order: page.order, label: () => t(page.key),
    // This Source pins its compound title/tab header; nested page headings scroll with their content.
    navigation: { stickyHeader: false, group: page.id === 'spaces' ? 'storage' : 'tools', primary: page.id === 'spaces', glyph: page.glyph },
    component: props => <MemorySpacesSourcePage {...props} page={page.id} />,
  })) })
}

export const inject = ['slots', 'locale']
export function apply(ctx: Parameters<typeof installMemorySourceUI>[0] & MemoryComponentUIContext): void {
  installMemorySpacesUI(ctx, ctx.locale!.bind('mnemon'))
  if (yieldsComponentSettings(mnemonClient)) installMemorySpacesSettings(ctx)
}
