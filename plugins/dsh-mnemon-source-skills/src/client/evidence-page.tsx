import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { appearanceClass, SelectField } from 'dsh-mnemon/client'
import type { Trajectory, TrajectorySummary } from '../contracts.ts'
import { css, relative, stamp, useT } from './presentation.ts'
import { Busy, Clamp, Confirm, Empty, MoreMenu, SignalTag, StepTimeline } from './shared.tsx'
import type { SkillsLocation, SkillsPageContext } from './ui.tsx'

/**
 * 进化's third view: the conversations reviews read, the evidence every
 * suggestion and case cites. Pinned and newest first, narrowed to a skill
 * they used; each opens to its steps as the review numbered and marked them.
 * `bar` is 进化's own list header, so switching views keeps it in place.
 */
export function EvidenceView(props: { context: SkillsPageContext; location: SkillsLocation; bar: ReactNode }): JSX.Element {
  const t = useT()
  const { context, location } = props
  const [records, setRecords] = useState<TrajectorySummary[] | null>(null)
  // A link may narrow the view to one skill; one to a record shows it among all.
  const [skill, setSkill] = useState(location.filter === 'evidence' && location.trajectoryId === undefined ? location.skillName ?? '' : '')
  const [selected, setSelected] = useState<string | undefined>(location.trajectoryId)
  const paneRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { if (location.trajectoryId !== undefined) setSelected(location.trajectoryId) }, [location.trajectoryId, location.nonce])
  useEffect(() => {
    let active = true
    void context.client.trajectories().then(list => { if (active) setRecords(list) }).catch(context.fail)
    return () => { active = false }
  }, [context.client, context.revision])
  const skills = useMemo(() => [...new Set((records ?? []).flatMap(record => record.stats.skills))].sort(), [records])
  const shown = useMemo(() => (records ?? []).filter(record => skill === '' || record.stats.skills.includes(skill))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.createdAt) - Date.parse(a.createdAt)), [records, skill])
  const current = shown.find(record => record.id === selected) ?? shown[0]
  useLayoutEffect(() => {
    if (paneRef.current !== null) paneRef.current.scrollTop = 0
  }, [current?.id])
  return <div className={appearanceClass(css.skSplit, css.skEvolutionSplit)}>
    <aside className={css.skList}>
      {props.bar}
      {records === null ? <div className={css.skListNote}><Busy label={t('common.loading')} /></div> : <>
        {(skills.length > 1 || skill !== '') && <div className={css.skListFilter}>
          <SelectField size="sm" hideLabel label={t('evidence.skill')} value={skill} onChange={value => { setSkill(value); setSelected(undefined) }}
            options={[{ value: '', label: t('evidence.allSkills') }, ...skills.map(name => ({ value: name, label: name }))]} />
        </div>}
        {shown.map(record => <button key={record.id} type="button" className={css.skListItem} data-selected={current?.id === record.id ? '' : undefined} onClick={() => setSelected(record.id)}>
          <div><strong>{record.sessionTitle ?? record.sessionId.slice(0, 8)}</strong>{record.pinned && <Tag tone="neutral">{t('records.pinned')}</Tag>}</div>
          <p>{t('records.stats', { turns: record.stats.turns, tools: record.stats.toolCalls })}{record.stats.skills.length > 0 ? ` · ${record.stats.skills.join(', ')}` : ''}</p>
          <footer><time>{relative(t, record.createdAt)}</time>{record.suggestionIds.length > 0 && <span>{t('records.suggested', { count: record.suggestionIds.length })}</span>}</footer>
        </button>)}
      </>}
    </aside>
    <div ref={paneRef} className={css.skPane}>
      {records === null
        ? <Busy label={t('common.loading')} />
        : current === undefined
          ? <Empty glyph="✧" title={t('evolution.empty.evidence')}>{t('evolution.emptyBody.evidence')}</Empty>
          : <RecordDetail key={current.id} context={context} id={current.id} focus={current.id === location.trajectoryId ? location.steps : undefined} onDeleted={() => setSelected(undefined)} />}
    </div>
  </div>
}

/**
 * One recorded conversation: the steps the review read, with what it marked,
 * and making test cases from chosen steps.
 */
function RecordDetail(props: { context: SkillsPageContext; id: string; focus: number[] | undefined; onDeleted: () => void }): JSX.Element {
  const t = useT()
  const { context } = props
  const [loadedTrajectory, setLoadedTrajectory] = useState<Trajectory | null>(null)
  // A link's steps are highlighted, not chosen: making cases from them is the reader's call.
  const [chosen, setChosen] = useState<Set<number>>(() => new Set())
  const [target, setTarget] = useState('')
  const [names, setNames] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const configRevision = context.configRevision ?? 0
  useEffect(() => {
    setChosen(new Set())
    setTarget('')
    setDeleting(false)
  }, [props.id])
  useEffect(() => {
    let active = true
    void context.client.trajectory(props.id).then(value => {
      if (!active) return
      setLoadedTrajectory(value)
      setTarget(current => current !== '' ? current : value.stats.skills[0] ?? '')
    }).catch(context.fail)
    return () => { active = false }
  }, [context.client, props.id, context.revision])
  useEffect(() => {
    let active = true
    void context.client.catalog().then(catalog => { if (active) setNames([...new Set(catalog.skills.map(skill => skill.name))]) }).catch(() => undefined)
    return () => { active = false }
  }, [context.client, configRevision])
  const trajectory = loadedTrajectory !== null && loadedTrajectory.id === props.id ? loadedTrajectory : null
  if (trajectory === null) return <Busy label={t('common.loading')} />
  const targets = [...new Set([...trajectory.stats.skills, ...names])]
  const skillName = target !== '' ? target : targets[0] ?? ''
  const toggle = (index: number) => setChosen(current => {
    const next = new Set(current)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    return next
  })
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true)
    try { await operation(); context.refresh() } catch (error) { context.fail(error) } finally { setBusy(false) }
  }
  const derive = () => act(async () => {
    const result = await context.client.deriveCases({ trajectoryId: trajectory.id, skillName, ...(chosen.size === 0 ? {} : { steps: [...chosen].sort((a, b) => a - b) }) })
    context.notice(t('records.derived', { count: result.added.length, name: skillName }))
    setChosen(new Set())
  })
  const meta = [stamp(trajectory.createdAt), t('records.stats', { turns: trajectory.stats.turns, tools: trajectory.stats.toolCalls }), ...(trajectory.stats.toolFailures > 0 ? [t('records.failures', { count: trajectory.stats.toolFailures })] : [])]
  const canDerive = context.client.canAssist('skill-derive-cases') && context.writable
  return <article className={css.skDetail}>
    <header className={css.skDetailHead}>
      <div>
        <h3>{trajectory.sessionTitle ?? trajectory.sessionId}</h3>
        <span className={css.skMeta}>{meta.map(part => <span key={part}>{part}</span>)}</span>
      </div>
      <div className={css.skDetailActions}>
        <Button variant="ghost" size="sm" disabled={!context.writable || busy} onClick={() => void act(() => context.client.pinTrajectory(trajectory.id, !trajectory.pinned))}>{trajectory.pinned ? t('records.unpin') : t('records.pin')}</Button>
        <MoreMenu label={t('common.more')} disabled={!context.writable} items={[{ id: 'delete', label: t('common.delete'), danger: true }]} onSelect={() => setDeleting(true)} />
      </div>
    </header>
    {trajectory.reviewSummary !== undefined && <Clamp text={trajectory.reviewSummary} />}
    {trajectory.signals.length > 0 && <div className={css.skChips}>{trajectory.signals.map(signal => <SignalTag key={signal} signal={signal} />)}</div>}
    {trajectory.suggestionIds.length > 0 && <div className={css.skChips}>
      {trajectory.suggestionIds.map((id, index) => <button key={id} type="button" className={css.skLink} onClick={() => context.navigate({ tab: 'evolution', suggestionId: id })}>{t('records.suggestion', { index: index + 1 })} ›</button>)}
    </div>}
    {canDerive && targets.length > 0 && <div className={css.skDeriveBar}>
      <span>{chosen.size === 0 ? t('records.deriveAll') : t('records.deriveChosen', { count: chosen.size })}</span>
      <SelectField size="sm" inline hideLabel label={t('records.deriveFor')} value={skillName} onChange={setTarget} options={targets.map(name => ({ value: name, label: name }))} />
      <Button variant="outline" size="sm" disabled={busy || skillName === ''} onClick={() => void derive()}>{t('records.derive')}</Button>
    </div>}
    <StepTimeline steps={trajectory.steps} annotations={trajectory.annotations} highlight={new Set(props.focus ?? [])} selected={chosen} {...(canDerive ? { onToggle: toggle } : {})} />
    {deleting && <Confirm danger title={t('records.deleteTitle')} body={t('records.deleteBody')} confirmLabel={t('common.delete')} busy={busy} onClose={() => setDeleting(false)} onConfirm={() => void (async () => {
      setBusy(true)
      try { await context.client.deleteTrajectory(trajectory.id); setDeleting(false); props.onDeleted(); context.refresh() } catch (error) { context.fail(error) } finally { setBusy(false) }
    })()} />}
  </article>
}
