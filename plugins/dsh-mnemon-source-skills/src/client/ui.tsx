import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { installMemorySourceUI, MemorySourcePageFrame, PageHeader, Reveal, type MemorySourcePageProps } from 'dsh-mnemon/client'
import type { SkillsOverview } from '../contracts.ts'
import { skillsPageClient, type SkillsPageClient } from './api.ts'
import { EvalsPage } from './evals-page.tsx'
import { EvolutionPage } from './evolution-page.tsx'
import { MarketPage } from './market-page.tsx'
import { css, errorText, sidebarCss, translate, useT } from './presentation.ts'
import { SkillsPage } from './skills-page.tsx'
import { TrashPage } from './trash-page.tsx'
import { installSkillUseBridge, requestSkillUse } from './use-skill.tsx'

export type SkillsTab = 'skills' | 'evolution' | 'evals' | 'market' | 'trash'
/** What 进化 lists: suggestions still waiting, those handled, or the conversations reviews read. */
export type EvolutionFilter = 'pending' | 'done' | 'evidence'

/** Where a link inside the page points: a tab, and what to select there. */
export interface SkillsLocation {
  tab: SkillsTab
  skillKey?: string
  /** A skill by name: the one DSH loads, its first waiting suggestion, or its tests. */
  skillName?: string
  suggestionId?: string
  draftId?: string
  trajectoryId?: string
  steps?: number[]
  filter?: EvolutionFilter
  nonce?: number
}

/** Self-evolution as the page knows it from its settings: on or off, and turning it on from here. */
export interface EvolutionState {
  on: boolean
  enable?: () => Promise<void>
}

export interface SkillsPageContext {
  client: SkillsPageClient
  writable: boolean
  /** Reload this page's data; every tab watches it. */
  revision: number
  refresh(): void
  navigate(location: SkillsLocation): void
  notice(text: string): void
  fail(error: unknown): void
  /** Put `/name` into the conversation's input and go back to it. */
  useSkill(name: string): void
  /** Unknown where the page has no settings to read. */
  evolution: EvolutionState | undefined
  /** Open 技能管理's settings under Plugins. */
  openSettings?: () => void
  sessionId?: string
}

const TABS: readonly SkillsTab[] = ['skills', 'evolution', 'evals', 'market', 'trash']
const POLL_MS = 3_000
const NOTICE_MS = 5_000
const FILTERS: readonly EvolutionFilter[] = ['pending', 'done', 'evidence']

/**
 * `skill:<key>`, `name:<skill>`, `suggestion:<id>`, `draft:<id>`,
 * `trajectory:<id>`, `evals:<skill>` or `evolution:<filter>` from a link
 * elsewhere, such as the skills line under a turn.
 */
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

/** The tab the page showed last, while the client runs: reopening the page lands there again. */
let rememberedTab: SkillsTab = 'skills'

function SkillsView(props: MemorySourcePageProps & { management: NonNullable<MemorySourcePageProps['management']> }): JSX.Element {
  const t = useT()
  const client = useMemo(() => skillsPageClient(props.management), [props.management])
  const [location, setLocation] = useState<SkillsLocation>(() => seedLocation(props.navigationInput) ?? { tab: rememberedTab })
  const [revision, setRevision] = useState(0)
  const [overview, setOverview] = useState<SkillsOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  const refreshKey = useRef(props.refreshKey)
  useEffect(() => {
    if (refreshKey.current === props.refreshKey) return
    refreshKey.current = props.refreshKey
    refresh()
  }, [props.refreshKey, refresh])
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
  // Drafts and backtests finish in the background; follow them while one is under way.
  const busy = overview !== null && (overview.counts.runsRunning > 0 || overview.counts.drafting > 0)
  const wasBusy = useRef(false)
  useEffect(() => {
    if (props.active === false) return
    // The overview and each tab read separately. Once completion stops polling,
    // fetch the cards again so a pre-completion response cannot remain on screen.
    if (wasBusy.current && !busy) refresh()
    wasBusy.current = busy
    if (!busy) return
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [busy, refresh, props.active])
  useEffect(() => {
    if (props.active === false) return
    const resume = (): void => { if (document.visibilityState !== 'hidden') refresh() }
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [refresh, props.active])
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

  const context: SkillsPageContext = {
    client,
    writable: props.writable !== false,
    revision,
    refresh,
    navigate: next => setLocation({ ...next, nonce: Date.now() }),
    notice: text => { setNotice(text); setError(null) },
    fail: reason => { setError(errorText(reason)); setNotice(null) },
    useSkill: name => {
      const taken = requestSkillUse(name, props.sessionId)
      if (props.onReturnToConversation !== undefined) props.onReturnToConversation()
      else if (taken) { setNotice(t('skills.used', { name })); setError(null) }
      else { setError(t('skills.noConversation')); setNotice(null) }
    },
    evolution,
    ...(props.onOpenSettings === undefined ? {} : { openSettings: props.onOpenSettings }),
    ...(props.sessionId === undefined ? {} : { sessionId: props.sessionId }),
  }
  const waiting = overview === null ? 0 : overview.counts.pending + overview.counts.drafts
  const trashed = overview === null ? 0 : overview.counts.trash
  const tabs = <div className={sidebarCss.memoryNavigation}>
    <div className={sidebarCss.memoryTabs} role="tablist" aria-label={t('tabs.aria')}>
      {TABS.map(tab => <button key={tab} type="button" role="tab" aria-selected={location.tab === tab} data-active={location.tab === tab ? '' : undefined} onClick={() => setLocation({ tab })}>
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
    // This page pins its own title and tabs, as Memory Spaces does.
    navigation: { stickyHeader: false, group: 'tools', glyph: '✦' },
    component: SkillsSourcePage,
  }] })
}

export const inject = ['slots']
/** The tab is named by the component's declaration; the page label is only a fallback. */
export function apply(ctx: Parameters<typeof installMemorySourceUI>[0]): void {
  installSkillsMemoryUI(ctx)
  installSkillUseBridge(ctx)
}
