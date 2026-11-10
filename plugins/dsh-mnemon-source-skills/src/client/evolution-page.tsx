import { useEffect, useMemo, useState, type JSX } from 'react'
import { Button, DiffBlock, IconSparkleRegular, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { appearanceClass, SelectField } from 'dsh-mnemon/client'
import type { AutoAdoptionEvent, BacktestRun, DraftView, ModelRoute, SkillDraft, SkillRootKind, SkillSuggestion, SuggestionStatus, SuggestionView, Trajectory } from '../contracts.ts'
import { modelOptionPick, modelOptionValue, useModelChoice } from './model-choice.tsx'
import { css, points, relative, stamp, useT } from './presentation.ts'
import { ActionTag, Busy, Clamp, Confirm, diffLabels, Empty, Fold, MoreList, MoreMenu, SkillMarkdown, StatusTag, StepTimeline, useLink } from './shared.tsx'
import { EvidenceView } from './evidence-page.tsx'
import { RunDetail } from './skill-tests.tsx'
import type { EvolutionFilter, SkillsLocation, SkillsPageContext } from './ui.tsx'

const PENDING: readonly SuggestionStatus[] = ['pending', 'drafting', 'review']
const DONE: readonly SuggestionStatus[] = ['adopted', 'dismissed', 'expired', 'invalidated']

/** One row of the inbox: a suggestion, or a draft written for a skill directly. */
type Item =
  | { kind: 'suggestion'; id: string; suggestion: SkillSuggestion }
  | { kind: 'draft'; id: string; draft: SkillDraft }

export function EvolutionPage(props: { context: SkillsPageContext; location: SkillsLocation }): JSX.Element {
  const t = useT()
  const { context, location } = props
  const [filter, setFilter] = useState<EvolutionFilter>(location.filter ?? 'pending')
  const [suggestions, setSuggestions] = useState<SkillSuggestion[] | null>(null)
  const [drafts, setDrafts] = useState<SkillDraft[]>([])
  const [selected, setSelected] = useState<string | undefined>(location.suggestionId ?? location.draftId)
  const [reviewing, setReviewing] = useState(false)
  const [deleting, setDeleting] = useState<string | undefined>(undefined)
  const choice = useModelChoice(context, 'evolution.modelAuto')
  useEffect(() => {
    let active = true
    void context.client.suggestions().then(list => { if (active) setSuggestions(list) }).catch(context.fail)
    // Drafts written for a skill directly have no suggestion; the ready ones wait beside the suggestions.
    void context.client.overview().then(async overview => {
      const ids = overview.attention.filter(item => item.kind === 'draft').map(item => item.id)
      const views = await Promise.all(ids.map(id => context.client.draft(id).then(view => view.draft).catch(() => undefined)))
      if (active) setDrafts(views.filter((draft): draft is SkillDraft => draft !== undefined && draft.suggestionId === undefined))
    }).catch(() => undefined)
    return () => { active = false }
  }, [context.client, context.revision])
  // A link opens a suggestion, a draft, the first suggestion waiting for a skill, or the evidence.
  useLink(location.nonce, location.filter === 'evidence' || suggestions !== null, () => {
    if (location.filter === 'evidence' || suggestions === null) { setFilter('evidence'); return }
    const target = location.suggestionId !== undefined ? suggestions.find(entry => entry.id === location.suggestionId)
      : location.draftId !== undefined ? suggestions.find(entry => entry.draftId === location.draftId)
        : location.skillName !== undefined ? suggestions.find(entry => entry.skillName === location.skillName && PENDING.includes(entry.status)) : undefined
    if (target !== undefined) { setFilter(PENDING.includes(target.status) ? 'pending' : 'done'); setSelected(target.id); return }
    if (location.draftId !== undefined) { setFilter('pending'); setSelected(location.draftId); return }
    if (location.filter !== undefined) setFilter(location.filter)
  })
  const items = useMemo<Item[]>(() => {
    const statuses = filter === 'pending' ? PENDING : DONE
    return [
      ...(filter === 'pending' ? drafts.map(draft => ({ kind: 'draft' as const, id: draft.id, draft })) : []),
      ...(suggestions ?? []).filter(entry => statuses.includes(entry.status)).map(suggestion => ({ kind: 'suggestion' as const, id: suggestion.id, suggestion })),
    ]
  }, [filter, suggestions, drafts])
  if (suggestions === null) return <Busy label={t('common.loading')} />
  const pendingCount = suggestions.filter(entry => PENDING.includes(entry.status)).length + drafts.length
  const oneOff = filter === 'pending' ? items.filter(item => item.kind === 'suggestion' && item.suggestion.status === 'pending' && item.suggestion.triage?.classification === 'one-off') : []
  const folded = new Set(oneOff.map(item => item.id))
  const prominent = items.filter(item => !folded.has(item.id)).sort((a, b) =>
    Number(b.kind === 'suggestion' && b.suggestion.triage?.classification === 'durable') - Number(a.kind === 'suggestion' && a.suggestion.triage?.classification === 'durable'))
  const current = items.find(item => item.id === selected) ?? prominent[0]
  const selectedOneOff = selected !== undefined && folded.has(selected)
  const canReview = context.sessionId !== undefined && context.client.canAssist('skill-review-now')
  const reviewNow = async () => {
    setReviewing(true)
    try {
      const result = await context.client.reviewNow()
      const found = result.inserted + result.updated
      context.notice(found > 0 ? t('evolution.reviewFound', { count: found }) : t('evolution.reviewNothing'))
      if (result.suggestionIds[0] !== undefined) { setFilter('pending'); setSelected(result.suggestionIds[0]) }
      context.refresh()
    } catch (error) { context.fail(error) } finally { setReviewing(false) }
  }
  const evolutionOff = context.evolution !== undefined && !context.evolution.on
  const bar = <header className={css.skListBar}>
    <SegmentedControl id="skill-evolution-filter" label={t('tab.evolution')} value={filter} onChange={value => { setFilter(value); setSelected(undefined) }}
      options={[
        { value: 'pending', label: pendingCount > 0 ? t('evolution.pendingCount', { count: pendingCount }) : t('evolution.pending') },
        { value: 'done', label: t('evolution.done') },
        { value: 'evidence', label: t('evolution.evidence') },
      ]} />
    {canReview && <button type="button" className={css.skIconButton} disabled={reviewing || !context.writable} onClick={() => void reviewNow()}
      aria-label={t('evolution.reviewNow')} title={t('evolution.reviewNow')} data-pulse={reviewing ? '' : undefined}><IconSparkleRegular size={16} /></button>}
  </header>
  if (filter === 'evidence') return <EvidenceView context={context} location={location} bar={bar} />
  // The picks that apply right now: this card's own, else the global one. A
  // draft row has no suggestion, so only the global pick governs it.
  const currentId = current?.kind === 'suggestion' ? current.id : undefined
  const canOverride = currentId !== undefined && current?.kind === 'suggestion' && PENDING.includes(current.suggestion.status)
  const currentOverride = currentId === undefined ? null : Object.hasOwn(choice.preferences.suggestionModels, currentId) ? choice.preferences.suggestionModels[currentId]! : null
  const currentModel = currentOverride ?? choice.preferences.model ?? null
  const saveDraftModel = (value: string) => choice.saveDraftModel(modelOptionPick(value))
  const saveSuggestionModel = (value: string) => { if (canOverride && currentId !== undefined) choice.saveSuggestionModel(currentId, modelOptionPick(value)) }
  const removeItem = async (item: Item) => {
    try {
      if (item.kind === 'draft') await context.client.deleteDraft(item.id)
      else await context.client.deleteSuggestion(item.id)
      setDeleting(undefined)
      if (selected === item.id) setSelected(undefined)
      context.notice(t('evolution.deleted'))
      context.refresh()
    } catch (error) { context.fail(error) }
  }
  // The same two pickers on both pages: the global pick, and this card's own.
  const modelBar = <div className={css.skListBar} style={{ borderBottom: 'none', padding: '0 0 10px' }}>
    <div className={css.skSplit} style={{ minHeight: 0, alignItems: 'center', width: '100%' }}>
      <SelectField<string> label={t('evolution.model')} triggerDetail inline size="sm" value={modelOptionValue(choice.preferences.model)} disabled={!context.writable || choice.models === null} onChange={saveDraftModel} options={choice.options} />
      <SelectField<string> label={t('evolution.modelCard')} triggerDetail inline size="sm" value={modelOptionValue(currentOverride)} disabled={!context.writable || !canOverride || choice.models === null} onChange={saveSuggestionModel} options={choice.cardOptions} />
    </div>
  </div>
  return <>
    {modelBar}
    <div className={appearanceClass(css.skSplit, css.skEvolutionSplit)}>
    <aside className={css.skList}>
      {bar}
      {prominent.map(item => <ListItem key={item.id} item={item} selected={current?.id === item.id} onSelect={() => setSelected(item.id)} />)}
      {oneOff.length > 0 && <Fold key={selectedOneOff ? selected : 'one-off'} defaultOpen={selectedOneOff} title={t('triage.fold', { count: oneOff.length })}>
        <p className={css.skMuted}>{t('triage.soft')}</p>
        {oneOff.map(item => <ListItem key={item.id} item={item} selected={current?.id === item.id} onSelect={() => setSelected(item.id)} />)}
      </Fold>}
    </aside>
    <div key={current?.id ?? filter} className={css.skPane}>
      {current === undefined
        ? filter === 'pending' && evolutionOff
          ? <Empty glyph="✧" title={t('evolution.off')} action={<>
              {context.evolution?.enable !== undefined && <Button variant="primary" size="sm" disabled={!context.writable} onClick={() => void context.evolution!.enable!().then(context.refresh, context.fail)}>{t('evolution.turnOn')}</Button>}
              {context.openSettings !== undefined && <Button variant="outline" size="sm" onClick={context.openSettings}>{t('common.settings')}</Button>}
            </>}>{t('evolution.offBody')}</Empty>
          : <Empty glyph="✧" title={t(oneOff.length > 0 ? 'triage.choose' : `evolution.empty.${filter}`)}>{t(oneOff.length > 0 ? 'triage.soft' : `evolution.emptyBody.${filter}`)}</Empty>
        : current.kind === 'suggestion'
          ? <SuggestionDetail key={current.id} context={context} id={current.id} model={currentModel} />
          : <article className={css.skDetail}>
              <header className={css.skDetailHead}>
                <div><span className={css.skKicker}><ActionTag action="update" /></span><h3>{current.draft.skillName}</h3></div>
                <div className={css.skDetailActions}>
                  <Button variant="ghost" size="sm" disabled={!context.writable} onClick={() => setDeleting(current.id)}>{t('common.delete')}</Button>
                </div>
              </header>
              <DraftReview key={current.id} context={context} draftId={current.id} model={currentModel} />
              {deleting === current.id && <Confirm danger title={t('evolution.deleteTitle')} body={t('evolution.deleteBody')} confirmLabel={t('common.delete')}
                onClose={() => setDeleting(undefined)} onConfirm={() => void removeItem(current)} />}
            </article>}
    </div>
    </div>
  </>
}

function ListItem(props: { item: Item; selected: boolean; onSelect: () => void }): JSX.Element {
  const t = useT()
  const { item } = props
  const common = { type: 'button' as const, className: css.skListItem, 'data-selected': props.selected ? '' : undefined, onClick: props.onSelect }
  if (item.kind === 'draft') {
    return <button {...common}>
      <div><ActionTag action="update" /><strong>{item.draft.skillName}</strong><Tag tone="warning">{t('status.review')}</Tag></div>
      <p>{item.draft.notes}</p>
      <footer><time>{relative(t, item.draft.updatedAt)}</time></footer>
    </button>
  }
  const { suggestion } = item
  return <button {...common}>
    <div><ActionTag action={suggestion.action} /><strong>{suggestion.skillName}</strong>{suggestion.status !== 'pending' && <StatusTag status={suggestion.status} />}</div>
    <p>{suggestion.summary}</p>
    {suggestion.triage !== undefined && <small>{t(`triage.${suggestion.triage.classification}`)} · {t('triage.facts', suggestion.triage as unknown as Record<string, unknown>)}</small>}
    <footer><time>{relative(t, suggestion.updatedAt)}</time>{suggestion.sourceSessionTitle !== undefined && <span title={suggestion.sourceSessionTitle}>{suggestion.sourceSessionTitle}</span>}</footer>
  </button>
}

function SuggestionDetail(props: { context: SkillsPageContext; id: string; model?: ModelRoute | null }): JSX.Element {
  const t = useT()
  const { context } = props
  // The pick the page holds for this card, as `provider`/`model` for the Host;
  // none at all asks it to use the task Agent's own route.
  const route = props.model === null || props.model === undefined ? {} : { provider: props.model.provider, model: props.model.model }
  const [view, setView] = useState<SuggestionView | null>(null)
  const [loadError, setLoadError] = useState<'missing' | 'failed' | null>(null)
  const [reload, setReload] = useState(0)
  const [trajectories, setTrajectories] = useState<Map<string, Trajectory | null>>(new Map())
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    let active = true
    setLoadError(null)
    void context.client.suggestion(props.id).then(async value => {
      if (!active) return
      setView(value)
      const loaded = new Map<string, Trajectory | null>()
      for (const reference of value.suggestion.evidence.slice(-4)) {
        if (loaded.has(reference.trajectoryId)) continue
        loaded.set(reference.trajectoryId, await context.client.trajectory(reference.trajectoryId).catch(() => null))
      }
      if (active) setTrajectories(loaded)
    }).catch(error => {
      if (!active) return
      setView(null)
      if ((error instanceof Error ? error.message : String(error)) === 'suggestion not found: ' + props.id) setLoadError('missing')
      else { setLoadError('failed'); context.fail(error) }
    })
    return () => { active = false }
  }, [context.client, props.id, context.revision, reload])
  if (loadError !== null) return <Empty glyph="?" title={t(loadError === 'missing' ? 'evolution.missing' : 'evolution.loadFailed')}
    action={<Button variant="ghost" onClick={() => setReload(value => value + 1)}>{t('common.retry')}</Button>}>{t(loadError === 'missing' ? 'evolution.missingBody' : 'evolution.loadFailedBody')}</Empty>
  if (view === null) return <Busy label={t('common.loading')} />
  const { suggestion } = view
  const canDraft = context.client.canAssist('skill-draft') && !(suggestion.action === 'update' && view.skill === undefined)
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true)
    try { await operation(); context.refresh() } catch (error) { context.fail(error); context.refresh() } finally { setBusy(false) }
  }
  const references = suggestion.evidence.slice(-4)
  const cited = references.reduce((sum, reference) => sum + reference.steps.length, 0)
  const meta = [
    ...(suggestion.sourceSessionTitle === undefined ? [] : [t('evolution.from', { session: suggestion.sourceSessionTitle })]),
    relative(t, suggestion.createdAt),
    t('evolution.confidence', { value: Math.round(suggestion.confidence * 100) }),
    ...(suggestion.action === 'create' && suggestion.targetRoot !== undefined ? [t('evolution.targetRoot', { root: t(`root.${suggestion.targetRoot}`) })] : []),
  ]
  return <article className={css.skDetail}>
    <header className={css.skDetailHead}>
      <div>
        <span className={css.skKicker}><ActionTag action={suggestion.action} />{suggestion.status !== 'pending' && <StatusTag status={suggestion.status} />}</span>
        <h3>{view.skill === undefined || view.skillInCatalog === false ? suggestion.skillName : <button type="button" className={css.skTitleLink} onClick={() => context.navigate({ tab: 'skills', skillKey: view.skill!.key })}>{suggestion.skillName}</button>}</h3>
        <p>{suggestion.summary}</p>
        <span className={css.skMeta}>{meta.map(part => <span key={part}>{part}</span>)}</span>
      </div>
      {suggestion.status === 'pending' && <div className={css.skDetailActions}>
        <Button variant="primary" size="sm" disabled={!context.writable || busy || !canDraft} title={canDraft ? undefined : t('evolution.noAgent')} onClick={() => void act(() => context.client.generateDraft({ suggestionId: suggestion.id, ...route }))}>{t('evolution.draft')}</Button>
        <Button variant="ghost" size="sm" disabled={!context.writable || busy} onClick={() => void act(async () => { await context.client.dismissSuggestion(suggestion.id); context.notice(t('evolution.dismissed')) })}>{t('evolution.dismiss')}</Button>
        <Button variant="ghost" size="sm" disabled={!context.writable || busy} onClick={() => setDeleting(true)}>{t('common.delete')}</Button>
      </div>}
    </header>
    {deleting && <Confirm danger title={t('evolution.deleteTitle')} body={t('evolution.deleteBody')} confirmLabel={t('common.delete')}
      onClose={() => setDeleting(false)}
      onConfirm={() => void act(async () => { await context.client.deleteSuggestion(suggestion.id); setDeleting(false); context.notice(t('evolution.deleted')) })} />}
    {suggestion.triage !== undefined && <section aria-label={t('triage.title')}>
      <p><strong>{t(`triage.${suggestion.triage.classification}`)}</strong> · {t('triage.facts', suggestion.triage as unknown as Record<string, unknown>)}</p>
      <p className={css.skMuted}>{t('triage.rules')} {t('triage.soft')}</p>
    </section>}
    {suggestion.rationale !== undefined && <Clamp text={suggestion.rationale} />}
    {suggestion.action === 'update' && view.skill === undefined && <p className={css.skWarn}>{t(view.resolution === 'origin-unavailable' ? 'evolution.originUnavailable' : 'evolution.skillGone')}</p>}
    {suggestion.action === 'update' && view.skill !== undefined && !view.hashCurrent && suggestion.status === 'pending' && <p className={css.skWarn}>{t('evolution.skillChanged')}</p>}
    {suggestion.autoAdoption !== undefined && suggestion.autoAdoption.length > 0 && <AutoAdoptionHistory events={suggestion.autoAdoption} />}
    {suggestion.status === 'drafting' && <Busy label={t('evolution.drafting')} />}
    {suggestion.lastError !== undefined && suggestion.status === 'pending' && <p className={css.inlineError}>{t('evolution.draftFailed', { error: suggestion.lastError })}</p>}
    {suggestion.status === 'review' && suggestion.draftId !== undefined && <DraftReview context={context} draftId={suggestion.draftId} model={props.model ?? null} />}
    {suggestion.status === 'adopted' && view.skill !== undefined && <p className={css.skSuccess}>{t('evolution.adopted')} {view.skillInCatalog !== false && <button type="button" className={css.skLink} onClick={() => context.navigate({ tab: 'skills', skillKey: view.skill!.key })}>{t('evolution.openSkill')} ›</button>}</p>}
    <div className={css.skFolds}>
      {view.skill !== undefined && <Fold title={t('evolution.currentSkill')} meta={t(`root.${view.skill.root}`)}>
        <p className={css.skMuted}>{view.skill.path}</p>
        <SkillMarkdown body={view.skill.body} />
      </Fold>}
      <Fold title={t('evolution.evidence')} meta={t('evolution.evidenceMeta', { conversations: references.length, steps: cited })}>
        {references.map((reference, index) => {
          const trajectory = trajectories.get(reference.trajectoryId)
          if (trajectory === undefined) return <Busy key={index} label={t('common.loading')} />
          if (trajectory === null) return <p key={index} className={css.skMuted}>{t('evolution.evidenceGone')}</p>
          const marked = new Set(reference.steps)
          const steps = trajectory.steps.filter(step => [...marked].some(value => Math.abs(value - step.index) <= 1))
          return <div key={index} className={css.skEvidence}>
            <header><strong>{trajectory.sessionTitle ?? trajectory.sessionId.slice(0, 8)}</strong><span>{relative(t, trajectory.createdAt)}</span>
              <button type="button" className={css.skLink} onClick={() => context.navigate({ tab: 'evolution', filter: 'evidence', trajectoryId: trajectory.id, steps: reference.steps })}>{t('evolution.openRecord')} ›</button></header>
            <StepTimeline compact steps={steps} annotations={trajectory.annotations} highlight={marked} />
          </div>
        })}
      </Fold>
    </div>
  </article>
}

/**
 * Average scores of a draft and its baseline over the cases both graded: a
 * case that could not run on either side says nothing about the change.
 */
export function compareRuns(baseline: BacktestRun | undefined, candidate: BacktestRun | undefined): { baseline?: number; candidate?: number; excluded: number } {
  if (baseline?.status !== 'completed' || candidate?.status !== 'completed') return { excluded: 0 }
  const graded = (run: BacktestRun) => new Map(run.results.filter(result => result.verdict !== 'error').map(result => [result.caseId, result.score]))
  const base = graded(baseline)
  const next = graded(candidate)
  const shared = [...next.keys()].filter(id => base.has(id))
  const excluded = new Set([...baseline.results, ...candidate.results].map(result => result.caseId)).size - shared.length
  if (shared.length === 0) return { excluded }
  const mean = (scores: Map<string, number>) => shared.reduce((sum, id) => sum + scores.get(id)!, 0) / shared.length
  return { baseline: mean(base), candidate: mean(next), excluded }
}

/** Where adopting may write a new skill: the user's own DSH skills, or the project's. */
const NEW_SKILL_ROOTS: readonly SkillRootKind[] = ['user-dsh', 'project-dsh']

/**
 * A draft under review: what changed and why, the backtest as one line that
 * opens to its cases, and the diff. Adopt and discard sit with its title;
 * editing and redrafting with a note wait behind its menu.
 */
function DraftReview(props: { context: SkillsPageContext; draftId: string; model?: ModelRoute | null }): JSX.Element {
  const t = useT()
  const { context } = props
  // A redraft continues what the user picked for drafts; a pick of none follows
  // the task Agent, as every run did before the pickers existed.
  const route = props.model === null || props.model === undefined ? {} : { provider: props.model.provider, model: props.model.model }
  const [view, setView] = useState<DraftView | null>(null)
  const [cases, setCases] = useState<number | undefined>(undefined)
  const [editing, setEditing] = useState<string | null>(null)
  const [redrafting, setRedrafting] = useState<string | null>(null)
  const [root, setRoot] = useState<SkillRootKind>('user-dsh')
  const [roots, setRoots] = useState<readonly SkillRootKind[]>(['user-dsh'])
  const [details, setDetails] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmAdopt, setConfirmAdopt] = useState(false)
  useEffect(() => {
    let active = true
    void context.client.draft(props.draftId).then(value => {
      if (!active) return
      setView(value)
      if (value.draft.targetRoot !== undefined) setRoot(value.draft.targetRoot)
      // A project root exists only for a conversation in a project.
      if (value.draft.action === 'create') void context.client.catalog().then(catalog => { if (active) setRoots(NEW_SKILL_ROOTS.filter(kind => catalog.roots.some(entry => entry.kind === kind))) }).catch(() => undefined)
      void context.client.cases(value.draft.skillName).then(list => { if (active) setCases(list.filter(entry => entry.enabled).length) }).catch(() => undefined)
    }).catch(context.fail)
    return () => { active = false }
  }, [context.client, props.draftId, context.revision])
  if (view === null) return <Busy label={t('common.loading')} />
  const { draft } = view
  // Runs are linked oldest first; the comparison is always the latest pair.
  const latest = [...view.runs].reverse()
  const candidate = latest.find(run => run.target.kind === 'draft' && run.target.draftId === draft.id)
  const baseline = latest.find(run => run.target.kind !== 'draft')
  const { baseline: baselineScore, candidate: candidateScore, excluded } = compareRuns(baseline, candidate)
  const regressed = candidateScore !== undefined && baselineScore !== undefined && candidateScore < baselineScore
  const running = view.runs.some(run => run.status === 'running')
  const act = async (operation: () => Promise<unknown>, after?: () => void) => {
    setBusy(true)
    try { await operation(); after?.(); context.refresh() } catch (error) { context.fail(error); context.refresh() } finally { setBusy(false) }
  }
  const adopt = () => act(async () => {
    const result = await context.client.adoptDraft(draft.id, draft.action === 'create' ? root : undefined)
    context.notice(t('draft.adopted', { name: result.skill.name }))
  }, () => setConfirmAdopt(false))
  const backtest = () => act(async () => {
    await context.client.backtest({ skillName: draft.skillName, target: { kind: 'draft', draftId: draft.id } })
    const started = await context.client.backtest({ skillName: draft.skillName, target: { kind: draft.action === 'update' ? 'current' : 'none', ...(draft.action === 'update' ? { draftId: draft.id } : {}) } })
    await context.client.linkRun(draft.id, started.runId)
  })
  const redraft = (note: string, backtest = false) => act(() => context.client.generateDraft({ ...(backtest ? { backtest: true } : {}), draftId: draft.id, ...(draft.suggestionId === undefined ? {} : { suggestionId: draft.suggestionId }), guidance: note, ...route }), () => setRedrafting(null))
  const ready = draft.status === 'ready'
  const originalAvailable = draft.action !== 'update' || view.base !== undefined
  const progress = (run: BacktestRun | undefined) => run === undefined ? 0 : run.progress.done
  const total = (candidate?.progress.total ?? 0) + (baseline?.progress.total ?? 0)
  const results = new Map<string, { title: string; base?: BacktestRun['results'][number]; next?: BacktestRun['results'][number] }>()
  for (const result of baseline?.results ?? []) results.set(result.caseId, { title: result.title, base: result })
  for (const result of candidate?.results ?? []) results.set(result.caseId, { ...results.get(result.caseId), title: result.title, next: result })
  return <section className={css.skDraft}>
    <header className={css.skSectionHead}>
      <h4>{t('draft.title')}<small>{stamp(draft.updatedAt)}</small></h4>
      {ready && <div>
        {draft.action === 'create' && roots.length > 1 && <SelectField inline size="sm" label={t('draft.writeTo')} value={root} disabled={busy} onChange={setRoot}
          options={roots.map(kind => ({ value: kind, label: t(`root.${kind}`) }))} />}
        <Button variant="primary" size="sm" disabled={!context.writable || busy || editing !== null || running || view.conflict !== undefined || !originalAvailable} onClick={() => regressed ? setConfirmAdopt(true) : void adopt()}>{t('draft.adopt')}</Button>
        <Button variant="ghost" size="sm" disabled={!context.writable || busy} onClick={() => void act(() => context.client.discardDraft(draft.id))}>{t('draft.discard')}</Button>
        <MoreMenu label={t('common.more')} disabled={!context.writable || busy} onSelect={id => id === 'edit' ? setEditing(draft.content) : setRedrafting('')}
          items={[{ id: 'edit', label: t('draft.edit') }, ...(originalAvailable && context.client.canAssist('skill-draft') ? [{ id: 'redraft', label: t('draft.redraft') }] : [])]} />
      </div>}
    </header>
    {!originalAvailable && <p className={css.skWarn}>{t(view.resolution === 'origin-unavailable' ? 'evolution.originUnavailable' : 'evolution.skillGone')}</p>}
    {view.conflict !== undefined && ready && <div className={css.skWarn} role="status">
      <p>{t(view.conflict === 'target-exists' ? 'draft.targetExists' : 'draft.baseChanged')}</p>
      {originalAvailable && context.client.canAssist('skill-draft') && <Button size="sm" disabled={!context.writable || busy || running} onClick={() => void redraft(t('draft.refreshGuidance'), true)}>{t('draft.regenerate')}</Button>}
    </div>}
    {draft.notes !== '' && <Clamp text={draft.notes} />}
    {draft.changes.length > 0 && <MoreList items={draft.changes} shown={3} />}
    <div className={css.skBacktest} data-tone={regressed ? 'bad' : candidateScore !== undefined && baselineScore !== undefined && candidateScore > baselineScore ? 'good' : undefined}>
      {running
        ? <Busy label={t('draft.backtesting', { done: progress(candidate) + progress(baseline), total })} />
        : candidateScore !== undefined && baselineScore !== undefined
          ? <button type="button" className={css.skBacktestLine} aria-expanded={details} onClick={() => setDetails(value => !value)}>
              <span>{t('draft.backtest')}</span>
              <strong>{baseline?.target.kind === 'none' ? t('draft.withoutSkill') : t('draft.current')} {points(baselineScore)} → {t('draft.candidate')} {points(candidateScore)}</strong>
              <em>{candidateScore === baselineScore ? t('draft.same') : `${candidateScore > baselineScore ? '+' : '−'}${Math.round(Math.abs(candidateScore - baselineScore) * 100)}`}</em>
            </button>
          : <span className={css.skMuted}>{cases === 0 ? t('draft.noTests') : view.runs.length === 0 ? t('draft.notTested') : t('draft.notComparable')}</span>}
      {running && <Button variant="ghost" size="sm" disabled={!context.writable || busy} onClick={() => void act(async () => {
        for (const run of view.runs.filter(item => item.status === 'running')) await context.client.cancelRun(run.id)
      })}>{t('draft.cancelBacktest')}</Button>}
      {!running && (candidate?.status === 'interrupted' || baseline?.status === 'interrupted') && <p role="status">{t('draft.interrupted')}</p>}
      {!running && (cases ?? 0) > 0 && context.client.canAssist('skill-backtest') && ready && <Button variant="ghost" size="sm" disabled={!context.writable || busy || !originalAvailable} onClick={() => void backtest()}>{view.runs.length === 0 ? t('draft.runBacktest') : t('draft.rerun')}</Button>}
    </div>
    {excluded > 0 && !running && <p className={css.skMuted}>{t('draft.excluded', { count: excluded })}</p>}
    {details && results.size > 0 && <table className={css.skTable}>
      <thead><tr><th>{t('tests.case')}</th><th>{baseline?.target.kind === 'none' ? t('draft.withoutSkill') : t('draft.current')}</th><th>{t('draft.candidate')}</th></tr></thead>
      <tbody>{[...results.entries()].map(([id, row]) => <tr key={id}>
        <td>{row.title}</td>
        <td>{row.base === undefined ? '—' : <Tag tone={row.base.verdict === 'pass' ? 'success' : row.base.verdict === 'error' ? 'danger' : 'warning'}>{t(`run.verdict.${row.base.verdict}`)}</Tag>}</td>
        <td>{row.next === undefined ? '—' : <Tag tone={row.next.verdict === 'pass' ? 'success' : row.next.verdict === 'error' ? 'danger' : 'warning'}>{t(`run.verdict.${row.next.verdict}`)}</Tag>}{row.next?.checks.filter(check => !check.pass).slice(0, 1).map(check => <small key={check.checkId}>{check.note}</small>)}</td>
      </tr>)}</tbody>
    </table>}
    {details && candidate !== undefined && <Fold title={t('draft.runDetail')}><RunDetail run={candidate} /></Fold>}
    {redrafting !== null && <div className={css.skComposer}>
      <label><span>{t('draft.redraftNote')}</span><textarea rows={2} value={redrafting} autoFocus placeholder={t('draft.redraftPlaceholder')} onChange={event => setRedrafting(event.target.value)} /></label>
      {draft.guidance.length > 0 && <ul className={css.skGuidance}>{draft.guidance.map((text, index) => <li key={index}>{text}</li>)}</ul>}
      <footer>
        <Button variant="ghost" size="sm" onClick={() => setRedrafting(null)}>{t('common.cancel')}</Button>
        <Button variant="primary" size="sm" disabled={busy || redrafting.trim() === ''} onClick={() => void redraft(redrafting.trim())}>{t('draft.redraftStart')}</Button>
      </footer>
    </div>}
    {editing === null
      ? <DiffBlock maxLines={40} labels={diffLabels(t)} diffs={[{ path: `${draft.skillName}/SKILL.md`, oldText: view.base?.content ?? null, newText: draft.content }]} />
      : <div className={css.skComposer}>
          <textarea className={css.skEditor} spellCheck={false} value={editing} onChange={event => setEditing(event.target.value)} aria-label="SKILL.md" />
          <footer>
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" size="sm" disabled={busy || editing === draft.content} onClick={() => void act(() => context.client.updateDraft(draft.id, editing), () => setEditing(null))}>{t('common.save')}</Button>
          </footer>
        </div>}
    {confirmAdopt && <Confirm title={t('draft.adoptAnyway')} body={t('draft.regressed')} confirmLabel={t('draft.adopt')} busy={busy} onClose={() => setConfirmAdopt(false)} onConfirm={() => void adopt()} />}
  </section>
}


function AutoAdoptionHistory(props: { events: AutoAdoptionEvent[] }): JSX.Element {
  const t = useT()
  const latest = props.events[props.events.length - 1]!
  const describe = (event: AutoAdoptionEvent) => <>
    {t(`evolution.auto.stage.${event.stage}`)}{event.attempt > 0 ? ` · ${t('evolution.auto.attempt', { count: event.attempt })}` : ''}
    {event.reason === undefined ? '' : ` · ${t(`evolution.auto.reason.${event.reason}`)}`}
    {event.baselineScore === undefined || event.draftScore === undefined ? '' : ` · ${t('evolution.auto.scores', { baseline: points(event.baselineScore), draft: points(event.draftScore) })}`}
    {event.detail === undefined ? '' : ` · ${event.detail}`}
  </>
  return <section aria-label={t('evolution.auto.title')}>
    <p><strong>{t('evolution.auto.title')}</strong> · {describe(latest)}</p>
    <Fold title={t('evolution.auto.history')}><ol>{props.events.map((event, index) => <li key={index}>{stamp(event.at)} · {describe(event)}</li>)}</ol></Fold>
  </section>
}
