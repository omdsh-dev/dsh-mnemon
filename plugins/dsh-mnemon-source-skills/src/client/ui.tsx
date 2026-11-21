import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { installMemorySourceUI, MemorySourcePageFrame, PageHeader, Reveal, type MemorySourcePageProps } from 'dsh-mnemon/client'
import type { SkillsOverview } from '../contracts.ts'
import { skillsPageClient, type SkillsPageClient } from './api.ts'
import { EvalsPage } from './evals-page.tsx'
import { EvolutionPage } from './evolution-page.tsx'
import { MarketPage } from './market-page.tsx'
import { css, errorText, sidebarCss, translate, useT } from './presentation.ts'
import { SkillsPage } from './skills-page.tsx'
import { TrashPage } from './trash-page.tsx'
import { installSkillUseBridge, isDirectSkillUseActive, requestSkillUse, type SkillUseRuntimeContext } from './use-skill.tsx'

export type SkillsTab = 'skills' | 'evolution' | 'evals' | 'market' | 'trash'
export type EvolutionFilter = 'pending' | 'done' | 'evidence'

export interface SkillsLocation {
  tab: SkillsTab
  skillKey?: string
  skillName?: string
  suggestionId?: string
  draftId?: string
  trajectoryId?: string
  steps?: number[]
  filter?: EvolutionFilter
  nonce?: number
}

export interface EvolutionState {
  on: boolean
  enable?: () => Promise<void>
}

export interface SkillsPageContext {
  client: SkillsPageClient
  writable: boolean
  revision: number
  configRevision?: number
  overview?: SkillsOverview | null
  refresh(): void
  navigate(location: SkillsLocation): void
  notice(text: string): void
  fail(error: unknown): void
  useSkill(name: string): void
  evolution: EvolutionState | undefined
  openSettings?: (section?: string) => void
  sessionId?: string
}

const TABS: readonly SkillsTab[] = ['skills', 'evolution', 'evals', 'market', 'trash']
const POLL_MS = 3_000
const FOCUS_COOLDOWN_MS = 500
const NOTICE_MS = 5_000
const FILTERS: readonly EvolutionFilter[] = ['pending', 'done', 'evidence']

function seedLocation(input: MemorySourcePageProps['navigationInput']): SkillsLocation | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || typeof input.seed !== 'string') return undefined
  const nonce = typeof input.nonce === 'number' ? input.nonce : Date.now()
  const [kind, ...rest] = input.seed.split(':')
  const value = rest.join(':')
  if (kind === 'evolution') return { tab: 'evolution', filter: (FILTERS as readonly string[]).includes(value) ? value as EvolutionFilter : 'pending', nonce }
  if (kind === 'evals') return { tab: 'evals', ...(value === '' ? {} : { skillName: value }), nonce }
  if (value === '') return undefined
  if (kind === 'skill') return { tab: 'skills', skillKey: value, nonce }
  if (kind === 'name') return { tab: 'skills', skillName: value, nonce }
  if (kind === 'suggestion') return { tab: 'evolution', suggestionId: value, nonce }
  if (kind === 'draft') return { tab: 'evolution', draftId: value, nonce }
  if (kind === 'trajectory') return { tab: 'evolution', filter: 'evidence', trajectoryId: value, nonce }
  return undefined
}

let rememberedTab: SkillsTab = 'skills'

function SkillsView(props: MemorySourcePageProps & { management: NonNullable<MemorySourcePageProps['management']> }): JSX.Element {
  const t = useT()
  const client = useMemo(() => skillsPageClient(props.management), [props.management])
  const [location, setLocation] = useState<SkillsLocation>(() => seedLocation(props.navigationInput) ?? { tab: rememberedTab })
  const [revision, setRevision] = useState(0)
  const [configRevision, setConfigRevision] = useState(0)
  const [overview, setOverview] = useState<SkillsOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const pollRefresh = useCallback(() => {
    client.beginReadWave?.(() => setRevision(value => value + 1))
    setRevision(value => value + 1)
  }, [client])
  const refresh = useCallback(() => {
    client.beginReadWave?.(() => setRevision(value => value + 1))
    setRevision(value => value + 1)
    setConfigRevision(value => value + 1)
  }, [client])
  const refreshKey = useRef(props.refreshKey)
  useEffect(() => {
    if (refreshKey.current === props.refreshKey) return
    refreshKey.current = props.refreshKey
    client.invalidatePreferences?.()
    refresh()
  }, [client, props.refreshKey, refresh])
  useEffect(() => {
    const seeded = seedLocation(props.navigationInput)
    if (seeded !== undefined) setLocation(seeded)
  }, [props.navigationInput])
  useEffect(() => { rememberedTab = location.tab }, [location.tab])
  useLayoutEffect(() => { props.onResetScroll?.() }, [location.tab, props.onResetScroll])
  useEffect(() => {
    let active = true
    void client.overview().then(value => { if (active) setOverview(value) }).catch(reason => { if (active) setError(errorText(reason)) })
    return () => { active = false }
  }, [client, revision])
  const busy = overview !== null && (overview.counts.runsRunning > 0 || overview.counts.drafting > 0)
  const wasBusy = useRef(false)
  useEffect(() => {
    if (props.active === false) return
    if (wasBusy.current && !busy && client.markWaveIdleAndCheckStale?.() === true) pollRefresh()
    wasBusy.current = busy
    if (!busy) return
    const timer = setInterval(pollRefresh, POLL_MS)
    return () => clearInterval(timer)
  }, [busy, client, pollRefresh, props.active])
  const lastFocusRefreshAt = useRef(0)
  useEffect(() => {
    if (props.active === false) return
    const resume = (): void => {
      if (document.visibilityState === 'hidden') return
      const now = Date.now()
      if (now - lastFocusRefreshAt.current < FOCUS_COOLDOWN_MS) return
      lastFocusRefreshAt.current = now
      client.invalidatePreferences?.()
      refresh()
    }
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [client, refresh, props.active])
  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])
  const preferences = props.preferences
  const evolution = useMemo<EvolutionState | undefined>(() => {
    const value = preferences?.value
    if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof value.evolution !== 'boolean') return undefined
    return { on: value.evolution, ...(preferences!.writable ? { enable: () => preferences!.replace({ evolution: true }) } : {}) }
  }, [preferences])

  const tRef = useRef(t)
  tRef.current = t
  const returnToConversationRef = useRef(props.onReturnToConversation)
  returnToConversationRef.current = props.onReturnToConversation
  const sessionIdRef = useRef(props.sessionId)
  sessionIdRef.current = props.sessionId
  const navigate = useCallback((next: SkillsLocation) => setLocation({ ...next, nonce: Date.now() }), [])
  const showNotice = useCallback((text: string) => { setNotice(text); setError(null) }, [])
  const fail = useCallback((reason: unknown) => { setError(errorText(reason)); setNotice(null) }, [])
  const useSkill = useCallback((name: string) => {
    const taken = requestSkillUse(name, sessionIdRef.current)
    const returnToConversation = returnToConversationRef.current
    if (returnToConversation !== undefined && (taken || !isDirectSkillUseActive())) returnToConversation()
    else if (taken) { setNotice(tRef.current('skills.used', { name })); setError(null) }
    else { setError(tRef.current('skills.noConversation')); setNotice(null) }
  }, [])

  const context = useMemo<SkillsPageContext>(() => ({
    client,
    writable: props.writable !== false,
    revision,
    configRevision,
    overview,
    refresh,
    navigate,
    notice: showNotice,
    fail,
    useSkill,
    evolution,
    ...(props.onOpenSettings === undefined ? {} : { openSettings: props.onOpenSettings }),
    ...(props.sessionId === undefined ? {} : { sessionId: props.sessionId }),
  }), [client, configRevision, evolution, fail, navigate, overview, props.onOpenSettings, props.sessionId, props.writable, refresh, revision, showNotice, useSkill])
  const waiting = overview === null ? 0 : overview.counts.pending + overview.counts.drafts
  const trashed = overview === null ? 0 : overview.counts.trash
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentIndex = TABS.indexOf(location.tab)
    if (currentIndex < 0) return
    let nextIndex: number | undefined
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % TABS.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = TABS.length - 1
    if (nextIndex === undefined) return
    event.preventDefault()
    setLocation({ tab: TABS[nextIndex]! })
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons[nextIndex]?.focus()
  }
  const tabs = <div className={sidebarCss.memoryNavigation}>
    <div className={sidebarCss.memoryTabs} role="tablist" aria-label={t('tabs.aria')} onKeyDown={onTabKeyDown}>
      {TABS.map(tab => <button key={tab} type="button" role="tab" tabIndex={location.tab === tab ? 0 : -1} aria-selected={location.tab === tab} data-active={location.tab === tab ? '' : undefined} onClick={() => setLocation({ tab })}>
        {t(`tab.${tab}`)}{tab === 'evolution' && waiting > 0 && <b className={css.skTabBadge} aria-label={t('tabs.waiting', { count: waiting })}>{waiting}</b>}
        {tab === 'trash' && trashed > 0 && <b className={css.skTabBadge} aria-label={t('tabs.trash', { count: trashed })}>{trashed}</b>}
      </button>)}
    </div>
  </div>
  return <>
    <section className={sidebarCss.memoryWorkspace}>
      {props.standalone !== true && <PageHeader title={t('page.title')} description={t('page.description')} {...(context.writable ? {} : { meta: t('page.readOnly') })} />}
      {tabs}
    </section>
    <Reveal>{error === null ? null : <div className={css.skAlert} role="alert"><span>{error}</span><button type="button" className={css.skDismiss} onClick={() => setError(null)} aria-label={t('common.close')}>×</button></div>}</Reveal>
    <Reveal>{notice === null ? null : <div className={css.skNotice} role="status"><span>{notice}</span><button type="button" className={css.skDismiss} onClick={() => setNotice(null)} aria-label={t('common.close')}>×</button></div>}</Reveal>
    <div key={location.tab} className={css.skPage}>
      {location.tab === 'skills' && <SkillsPage context={context} location={location} />}
      {location.tab === 'evolution' && <EvolutionPage context={context} location={location} />}
      {location.tab === 'evals' && <EvalsPage context={context} location={location} />}
      {location.tab === 'market' && <MarketPage context={context} location={location} />}
      {location.tab === 'trash' && <TrashPage context={context} location={location} />}
    </div>
  </>
}

export function SkillsSourcePage(props: MemorySourcePageProps): ReactNode {
  if (props.management === undefined) return null
  return <MemorySourcePageFrame locale={props.locale}><SkillsView key={props.sourceInstanceKey} {...props} management={props.management} /></MemorySourcePageFrame>
}

export function installSkillsMemoryUI(ctx: Parameters<typeof installMemorySourceUI>[0], locale = 'zh'): () => void {
  const t = translate(locale)
  return installMemorySourceUI(ctx, { sourceTypeId: 'skills', pages: [{
    id: 'library', order: 800, label: () => t('page.title'),
    navigation: { stickyHeader: false, group: 'tools', glyph: '✦' },
    component: SkillsSourcePage,
  }] })
}

type SkillsCordisClientContext = Parameters<typeof installMemorySourceUI>[0] & SkillUseRuntimeContext & {
  effect?: (fn: () => () => void) => void
  inject?: (deps: readonly string[], callback: (inner: SkillsCordisClientContext) => void) => void
}

export const inject = ['slots']
export function apply(ctx: SkillsCordisClientContext): void {
  const disposePage = installSkillsMemoryUI(ctx)
  let disposeBridge = installSkillUseBridge(ctx)
  ctx.inject?.(['conversation', 'sessions', 'layout'], inner => {
    disposeBridge()
    const disposeDirect = installSkillUseBridge(inner)
    inner.effect?.(() => () => {
      disposeDirect()
      disposeBridge = installSkillUseBridge(ctx)
    })
  })
  ctx.effect?.(() => () => {
    disposeBridge()
    disposePage()
  })
}
