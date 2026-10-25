import { useEffect, useState, type JSX } from 'react'
import { Button, Checkbox, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { SidebarModal } from 'dsh-mnemon/client'
import type { BacktestRun, EvalCase } from '../contracts.ts'
import type { CaseDraft } from './api.ts'
import { css, errorText, points, relative, useT, type SkillsTranslate } from './presentation.ts'
import { Busy, Confirm, Field, MoreMenu, RunStatusDot } from './shared.tsx'
import type { SkillsPageContext } from './ui.tsx'

/** How many earlier backtests the history keeps on screen. */
const HISTORY = 6

function completedRunSummary(run: BacktestRun, t: SkillsTranslate): string {
  const unmeasured = run.results.filter(result => result.unmeasuredReason === 'requires-vision').length
  const errors = run.results.filter(result => result.verdict === 'error' && result.unmeasuredReason === undefined).length
  return [
    ...(run.score === undefined && unmeasured > 0 ? [] : [t('tests.score', { score: points(run.score) })]),
    ...(unmeasured > 0 ? [t('tests.unmeasured', { count: unmeasured })] : []),
    ...(errors > 0 ? [t('tests.errors', { count: errors })] : []),
  ].join(' · ')
}

/**
 * A skill's test cases and its backtests: the cases with a switch each, one
 * button that backtests the current version, and the runs, newest first, each
 * opening to its per-case verdicts. A draft is backtested from its review.
 */
export function SkillTests(props: { context: SkillsPageContext; skillName: string }): JSX.Element {
  const t = useT()
  const { context, skillName } = props
  const [cases, setCases] = useState<EvalCase[] | null>(null)
  const [runs, setRuns] = useState<BacktestRun[]>([])
  const [hasFile, setHasFile] = useState(true)
  const [editing, setEditing] = useState<CaseDraft | null>(null)
  const [deleting, setDeleting] = useState<EvalCase | null>(null)
  const [openRun, setOpenRun] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void Promise.all([context.client.cases(skillName), context.client.runs(skillName), context.client.evidencePack({ skill: skillName })]).then(([list, history, pack]) => {
      if (!active) return
      setCases(list)
      setRuns(history.filter(run => run.target.kind !== 'draft'))
      setHasFile(pack.skill !== undefined)
    }).catch(context.fail)
    return () => { active = false }
  }, [context.client, skillName, context.revision])
  if (cases === null) return <Busy label={t('common.loading')} />
  const enabled = cases.filter(entry => entry.enabled)
  const running = runs.some(entry => entry.status === 'running')
  const run = async () => {
    setBusy(true)
    try {
      const started = await context.client.backtest({ skillName, target: { kind: hasFile ? 'current' : 'none' } })
      setOpenRun(started.runId)
      context.refresh()
    } catch (error) { context.fail(error) } finally { setBusy(false) }
  }
  const save = async (input: CaseDraft) => {
    setBusy(true)
    try { await context.client.saveCase(input); setEditing(null); context.refresh() } catch (error) { context.fail(error) } finally { setBusy(false) }
  }
  return <div className={css.skTests}>
    <div className={css.skTestsBar}>
      <Button variant="primary" size="sm" disabled={!context.writable || busy || running || enabled.length === 0 || !context.client.canAssist('skill-backtest')} onClick={() => void run()}>
        {running ? t('tests.running') : t('tests.run')}
      </Button>
      <Button variant="ghost" size="sm" disabled={!context.writable} onClick={() => setEditing({ skillName, title: '', prompt: '', checks: [{ text: '', must: true }] })}>{t('tests.add')}</Button>
    </div>
    {cases.length === 0
      ? <p className={css.skMuted}>{t('tests.empty')}</p>
      : <ul className={css.skCases}>{cases.map(entry => <li key={entry.id} data-off={entry.enabled ? undefined : ''}>
          <details>
            <summary><strong>{entry.title}</strong>{entry.requiresVision === true && <Tag tone="quiet">{t('tests.requiresVision')}</Tag>}<small>{t('tests.checks', { count: entry.checks.length })}</small></summary>
            <p>{entry.prompt}</p>
            <ul>{entry.checks.map(check => <li key={check.id}><Tag tone={check.must ? 'neutral' : 'quiet'}>{check.must ? t('tests.must') : t('tests.should')}</Tag><span>{check.text}</span></li>)}</ul>
            {entry.origin.trajectoryId !== undefined && <button type="button" className={css.skLink}
              onClick={() => context.navigate({ tab: 'evolution', filter: 'evidence', trajectoryId: entry.origin.trajectoryId!, ...(entry.origin.steps === undefined ? {} : { steps: entry.origin.steps }) })}>{t('tests.origin')} ›</button>}
          </details>
          <Switch checked={entry.enabled} label={t('tests.enabled', { title: entry.title })} disabled={!context.writable || busy} onChange={next => void save({ ...entry, enabled: next })} />
          <MoreMenu label={t('common.more')} disabled={!context.writable} onSelect={id => id === 'edit' ? setEditing({ ...entry }) : setDeleting(entry)}
            items={[{ id: 'edit', label: t('common.edit') }, { id: 'delete', label: t('common.delete'), danger: true }]} />
        </li>)}</ul>}
    {runs.length > 0 && <h6 className={css.skCaption}>{t('tests.history')}</h6>}
    {runs.length > 0 && <ul className={css.skRuns}>
      {runs.slice(0, HISTORY).map(entry => <li key={entry.id}>
        <button type="button" aria-expanded={openRun === entry.id} onClick={() => setOpenRun(openRun === entry.id ? undefined : entry.id)}>
          <RunStatusDot status={entry.status} />
          <span>{entry.status === 'running' ? t('tests.progress', { done: entry.progress.done, total: entry.progress.total })
            : entry.status === 'completed' ? completedRunSummary(entry, t)
              : t(`run.status.${entry.status}`)}</span>
          {entry.target.kind === 'none' && <Tag tone="quiet">{t('tests.withoutSkill')}</Tag>}
          <time>{relative(t, entry.startedAt)}</time>
        </button>
        {openRun === entry.id && <RunDetail run={entry} />}
      </li>)}
    </ul>}
    {editing !== null && <CaseEditor initial={editing} busy={busy} onClose={() => setEditing(null)} onSave={input => void save(input)} />}
    {deleting !== null && <Confirm danger title={t('tests.deleteTitle')} body={deleting.title} confirmLabel={t('common.delete')} busy={busy} onClose={() => setDeleting(null)} onConfirm={() => void (async () => {
      setBusy(true)
      try { await context.client.deleteCase(deleting.id); setDeleting(null); context.refresh() } catch (error) { context.fail(error) } finally { setBusy(false) }
    })()} />}
  </div>
}

/** One run's cases: the verdict, each check with the judge's note, and what the simulated run did and answered. */
export function RunDetail(props: { run: BacktestRun }): JSX.Element {
  const t = useT()
  if (props.run.error !== undefined && props.run.results.length === 0) return <p className={css.inlineError}>{props.run.error}</p>
  return <div className={css.skRunDetail}>
    {props.run.results.map(result => <details key={result.caseId}>
      <summary>
        <Tag tone={result.unmeasuredReason === 'requires-vision' ? 'quiet' : result.verdict === 'pass' ? 'success' : result.verdict === 'error' ? 'danger' : 'warning'}>{t(`run.verdict.${result.unmeasuredReason === 'requires-vision' ? 'unmeasured' : result.verdict}`)}</Tag>
        <strong>{result.title}</strong>
        {result.verdict !== 'error' && <span>{points(result.score)}</span>}
      </summary>
      {result.unmeasuredReason === 'requires-vision' ? <p className={css.skMuted}>{t('run.requiresVision')}</p>
        : result.error !== undefined && <p className={css.inlineError}>{result.error}</p>}
      {result.checks.length > 0 && <ul className={css.skVerdicts}>{result.checks.map(check => <li key={check.checkId} data-pass={check.pass ? '' : undefined}><b aria-hidden="true">{check.pass ? '✓' : '✕'}</b><span>{check.note}</span></li>)}</ul>}
      {result.steps.length > 0 && <><h6>{t('run.steps')}</h6><ol className={css.skRunSteps}>{result.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></>}
      {result.answer !== '' && <><h6>{t('run.answer')}</h6><pre className={css.skAnswer}>{result.answer}</pre></>}
    </details>)}
  </div>
}

function CaseEditor(props: { initial: CaseDraft; busy: boolean; onClose: () => void; onSave: (input: CaseDraft) => void }): JSX.Element {
  const t = useT()
  const [value, setValue] = useState<CaseDraft>(props.initial)
  const [error, setError] = useState<string | null>(null)
  const checks = value.checks.filter(check => check.text.trim() !== '')
  const valid = value.title.trim() !== '' && value.prompt.trim() !== '' && checks.length > 0
  const setCheck = (index: number, patch: Partial<CaseDraft['checks'][number]>) => setValue(current => ({ ...current, checks: current.checks.map((check, position) => position === index ? { ...check, ...patch } : check) }))
  return <SidebarModal wide title={props.initial.id === undefined ? t('tests.newTitle') : t('tests.editTitle')} busy={props.busy} onClose={props.onClose} footer={<>
    {error !== null && <span className={css.skFormError}>{error}</span>}
    <Button variant="ghost" onClick={props.onClose}>{t('common.cancel')}</Button>
    <Button variant="primary" disabled={!valid || props.busy} onClick={() => { try { props.onSave({ ...value, checks }) } catch (reason) { setError(errorText(reason)) } }}>{t('common.save')}</Button>
  </>}>
    <div className={css.skForm}>
      <Field label={t('tests.caseTitle')}>{control => <input {...control} value={value.title} onChange={event => setValue({ ...value, title: event.target.value })} />}</Field>
      <Field label={t('tests.prompt')} hint={t('tests.promptHint')}>{control => <textarea {...control} rows={4} value={value.prompt} onChange={event => setValue({ ...value, prompt: event.target.value })} />}</Field>
      <Field label={t('tests.context')}>{control => <textarea {...control} rows={3} value={value.context ?? ''} onChange={event => setValue({ ...value, context: event.target.value })} />}</Field>
      <div>
        <Checkbox checked={value.requiresVision ?? false} label={t('tests.requiresVision')} disabled={props.busy} onChange={requiresVision => setValue({ ...value, requiresVision })} />
        <p className={css.skMuted}>{t('tests.requiresVisionHint')}</p>
      </div>
      <fieldset className={css.skChecks}>
        <legend>{t('tests.checksLabel')}</legend>
        {value.checks.map((check, index) => <div key={index}>
          <Checkbox className={css.skMust} checked={check.must} label={t('tests.must')} onChange={must => setCheck(index, { must })} />
          <input value={check.text} placeholder={t('tests.checkPlaceholder')} onChange={event => setCheck(index, { text: event.target.value })} />
          <button type="button" className={css.skDismiss} aria-label={t('common.delete')} onClick={() => setValue(current => ({ ...current, checks: current.checks.filter((_, position) => position !== index) }))}>×</button>
        </div>)}
        {value.checks.length < 8 && <Button variant="ghost" size="sm" onClick={() => setValue(current => ({ ...current, checks: [...current.checks, { text: '', must: false }] }))}>{t('tests.addCheck')}</Button>}
      </fieldset>
    </div>
  </SidebarModal>
}
