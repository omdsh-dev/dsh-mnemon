import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import * as SkillsContracts from 'dsh-mnemon-source-skills/contracts'
import type { AutoAdoptionEvent, BacktestRun, DraftPreferencesView, DraftView, EvalCase, ModelRoute, SkillDraft, SkillSuggestion } from 'dsh-mnemon-source-skills/contracts'
import type { ResolvedSkillsConfig } from './protocol.ts'
import type { SkillsSourcePort } from './skill-evolution.ts'

type Route = ModelRoute & { reasoningEffort?: string }
type Reason = NonNullable<AutoAdoptionEvent['reason']>
interface Job { source: SkillsSourcePort; workspace: string | undefined; id: string; available: () => boolean; controller: AbortController; action?: 'create' | 'update' }
interface Host {
  settings(): ResolvedSkillsConfig
  route(workspace: string | undefined): Route | undefined
  draft(source: SkillsSourcePort, workspace: string | undefined, input: { suggestionId: string; action: 'create' | 'update'; previous?: SkillDraft; guidance: string; route: Route }, signal: AbortSignal): Promise<SkillDraft>
  backtest(source: SkillsSourcePort, workspace: string | undefined, input: { skillName: string; target: SkillsContracts.RunTarget; route: Route; expectedCasesHash: string; signal: AbortSignal }): Promise<{ runId: string }>
  warn(message: string, error?: unknown): void
}
export class AutomaticSkillStop extends Error {
  constructor(readonly reason: Reason, detail?: string) { super(detail ?? reason) }
}
export function hashSkillCases(cases: readonly EvalCase[]): string {
  return createHash('sha256').update(SkillsContracts.skillCaseSignature(cases)).digest('hex')
}
export function hashSkillDraft(draft: SkillDraft): string { return createHash('sha256').update(draft.content).digest('hex') }

/** Only fresh idle-review suggestions enter this bounded, in-process queue. */
export class SkillAutoAdoption {
  private readonly jobs = new Map<string, Job>()
  private tail: Promise<void> = Promise.resolve()
  private disposed = false
  constructor(private readonly host: Host) {}

  enqueue(source: SkillsSourcePort, workspace: string | undefined, ids: readonly string[], available: () => boolean): void {
    if (this.disposed || !this.host.settings().autoAdopt) return
    for (const id of ids) {
      if (this.jobs.has(id)) continue
      if (this.jobs.size >= 16) {
        void this.record({ source, id }, { stage: 'review', attempt: 0, reason: 'queue-full' }).catch(error => this.host.warn('Could not record automatic adoption queue limit', error))
        continue
      }
      const job: Job = { source, workspace, id, available, controller: new AbortController() }
      this.jobs.set(id, job)
      this.tail = this.tail.then(() => this.run(job)).catch(error => this.host.warn('Automatic skill adoption failed', error)).finally(() => { this.jobs.delete(id) })
    }
  }

  private allowed(job: Job): boolean {
    const settings = this.host.settings()
    return !this.disposed && settings.evolution && settings.autoAdopt && settings.autoBacktest && job.available()
      && (job.action === undefined || (job.action === 'create' ? settings.allowCreate : settings.allowUpdate))
  }
  settingsChanged(): void {
    for (const job of this.jobs.values()) if (!this.allowed(job)) job.controller.abort(new AutomaticSkillStop('disabled'))
  }
  dispose(): void {
    this.disposed = true
    for (const job of this.jobs.values()) job.controller.abort(new AutomaticSkillStop('interrupted'))
  }
  private checkpoint(job: Job): void {
    if (!this.allowed(job)) job.controller.abort(new AutomaticSkillStop(this.disposed ? 'interrupted' : 'disabled'))
    job.controller.signal.throwIfAborted()
  }
  private record(job: Pick<Job, 'source' | 'id'>, event: Omit<AutoAdoptionEvent, 'at'>): Promise<unknown> {
    return job.source.mutate('auto-adoption-record', { id: job.id, ...event })
  }
  private async unchanged(job: Job, draft: SkillDraft, casesHash: string): Promise<void> {
    this.checkpoint(job)
    const current = await job.source.read<DraftView>('draft', { id: draft.id }, job.controller.signal)
    const suggestions = await job.source.read<SkillSuggestion[]>('suggestions', null, job.controller.signal)
    const suggestion = suggestions.find(entry => entry.id === job.id)
    const cases = (await job.source.read<EvalCase[]>('cases', { skill: draft.skillName }, job.controller.signal)).filter(entry => entry.enabled)
    if (current.conflict !== undefined || current.draft.status !== 'ready' || suggestion?.status !== 'review' || suggestion.draftId !== draft.id || hashSkillDraft(current.draft) !== hashSkillDraft(draft) || hashSkillCases(cases) !== casesHash) throw new AutomaticSkillStop('changed')
  }
  private async runs(job: Job, ids: string[]): Promise<BacktestRun[]> {
    // The backtest workers each have a 45-minute deadline, including queueing.
    const deadline = AbortSignal.timeout(46 * 60 * 1000)
    const signal = AbortSignal.any([job.controller.signal, deadline])
    for (;;) {
      this.checkpoint(job)
      signal.throwIfAborted()
      const runs = await Promise.all(ids.map(id => job.source.read<BacktestRun>('run', { id }, signal)))
      if (runs.some(run => run.status !== 'running' && run.status !== 'completed') || runs.every(run => run.status !== 'running')) return runs
      await delay(250, undefined, { signal })
    }
  }
  private async run(job: Job): Promise<void> {
    const runIds = new Set<string>()
    let attempt = 0
    let scores: Pick<AutoAdoptionEvent, 'baselineScore' | 'draftScore'> = {}
    try {
      this.checkpoint(job)
      const suggestion = (await job.source.read<SkillSuggestion[]>('suggestions')).find(entry => entry.id === job.id)
      if (suggestion?.status !== 'pending' || suggestion.draftId !== undefined) throw new AutomaticSkillStop('changed')
      job.action = suggestion.action
      this.checkpoint(job)
      await this.record(job, { stage: 'queued', attempt })
      const cases = (await job.source.read<EvalCase[]>('cases', { skill: suggestion.skillName })).filter(entry => entry.enabled)
      if (cases.length === 0) throw new AutomaticSkillStop('no-cases')
      if (cases.some(entry => entry.requiresVision === true || entry.checks.length === 0)) throw new AutomaticSkillStop('unmeasured')
      if (cases.length > this.host.settings().casesPerRun) throw new AutomaticSkillStop('case-limit')
      const casesHash = hashSkillCases(cases)
      const preferences = await job.source.read<DraftPreferencesView>('draft-preferences')
      const defaultRoute = this.host.route(job.workspace)
      const runRoute = preferences.skillRunModels[suggestion.skillName] ?? preferences.runModel ?? defaultRoute
      const draftRoute = preferences.suggestionModels[job.id] ?? preferences.model ?? defaultRoute
      if (runRoute === undefined || draftRoute === undefined) throw new AutomaticSkillStop('model-unavailable')
      let previous: SkillDraft | undefined
      let guidance = ''
      for (attempt = 1; attempt <= 3; attempt++) {
        this.checkpoint(job)
        await this.record(job, { stage: 'drafting', attempt })
        const draft = await this.host.draft(job.source, job.workspace, { suggestionId: job.id, action: suggestion.action, ...(previous === undefined ? {} : { previous }), guidance, route: draftRoute }, job.controller.signal)
        await this.unchanged(job, draft, casesHash)
        await this.record(job, { stage: 'backtesting', attempt })
        // Always measure a fresh pair, with one frozen route and identical cases.
        const baseline = await this.host.backtest(job.source, job.workspace, { skillName: draft.skillName, target: { kind: draft.action === 'update' ? 'current' : 'none', ...(draft.action === 'update' ? { draftId: draft.id } : {}) }, route: runRoute, expectedCasesHash: casesHash, signal: job.controller.signal })
        runIds.add(baseline.runId)
        this.checkpoint(job)
        const candidate = await this.host.backtest(job.source, job.workspace, { skillName: draft.skillName, target: { kind: 'draft', draftId: draft.id }, route: runRoute, expectedCasesHash: casesHash, signal: job.controller.signal })
        runIds.add(candidate.runId)
        await job.source.mutate('run-link', { draftId: draft.id, runId: baseline.runId }, job.controller.signal)
        const [before, after] = await this.runs(job, [baseline.runId, candidate.runId])
        await this.unchanged(job, draft, casesHash)
        const comparison = SkillsContracts.compareAutomaticSkillRuns(cases, before, after, casesHash)
        scores = { ...(comparison.baselineScore === undefined ? {} : { baselineScore: comparison.baselineScore }), ...(comparison.draftScore === undefined ? {} : { draftScore: comparison.draftScore }) }
        if (comparison.outcome === 'unmeasured') throw new AutomaticSkillStop('unmeasured')
        if (comparison.outcome === 'not-worse') {
          this.checkpoint(job)
          await job.source.mutate('draft-adopt', { id: draft.id, automatic: { draftHash: hashSkillDraft(draft), baselineRunId: baseline.runId, draftRunId: candidate.runId, casesHash, attempt } }, job.controller.signal)
          return // The Source records adoption and its scores with the version.
        }
        if (attempt === 3) throw new AutomaticSkillStop('regressed')
        await this.record(job, { stage: 'rewriting', attempt, reason: 'regressed', ...scores })
        guidance = `The previous draft regressed in paired backtests. Baseline score: ${comparison.baselineScore}; previous draft score: ${comparison.draftScore}. Improve each regressed case without losing any previously passing check.\n` + JSON.stringify(cases.map(entry => ({ title: entry.title, baseline: before!.results.find(result => result.caseId === entry.id), draft: after!.results.find(result => result.caseId === entry.id) }))).slice(0, 8_000)
        previous = draft
      }
    } catch (error) {
      const failure = job.controller.signal.aborted ? job.controller.signal.reason : error
      const reason: Reason = failure instanceof AutomaticSkillStop ? failure.reason : 'failed'
      await this.record(job, { stage: reason === 'disabled' || reason === 'interrupted' ? 'paused' : 'review', attempt: Math.min(attempt, 3), reason, ...scores,
        ...(failure instanceof AutomaticSkillStop ? {} : { detail: failure instanceof Error ? failure.message : String(failure) }),
      }).catch(recordError => this.host.warn('Could not record automatic adoption outcome', recordError))
    } finally {
      // Also stop the first run if starting the second run failed or was disabled.
      for (const id of runIds) await job.source.mutate('run-cancel', { id }).catch(error => this.host.warn('Could not stop automatic skill backtest', error))
    }
  }
}
