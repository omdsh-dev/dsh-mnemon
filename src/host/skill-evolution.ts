import { accessSync, constants, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  BacktestRun, DraftView, EvalCase, EvidencePack, ReviewLogEntry, ReviewRecordInput, ReviewRecordResult, RunTarget, SkillCatalog, SkillDocument, SkillDraft, SkillRootKind, SkillSuggestion, Trajectory,
  ModelRoute,
} from 'dsh-mnemon-source-skills/contracts'
import type { HostAgent, HostPreStepDecision, HostSessionEvent } from './dsh.ts'
import type { ResolvedSkillsConfig, SkillActivitySnapshot, StorageScopeKind, TurnSkillReview } from './protocol.ts'
import {
  gradeCase, parseCases, parseExecution, parseSkillDraft, parseSkillReview, SKILL_CASES_PERSONA, SKILL_CASES_SCHEMA, SKILL_DRAFT_PERSONA, SKILL_DRAFT_SCHEMA,
  SKILL_EXECUTOR_PERSONA, SKILL_EXECUTOR_SCHEMA, SKILL_JUDGE_PERSONA, SKILL_JUDGE_SCHEMA, SKILL_REVIEW_PERSONA, SKILL_REVIEW_SCHEMA,
  skillCasesPrompt, skillDraftPrompt, skillExecutorPrompt, skillJudgePrompt, skillReviewPrompt,
} from './skill-review.ts'
import { captureTurn, redact, sessionTitle, TrajectoryWindow, turnSkillUses } from './skill-trajectory.ts'
import { SubagentStoppedError } from './subagent-errors.ts'

/** The Skills Source's management protocol, as the Host calls it. */
export interface SkillsSourcePort {
  /** The Source session's effective storage scope, including pinned workspace graphs. */
  readonly scope?: { readonly storage: StorageScopeKind }
  read<T>(operation: string, input?: unknown, signal?: AbortSignal): Promise<T>
  mutate<T>(operation: string, input: unknown, signal?: AbortSignal): Promise<T>
}

export interface SkillEvolutionHost {
  /** 技能管理's settings as they are now; read at every turn and review. */
  settings(): ResolvedSkillsConfig
  /** The Skills Source for a conversation's workspace; undefined when it is not installed or its layer is off. */
  source(agent: HostAgent): SkillsSourcePort | undefined
  /** Run model work under a fresh task Agent in a workspace, outside any conversation. */
  runTask<T>(workspaceRoot: string | undefined, signal: AbortSignal, operation: (agent: HostAgent) => Promise<T>, route?: ModelRoute): Promise<T>
  skillTask(parent: HostAgent, label: string, prompt: string, schema: Record<string, unknown>, persona: string, signal: AbortSignal, route?: ModelRoute, maxTokens?: number): Promise<{ structured: unknown }>
  now?(): Date
  warn?(message: string, error?: unknown): void
}

interface SessionState {
  window: TrajectoryWindow
  timer?: ReturnType<typeof setTimeout>
  /** The turn a review waiting for the conversation to sit idle will be placed under. */
  scheduled?: number
  running?: Promise<void>
  /** The turn the review under way is placed under. */
  reviewing?: number
  lastReviewAt?: number
  failures: number
}

/** A conversation's turn bars read at most this many of its reviews. */
const ACTIVITY_REVIEWS = 50
const WAITING_STATUSES: ReadonlySet<string> = new Set(['pending', 'drafting', 'review'])

/** A session stops reviewing after this many failures in a row, until DSH recreates its Agent. */
const MAX_CONSECUTIVE_FAILURES = 3
/** Backtest children run this many cases at once. */
/** One retry for a case whose run failed rather than scored. */
const CASE_ATTEMPTS = 2
const BACKTEST_CONCURRENCY = 2

interface PreStepPayload { step: number; signal: AbortSignal }

/**
 * The Source's revision moves with every write, and background reviews and
 * runs write concurrently. A conflict is refused before the Source runs, and
 * every write carries its own precondition (a file hash, a status), so trying
 * again on the fresh revision is safe.
 */
export function retryingSource(source: SkillsSourcePort, attempts = 4): SkillsSourcePort {
  return {
    ...(source.scope === undefined ? {} : { scope: source.scope }),
    read: (operation, input, signal) => source.read(operation, input, signal),
    mutate: async <T>(operation: string, input: unknown, signal?: AbortSignal): Promise<T> => {
      for (let attempt = 1; ; attempt++) {
        try { return await source.mutate<T>(operation, input, signal) } catch (error) {
          if (attempt >= attempts || !/revision conflict|Skills Source changed since it was read; reload/u.test(error instanceof Error ? error.message : String(error))) throw error
        }
      }
    },
  }
}

function message(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error))
}

/**
 * A draft task that stops reporting is abandoned here. The subagent behind it
 * can die without settling, and the suggestion would otherwise stay `drafting`
 * - blocking dismiss, delete and a retry - until the Host restarts.
 */
const DRAFT_DEADLINE_MS = 15 * 60 * 1000

/** Distinguishes a deadline abort from the plain abort a Host shutdown sends. */
class DraftDeadlineError extends Error {}

/** The deadline error a task ran into, so the Source records why the draft ended. */
function deadlineReason(signal: AbortSignal): DraftDeadlineError | undefined {
  return signal.reason instanceof DraftDeadlineError ? signal.reason : undefined
}

/** Cancellation settles the owner even when an underlying task ignores its signal. */
function abortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Resolve only roots supplied by this Source's scoped catalog, never the task's cwd. */
function newSkillRoot(settings: ResolvedSkillsConfig, source: SkillsSourcePort, catalog: SkillCatalog, explicit?: SkillRootKind): SkillRootKind {
  let root = explicit
  if (root === undefined) {
    if (settings.targetScope === 'storage' && source.scope === undefined) throw new Error('The skill destination needs a known storage scope; select User or Project in Skills settings.')
    const project = settings.targetScope === 'project' || (settings.targetScope === 'storage' && (source.scope?.storage === 'workspace' || source.scope?.storage === 'workspaces'))
    root = project ? 'project-dsh' : 'user-dsh'
  }
  const directory = catalog.roots.find(candidate => candidate.kind === root)?.path
  if (directory === undefined || (root.startsWith('project-') && catalog.projectRoot === undefined)) throw new Error('Project skill roots need a selected workspace; select a workspace or choose User in Skills settings.')
  if (root.startsWith('project-')) {
    try {
      if (!statSync(catalog.projectRoot!).isDirectory()) throw new Error('not a directory')
    } catch { throw new Error('The selected workspace project is unavailable; select an existing workspace or choose User in Skills settings.') }
  }
  // The root may not exist until adoption. Check its nearest existing parent
  // without creating directories; adoption still reports any later I/O failure.
  let parent = directory
  try {
    for (;;) {
      try {
        if (!statSync(parent).isDirectory()) throw new Error('not a directory')
        accessSync(parent, constants.W_OK | constants.X_OK)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error
        parent = dirname(parent)
      }
    }
  } catch { throw new Error(`Cannot create a skill in ${root}: its directory is not writable. Choose another destination or fix its permissions.`) }
  return root
}

/**
 * The Host half of skill evolution: it captures each conversation's
 * trajectory as turns end, decides when a window has earned a review, runs
 * every model step under a task Agent, and records the results through the
 * Skills Source's own protocol. It never writes a skill file itself.
 */
export class SkillEvolution {
  private readonly sessions = new Map<string, SessionState>()
  private readonly jobs = new Set<AbortController>()
  private disposed = false
  private activeBacktests = 0
  private backtestJobs = 0
  private readonly backtestWaiters = new Set<() => void>()

  constructor(private readonly host: SkillEvolutionHost) {}

  private source(agent: HostAgent): SkillsSourcePort | undefined {
    const source = this.host.source(agent)
    return source === undefined ? undefined : retryingSource(source)
  }

  private now(): Date {
    return this.host.now?.() ?? new Date()
  }

  private warn(text: string, error?: unknown): void {
    if (this.host.warn !== undefined) this.host.warn(text, error)
    else console.warn(`dsh-mnemon: ${text}`, error === undefined ? '' : message(error))
  }

  private state(agent: HostAgent): SessionState {
    let state = this.sessions.get(agent.id)
    if (state === undefined) {
      state = { window: new TrajectoryWindow(), failures: 0 }
      this.sessions.set(agent.id, state)
    }
    return state
  }

  /** Observe one root conversation Agent; the returned function stops observing it. */
  watch(agent: HostAgent): () => void {
    const stops = [
      agent.ctx.on('session/event', ((session: HostAgent['session'], event: HostSessionEvent) => {
        if (session !== agent.session || event.type !== 'turn/end' || typeof event.data.turn !== 'number') return
        void this.turnEnded(agent, event.data.turn).catch(error => this.warn('skill evolution could not read a finished turn', error))
      }) as never),
      agent.ctx.on('agent/pre-step', (async (payload: PreStepPayload, next: () => Promise<HostPreStepDecision>) => {
        // A new turn means the conversation is not idle; the review waits for the next pause.
        if (payload.step === 1) this.cancelTimer(agent.id)
        return next()
      }) as never),
    ]
    return () => {
      for (const stop of stops) stop()
      this.cancelTimer(agent.id)
      this.sessions.delete(agent.id)
    }
  }

  private cancelTimer(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state?.timer !== undefined) { clearTimeout(state.timer); delete state.timer }
    if (state !== undefined) delete state.scheduled
  }

  /** 技能管理's settings as they are now. */
  config(): ResolvedSkillsConfig {
    return this.host.settings()
  }

  /** Capture the finished turn and, when the window has earned it, schedule a review for the next pause. */
  async turnEnded(agent: HostAgent, turn: number): Promise<void> {
    if (this.disposed) return
    const settings = this.host.settings()
    if (!settings.evolution || (!settings.allowCreate && !settings.allowUpdate)) { this.cancelTimer(agent.id); return }
    if (this.source(agent) === undefined) return
    const captured = captureTurn(agent.session.snapshotEvents(), turn)
    if (captured === undefined || captured.steps.length === 0) return
    const state = this.state(agent)
    if (state.failures >= MAX_CONSECUTIVE_FAILURES) return
    state.window.add(captured, this.now())
    this.schedule(agent, state, settings)
  }

  private schedule(agent: HostAgent, state: SessionState, settings: ResolvedSkillsConfig): void {
    this.cancelTimer(agent.id)
    if (state.running !== undefined || state.window.score().score < settings.reviewThreshold) return
    const now = this.now().getTime()
    const cooldown = state.lastReviewAt === undefined ? 0 : Math.max(0, state.lastReviewAt + settings.cooldownSeconds * 1000 - now)
    const turn = state.window.lastTurn
    if (turn !== undefined) state.scheduled = turn
    state.timer = setTimeout(() => {
      delete state.timer
      delete state.scheduled
      if (this.disposed || state.running !== undefined) return
      const current = this.host.settings()
      if (agent.status !== 'idle' || !current.evolution || (!current.allowCreate && !current.allowUpdate)) return
      state.running = this.review(agent, state, 'automatic').then(() => undefined).finally(() => { delete state.running })
    }, Math.max(settings.idleSeconds * 1000, cooldown))
  }

  /**
   * Review one session now, whatever its score: the window collected so far,
   * or the session's recent turns when nothing is collected yet.
   */
  async reviewNow(agent: HostAgent): Promise<ReviewRecordResult> {
    const settings = this.host.settings()
    if (!settings.allowCreate && !settings.allowUpdate) throw new Error('Enable new-skill or skill-improvement suggestions before reviewing')
    const source = this.source(agent)
    if (source === undefined) throw new Error('the Skills Source is not running for this conversation')
    const state = this.state(agent)
    if (state.running !== undefined) await state.running
    if (state.window.size === 0) {
      const events = agent.session.snapshotEvents()
      const turns = [...new Set(events.filter(event => event.type === 'turn/end' && typeof event.data.turn === 'number').map(event => Number(event.data.turn)))].slice(-6)
      for (const turn of turns) {
        const captured = captureTurn(events, turn)
        if (captured !== undefined && captured.steps.length > 0) state.window.add(captured, this.now())
      }
    }
    if (state.window.size === 0) throw new Error('this conversation has no finished turn to review yet')
    this.cancelTimer(agent.id)
    const run = this.review(agent, state, 'manual')
    state.running = run.then(() => undefined).finally(() => { delete state.running })
    const result = await run
    if (result instanceof Error) throw result
    return result
  }

  /** Run one review; a failure is logged and returned, never thrown. */
  private async review(agent: HostAgent, state: SessionState, trigger: 'automatic' | 'manual'): Promise<ReviewRecordResult | Error> {
    const source = this.source(agent)
    if (source === undefined) return new Error('the Skills Source is not running for this conversation')
    const settings = this.host.settings()
    if ((!settings.allowCreate && !settings.allowUpdate) || (trigger === 'automatic' && !settings.evolution)) return new Error('Skill reviews are disabled')
    const allowedTypes = () => {
      const current = this.host.settings()
      const enabled = trigger === 'manual' || current.evolution
      return {
        allowCreate: enabled && settings.allowCreate && current.allowCreate,
        allowUpdate: enabled && settings.allowUpdate && current.allowUpdate,
      }
    }
    const started = this.now()
    // The window moves out now; turns that end during the review start the next one.
    const window = state.window
    state.window = new TrajectoryWindow()
    const turn = window.lastTurn
    if (turn !== undefined) state.reviewing = turn
    const events = agent.session.snapshotEvents()
    const workspace = agent.session.header?.cwd?.trim() || undefined
    const steps = window.steps()
    const stats = window.stats()
    const score = window.score()
    const title = sessionTitle(events)
    const controller = new AbortController()
    this.jobs.add(controller)
    const base = {
      at: started.toISOString(), sessionId: agent.id, ...(title === undefined ? {} : { sessionTitle: title }), trigger, ...(turn === undefined ? {} : { turn }),
      score: { score: score.score, threshold: score.threshold, textLengthScore: score.textLengthScore, turnScore: score.turnScore, toolCallScore: score.toolCallScore, toolDiversityScore: score.toolDiversityScore },
    }
    const trajectory: ReviewRecordInput['trajectory'] = {
      sessionId: agent.id, ...(title === undefined ? {} : { sessionTitle: title }), ...(workspace === undefined ? {} : { workspace }),
      startedAt: window.startedAt ?? started.toISOString(), endedAt: started.toISOString(), stats, score: base.score, steps, annotations: [],
    }
    try {
      const catalog = await source.read<SkillCatalog>('catalog', null, controller.signal)
      const active = catalog.skills.filter(skill => skill.shadowedBy === undefined)
      // Management reads are deeply frozen, so order a copy instead of the result.
      const openSuggestions = [...await source.read<SkillSuggestion[]>('suggestions', { status: ['pending', 'drafting', 'review'] }, controller.signal)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      const loaded: SkillDocument[] = []
      const caseTitles: Record<string, string[]> = {}
      for (const name of stats.skills.slice(0, 3)) {
        const skill = active.find(candidate => candidate.name === name)
        if (skill === undefined) continue
        loaded.push(await source.read<SkillDocument>('skill', { key: skill.key }, controller.signal))
        caseTitles[name] = (await source.read<EvalCase[]>('cases', { skill: name }, controller.signal)).map(entry => entry.title)
      }
      const prompt = skillReviewPrompt({
        ...allowedTypes(),
        ...(title === undefined ? {} : { sessionTitle: title }), ...(workspace === undefined ? {} : { workspace }),
        steps, stats, score: score.score, threshold: score.threshold,
        loaded, catalog: active.map(skill => ({ name: skill.name, description: skill.description })), caseTitles, openSuggestions,
      })
      const paused = { structured: { outcome: 'nothing', summary: 'Skill review was paused by the current settings.', suggestions: [] } }
      const types = allowedTypes()
      const answer = !types.allowCreate && !types.allowUpdate ? paused : await this.host.runTask(workspace, controller.signal, task => {
        const current = allowedTypes()
        return !current.allowCreate && !current.allowUpdate ? Promise.resolve(paused)
          : this.host.skillTask(task, 'Mnemon skill review', prompt, SKILL_REVIEW_SCHEMA as unknown as Record<string, unknown>, SKILL_REVIEW_PERSONA, controller.signal)
      })
      const parsed = parseSkillReview(answer.structured)
      // A switch changed while the model ran also applies to this result. The
      // Source checks the final action against its current skill catalog.
      const current = this.host.settings()
      const policy = {
        ...allowedTypes(),
        minConfidence: current.minConfidence, expiryDays: current.expiryDays, maxPendingPerSession: current.maxPendingPerSession,
      }
      const targetRoot = policy.allowCreate && parsed.suggestions.some(suggestion => suggestion.action === 'create' && !active.some(skill => skill.name === suggestion.skillName))
        ? newSkillRoot(current, source, catalog) : undefined
      const result = await source.mutate<ReviewRecordResult>('review-record', {
        review: { ...base, durationMs: this.now().getTime() - started.getTime(), outcome: parsed.suggestions.length > 0 ? 'suggested' : 'nothing', summary: parsed.summary },
        trajectory, annotations: parsed.annotations,
        suggestions: parsed.suggestions.map(suggestion => suggestion.action === 'create' && targetRoot !== undefined ? { ...suggestion, targetRoot } : suggestion),
        cases: parsed.cases, policy,
      } satisfies ReviewRecordInput)
      state.failures = 0
      state.lastReviewAt = this.now().getTime()
      return result
    } catch (error) {
      state.failures += 1
      state.lastReviewAt = this.now().getTime()
      // Keep the evidence for the next attempt, ahead of anything that arrived since.
      const pending = state.window
      state.window = window
      for (const turn of pending.captured()) state.window.add(turn, this.now())
      this.warn('skill review failed', error)
      try {
        await source.mutate('review-record', {
          review: { ...base, durationMs: this.now().getTime() - started.getTime(), outcome: 'error', error: message(error) },
          trajectory, annotations: [], suggestions: [], cases: [],
        } satisfies ReviewRecordInput)
      } catch (recordError) { this.warn('skill review failure could not be logged', recordError) }
      return error instanceof Error ? error : new Error(String(error))
    } finally {
      this.jobs.delete(controller)
      delete state.reviewing
    }
  }

  // ---- page assistance -----------------------------------------------------

  private background(name: string, work: (signal: AbortSignal) => Promise<void>, deadlineMs?: number): Promise<void> {
    const controller = new AbortController()
    this.jobs.add(controller)
    const timer = deadlineMs === undefined ? undefined : setTimeout(() => {
      controller.abort(new DraftDeadlineError(`${name} did not finish within ${Math.round(deadlineMs / 60_000)} minutes`))
    }, deadlineMs)
    timer?.unref?.()
    const result = work(controller.signal).catch(error => this.warn(`${name} failed`, deadlineReason(controller.signal) ?? error)).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
      this.jobs.delete(controller)
    })
    return result
  }

  /**
   * Write a draft for a suggestion (or for a skill directly) in the
   * background; the suggestion shows `drafting` until it is recorded.
   */
  async draft(port: SkillsSourcePort, workspace: string | undefined, input: { suggestionId?: string; draftId?: string; skill?: string; guidance?: string; targetRoot?: SkillRootKind; backtest?: boolean; route?: ModelRoute }): Promise<{ started: true; suggestionId?: string }> {
    const source = retryingSource(port)
    const pack = await source.read<EvidencePack>('evidence-pack', { ...(input.suggestionId === undefined ? {} : { suggestionId: input.suggestionId }), ...(input.draftId === undefined ? {} : { draftId: input.draftId }), ...(input.skill === undefined ? {} : { skill: input.skill }) })
    // The evidence window contains only three recent drafts across this skill.
    // Resolve this flow's own prior draft independently of that bounded context.
    const previousId = input.draftId ?? pack.suggestion?.draftId
    const previous = previousId === undefined
      ? (await source.read<SkillDraft[]>('drafts', { skill: pack.skillName, ...(pack.skill === undefined ? {} : { path: pack.skill.path }), ...(input.suggestionId === undefined ? {} : { suggestionId: input.suggestionId }) })).find(draft => draft.suggestionId === input.suggestionId)
      : (await source.read<DraftView>('draft', { id: previousId })).draft
    // An improvement always keeps the file the Source loaded. For a creation,
    // freeze one choice before model work and use it for both prompt and record.
    const targetRoot = pack.action === 'update' ? pack.skill!.root
      : newSkillRoot(this.host.settings(), source, await source.read<SkillCatalog>('catalog'), input.targetRoot ?? previous?.targetRoot ?? pack.suggestion?.targetRoot)
    const guidance = [...(previous?.guidance ?? []), ...(input.guidance?.trim() ? [input.guidance.trim()] : [])].slice(-8)
    if (input.suggestionId !== undefined) await source.mutate('suggestion-status', { id: input.suggestionId, status: 'drafting' })
    this.background('skill draft', async signal => {
      let recorded = false
      try {
        await abortable(signal, () => this.writeDraft(source, workspace, input, { pack, targetRoot, guidance, onRecorded: () => { recorded = true } }, signal))
      } catch (error) {
        if (!recorded && input.suggestionId !== undefined) {
          const suggestions = await source.read<SkillSuggestion[]>('suggestions')
          if (suggestions.find(item => item.id === input.suggestionId)?.status === 'drafting') {
            await source.mutate('suggestion-status', { id: input.suggestionId, status: 'pending', error: message(deadlineReason(signal) ?? error) }).catch(() => undefined)
          }
        }
        throw error
      }
    }, DRAFT_DEADLINE_MS)
    return { started: true, ...(input.suggestionId === undefined ? {} : { suggestionId: input.suggestionId }) }
  }

  private async writeDraft(source: SkillsSourcePort, workspace: string | undefined, input: { suggestionId?: string; draftId?: string; skill?: string; guidance?: string; targetRoot?: SkillRootKind; backtest?: boolean; route?: ModelRoute }, prepared: { pack: EvidencePack; targetRoot: SkillRootKind; guidance: string[]; onRecorded?: () => void }, signal: AbortSignal): Promise<SkillDraft> {
    const settings = this.host.settings()
    const { pack, targetRoot, guidance } = prepared
    let prompt = skillDraftPrompt(pack, guidance, targetRoot)
    let maxTokens = settings.draftMaxTokens
    const attemptedBudgets: number[] = []
    let draft: SkillDraft | undefined
    for (let attempt = 0; draft === undefined; attempt++) {
      signal.throwIfAborted()
      attemptedBudgets.push(maxTokens)
      let answer: { structured: unknown }
      try {
        answer = await this.host.runTask(workspace, signal, task => this.host.skillTask(task, 'Mnemon skill draft', prompt, SKILL_DRAFT_SCHEMA as unknown as Record<string, unknown>, SKILL_DRAFT_PERSONA, signal, input.route, maxTokens), input.route)
        signal.throwIfAborted()
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof SubagentStoppedError && error.maxTokens !== undefined) attemptedBudgets[attemptedBudgets.length - 1] = error.maxTokens
        // Share the existing one-retry limit with file-validation repair. A
        // fresh task discards truncated JSON and gets a new result capability.
        if (error instanceof SubagentStoppedError && error.stopReason === 'max-tokens' && attempt === 0 && settings.draftRetryMaxTokens > maxTokens) {
          maxTokens = settings.draftRetryMaxTokens
          prompt += '\n\nThe previous attempt exhausted its output budget and was discarded. Return a complete SKILL.md from the beginning; keep notes and changes concise.'
          continue
        }
        const bytes = Buffer.byteLength(pack.skill?.content ?? '', 'utf8')
        // The Source retains 500 error characters. Put actionable context first
        // and bound provider detail so the page keeps the complete guidance.
        throw new Error(`Skill draft failed. Attempted budgets: ${attemptedBudgets.join(', ')} tokens; source SKILL.md: ${bytes} bytes (UTF-8). Adjust skills.draftMaxTokens / skills.draftRetryMaxTokens in Plugins → dsh-mnemon → Skills → Draft generation. Stay within provider/model caps: lower rejected budgets, shorten the skill or use a model with a higher output cap. Reason: ${message(error).slice(0, 100)}`, { cause: error })
      }
      const parsed = parseSkillDraft(answer.structured)
      try {
        signal.throwIfAborted()
        draft = await source.mutate<SkillDraft>('draft-record', {
          ...(input.suggestionId === undefined ? {} : { suggestionId: input.suggestionId }),
          ...(input.draftId === undefined ? {} : { draftId: input.draftId }),
          skillName: pack.skillName, content: parsed.content, notes: parsed.notes, changes: parsed.changes, guidance,
          expectedBaseHash: pack.skill?.hash ?? null,
          ...(pack.action === 'create' ? { targetRoot } : {}),
        }, signal)
        prepared.onRecorded?.()
      } catch (error) {
        signal.throwIfAborted()
        // One retry, told exactly why DSH would refuse the file.
        if (attempt > 0 || /changed while this draft/.test(message(error))) throw error
        prompt += `\n\nYour previous SKILL.md was rejected: ${message(error)}. Return a corrected complete file.`
      }
    }
    signal.throwIfAborted()
    if ((settings.autoBacktest || input.backtest) && pack.cases.length > 0) {
      await this.backtest(source, workspace, { skillName: pack.skillName, target: { kind: 'draft', draftId: draft.id }, ...(input.route === undefined ? {} : { route: input.route }) })
      // Older runs do not record their model, so they cannot be a baseline for
      // an explicitly selected route even when the skill content is unchanged.
      const baselineKnown = input.route === undefined && pack.action === 'update' && pack.lastRun !== undefined && pack.lastRun.target.hash === pack.skill?.hash
      if (baselineKnown) await source.mutate('run-link', { draftId: draft.id, runId: pack.lastRun!.id })
      else {
        const baseline = await this.backtest(source, workspace, { skillName: pack.skillName, target: { kind: pack.action === 'update' ? 'current' : 'none', ...(pack.action === 'update' ? { draftId: draft.id } : {}) }, ...(input.route === undefined ? {} : { route: input.route }) })
        await source.mutate('run-link', { draftId: draft.id, runId: baseline.runId })
      }
    }
    return draft
  }

  /** Start a backtest of one version of a skill against its enabled cases; it runs in the background. */
  private backtestSlot(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const abort = () => { this.backtestWaiters.delete(acquire); reject(signal.reason) }
      const acquire = () => {
        if (signal.aborted) { abort(); return }
        if (this.activeBacktests >= 2) return
        this.backtestWaiters.delete(acquire)
        signal.removeEventListener('abort', abort)
        this.activeBacktests++
        resolve(() => {
          this.activeBacktests--
          for (const waiter of [...this.backtestWaiters]) waiter()
        })
      }
      this.backtestWaiters.add(acquire)
      signal.addEventListener('abort', abort, { once: true })
      acquire()
    })
  }

  async backtest(port: SkillsSourcePort, workspace: string | undefined, input: { skillName: string; target: RunTarget; caseIds?: string[]; route?: ModelRoute }): Promise<{ runId: string }> {
    if (this.disposed) throw new Error('Skill evolution has stopped')
    if (this.backtestJobs >= 16) throw new Error('The skill backtest queue is full. Cancel a run or retry after it finishes.')
    this.backtestJobs++
    const source = retryingSource(port)
    try {
      const settings = this.host.settings()
      const cases = (await source.read<EvalCase[]>('cases', { skill: input.skillName })).filter(entry => entry.enabled && (input.caseIds === undefined || input.caseIds.includes(entry.id))).slice(0, settings.casesPerRun)
      if (cases.length === 0) throw new Error(`${input.skillName} has no enabled eval case to run`)
      if (cases.some(entry => entry.requiresVision !== undefined && typeof entry.requiresVision !== 'boolean')) throw new Error('requiresVision must be a boolean')
      const resolved = await source.read<{ content?: string; target: RunTarget }>('target-content', { skillName: input.skillName, target: input.target })
      const run = await source.mutate<BacktestRun>('run-start', { skillName: input.skillName, target: resolved.target, caseIds: cases.map(entry => entry.id) })
      void this.background('skill backtest', async deadline => {
        const controller = new AbortController()
        const abort = () => controller.abort(deadline.reason)
        deadline.addEventListener('abort', abort, { once: true })
        if (deadline.aborted) abort()
        const signal = controller.signal
        // Cancellation is a Source-owned mutation and works even after a restart.
        let checking = false
        const watcher = setInterval(() => {
          if (checking || signal.aborted) return
          checking = true
          void source.read<BacktestRun>('run', { id: run.id }).then(current => {
            if (current.status !== 'running') controller.abort(new Error(current.error ?? 'Backtest interrupted'))
          }).catch(error => controller.abort(error)).finally(() => { checking = false })
        }, 1_000)
        watcher.unref?.()
        try {
          await abortable(signal, async () => {
            const release = await this.backtestSlot(signal)
            try {
              for (const entry of cases.filter(entry => entry.requiresVision === true)) {
                signal.throwIfAborted()
                await source.mutate('run-progress', { id: run.id, result: {
                  caseId: entry.id, title: entry.title, verdict: 'error', score: 0,
                  unmeasuredReason: 'requires-vision', checks: [], steps: [], answer: '',
                  error: 'Not measured: this case requires image input, which text-only backtests cannot receive.',
                } }, signal)
              }
              const queue = cases.filter(entry => entry.requiresVision !== true)
              if (queue.length > 0) await abortable(signal, () => this.host.runTask(workspace, signal, async task => {
                const worker = async () => {
                  for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
                    signal.throwIfAborted()
                    const result = await this.runCase(task, entry, input.skillName, resolved.content, signal)
                    signal.throwIfAborted()
                    await source.mutate('run-progress', { id: run.id, result }, signal)
                  }
                }
                await Promise.all(Array.from({ length: Math.min(BACKTEST_CONCURRENCY, queue.length) }, worker))
              }, input.route))
              signal.throwIfAborted()
              await source.mutate('run-finish', { id: run.id, status: 'completed' }, signal)
            } finally { release() }
          })
        } catch (error) {
          await source.mutate('run-finish', { id: run.id, status: signal.aborted ? 'interrupted' : 'failed', error: message(signal.aborted ? signal.reason : error) }).catch(() => undefined)
          throw error
        } finally {
          clearInterval(watcher)
          deadline.removeEventListener('abort', abort)
        }
      }, 45 * 60 * 1000).finally(() => { this.backtestJobs-- })
      return { runId: run.id }
    } catch (error) {
      this.backtestJobs--
      throw error
    }
  }

  /**
   * Execute and grade one case. A run that fails (an output limit, a missing
   * result) gets one more try; a case that still cannot run is recorded as
   * an error, which the run's score leaves out.
   */
  private async runCase(task: HostAgent, entry: EvalCase, skillName: string, content: string | undefined, signal: AbortSignal) {
    let failure: unknown
    for (let attempt = 0; attempt < CASE_ATTEMPTS; attempt++) {
      try {
        const executed = parseExecution((await this.host.skillTask(task, `Mnemon skill eval: ${entry.title}`.slice(0, 120), skillExecutorPrompt(entry, { name: skillName, ...(content === undefined ? {} : { content }) }), SKILL_EXECUTOR_SCHEMA as unknown as Record<string, unknown>, SKILL_EXECUTOR_PERSONA, signal)).structured)
        signal.throwIfAborted()
        const judged = await this.host.skillTask(task, `Mnemon skill judge: ${entry.title}`.slice(0, 120), skillJudgePrompt(entry, executed.steps, executed.answer), SKILL_JUDGE_SCHEMA as unknown as Record<string, unknown>, SKILL_JUDGE_PERSONA, signal)
        const grade = gradeCase(entry, judged.structured)
        return { caseId: entry.id, title: entry.title, verdict: grade.verdict, score: grade.score, checks: grade.checks, steps: executed.steps, answer: executed.answer, summary: grade.summary }
      } catch (error) {
        if (signal.aborted) throw error
        failure = error
      }
    }
    return { caseId: entry.id, title: entry.title, verdict: 'error' as const, score: 0, checks: [], steps: [], answer: '', error: message(failure) }
  }

  /** Turn a recorded trajectory into eval cases for one skill. */
  async deriveCases(port: SkillsSourcePort, workspace: string | undefined, input: { trajectoryId: string; skillName: string; steps?: number[] }, signal: AbortSignal): Promise<{ added: EvalCase[]; skipped: number }> {
    const source = retryingSource(port)
    const trajectory = await source.read<Trajectory>('trajectory', { id: input.trajectoryId }, signal)
    const wanted = new Set(input.steps ?? [])
    const steps = wanted.size === 0 ? trajectory.steps : trajectory.steps.filter(step => [...wanted].some(index => Math.abs(index - step.index) <= 1))
    const existing = await source.read<EvalCase[]>('cases', { skill: input.skillName }, signal)
    const catalog = await source.read<SkillCatalog>('catalog', null, signal)
    const skill = catalog.skills.find(candidate => candidate.name === input.skillName && candidate.shadowedBy === undefined)
    const document = skill === undefined ? undefined : await source.read<SkillDocument>('skill', { key: skill.key }, signal)
    const answer = await this.host.runTask(workspace, signal, task => this.host.skillTask(task, 'Mnemon skill eval cases', skillCasesPrompt(input.skillName, steps, existing, document?.content), SKILL_CASES_SCHEMA as unknown as Record<string, unknown>, SKILL_CASES_PERSONA, signal))
    const cases = parseCases(answer.structured)
    if (cases.length === 0) return { added: [], skipped: 0 }
    return source.mutate('cases-add', { skillName: input.skillName, trajectoryId: input.trajectoryId, ...(input.steps === undefined ? {} : { steps: input.steps }), cases }, signal)
  }

  /**
   * What one conversation did with skills, for the bars under its turns: the
   * skills each turn used, read from its own log, and each review placed under
   * the turn its window ended with — the one waiting or under way first, then
   * the recorded ones with the suggestions they left that still wait. A
   * conversation that is not live passes its stored log.
   */
  async activity(agent: HostAgent, events?: readonly HostSessionEvent[]): Promise<SkillActivitySnapshot> {
    const port = this.host.source(agent)
    if (port === undefined) return { available: false, turns: [], reviews: [] }
    const turns = turnSkillUses(events ?? agent.session.snapshotEvents())
    const state = this.sessions.get(agent.id)
    const reviews: TurnSkillReview[] = []
    if (state?.reviewing !== undefined) reviews.push({ turn: state.reviewing, state: 'reviewing', suggestions: [] })
    else if (state?.scheduled !== undefined) reviews.push({ turn: state.scheduled, state: 'scheduled', suggestions: [] })
    const [log, suggestions] = await Promise.all([
      port.read<ReviewLogEntry[]>('reviews', { sessionId: agent.id, limit: ACTIVITY_REVIEWS }),
      port.read<SkillSuggestion[]>('suggestions', {}),
    ])
    const byId = new Map(suggestions.map(suggestion => [suggestion.id, suggestion]))
    for (const entry of log) {
      if (entry.turn === undefined || reviews.some(review => review.turn === entry.turn)) continue
      const left = (entry.suggestionIds ?? []).flatMap(id => {
        const suggestion = byId.get(id)
        return suggestion === undefined || !WAITING_STATUSES.has(suggestion.status) ? [] : [{ id, skillName: suggestion.skillName, action: suggestion.action, status: suggestion.status }]
      })
      reviews.push({ turn: entry.turn, state: entry.outcome, suggestions: left, ...(entry.error === undefined ? {} : { error: entry.error }) })
    }
    return { available: true, turns, reviews }
  }

  /** The window each live session has collected, for the page. */
  pending(sessionId: string): { turns: number; score: number } | undefined {
    const state = this.sessions.get(sessionId)
    return state === undefined ? undefined : { turns: state.window.size, score: state.window.score().score }
  }

  dispose(): void {
    this.disposed = true
    for (const state of this.sessions.values()) if (state.timer !== undefined) clearTimeout(state.timer)
    this.sessions.clear()
    for (const job of this.jobs) job.abort()
    this.jobs.clear()
  }
}
