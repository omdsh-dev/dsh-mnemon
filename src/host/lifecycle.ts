import { findSessionEvent, sessionEvents, sessionLength, sessionTurnEvents, SessionEventCursor } from './session-events.ts'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ResolvedConfig } from './config.ts'
import type {
  CreateHostAgentOptions,
  HostAgent,
  HostAgentContext,
  HostAgentHandle,
  HostContextShape,
  HostLlmService,
  HostPreStepDecision,
  HostSessionEvent,
  HostSubagentRun,
  HostUserMessage,
} from "./dsh.ts"
import type { Insight, RememberRequest, SearchRequest } from 'dsh-mnemon-source-memory-spaces/contracts'
import type { RuntimeMemoryMutation } from 'dsh-mnemon-source-runtime/contracts'
import type { DocumentMutation } from 'dsh-mnemon-source-documents/contracts'
import { delegatedTaskLine, IdleReviewError, MnemonSubagentCoordinator, type IsolatedReviewRequest } from './subagent.ts'
import { attachContinuationTurns } from './continuation-turn.ts'
import { archiveOrphanedIdleReviews, archiveTaskSession, isIdleReviewOwner } from './task-session-cleanup.ts'
import { scoreReviewActivity } from './review-activity.ts'
import { idleReviewBlockReason } from './review-tools.ts'
import { TurnActivityProjection, type TurnMemoryActivitySnapshot } from './activity.ts'
import { applyMemoryViewGuidance } from './guidance.ts'
import { modelMemoryWake } from './view-presentation.ts'
import { strategyDrives, viewStrategy } from './strategy-workflows.ts'
import { mainStrategyTypeId } from './main-strategy.ts'
import { MEMORY_TOOLS } from './protocol.ts'
import { WORKSPACE_MEMORY_EXCLUDED } from './workspace-exclusion.ts'
import { AgentMemoryTurn, openAgentStep, openAgentTurn, type DelegatedMemoryView } from './agent-memory-turn.ts'
import type { AssistantMessageText, LifecycleAgentSnapshot, LifecycleCounters, LifecyclePhase, LifecycleSnapshot, ReviewActivityScore, SkillActivitySnapshot, SupervisedWritebackResult, TaskAgentModelCatalog } from "./protocol.ts"
import type { PreparedMemoryPlacement } from 'dsh-mnemon-source-memory-spaces/contracts'
import type { MemoryWake } from "../core/contracts/index.ts"
import { agentScope, type MnemonAgentRuntimeSource } from './runtime.ts'
import { createPluginMessage, isMnemonMessageSource, MNEMON_PLUGIN_SOURCE } from './plugin-message.ts'
import { bm25View, readBm25RecallState } from './bm25-recall.ts'
import { prepareMemorySnapshot, runtimeSnapshotRanges, type MemorySnapshotOptions } from './memory-snapshot.ts'
import { memorySnapshotState, retainsSnapshotEntries } from './memory-snapshot-state.ts'
import { bindSnapshotAuthority, takeSnapshotCompactionStep, takeSummaryAuthority, type SnapshotAuthority } from './snapshot-compaction.ts'
import type { SkillEvolution } from './skill-evolution.ts'
import { IdleReviewWatermarkStore } from './idle-review-watermark.ts'
import { activationOwned, contextIsActive, isInactiveContextError, isCreatingChild, isRootAgent, isTaskRecord, rootAgents, titleTask, withReservedChild } from './agent-compat.ts'
import { childComposition, startSubagent } from './subagent-start.ts'

type AgentRuntimeSource = Pick<MnemonAgentRuntimeSource, 'config' | 'forAgent' | 'executions' | 'onChanged' | 'memoryParticipation'>

interface HostDefaultModelService {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

interface HostAgentPresetService {
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: HostAgent['ctx'], id?: string): Promise<unknown>
}

function modelService(value: unknown): HostDefaultModelService | undefined {
  if (typeof value !== 'object' || value === null || !('currentSelection' in value) || typeof value.currentSelection !== 'function') return undefined
  return value as HostDefaultModelService
}

function presetService(value: unknown): HostAgentPresetService | undefined {
  if (typeof value !== 'object' || value === null || !('resolve' in value) || typeof value.resolve !== 'function' || !('mount' in value) || typeof value.mount !== 'function') return undefined
  return value as HostAgentPresetService
}

function llmService(value: unknown): HostLlmService | undefined {
  if (typeof value !== 'object' || value === null || !('listProviders' in value) || typeof value.listProviders !== 'function' || !('listModels' in value) || typeof value.listModels !== 'function') return undefined
  return value as HostLlmService
}

export type { TurnMemoryActivity, TurnMemoryActivitySnapshot } from './activity.ts'
export type { AssistantMessageText, LifecycleAgentSnapshot, LifecycleCounters, LifecyclePhase, LifecycleSnapshot, SupervisedWritebackResult } from "./protocol.ts"

export { MNEMON_PLUGIN_SOURCE }

interface AgentEventPayload {
  agent: HostAgent
}

interface SessionStartPayload extends AgentEventPayload {
  source: 'startup' | 'resume' | 'clear' | 'compact'
}

interface PreStepPayload extends AgentEventPayload {
  messages: HostUserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}

interface PendingMemorySnapshot {
  turn: number
  step: number
  signal: AbortSignal
  update: ReturnType<typeof prepareMemorySnapshot>
  checkpoint: boolean
  recallCheckpoint: boolean
  recallQuery: string | undefined
  deferRetirement: boolean
  injecting: Set<string>
}

interface TurnStoppingPayload extends AgentEventPayload {
  turn: number
  signal: AbortSignal
}

interface PromptAssembly {
  sections: Array<{ name: string; text: string }>
  contexts: Array<{ name: string; text: string }>
  [key: string]: unknown
}

interface PromptAssemblyContext {
  agent?: HostAgent
  signal?: AbortSignal
}

function isOwnUserMessageEvent(event: HostSessionEvent | undefined): boolean {
  if (event?.type !== 'user/message') return false
  return isMnemonMessageSource(event.data.source)
}

function eventTurn(event: HostSessionEvent): number | undefined {
  return typeof event.data.turn === 'number' ? event.data.turn : undefined
}

const MAX_TRACKED_TURN_ENTRIES = 128

class LifecycleLogProjection {
  private readonly cursor = new SessionEventCursor()
  memoryToolCalls = 0
  readonly assistantCharacters = new Map<number, number>()

  read(session: HostAgent['session']): this {
    this.cursor.consume(session, event => {
      if (event.type === 'tool/call' && typeof event.data.name === 'string' && event.data.name.startsWith('mnemon_')) this.memoryToolCalls++
      const turn = eventTurn(event)
      if (turn !== undefined && event.type === 'assistant/message') {
        this.assistantCharacters.set(turn, (this.assistantCharacters.get(turn) ?? 0) + assistantEventTextLength(event))
        while (this.assistantCharacters.size > MAX_TRACKED_TURN_ENTRIES) {
          this.assistantCharacters.delete(this.assistantCharacters.keys().next().value!)
        }
      }
    }, () => { this.memoryToolCalls = 0; this.assistantCharacters.clear() })
    return this
  }
}

const REVIEW_SUBSTANTIVE_USER_CHARACTERS = 320
const REVIEW_SUBSTANTIVE_ASSISTANT_CHARACTERS = 600
const EXPLICIT_MEMORY_CANDIDATE = [
  /(?:记住|记下来|保存到记忆|写入记忆|长期记录)/u,
  /\b(?:please\s+)?remember\b/iu,
  /\b(?:save|store|write|record|persist)\b.{0,32}\b(?:memory|memories)\b/iu,
]
const NO_MEMORY_MAINTENANCE = [
  /(?:不要|不必|无需|请勿|禁止|别)(?:再|主动|自动|在后台|替我)?(?:记住|记忆)/u,
  /(?:不要|不必|无需|请勿|禁止|别)(?:再|主动|自动|在后台|替我)?(?:保存|写(?:入)?|记录|更新|维护|持久化).{0,16}(?:记忆|memory)/iu,
  /\b(?:do not|don't|dont|never|no need to)\s+(?:proactively\s+|automatically\s+)?remember\b/iu,
  /\b(?:do not|don't|dont|never|no need to)\s+(?:proactively\s+|automatically\s+)?(?:save|store|write|record|persist|update|maintain)\b.{0,32}\b(?:memory|memories)\b/iu,
  /\bno\s+(?:memory|memories)\s+(?:write|writes|writing|maintenance|update|updates)\b/iu,
]

function userMessageText(message: HostUserMessage): string {
  if (message.source.kind !== 'user') return ''
  return message.content
    .filter(block => block.type === 'text' && 'text' in block && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(value))
}

function assistantEventTextLength(event: HostSessionEvent): number {
  if (event.type !== 'assistant/message') return 0
  const message = event.data.message as { content?: Array<{ type?: unknown; text?: unknown }> } | undefined
  if (!Array.isArray(message?.content)) return 0
  return message.content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => String(block.text).trim().length)
    .reduce((total, length) => total + length, 0)
}

function completedToolActivity(events: Iterable<HostSessionEvent>, turn: number): { count: number; names: Set<string> } {
  let count = 0
  const names = new Set<string>()
  for (const event of events) {
    if (eventTurn(event) !== turn) continue
    if (event.type === 'tool/result') count++
    if (event.type === 'tool/call' && typeof event.data.name === 'string') names.add(event.data.name)
  }
  return { count, names }
}

function assistantMessageText(events: Iterable<HostSessionEvent>, messageId: string): AssistantMessageText | null {
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const message = event.data.message as { id?: unknown; content?: Array<{ type?: unknown; text?: unknown }> } | undefined
    if (message === undefined || typeof message !== 'object' || message.id !== messageId) continue
    const content = Array.isArray(message.content) ? message.content : []
    const text = content
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => String(block.text))
      .join('\n\n')
      .trim()
    return text === '' ? null : { messageId, text }
  }
  return null
}

function guidedReminder(config: ResolvedConfig, guidance?: import('../core/contracts/view.ts').MemoryViewGuidance): string | undefined {
  const read = config.recallMode === 'guided'
  const write = config.writeEnabled && config.writebackMode === 'guided'
  const chosen = read && write ? guidance?.reminders?.both : read ? guidance?.reminders?.read : write ? guidance?.reminders?.write : undefined
  if (chosen !== undefined) return chosen
  const instructions = [
    ...(config.recallMode === 'guided' ? ['Use mnemon_view_route only when relevant evidence is missing.'] : []),
    ...(config.writeEnabled && config.writebackMode === 'guided' ? ['Use mnemon_view_action only for an intended memory change; require a write receipt.'] : []),
  ]
  if (instructions.length === 0) return undefined
  return '[MNEMON] ' + instructions.join(' ') + ' Use only ids offered by the current View and follow each Source\'s semantics. Otherwise use none.'
}

class MnemonAgentLifecycle {
  private primePending = true
  private startSource: LifecycleAgentSnapshot['startSource']
  private readonly guidedTurns = new Set<number>()
  private pendingSnapshot: PendingMemorySnapshot | undefined
  private recallCheckpoint: boolean | undefined
  private readonly memoryActivity = new TurnActivityProjection()
  private readonly log = new LifecycleLogProjection()
  private readonly turnActivity = new Map<number, {
    messageIds: Set<string>
    userTextLength: number
    toolCallCount: number
    toolNames: Set<string>
    explicitCandidate: boolean
    noMaintenance: boolean
  }>()
  private idleReviewTimer: ReturnType<typeof setTimeout> | undefined
  private reviewController: AbortController | undefined
  private reviewRunning = false
  private reviewAccessBlocked = false
  private reviewAdmission: { turn: number; step: number; attempts: number; policy: string | undefined; available: boolean } | undefined
  private lastReviewAt: string | undefined
  private lastReviewAction: string | undefined
  private lastReviewScore: number | undefined
  private lastReviewDocumentIds: string[] | undefined
  private disposed = false
  private reviewEpoch = 0
  private observedReviewPolicy: string | undefined
  private watermarkEnabled = false
  private readonly reviewUsage = new Map<string, { attempts: number; lastReviewAttemptAt: number | null }>()
  private watermarkKey: string | undefined
  private watermarkStore: IdleReviewWatermarkStore | undefined
  private watermarkError: string | undefined
  private watermarkRetryTurn: number | undefined
  private restoredAttempts = 0
  private idleReviewAttempts = 0
  private lastReviewAttemptAt: number | undefined
  private lastReviewFailure: LifecycleAgentSnapshot['lastReviewFailure']
  private lastPhase: LifecyclePhase = 'idle'
  private lastAt: string | undefined
  private lastError: string | undefined
  private snapshotCheckpoint: boolean | undefined
  private activeSnapshot: PendingMemorySnapshot | undefined
  private composedTurn: { turn: number; typeId: string; idleReview: boolean; directory?: string } | undefined

  constructor(
    readonly agent: HostAgent,
    private readonly coordinator: MnemonSubagentCoordinator,
    private readonly config: ResolvedConfig,
    private readonly counters: LifecycleCounters,
    source: LifecycleAgentSnapshot['startSource'],
    private readonly memoryTurn?: AgentMemoryTurn,
    private readonly runtimeDirectory?: () => string | undefined,
  ) {
    this.startSource = source
  }

  start(): () => void {
    this.restoreWatermark()
    this.observedReviewPolicy = this.reviewPolicy()
    const disposers = [
      bindSnapshotAuthority(this.agent.session, signal => this.memoryTurn?.snapshotAuthority(signal) ?? Promise.resolve(undefined)),
      this.agent.ctx.on('session/event', ((session: HostAgent['session'], event: HostSessionEvent) => this.sessionEvent(session, event)) as never),
      this.agent.ctx.on('system-prompt/assemble', ((assembly: PromptAssembly, context: PromptAssemblyContext, next: () => Promise<PromptAssembly>) => this.assemblePrompt(assembly, context, next)) as never),
      this.agent.ctx.on('agent/pre-step', ((payload: PreStepPayload, next: () => Promise<HostPreStepDecision>) => this.preStep(payload, next)) as never, { prepend: true }),
      this.agent.ctx.on('agent/request', (async (payload: TurnStoppingPayload & { step: number }, next: () => Promise<unknown>) => {
        await this.prepareReviewAccess(payload)
        return next()
      }) as never, { prepend: true }),
      this.agent.ctx.on('agent/turn-stopping', ((payload: TurnStoppingPayload) => this.finishTurn(payload)) as never),
    ]
    return () => {
      this.disposed = true
      const pending = this.pendingSnapshot
      this.pendingSnapshot = undefined
      this.activeSnapshot = undefined
      const started = pending === undefined ? undefined : findSessionEvent(this.agent.session, event => event.type === 'step/start')?.event
      if (pending !== undefined && started !== undefined && eventTurn(started) === pending.turn && started.data.step === pending.step) {
        this.queueSnapshotRetirement(pending)
      }
      this.releaseView()
      this.cancelIdleReview(true)
      for (const dispose of disposers.reverse()) dispose()
    }
  }

  snapshot(): LifecycleAgentSnapshot {
    this.restoreWatermark()
    return {
      sessionId: this.agent.id,
      status: this.agent.status,
      startSource: this.startSource,
      primePending: this.primePending,
      guidedTurns: this.guidedTurns.size,
      memoryToolCalls: this.log.read(this.agent.session).memoryToolCalls,
      idleReviewPending: this.idleReviewTimer !== undefined,
      reviewRunning: this.reviewRunning,
      idleReviewAccess: this.coordinator.reviewAccessStatus?.(this.agent),
      reviewActivity: this.reviewActivity(),
      idleReviewAttempts: this.idleReviewAttempts,
      ...(this.config.idleReview.persistWatermark ? { idleReviewWatermark: {
        state: this.watermarkError === undefined ? 'ready' as const : 'error' as const,
        restoredAttempts: this.restoredAttempts, maxPerSession: this.config.idleReview.maxPerSession,
        ...(this.watermarkError === undefined ? {} : { error: this.watermarkError }),
      } } : {}),
      ...(this.config.confirmWrites ? { idleReviewBlocked: 'write-confirmation' as const } : idleReviewBlockReason(this.agent, this.config.idleReview.agentTeams) !== undefined
        ? { idleReviewBlocked: 'agent-team' as const } : this.reviewAccessBlocked ? { idleReviewBlocked: 'tool-access' as const } : {}),
      ...(this.lastReviewAttemptAt === undefined ? {} : { nextReviewAt: new Date(Math.min(8_640_000_000_000_000, this.lastReviewAttemptAt + this.config.idleReview.minIntervalMs)).toISOString() }),
      ...(this.lastReviewFailure === undefined ? {} : { lastReviewFailure: this.lastReviewFailure }),
      lastPhase: this.lastPhase,
      ...(this.lastReviewAt === undefined ? {} : { lastReviewAt: this.lastReviewAt }),
      ...(this.lastReviewAction === undefined ? {} : { lastReviewAction: this.lastReviewAction }),
      ...(this.lastReviewScore === undefined ? {} : { lastReviewScore: this.lastReviewScore }),
      ...(this.lastReviewDocumentIds === undefined ? {} : { lastReviewDocumentIds: [...this.lastReviewDocumentIds] }),
      ...(this.lastAt === undefined ? {} : { lastAt: this.lastAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    }
  }

  markSupervised(): void {
    this.counters.supervisedRequests += 1
    this.mark('supervised')
  }

  turnMemoryActivities(): TurnMemoryActivitySnapshot {
    return this.memoryActivity.snapshotSession(this.agent.session)
  }

  assistantMessageText(messageId: string): AssistantMessageText | null {
    return assistantMessageText(sessionEvents(this.agent.session), messageId)
  }

  memoryWake(presentation?: import('../core/contracts/index.ts').ComposableMemoryView): MemoryWake | undefined {
    const pinned = this.memoryTurn?.current
    if (pinned === undefined) return undefined
    return modelMemoryWake(pinned.graph, pinned.context, true, this.agent, presentation)
  }

  private cueAlreadyVisible(): boolean {
    for (const seq of this.agent.session.surface.nodes) {
      if (isOwnUserMessageEvent(this.agent.session.eventAt(seq))) return true
    }
    return false
  }

  private async preStep(payload: PreStepPayload, next: () => Promise<HostPreStepDecision>): Promise<HostPreStepDecision> {
    this.pendingSnapshot = undefined
    if (payload.step === 1) this.cancelIdleReview(true)
    const decision = await next()
    const deferRetirement = takeSnapshotCompactionStep(this.agent.session, payload.turn, payload.step)
    if (decision.kind === 'reject' || payload.signal.aborted) {
      this.releaseView(payload.turn)
      return decision
    }
    if (!this.disposed && openAgentTurn(this.agent) === payload.turn) await this.memoryTurn?.begin(payload.turn, payload.signal)
    const view = this.memoryTurn?.current?.context.view
    const experiment = this.config.lifecycleEnabled && (this.config.runtimeMemory.bm25Recall || this.config.runtimeMemory.indexPush) && !this.memoryTurn?.excluded
      ? bm25View(view) : undefined
    if (experiment !== undefined && this.recallCheckpoint === undefined) {
      const latest = findSessionEvent(this.agent.session, event => event.type === 'step/start'
        || event.type === 'compaction/end' && event.data.error === undefined)
      this.recallCheckpoint = latest?.event.type === 'compaction/end'
    }
    const recallCheckpoint = this.recallCheckpoint === true
    const ownRequest = payload.step === 1 && decision.messages.some(message => isMnemonMessageSource(message.source))
    const query = experiment !== undefined && payload.step === 1 && !ownRequest
      ? decision.messages.filter(message => message.source.kind === 'user')
        .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
      : undefined
    if (deferRetirement && this.snapshotCheckpoint === undefined) {
      const latest = findSessionEvent(this.agent.session, event => {
        if (event.type === 'compaction/end') return event.data.error === undefined
        const source = event.type === 'developer/message'
          ? (event.data.message as { source?: unknown } | undefined)?.source : event.data.source
        return isMnemonMessageSource(source) && ['memory-snapshot', 'memory-snapshot-retired'].includes((source as { form: string }).form)
      })?.event
      this.snapshotCheckpoint = latest?.type === 'compaction/end'
    }
    const checkpoint = deferRetirement && this.snapshotCheckpoint === true
    const update = this.planSnapshot({ deferRetirement, checkpoint,
      ...(experiment === undefined ? {} : { recall: { view: experiment, query, checkpoint: recallCheckpoint } }),
    })
    const pending: PendingMemorySnapshot = {
      turn: payload.turn, step: payload.step, signal: payload.signal, update, checkpoint, recallCheckpoint,
      recallQuery: undefined, deferRetirement: false, injecting: new Set(),
    }
    this.pendingSnapshot = pending
    if (!this.config.lifecycleEnabled || this.memoryTurn?.excluded) return decision
    if (this.config.writeEnabled && this.config.writebackMode === 'guided') {
      this.recordTurnMessages(payload.turn, decision.messages)
    }
    if (payload.step !== 1) {
      pending.deferRetirement = deferRetirement
      if (!checkpoint || update.message === undefined) return decision
      pending.injecting.add(update.message.id)
      return { kind: 'enter', messages: [...decision.messages, update.message] }
    }

    if (ownRequest) {
      return decision
    }
    if (decision.messages.length === 0) return decision
    const additions = [update.message, update.recall].filter(message => message !== undefined)
    pending.deferRetirement = deferRetirement
    pending.recallQuery = query
    for (const addition of additions) pending.injecting.add(addition.id)
    const withSnapshot = (messages: HostUserMessage[]): HostUserMessage[] =>
      additions.length === 0 ? messages : [...messages, ...additions]

    if (this.primePending) {
      this.primePending = false
      this.counters.primes += 1
      this.mark('prime')
    }
    if (this.cueAlreadyVisible()) return { kind: 'enter', messages: withSnapshot(decision.messages) }
    const reminder = guidedReminder(this.config, this.memoryTurn?.current?.context.view.guidance)
    if (reminder === undefined) return { kind: 'enter', messages: withSnapshot(decision.messages) }
    this.guidedTurns.add(payload.turn)
    if (this.config.recallMode === 'guided') this.counters.recallCues += 1
    if (this.config.writebackMode === 'guided' && this.config.writeEnabled) this.counters.writebackCues += 1
    this.mark(this.config.recallMode === 'guided' ? 'recall' : 'writeback')
    return { kind: 'enter', messages: withSnapshot([...decision.messages, createPluginMessage(reminder, 'instructions')]) }
  }

  private async assemblePrompt(_assembly: PromptAssembly, context: PromptAssemblyContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly> {
    if (context.agent !== undefined && context.agent.id !== this.agent.id) return next()
    const turn = openAgentTurn(this.agent)
    if (turn === undefined) return next()
    this.cancelIdleReview(true)
    if (context.signal?.aborted === true || openAgentTurn(this.agent) !== turn) return next()
    await this.memoryTurn?.begin(turn, context.signal)
    const assembled = await next()
    return applyMemoryViewGuidance(assembled, this.memoryTurn?.current?.context.view, this.config.routingGuidance)
  }

  private releaseView(turn?: number): void {
    this.memoryTurn?.end(turn)
  }

  private async finishTurn(payload: TurnStoppingPayload): Promise<void> {
    this.cancelIdleReview(true)
    this.recordComposedTurn(payload.turn)
    if (payload.signal.aborted || !this.restoreWatermark() || !this.idleReviewAllowed()) return
    const activity = this.ensureTurnActivity(payload.turn)
    const tools = completedToolActivity(sessionTurnEvents(this.agent.session, payload.turn), payload.turn)
    activity.toolCallCount = tools.count
    activity.toolNames = tools.names
    if (!this.reviewActivity().eligible || !this.reviewAdmitted(payload.turn)) return
    const admission = this.reviewAdmission
    if (admission?.turn === payload.turn && admission.policy === this.reviewPolicy() && admission.available) this.scheduleIdleReview(payload.turn)
  }

  private async prepareReviewAccess(payload: TurnStoppingPayload & { step: number }): Promise<void> {
    this.recordComposedTurn(payload.turn)
    if (payload.signal.aborted || !this.restoreWatermark(payload.turn) || !this.idleReviewAllowed() || this.turnActivity.get(payload.turn)?.noMaintenance) return
    const policy = this.reviewPolicy()
    const previous = this.reviewAdmission?.turn === payload.turn && this.reviewAdmission.policy === policy ? this.reviewAdmission : undefined
    if (previous !== undefined && (previous.available || previous.attempts >= 2 || payload.step <= previous.step)) return
    const attempts = (previous?.attempts ?? 0) + 1
    this.reviewAdmission = { turn: payload.turn, step: payload.step, attempts, policy, available: false }
    const controller = new AbortController()
    const signal = AbortSignal.any([payload.signal, controller.signal])
    const epoch = this.reviewEpoch
    this.reviewController = controller
    this.reviewRunning = true
    try {
      const available = await this.coordinator.checkReviewAccess(this.agent, signal)
      if (signal.aborted || epoch !== this.reviewEpoch || policy !== this.reviewPolicy() || !this.idleReviewAllowed()) return
      this.reviewAccessBlocked = !available
      this.reviewAdmission = { turn: payload.turn, step: payload.step, attempts, policy, available }
    } catch (error) {
      if (!signal.aborted) this.fail(error)
    } finally {
      if (this.reviewController === controller) {
        this.reviewRunning = false
        this.reviewController = undefined
      }
    }
  }

  private sessionEvent(session: HostAgent['session'], event: HostSessionEvent): void {
    if (session !== this.agent.session) return
    if (event.type === 'compaction/end') {
      const authority = takeSummaryAuthority(session)
      if (event.data.error === undefined) {
        this.snapshotCheckpoint = this.recallCheckpoint = true
        if (this.activeSnapshot !== undefined && authority !== undefined) this.restoreSnapshotAfterCompaction(this.activeSnapshot, authority.value)
      }
      return
    }
    if (event.type === 'user/message' && typeof event.data.id === 'string') this.activeSnapshot?.injecting.delete(event.data.id)
    const turn = eventTurn(event)
    if (event.type === 'step/start') {
      const pending = this.pendingSnapshot
      if (pending === undefined || pending.turn !== turn || pending.step !== event.data.step) return
      this.pendingSnapshot = undefined
      if (pending.checkpoint) this.snapshotCheckpoint = false
      if (pending.recallCheckpoint) this.recallCheckpoint = false
      this.activeSnapshot = pending.deferRetirement ? pending : undefined
      this.queueSnapshotRetirement(pending)
      return
    }
    if (event.type !== 'turn/end') return
    if (this.pendingSnapshot?.turn === turn) this.pendingSnapshot = undefined
    if (this.activeSnapshot?.turn === turn) this.activeSnapshot = undefined
    const current = this.memoryTurn?.current
    const pinned = turn === undefined || current?.turn !== turn ? undefined : current
    if (pinned === undefined) return
    this.releaseView(turn)
  }

  private planSnapshot(options: MemorySnapshotOptions): ReturnType<typeof prepareMemorySnapshot> {
    const presentation = options.recall?.view.view
    const view = presentation ?? this.memoryTurn?.current?.context.view
    const wake = this.config.lifecycleEnabled && !this.memoryTurn?.excluded ? this.memoryWake(presentation) : undefined
    const ranges = wake === undefined ? undefined : runtimeSnapshotRanges(wake)
    return prepareMemorySnapshot(this.agent.session, wake?.text, wake === undefined ? undefined : memorySnapshotState(view),
      { ...options, ...(ranges === undefined ? {} : { runtimeRanges: ranges }) })
  }

  private restoreSnapshotAfterCompaction(active: PendingMemorySnapshot, authority: SnapshotAuthority | undefined): void {
    queueMicrotask(() => {
      const step = openAgentStep(this.agent)
      if (this.activeSnapshot !== active || active.signal.aborted || step?.turn !== active.turn || step.step !== active.step) return
      try {
        const pinnedView = this.memoryTurn?.current?.context.view
        const pinnedRecall = (this.config.runtimeMemory.bm25Recall || this.config.runtimeMemory.indexPush) ? bm25View(pinnedView) : undefined
        const pinned = memorySnapshotState(pinnedRecall?.view ?? pinnedView)
        const currentState = authority?.state
        const authorized = pinned !== undefined && currentState?.boundary === pinned.boundary
          && currentState.branchVisibility === pinned.branchVisibility
          && retainsSnapshotEntries(pinned.entries, currentState.entries)

        const currentRecall = authority?.recall
        const allowed = new Set(currentRecall === undefined ? [] : [...currentRecall.memory, ...currentRecall.documents, ...(currentRecall.spaces ?? [])].map(item => item.key))
        const recall = pinnedRecall !== undefined && currentRecall?.scope === pinnedRecall.scope ? {
          view: {
            ...pinnedRecall,
            memory: pinnedRecall.memory.filter(item => allowed.has(item.key)),
            documents: pinnedRecall.documents.filter(item => allowed.has(item.key)),
            spaces: (pinnedRecall.spaces ?? []).filter(item => allowed.has(item.key)),
          },
          query: active.recallQuery,
          checkpoint: true,
        } : undefined
        const options = recall === undefined ? {} : { recall }
        const update = authorized ? this.planSnapshot({ ...options, deferRetirement: true, checkpoint: true })
          : prepareMemorySnapshot(this.agent.session, undefined, undefined, options)
        update.retire(active.turn, active.step)
        const snapshotPending = active.update.message !== undefined && active.injecting.has(active.update.message.id)
        const recallPending = active.update.recall !== undefined && active.injecting.has(active.update.recall.id)
        const plannedRecall = readBm25RecallState(active.update.recall?.source)
        if ((!authorized && snapshotPending) || (recallPending
          && (recall === undefined || plannedRecall?.scope !== recall.view.scope || plannedRecall.added.some(key => !allowed.has(key))))) {
          this.cancelSnapshotRequest()
          return
        }
        const replacements = [snapshotPending ? undefined : update.message, recallPending ? undefined : update.recall]
        for (const message of replacements) {
          if (message === undefined) continue
          if (this.agent.session.append === undefined) throw new Error('DSH Session append is required after compaction')
          this.agent.session.append('user/message', message, { surfaceOp: 'append' })
        }
        this.snapshotCheckpoint = this.recallCheckpoint = false
      } catch { this.cancelSnapshotRequest() }
    })
  }

  private queueSnapshotRetirement(pending: PendingMemorySnapshot): void {
    queueMicrotask(() => {
      if (pending.signal.aborted || openAgentTurn(this.agent) !== pending.turn) return
      try { pending.update.retire(pending.turn, pending.step) }
      catch { this.cancelSnapshotRequest() }
    })
  }

  private cancelSnapshotRequest(): void {
    const reason = 'Memory snapshot checkpoint failed; model request cancelled.'
    this.counters.failures += 1
    this.lastPhase = 'error'
    this.lastAt = new Date().toISOString()
    this.lastError = reason
    this.agent.cancel({ kind: 'hook', reason }, { keepInbox: true })
    console.warn('[dsh-mnemon] ' + reason)
  }

  private scheduleIdleReview(turn: number): void {
    this.cancelIdleReview(true)
    if (!this.restoreWatermark() || !this.idleReviewAllowed()) return
    if (!this.reviewActivity().eligible || !this.reviewAdmitted(turn)) return
    const epoch = this.reviewEpoch
    const policy = this.reviewPolicy()
    this.idleReviewTimer = setTimeout(() => {
      this.idleReviewTimer = undefined
      try {
        if (epoch !== this.reviewEpoch || policy !== this.reviewPolicy() || !this.idleReviewAllowed() || this.reviewRunning) return
        if (this.lastReviewAttemptAt !== undefined && Date.now() < this.lastReviewAttemptAt + this.config.idleReview.minIntervalMs) {
          this.scheduleIdleReview(turn)
          return
        }
        if (this.agent.status !== 'idle') return
        const completed = findSessionEvent(this.agent.session, event => event.type === 'turn/end' && eventTurn(event) === turn) !== undefined
        if (!completed || !this.reviewActivity().eligible || !this.reviewAdmitted(turn)) return
        void this.runIdleReview().catch(error => {
          if (this.disposed || isInactiveContextError(error)) return
          try { if (!contextIsActive(this.agent.ctx)) return } catch { return }
          this.fail(error)
        })
      } catch (error) {
        if (this.disposed || isInactiveContextError(error)) return
        try { if (!contextIsActive(this.agent.ctx)) return } catch { return }
        this.fail(error)
      }
    }, Math.min(2_147_483_647, Math.max(this.config.idleReviewMs, (this.lastReviewAttemptAt ?? -Infinity) + this.config.idleReview.minIntervalMs - Date.now())))
  }

  private restoreWatermark(retryTurn?: number): boolean {
    if (this.memoryTurn?.excluded) { this.watermarkEnabled = false; return false }
    if (!this.config.idleReview.persistWatermark) { this.watermarkEnabled = false; return true }
    try {
      const directory = this.runtimeDirectory?.()
      if (directory === undefined || directory.trim() === '') throw new Error('runtime storage unavailable')
      const key = JSON.stringify([resolve(directory), this.agent.id])
      const sameRoot = this.watermarkKey === key
      if (sameRoot && this.watermarkEnabled) {
        if (this.watermarkError === undefined) return true
        if (retryTurn === undefined || this.watermarkRetryTurn === retryTurn) return false
      }
      this.watermarkRetryTurn = retryTurn
      this.watermarkEnabled = true
      this.watermarkKey = key
      this.watermarkStore = new IdleReviewWatermarkStore(directory, this.agent.id)
      this.watermarkError = undefined
      this.restoredAttempts = 0
      const floor = this.reviewUsage.get(resolve(directory))
      if (!sameRoot) {
        this.idleReviewAttempts = floor?.attempts ?? 0
        this.lastReviewAttemptAt = floor?.lastReviewAttemptAt ?? undefined
      }
      const state = this.watermarkStore.restore(floor)
      this.restoredAttempts = state.attempts
      this.idleReviewAttempts = state.attempts
      this.lastReviewAttemptAt = state.lastReviewAttemptAt ?? undefined
      this.reviewUsage.set(resolve(directory), state)
      return true
    } catch (error) { this.pauseWatermark(error); return false }
  }

  configurationChanged(): void {
    if (this.memoryTurn?.excluded) { this.cancelIdleReview(true); this.memoryTurn.end() }
    const policy = this.reviewPolicy()
    if (policy !== this.observedReviewPolicy) {
      this.cancelIdleReview(true)
      this.reviewAccessBlocked = false
      this.reviewAdmission = undefined
    }
    this.observedReviewPolicy = policy
    this.restoreWatermark()
  }

  private pauseWatermark(error: unknown): void {
    const message = error instanceof Error && error.message.startsWith('Idle review watermark unavailable')
      ? error.message
      : "Idle review watermark unavailable. Automatic review is paused. Continue the conversation to recheck. If the error persists, stop Hosts using this storage root before inspecting this session's state or lock under state/idle-review."
    this.watermarkError = message
  }

  private reviewPolicy(): string | undefined {
    try { return JSON.stringify([this.config.idleReview.persistWatermark ? this.runtimeDirectory?.() : undefined, this.config.lifecycleEnabled, this.config.writeEnabled, this.config.confirmWrites,
      this.config.storageScope, this.config.dataDir, this.config.writebackMode, this.config.idleReviewMs, this.config.idleReview, this.config.taskAgentModel, mainStrategyTypeId(this.config)]) } catch (error) {
      if (this.config.idleReview.persistWatermark) this.pauseWatermark(error)
      return undefined
    }
  }

  private recordComposedTurn(turn: number): void {
    if (this.memoryTurn === undefined) return
    const pinned = this.memoryTurn.current
    if (pinned?.turn === turn) {
      const strategy = viewStrategy(pinned.graph.memoryComposition.generation(pinned.context.view.runtimeGeneration), pinned.context.view)
      this.composedTurn = { turn, typeId: strategy.typeId, idleReview: strategyDrives(strategy, 'idle-review'), directory: pinned.graph.directory }
    } else if (this.composedTurn?.turn !== turn) this.composedTurn = undefined
  }

  private strategyDrivesIdleReview(): boolean {
    const typeId = mainStrategyTypeId(this.config)
    if (this.memoryTurn === undefined) return strategyDrives({ typeId }, 'idle-review')
    return this.composedTurn?.typeId === typeId && this.composedTurn.idleReview
  }

  private idleReviewAllowed(reserved = false): boolean {
    return !this.disposed && contextIsActive(this.agent.ctx) && (!this.config.idleReview.persistWatermark || this.watermarkError === undefined)
      && !this.memoryTurn?.excluded && this.config.lifecycleEnabled && this.config.writeEnabled && !this.config.confirmWrites && this.config.writebackMode === 'guided'
      && this.config.idleReview.enabled && (reserved || this.idleReviewAttempts < this.config.idleReview.maxPerSession)
      && idleReviewBlockReason(this.agent, this.config.idleReview.agentTeams) === undefined
      && this.strategyDrivesIdleReview()
      && this.coordinator.canReview(this.agent)
  }

  private async runIdleReview(): Promise<void> {
    if (!contextIsActive(this.agent.ctx)) return
    const controller = new AbortController()
    const triggeredScore = this.reviewActivity().score
    const epoch = this.reviewEpoch
    const policy = this.reviewPolicy()
    this.reviewRunning = true
    this.reviewController = controller
    try {
      if (epoch !== this.reviewEpoch || policy !== this.reviewPolicy() || !this.idleReviewAllowed()) {
        controller.abort(new Error('Automatic idle review admission changed'))
      }
      controller.signal.throwIfAborted()
      if (this.config.idleReview.persistWatermark) {
        try {
          if (!this.restoreWatermark() || this.watermarkStore === undefined || !this.idleReviewAllowed()) return
          const reserved = this.watermarkStore.reserve({ ...this.config.idleReview, now: Date.now(),
            floor: { attempts: this.idleReviewAttempts, lastReviewAttemptAt: this.lastReviewAttemptAt ?? null } })
          const state = reserved ?? this.watermarkStore.load()
          this.idleReviewAttempts = Math.max(this.idleReviewAttempts, state.attempts)
          this.lastReviewAttemptAt = Math.max(this.lastReviewAttemptAt ?? -Infinity, state.lastReviewAttemptAt ?? -Infinity)
          if (this.lastReviewAttemptAt === -Infinity) this.lastReviewAttemptAt = undefined
          const directory = this.runtimeDirectory?.()
          if (directory !== undefined) this.reviewUsage.set(resolve(directory), { attempts: this.idleReviewAttempts, lastReviewAttemptAt: this.lastReviewAttemptAt ?? null })
          if (reserved === undefined) return
        } catch (error) { this.pauseWatermark(error); return }
      } else {
        this.idleReviewAttempts += 1
        this.lastReviewAttemptAt = Date.now()
        const directory = this.composedTurn?.directory
        if (directory !== undefined) {
          const key = resolve(directory)
          this.reviewUsage.set(key, { attempts: (this.reviewUsage.get(key)?.attempts ?? 0) + 1, lastReviewAttemptAt: this.lastReviewAttemptAt })
        }
      }
      this.mark('review')
      const result = await this.coordinator.review(this.agent, controller.signal, () => {
        if (epoch !== this.reviewEpoch || policy !== this.reviewPolicy() || !this.idleReviewAllowed(true)) {
          controller.abort(new Error('Automatic idle review admission changed'))
        }
        controller.signal.throwIfAborted()
      })
      if (controller.signal.aborted) return
      this.lastReviewAt = new Date().toISOString()
      this.lastReviewAction = result.action
      this.lastReviewScore = triggeredScore
      this.lastReviewDocumentIds = result.documentIds
      this.lastReviewFailure = undefined
      this.turnActivity.clear()
      this.lastError = undefined
      this.mark('review')
    } catch (error) {
      const partial = error instanceof IdleReviewError && (error.review.status === 'partial' || error.review.receipts.length > 0)
      if (!partial && (isInactiveContextError(error) || !contextIsActive(this.agent.ctx))) {
        controller.abort(error)
        return
      }
      if (error instanceof IdleReviewError) this.lastReviewFailure = error.review
      if (!controller.signal.aborted || error instanceof IdleReviewError && error.review.status === 'partial') this.fail(error)
    } finally {
      if (this.reviewController === controller) {
        this.reviewRunning = false
        this.reviewController = undefined
      }
    }
  }

  private cancelIdleReview(abortRunning: boolean): void {
    this.reviewEpoch += 1
    if (this.idleReviewTimer !== undefined) clearTimeout(this.idleReviewTimer)
    this.idleReviewTimer = undefined
    if (abortRunning) this.reviewController?.abort()
  }

  private ensureTurnActivity(turn: number) {
    let activity = this.turnActivity.get(turn)
    if (activity === undefined) {
      activity = {
        messageIds: new Set(),
        userTextLength: 0,
        toolCallCount: 0,
        toolNames: new Set(),
        explicitCandidate: false,
        noMaintenance: false,
      }
      this.turnActivity.set(turn, activity)
      while (this.turnActivity.size > MAX_TRACKED_TURN_ENTRIES) {
        this.turnActivity.delete(this.turnActivity.keys().next().value!)
      }
    }
    return activity
  }

  private recordTurnMessages(turn: number, messages: readonly HostUserMessage[]): void {
    const activity = this.ensureTurnActivity(turn)
    for (const message of messages) {
      if (message.source.kind !== 'user' || activity.messageIds.has(message.id)) continue
      activity.messageIds.add(message.id)
      const text = userMessageText(message)
      activity.userTextLength += text.length
      activity.explicitCandidate ||= matchesAny(text, EXPLICIT_MEMORY_CANDIDATE)
      activity.noMaintenance ||= matchesAny(text, NO_MEMORY_MAINTENANCE)
    }
  }

  private reviewAdmitted(currentTurn: number): boolean {
    if (this.turnActivity.get(currentTurn)?.noMaintenance === true) return false
    const turns = new Set([...this.turnActivity.entries()]
      .filter(([, activity]) => !activity.noMaintenance)
      .map(([turn]) => turn))
    let totalUserTextLength = 0
    let explicitCandidate = false
    let completedNonMemoryTool = false
    for (const activity of this.turnActivity.values()) {
      if (activity.noMaintenance) continue
      totalUserTextLength += activity.userTextLength
      explicitCandidate ||= activity.explicitCandidate
      completedNonMemoryTool ||= activity.toolCallCount > 0 && [...activity.toolNames].some(name => !name.startsWith('mnemon_'))
    }
    const characters = this.log.read(this.agent.session).assistantCharacters
    const assistantTextLength = [...turns].reduce((total, turn) => total + (characters.get(turn) ?? 0), 0)
    return explicitCandidate
      || totalUserTextLength >= REVIEW_SUBSTANTIVE_USER_CHARACTERS
      || assistantTextLength >= REVIEW_SUBSTANTIVE_ASSISTANT_CHARACTERS
      || completedNonMemoryTool
  }

  private reviewActivity(): ReviewActivityScore {
    const toolNames = new Set<string>()
    let totalUserTextLength = 0
    let turnCount = 0
    let toolCallCount = 0
    for (const activity of this.turnActivity.values()) {
      if (activity.noMaintenance) continue
      turnCount += 1
      totalUserTextLength += activity.userTextLength
      toolCallCount += activity.toolCallCount
      for (const name of activity.toolNames) toolNames.add(name)
    }
    return scoreReviewActivity({
      totalUserTextLength,
      turnCount,
      toolCallCount,
      uniqueToolCount: toolNames.size,
    })
  }

  private mark(phase: LifecyclePhase): void {
    this.lastPhase = phase
    this.lastAt = new Date().toISOString()
  }

  private fail(error: unknown): void {
    this.counters.failures += 1
    this.lastPhase = 'error'
    this.lastAt = new Date().toISOString()
    this.lastError = (error instanceof Error ? error.message : String(error))
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
      .replace(/\s+/gu, ' ').trim().slice(0, 500)
    console.warn(`[dsh-mnemon] idle review failed: ${this.lastError}`)
  }

}

function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(info => info.isDirectory(), () => false)
}

interface WorkingDirectoryService {
  set(agent: HostAgent, path: string, signal?: AbortSignal): Promise<string>
}

export type RoutedPick = { provider: string; model: string; reasoningEffort?: string }

export const TASK_ROUTE: unique symbol = Symbol.for('dsh-mnemon.taskRoute')

export function taskRoute(agent: HostAgent): RoutedPick | undefined {
  return (agent as unknown as Record<symbol, RoutedPick | undefined>)[TASK_ROUTE]
}

export class MnemonLifecycle {
  private readonly owners = new Map<HostAgent, { lifecycle: MnemonAgentLifecycle; dispose: () => unknown }>()
  private readonly children = new Map<HostAgent, () => unknown>()
  private readonly memoryTurns = new Map<HostAgent, AgentMemoryTurn>()
  private readonly workspacePolicies = new Map<HostAgent, { update(): void; dispose(): unknown }>()
  private readonly counters: LifecycleCounters = { primes: 0, recallCues: 0, writebackCues: 0, supervisedRequests: 0, failures: 0 }
  private readonly taskAgentIds = new Set<string>()
  private readonly supervisedWritebacks = new Map<string, { content: string; result: Promise<SupervisedWritebackResult> }>()
  private skillEvolution: SkillEvolution | undefined

  constructor(
    private readonly ctx: HostContextShape,
    private readonly coordinator: MnemonSubagentCoordinator,
    private readonly config: ResolvedConfig,
    private readonly runtimeSource?: AgentRuntimeSource,
  ) {}

  useSkillEvolution(evolution: SkillEvolution): void {
    this.skillEvolution = evolution
  }

  get skills(): SkillEvolution | undefined {
    return this.skillEvolution
  }

  runSkillTask<T>(workspaceRoot: string | undefined, signal: AbortSignal, operation: (agent: HostAgent) => Promise<T>, route?: RoutedPick): Promise<T> {
    return this.runTaskAgent('', workspaceRoot, signal, operation, route, 'Mnemon · Skills')
  }

  async skillActivity(sessionId: string): Promise<SkillActivitySnapshot> {
    const id = sessionId.trim()
    const unavailable: SkillActivitySnapshot = { available: false, turns: [], reviews: [] }
    if (id === '' || this.skillEvolution === undefined) return unavailable
    const agent = this.ctx.agents.get(id)
    if (agent !== undefined) return this.skillEvolution.activity(agent)
    const query = this.ctx.get('sessionQuery') as { readSession(sessionId: string): Promise<{ session: HostAgent['session']['header']; events: HostSessionEvent[] }> } | undefined
    if (query === undefined) return unavailable
    let log
    try { log = await query.readSession(id) } catch { return unavailable }
    const stored = { id, session: { header: log.session } } as unknown as HostAgent
    return this.skillEvolution.activity(stored, log.events)
  }

  reviewSkills(sessionId: string) {
    if (this.skillEvolution === undefined) throw new Error('skill evolution is unavailable')
    return this.skillEvolution.reviewNow(this.liveAgent(sessionId))
  }

  start(): () => void {
    this.coordinator.setIsolatedReviewRunner?.(request => this.runIsolatedReview(request))
    const repair = new AbortController()
    const repairScope = this.config.idleReview.silent && activationOwned(this.ctx.subagents) && typeof this.ctx.inject === 'function'
      ? this.ctx.inject(['workspaceRegistry', 'sessionQuery'], ctx => {
        if (this.config.idleReview.silent && !repair.signal.aborted) {
          void archiveOrphanedIdleReviews(ctx, repair.signal).catch(() => undefined)
        }
      }) as { dispose?(): unknown } | undefined
      : undefined
    const stopChanged = this.runtimeSource?.onChanged?.(() => {
      if (!this.config.idleReview.silent) repair.abort()
      for (const policy of this.workspacePolicies.values()) policy.update()
      for (const memory of this.memoryTurns.values()) if (memory.excluded) memory.end()
      for (const { lifecycle } of this.owners.values()) lifecycle.configurationChanged()
    })
    const stopCreated = this.ctx.on('agent/created', (({ agent, source }: SessionStartPayload) => { this.install(agent, source) }) as never, { prepend: true })
    for (const agent of this.ctx.agents.list?.() ?? []) if (contextIsActive(agent.ctx)) this.watchWorkspacePolicy(agent)
    for (const agent of rootAgents(this.ctx.agents, this.ctx.subagents)) this.install(agent, 'adopted')
    return () => {
      repair.abort()
      repairScope?.dispose?.()
      this.coordinator.setIsolatedReviewRunner?.(undefined)
      stopChanged?.()
      stopCreated()
      for (const dispose of [...this.children.values()].reverse()) dispose()
      for (const owner of [...this.owners.values()].reverse()) owner.dispose()
      for (const policy of [...this.workspacePolicies.values()].reverse()) policy.dispose()
      this.children.clear()
      this.owners.clear()
      this.memoryTurns.clear()
    }
  }

  snapshot(sessionId?: string, workspaceRoot?: string): LifecycleSnapshot {
    const requestedId = sessionId?.trim()
    const requested = requestedId === undefined || requestedId === '' ? undefined : this.ctx.agents.get(requestedId)
    const agent = requested !== undefined && this.owners.has(requested) ? requested : this.availableAgent(workspaceRoot)
    const owner = agent === undefined ? undefined : this.owners.get(agent)?.lifecycle
    return {
      enabled: this.config.lifecycleEnabled,
      recallMode: this.config.recallMode,
      writebackMode: this.config.writebackMode,
      idleReviewMs: this.config.idleReviewMs,
      activeAgents: this.owners.size,
      sessionAvailable: agent !== undefined,
      taskAgentAvailable: this.taskAgentModelOptions(requestedId ?? '', workspaceRoot) !== undefined,
      counters: { ...this.counters },
      subagents: this.coordinator.snapshot(),
      ...(owner === undefined ? {} : { current: owner.snapshot() }),
    }
  }

  async taskAgentModels(includeCatalog = true, sessionId?: string): Promise<TaskAgentModelCatalog> {
    const route = this.taskAgentModelRoute(sessionId ?? '', undefined)
    const conversation = this.conversationRoute(sessionId ?? '')
    const inherited = this.inheritedRoute(this.routeFallback(sessionId ?? '', undefined))
    let defaultSelection: { provider: string; model: string } | undefined
    try {
      const selected = modelService(this.ctx.get('agentDefaultModel'))?.currentSelection()
      const provider = selected?.provider.trim()
      const model = selected?.model.trim()
      if (provider !== undefined && provider !== '' && model !== undefined && model !== '') defaultSelection = { provider, model }
    } catch {}

    const base = {
      ...(route === undefined ? {} : { effective: { provider: route.options.provider!, model: route.options.model!, source: route.source } }),
      ...(defaultSelection === undefined ? {} : { defaultSelection }),
      ...(conversation === undefined ? {} : { session: { provider: conversation.provider, model: conversation.model } }),
      ...(inherited === undefined ? {} : { inherited: { provider: inherited.provider, model: inherited.model, source: inherited.source } }),
    }
    if (!includeCatalog) return { ...base, groups: [], failures: [] }
    const llm = llmService(this.ctx.get('llm'))
    if (llm === undefined) {
      return { ...base, groups: [], failures: [{ id: 'dsh', name: 'DSH', message: 'model directory service is unavailable' }] }
    }

    let providers: Array<{ id: string; name: string }>
    try {
      providers = llm.listProviders()
    } catch (error) {
      return { ...base, groups: [], failures: [{ id: 'dsh', name: 'DSH', message: error instanceof Error ? error.message : String(error) }] }
    }
    const entries = await Promise.all(providers.map(async provider => {
      try {
        let timeout: ReturnType<typeof setTimeout> | undefined
        const timeoutMs = provider.id === 'deepseek-official' ? 6_000 : 3_000
        const models = await Promise.race([
          llm.listModels(provider.id),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`model directory timed out after ${timeoutMs / 1000} seconds`)), timeoutMs) }),
        ]).finally(() => { if (timeout !== undefined) clearTimeout(timeout) })
        return {
          kind: 'group' as const,
          value: {
            id: provider.id,
            name: provider.name,
            models: models.map(model => ({
              id: model.id,
              name: model.name,
              ...(model.description === undefined ? {} : { description: model.description }),
              ...(model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] }),
            })),
          },
        }
      } catch (error) {
        return { kind: 'failure' as const, value: { id: provider.id, name: provider.name, message: error instanceof Error ? error.message : String(error) } }
      }
    }))
    return {
      ...base,
      groups: entries.flatMap(entry => entry.kind === 'group' && entry.value.models.length > 0 ? [entry.value] : []),
      failures: entries.flatMap(entry => entry.kind === 'failure' ? [entry.value] : []),
    }
  }

  private availableAgent(workspaceRoot?: string): HostAgent | undefined {
    const agents = [...this.owners.keys()]
    const normalizedRoot = workspaceRoot?.trim()
    if (normalizedRoot === undefined || normalizedRoot === '') return agents.find(agent => agent.status === 'idle') ?? agents[0]
    const expected = resolve(normalizedRoot)
    const matching = agents.filter(agent => {
      const cwd = agent.session.header?.cwd?.trim()
      return cwd !== undefined && cwd !== '' && resolve(cwd) === expected
    })
    return matching.find(agent => agent.status === 'idle') ?? matching[0]
  }

  workspaceRoot(sessionId?: string): string | undefined {
    if (sessionId === undefined || sessionId.trim() === '') return undefined
    return this.ctx.agents.get(sessionId.trim())?.session.header?.cwd
  }

  memoryView(sessionId: string, workspaceRoot?: string): import('./view-protocol.ts').MemoryViewInspection | undefined {
    const agent = this.ctx.agents.get(sessionId.trim())
    return agent === undefined ? undefined : this.memoryTurns.get(agent)?.inspect(workspaceRoot)
  }

  turnActivities(sessionId: string): TurnMemoryActivitySnapshot {
    const agent = this.ctx.agents.get(sessionId.trim())
    const owner = agent === undefined ? undefined : this.owners.get(agent)?.lifecycle
    return owner === undefined ? { cursor: 0, activities: [] } : owner.turnMemoryActivities()
  }

  assistantMessage(sessionId: string, messageId: string): AssistantMessageText | null {
    const agent = this.ctx.agents.get(sessionId.trim())
    const owner = agent === undefined ? undefined : this.owners.get(agent)?.lifecycle
    return owner === undefined ? null : owner.assistantMessageText(messageId)
  }

  recall(sessionId: string, request: SearchRequest, signal = new AbortController().signal) {
    return this.coordinator.recall(this.liveAgent(sessionId), request, signal)
  }

  related(sessionId: string, id: string, memoryBodyId?: string, signal = new AbortController().signal) {
    return this.coordinator.related(this.liveAgent(sessionId), id, memoryBodyId, signal)
  }

  answer(sessionId: string, query: string, evidence: Insight[], signal = new AbortController().signal) {
    return this.coordinator.answer(this.liveAgent(sessionId), query, evidence, signal)
  }

  answerTask(sessionId: string, query: string, evidence: Insight[], workspaceRoot?: string, signal = new AbortController().signal) {
    const root = workspaceRoot?.trim() || this.workspaceRoot(sessionId)
    return this.runTaskAgent(sessionId, root, signal, agent => this.coordinator.answer(agent, query, evidence, signal), undefined, 'Mnemon · Ask Agent')
  }

  remember(sessionId: string, request: RememberRequest, signal = new AbortController().signal) {
    return this.coordinator.remember(this.liveAgent(sessionId), request, signal, { activateTarget: true })
  }

  runtime(sessionId: string, request: RuntimeMemoryMutation, signal = new AbortController().signal) {
    return this.coordinator.runtime(this.liveAgent(sessionId), request, signal)
  }

  manageSource(graph: import('./runtime.ts').MnemonRuntimeGraph, request: import('../core/contracts/index.ts').MemorySourceManagementRequest) {
    return this.coordinator.manageSource(graph, request)
  }

  runRuntimeMaintenanceTask<T>(scope: import('../core/contracts/index.ts').MemoryOperationScope, signal: AbortSignal, operation: (agent: HostAgent) => Promise<T>): Promise<T> {
    return this.runTaskAgent(scope.sessionId ?? '', scope.workspaceId, signal, operation, undefined, 'Mnemon · Memory maintenance')
  }

  reconcile(graph: import('./runtime.ts').MnemonRuntimeGraph, scope: import('../core/contracts/index.ts').MemoryOperationScope, signal: AbortSignal, options?: import('./protocol.ts').MnemonReconcileOptions) {
    return this.coordinator.reconcile(graph, scope, signal, options)
  }

  documents(sessionId: string) {
    return this.coordinator.documentsSnapshot(this.liveAgent(sessionId))
  }

  document(sessionId: string, id: string) {
    return this.coordinator.documentGet(this.liveAgent(sessionId), id)
  }

  searchDocuments(sessionId: string, query: string, includeArchived = false, limit?: number) {
    return this.coordinator.documentSearch(this.liveAgent(sessionId), query, includeArchived, limit)
  }

  mutateDocument(sessionId: string, request: DocumentMutation, signal = new AbortController().signal) {
    return this.coordinator.document(this.liveAgent(sessionId), request, signal)
  }

  mutateDocumentTask(sessionId: string, request: DocumentMutation, workspaceRoot?: string, signal = new AbortController().signal) {
    const root = workspaceRoot?.trim() || this.workspaceRoot(sessionId)
    if (root === undefined || root.trim() === '') throw new Error('a selected DSH workspace is required to write a Mnemon Document')
    return this.runTaskAgent(sessionId, root, signal, agent => this.coordinator.document(agent, request, signal), undefined, 'Mnemon · Document')
  }

  archiveDocument(sessionId: string, id: string, workspaceRoot?: string, signal = new AbortController().signal) {
    const root = workspaceRoot?.trim() || this.workspaceRoot(sessionId)
    if (root === undefined || root.trim() === '') throw new Error('a selected DSH workspace is required to archive a Mnemon Document')
    return this.runTaskAgent(sessionId, root, signal, agent => this.coordinator.archiveDocument(agent, id, signal), undefined, 'Mnemon · Archive Document')
  }

  mutate(sessionId: string, operation: string, request: unknown, signal = new AbortController().signal) {
    return this.coordinator.write(this.liveAgent(sessionId), operation, request, signal)
  }

  placeProvider(sessionId: string, body: { name: string; description: string }, prepared: PreparedMemoryPlacement, signal = new AbortController().signal) {
    return this.coordinator.placeProvider(this.liveAgent(sessionId), body, prepared, signal)
  }

  placeProviderTask(sessionId: string, body: { name: string; description: string }, prepared: PreparedMemoryPlacement, workspaceRoot?: string, signal = new AbortController().signal) {
    const root = workspaceRoot?.trim() || this.workspaceRoot(sessionId)
    return this.runTaskAgent(sessionId, root, signal, agent => this.coordinator.placeProvider(agent, body, prepared, signal), undefined, 'Mnemon · Choose memory provider')
  }

  maintainMetadata(sessionId: string, memoryBodyIds: readonly string[], workspaceRoot?: string, signal = new AbortController().signal) {
    const root = workspaceRoot?.trim() || this.workspaceRoot(sessionId)
    return this.runTaskAgent(sessionId, root, signal, agent => this.coordinator.maintainMetadata(agent, memoryBodyIds, signal), undefined, 'Mnemon · Memory metadata')
  }

  async supervise(sessionId: string, content: string, idempotencyKey?: string, signal = new AbortController().signal): Promise<SupervisedWritebackResult> {
    const normalizedSessionId = sessionId.trim()
    if (normalizedSessionId === '') throw new Error('current DSH session is unavailable')
    return this.superviseResolved(
      normalizedSessionId,
      normalizedSessionId,
      content,
      idempotencyKey,
      signal,
      async operation => operation(this.liveAgent(normalizedSessionId)),
    )
  }

  async superviseTask(sessionId: string, content: string, idempotencyKey?: string, workspaceRoot?: string, signal = new AbortController().signal): Promise<SupervisedWritebackResult> {
    const normalizedSessionId = sessionId.trim()
    const root = workspaceRoot?.trim() || this.workspaceRoot(normalizedSessionId)
    const scopeKey = root === undefined ? `task:${normalizedSessionId || 'global'}` : `task:${resolve(root)}`
    return this.superviseResolved(
      scopeKey,
      normalizedSessionId,
      content,
      idempotencyKey,
      signal,
      operation => this.runTaskAgent(normalizedSessionId, root, signal, operation, undefined, 'Mnemon · Save to memory'),
    )
  }

  private async superviseResolved(
    replayScope: string,
    responseSessionId: string,
    content: string,
    idempotencyKey: string | undefined,
    signal: AbortSignal,
    withAgent: <T>(operation: (agent: HostAgent) => Promise<T>) => Promise<T>,
  ): Promise<SupervisedWritebackResult> {
    if (!this.config.writeEnabled) throw new Error('dsh-mnemon is configured read-only (writeEnabled: false)')
    const normalizedContent = content.trim()
    if (normalizedContent === '') throw new Error('memory candidate is required')
    if (normalizedContent.length > 8000) throw new Error('memory candidate is too long (max 8000 characters)')
    const normalizedKey = idempotencyKey?.trim()
    if (normalizedKey !== undefined && normalizedKey.length > 200) throw new Error('idempotency key is too long (max 200 characters)')

    const execute = async (): Promise<SupervisedWritebackResult> => {
      return withAgent(async agent => {
        const owner = this.owners.get(agent)?.lifecycle
        if (owner === undefined) this.counters.supervisedRequests += 1
        else owner.markSupervised()
        const result = await this.coordinator.write(agent, 'supervised-writeback', {
          content: normalizedContent,
          source: normalizedKey === undefined || normalizedKey === '' ? 'explicit Mnemon tab submission' : 'explicit assistant memory action',
        }, signal)
        return { ...result, sessionId: responseSessionId || agent.id }
      })
    }

    if (normalizedKey === undefined || normalizedKey === '') return execute()
    const replayKey = `${replayScope}\u0000${normalizedKey}`
    const existing = this.supervisedWritebacks.get(replayKey)
    if (existing?.content === normalizedContent) return existing.result
    if (existing === undefined && this.supervisedWritebacks.size >= 256) {
      const oldest = this.supervisedWritebacks.keys().next().value as string | undefined
      if (oldest !== undefined) this.supervisedWritebacks.delete(oldest)
    }
    const result = execute()
    this.supervisedWritebacks.delete(replayKey)
    this.supervisedWritebacks.set(replayKey, { content: normalizedContent, result })
    void result.catch(() => {
      if (this.supervisedWritebacks.get(replayKey)?.result === result) this.supervisedWritebacks.delete(replayKey)
    })
    return result
  }

  private liveAgent(sessionId: string): HostAgent {
    const normalized = sessionId.trim()
    if (normalized === '') throw new Error('current DSH session is unavailable')
    const agent = this.ctx.agents.get(normalized)
    if (agent === undefined) throw new Error('current DSH agent is not live; reopen or resume the conversation and try again')
    return agent
  }

  private async runTaskAgent<T>(
    fallbackSessionId: string,
    workspaceRoot: string | undefined,
    signal: AbortSignal,
    operation: (agent: HostAgent) => Promise<T>,
    route?: RoutedPick,
    title = 'Mnemon · Background task',
  ): Promise<T> {
    const modern = activationOwned(this.ctx.subagents)
    const sessionId = `mnemon-task-v1-${randomUUID()}`
    this.taskAgentIds.add(sessionId)
    let handle: HostAgentHandle | undefined
    let failure: unknown
    try {
      const creation = await this.taskAgentCreation(fallbackSessionId, workspaceRoot, signal, route)
      handle = await this.ctx.agents.create({
        sessionId,
        ...creation,
        signal,
      })
      if (modern) titleTask(handle.agent, title)
      if (route !== undefined) {
        try { (handle.agent as unknown as Record<symbol, RoutedPick>)[TASK_ROUTE] = route } catch { }
      }
      return await operation(handle.agent)
    } catch (error) {
      failure = error
      throw error
    } finally {
      if (handle !== undefined) {
        try { await handle.dispose() } catch (error) { if (failure === undefined) throw error }
      }
      await archiveTaskSession(this.ctx, sessionId, handle?.agent.session)
      this.taskAgentIds.delete(sessionId)
    }
  }

  private async taskAgentCreation(
    fallbackSessionId: string,
    workspaceRoot: string | undefined,
    signal: AbortSignal,
    route?: RoutedPick,
  ): Promise<Pick<CreateHostAgentOptions, 'meta' | 'agentOptions' | 'setup'>> {
    const baseOptions = this.taskAgentModelOptions(fallbackSessionId, workspaceRoot)
    const { reasoningEffort: _inheritedEffort, ...baseRest } = baseOptions ?? {}
    const agentOptions = route === undefined ? baseOptions : {
      ...baseRest,
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    }
    if (agentOptions === undefined) throw new Error('no default provider/model is available for a clean task Agent')
    const { cwd, workFrom } = await this.taskAgentDirectories(workspaceRoot)
    const presets = presetService(this.ctx.get('agentPresets'))
    const presetId = presets === undefined ? undefined : (await presets.resolve()).id
    const workingDirectory = workFrom === undefined ? undefined : this.ctx.get('workingDirectory') as WorkingDirectoryService | undefined
    const meta = { cwd, ...(activationOwned(this.ctx.subagents) ? {} : { origin: 'subagent' as const }), ...(presetId === undefined ? {} : { agentPreset: presetId }) }
    if (presets === undefined && typeof workingDirectory?.set !== 'function') return { meta, agentOptions }
    return {
      meta,
      agentOptions,
      setup: async (agentCtx, agent) => {
        if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId)
        if (workFrom !== undefined && agent !== undefined && typeof workingDirectory?.set === 'function') await workingDirectory.set(agent, workFrom, signal)
      },
    }
  }

  private async taskAgentDirectories(workspaceRoot: string | undefined): Promise<{ cwd: string; workFrom?: string }> {
    const requested = workspaceRoot?.trim()
    const cwd = requested !== undefined && requested !== '' ? resolve(requested) : this.registeredWorkspaces()[0] ?? process.cwd()
    return await isDirectory(cwd) ? { cwd } : { cwd, workFrom: await this.existingWorkspace() }
  }

  private async existingWorkspace(): Promise<string> {
    for (const workspace of this.registeredWorkspaces()) {
      if (await isDirectory(workspace)) return workspace
    }
    return process.cwd()
  }

  private registeredWorkspaces(): string[] {
    const registry = this.ctx.get('workspaceRegistry') as { list?: () => Array<{ path?: unknown }> } | undefined
    const listed = typeof registry?.list === 'function' ? registry.list() : []
    return listed.flatMap(workspace => typeof workspace?.path === 'string' && workspace.path.trim() !== '' ? [resolve(workspace.path)] : [])
  }

  private taskAgentModelRoute(fallbackSessionId: string, workspaceRoot: string | undefined): { options: NonNullable<CreateHostAgentOptions['agentOptions']>; source: 'fixed' | 'session' | 'dsh-default' | 'active-agent' } | undefined {
    const fallback = this.routeFallback(fallbackSessionId, workspaceRoot)
    const maxTokens = fallback?.options?.maxTokens === undefined ? {} : { maxTokens: fallback.options.maxTokens }
    if (this.config.taskAgentModel.mode === 'fixed') {
      const provider = this.config.taskAgentModel.provider?.trim()
      const model = this.config.taskAgentModel.model?.trim()
      if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
      return { source: 'fixed', options: { provider, model, ...maxTokens } }
    }
    const conversation = this.config.taskAgentModel.followConversation === true ? this.conversationRoute(fallbackSessionId) : undefined
    if (conversation !== undefined) return { source: 'session', options: { ...conversation, ...maxTokens } }
    const inherited = this.inheritedRoute(fallback)
    if (inherited === undefined) return undefined
    const { source, ...options } = inherited
    return { source, options: { ...options, ...maxTokens } }
  }

  private routeFallback(sessionId: string, workspaceRoot: string | undefined): HostAgent | undefined {
    return this.ctx.agents.get(sessionId.trim()) ?? this.availableAgent(workspaceRoot) ?? this.availableAgent()
  }

  private inheritedRoute(fallback: HostAgent | undefined): { provider: string; model: string; reasoningEffort?: string; source: 'dsh-default' | 'active-agent' } | undefined {
    let selected: ReturnType<HostDefaultModelService['currentSelection']> | undefined
    try { selected = modelService(this.ctx.get('agentDefaultModel'))?.currentSelection() } catch {}
    const selectedProvider = selected?.provider.trim()
    const selectedModel = selected?.model.trim()
    const provider = selectedProvider || fallback?.options?.provider?.trim()
    const model = selectedModel || fallback?.options?.model?.trim()
    if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
    const fromDefault = selectedProvider !== undefined && selectedProvider !== '' && selectedModel !== undefined && selectedModel !== ''
    const matchesFallback = provider === fallback?.options?.provider?.trim() && model === fallback?.options?.model?.trim()
    const effort = fromDefault ? selected?.reasoningEffort : matchesFallback ? fallback?.options?.reasoningEffort : undefined
    return { provider, model, ...(typeof effort === 'string' && effort.trim() !== '' ? { reasoningEffort: effort } : {}), source: fromDefault ? 'dsh-default' : 'active-agent' }
  }

  private conversationRoute(sessionId: string): { provider: string; model: string; reasoningEffort?: string } | undefined {
    const normalized = sessionId.trim()
    if (normalized === '') return undefined
    const agent = this.ctx.agents.get(normalized)
    if (agent === undefined) return undefined
    const config = agent.session.requestHeader?.()?.config ?? agent.options
    const provider = config?.provider?.trim()
    const model = config?.model?.trim()
    if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
    const effort = config?.reasoningEffort
    return { provider, model, ...(typeof effort === 'string' && effort !== '' ? { reasoningEffort: effort } : {}) }
  }

  skillTaskRoute(workspaceRoot: string | undefined): RoutedPick | undefined {
    const options = this.taskAgentModelOptions('', workspaceRoot)
    if (!options?.provider || !options.model) return undefined
    return { provider: options.provider, model: options.model, ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }) }
  }

  private taskAgentModelOptions(fallbackSessionId: string, workspaceRoot: string | undefined): NonNullable<CreateHostAgentOptions['agentOptions']> | undefined {
    return this.taskAgentModelRoute(fallbackSessionId, workspaceRoot)?.options
  }

  private install(agent: HostAgent, source: LifecycleAgentSnapshot['startSource']): void {
    if (!contextIsActive(agent.ctx)) return
    this.watchWorkspacePolicy(agent)
    if (this.taskAgentIds.has(agent.id) || isIdleReviewOwner(agent.id) || this.owners.has(agent) || this.children.has(agent)) return
    if ((isTaskRecord(agent.id) || this.coordinator.isFinishedTask(agent.id, agent)) && !isCreatingChild(this.ctx.agents, agent)) {
      this.coordinator.continueTask(agent)
      return
    }
    if (agent.session.header?.origin === 'subagent') {
      this.installChild(agent)
      return
    }
    if (!isRootAgent(this.ctx.agents, this.ctx.subagents, agent)) return
    const memoryTurn = this.runtimeSource === undefined ? undefined : new AgentMemoryTurn(agent, this.runtimeSource)
    const lifecycle = new MnemonAgentLifecycle(agent, this.coordinator, this.config, this.counters, source, memoryTurn,
      () => memoryTurn?.excluded ? undefined : this.runtimeSource?.forAgent(agent).directory)
    let dispose: () => unknown
    dispose = agent.ctx.effect(() => {
      const stop = lifecycle.start()
      let stopSkills: (() => void) | undefined
      const updateSkills = () => {
        if (memoryTurn?.excluded) { stopSkills?.(); stopSkills = undefined }
        else stopSkills ??= this.skillEvolution?.watch(agent)
      }
      updateSkills()
      const stopSkillsPolicy = this.runtimeSource?.onChanged?.(updateSkills)
      return () => {
        try {
          stopSkillsPolicy?.()
          stopSkills?.()
          stop()
        } finally {
          memoryTurn?.dispose()
          if (this.owners.get(agent)?.dispose === dispose) this.owners.delete(agent)
          if (this.memoryTurns.get(agent) === memoryTurn) this.memoryTurns.delete(agent)
        }
      }
    }, 'dsh-mnemon.lifecycle()')
    this.owners.set(agent, { lifecycle, dispose })
    if (memoryTurn !== undefined) this.memoryTurns.set(agent, memoryTurn)
  }

  private watchWorkspacePolicy(agent: HostAgent): void {
    if (this.workspacePolicies.has(agent) || this.runtimeSource?.memoryParticipation === undefined) return
    let update!: () => void
    const dispose = agent.ctx.effect(() => {
      let stopRestriction: (() => unknown) | undefined
      const excluded = () => this.runtimeSource?.memoryParticipation?.(agent).excluded === true
      const stopGuard = agent.ctx.tools?.guard?.(execution => execution.name?.startsWith('mnemon_')
        && this.runtimeSource?.memoryParticipation?.(execution.agent ?? agent).excluded ? WORKSPACE_MEMORY_EXCLUDED : undefined)
      update = () => {
        if (excluded()) {
          if (stopRestriction !== undefined) return
          const stop = agent.ctx.tools?.restrict?.({ deny: [...Object.keys(MEMORY_TOOLS), 'mnemon_subagent_result'] })
          if (typeof stop === 'function') stopRestriction = stop as () => unknown
        } else { stopRestriction?.(); stopRestriction = undefined }
      }
      update()
      return () => {
        stopRestriction?.()
        if (typeof stopGuard === 'function') stopGuard()
        this.workspacePolicies.delete(agent)
      }
    }, 'dsh-mnemon.workspace-participation()')
    this.workspacePolicies.set(agent, { update, dispose })
  }

  private installChild(agent: HostAgent): void {
    const runtime = this.runtimeSource
    const parentId = agent.session.header?.parentSession?.trim()
    const parent = parentId === undefined || parentId === '' ? undefined : this.ctx.agents.get(parentId)
    if (runtime === undefined || parent === undefined || parent === agent || !contextIsActive(agent.ctx) || !contextIsActive(parent.ctx)) return
    this.coordinator.inheritTaskContinuation(parent, agent)
    const delegation = this.delegatedMemoryFor(agent, parent, runtime)
    this.attachChildMemoryTurn(agent, runtime, delegation)
  }

  private delegatedMemoryFor(agent: HostAgent, parent: HostAgent, runtime: AgentRuntimeSource): DelegatedMemoryView | undefined {
    if (runtime.memoryParticipation?.(agent).excluded === true) return undefined
    const parentMemory = this.memoryTurns.get(parent)
    if (parentMemory !== undefined) return parentMemory.delegate()
    const graph = runtime.forAgent(parent)
    const parentPin = graph.composableTurns.activeTurn(parent.id)
    return {
      graph,
      scope: parentPin?.scope ?? agentScope(parent, graph.config),
      ...(parentPin === undefined ? {} : { viewId: parentPin.view.id }),
    }
  }

  private attachChildMemoryTurn(agent: HostAgent, runtime: AgentRuntimeSource, delegation: DelegatedMemoryView | undefined): () => unknown {
    let dispose: (() => unknown) | undefined
    dispose = agent.ctx.effect(() => {
      const memory = new AgentMemoryTurn(agent, runtime, delegation)
      this.memoryTurns.set(agent, memory)
      const stops: Array<() => unknown> = []
      const cleanup = () => {
        try {
          for (const stop of stops.reverse()) stop()
        } finally {
          try { memory.dispose() } finally {
            if (this.memoryTurns.get(agent) === memory) this.memoryTurns.delete(agent)
            if (this.children.get(agent) === dispose) this.children.delete(agent)
          }
        }
      }
      try {
        stops.push(agent.ctx.on('system-prompt/assemble', (async (_assembly: PromptAssembly, context: PromptAssemblyContext, next: () => Promise<PromptAssembly>) => {
          if (context.agent !== undefined && context.agent !== agent) return next()
          const turn = openAgentTurn(agent)
          if (turn !== undefined) await memory.begin(turn, context.signal)
          return applyMemoryViewGuidance(await next(), memory.current?.context.view, this.config.routingGuidance)
        }) as never))
        stops.push(agent.ctx.on('agent/pre-step', (async (payload: PreStepPayload, next: () => Promise<HostPreStepDecision>) => {
          const decision = await next()
          if (decision.kind === 'reject' || payload.signal.aborted) {
            memory.end(payload.turn)
            return decision
          }
          if (openAgentTurn(agent) !== payload.turn) return decision
          await memory.begin(payload.turn, payload.signal)
          const pinned = memory.current
          if (payload.step === 1 && this.config.lifecycleEnabled && pinned !== undefined) {
            const wake = memory.modelWake()
            if (wake !== undefined && wake.text.trim() !== '') return { kind: 'enter', messages: [...decision.messages, createPluginMessage(wake.text, 'recall')] }
          }
          return decision
        }) as never))
        stops.push(agent.ctx.on('session/event', ((session: HostAgent['session'], event: HostSessionEvent) => {
          if (session === agent.session && event.type === 'turn/end') memory.end(eventTurn(event))
        }) as never))
      } catch (error) {
        cleanup()
        throw error
      }
      return cleanup
    }, 'dsh-mnemon.child-memory()')
    this.children.set(agent, dispose)
    return dispose
  }

  private async runIsolatedReview(request: IsolatedReviewRequest): Promise<{ stopReason: string; detail?: string }> {
    const runtime = this.runtimeSource
    if (runtime === undefined) throw new Error('dsh-mnemon runtime source is unavailable')
    const parent = request.parent
    const permissionPresets = parent.ctx?.get?.('permissionPresets') as { current?(session: unknown): unknown } | undefined
    const sandboxPolicy = parent.ctx?.get?.('sandboxPolicy') as { overrideOf?(session: unknown): unknown } | undefined
    const approval = parent.ctx?.get?.('approval')
    const presetValue = permissionPresets?.current?.(parent.session)
    const delegatedPolicies = {
      permissionPreset: presetValue === 'auto' || presetValue === 'danger-full-access' ? presetValue : undefined,
      sandboxMode: sandboxPolicy?.overrideOf?.(parent.session),
      approvalPolicy: approval === undefined ? undefined : 'never',
    }
    const fixed = this.config.taskAgentModel.mode === 'fixed'
      ? this.taskAgentModelOptions(parent.id, parent.session.header?.cwd)
      : undefined
    const fallbackRoute = (() => {
      const provider = parent.options?.provider?.trim()
      const model = parent.options?.model?.trim()
      const effort = parent.options?.reasoningEffort?.trim()
      if (!provider || !model) return this.taskAgentModelOptions(parent.id, parent.session.header?.cwd)
      return { provider, model, ...(effort ? { reasoningEffort: effort } : {}) }
    })()
    const baseRoute = fixed ?? this.conversationRoute(parent.id) ?? fallbackRoute
    if (baseRoute === undefined) throw new Error('no default provider/model is available for an isolated idle review Agent')
    const agentOptions = { ...baseRoute, maxTokens: request.maxTokens }
    const requestedDir = parent.session.header?.cwd?.trim()
    const dir = await this.taskAgentDirectories(requestedDir === '' ? undefined : requestedDir)
    const presetsRaw = this.ctx.get('agentPresets') as (HostAgentPresetService & { composeFrom?(childCtx: unknown, parentCtx: unknown): void }) | undefined
    const presets = presetService(presetsRaw)
    const parentPreset = parent.session.header?.agentPreset
    const presetId = parentPreset !== undefined && parentPreset.trim() !== ''
      ? parentPreset
      : presets === undefined ? undefined : (await presets.resolve()).id
    const modern = activationOwned(this.ctx.subagents)
    const meta = {
      cwd: dir.cwd,
      ...(modern ? {} : { origin: 'subagent' as const }),
      ...(presetId === undefined ? {} : { agentPreset: presetId }),
    }
    const delegation = this.delegatedMemoryFor(parent, parent, runtime)
    if (delegation === undefined) throw new Error('Memory view delegation is unavailable for isolated idle review')

    this.taskAgentIds.add(request.sessionId)
    let handle: HostAgentHandle | undefined
    let stopContinuation: (() => void) | undefined
    const taskMessageId = `mnemon-review-${randomUUID()}`
    let disposeMemoryTurn: (() => unknown) | undefined
    let stopPersona: (() => unknown) | undefined
    const cancel = () => { try { handle?.agent.cancel({ kind: 'hook', reason: 'Idle review cancelled' }) } catch {} }
    try {
      const mountPreset = async (agentCtx: HostAgentContext) => {
        if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId)
        else presetsRaw?.composeFrom?.(agentCtx, parent.ctx)
      }
      const applyPolicies = (child: HostAgent) => {
        if (typeof child.session.append === 'function') {
          if (delegatedPolicies.sandboxMode !== undefined) child.session.append('sandbox/mode', { mode: delegatedPolicies.sandboxMode, source: 'delegation' })
          if (delegatedPolicies.approvalPolicy !== undefined) child.session.append('approval/policy', { policy: delegatedPolicies.approvalPolicy, source: 'delegation' })
          if (delegatedPolicies.permissionPreset !== undefined) child.session.append('permission/preset', { preset: delegatedPolicies.permissionPreset })
        }
      }
      const installReview = (agentCtx: HostAgentContext, child: HostAgent) => {
        if (typeof agentCtx.systemPrompt?.section === 'function') {
          agentCtx.systemPrompt.section({
            name: 'deployment:persona-prefix',
            order: agentCtx.systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX') ?? 10,
            text: request.persona,
          })
        } else if (typeof agentCtx.on === 'function') {
          const stop = agentCtx.on('system-prompt/assemble', (async (_assembly: PromptAssembly, _ctx: PromptAssemblyContext, next: () => Promise<PromptAssembly>) => {
            const assembled = await next()
            return { ...assembled, sections: [{ name: 'deployment:persona-prefix', text: request.persona }, ...assembled.sections] }
          }) as never)
          if (typeof stop === 'function') stopPersona = stop
        }
        agentCtx.tools?.restrict?.({ allow: request.allowedTools })
        agentCtx.tools?.guard?.(request.guardTools)
        stopContinuation = attachContinuationTurns(child)
        disposeMemoryTurn = this.attachChildMemoryTurn(child, runtime, delegation)
      }
      const prompt = [{ type: 'text' as const, text: `${delegatedTaskLine('review')}\n${request.prompt}` }]
      const subagents = this.ctx.subagents
      if (modern && childComposition(subagents, subagents.getProvider(request.provider)) === 'publication') {
        return await this.runManagedReview(request, meta, agentOptions, dir.workFrom ?? dir.cwd, prompt, mountPreset, child => {
          applyPolicies(child)
          installReview(child.ctx, child)
        })
      }
      handle = await this.ctx.agents.create({
        sessionId: request.sessionId,
        meta,
        agentOptions,
        signal: request.signal,
        setup: async (agentCtx, child) => {
          if (child === undefined) throw new Error('DSH omitted the created Agent during isolated idle review setup')
          await mountPreset(agentCtx)
          applyPolicies(child)
          const workingDirectory = (agentCtx.get?.('workingDirectory') ?? this.ctx.get('workingDirectory')) as WorkingDirectoryService | undefined
          if (typeof workingDirectory?.set === 'function') await workingDirectory.set(child, dir.workFrom ?? dir.cwd, request.signal)
          installReview(agentCtx, child)
        },
      })
      const child = handle.agent
      if (modern) titleTask(child, 'Mnemon · Idle review')
      request.signal.addEventListener('abort', cancel, { once: true })
      request.signal.throwIfAborted()
      const startSeq = sessionLength(child.session)
      child.followup({
        id: taskMessageId,
        role: 'user',
        source: { kind: 'user' },
        content: prompt,
      })
      let idleError: unknown
      try {
        await (child as HostAgent & { whenIdle(): Promise<void> }).whenIdle()
      } catch (error) {
        idleError = error
      }
      const turnEnd = findSessionEvent(child.session, event => event.type === 'turn/end', startSeq)?.event
      const reason = turnEnd?.data?.reason as { kind?: unknown; error?: { message?: unknown } } | undefined
      if (reason?.kind === 'error' || (idleError !== undefined && !request.signal.aborted && reason?.kind !== 'aborted')) {
        const detail = typeof reason?.error?.message === 'string'
          ? reason.error.message
          : idleError instanceof Error ? idleError.message : idleError === undefined ? undefined : String(idleError)
        return { stopReason: 'error', ...(detail === undefined ? {} : { detail }) }
      }
      if (request.signal.aborted || reason?.kind === 'aborted') return { stopReason: 'aborted' }
      if (reason?.kind === 'max-tokens') return { stopReason: 'max-tokens' }
      if (reason?.kind === 'refusal') return { stopReason: 'refusal' }
      return { stopReason: 'completed' }
    } finally {
      request.signal.removeEventListener('abort', cancel)
      stopPersona?.()
      stopContinuation?.()
      try {
        try { await handle?.dispose() } finally {
          disposeMemoryTurn?.()
          if (handle !== undefined) await archiveTaskSession(this.ctx, request.sessionId, handle.agent.session, taskMessageId)
        }
      } finally {
        this.taskAgentIds.delete(request.sessionId)
      }
    }
  }

  private async runManagedReview(request: IsolatedReviewRequest, meta: NonNullable<CreateHostAgentOptions['meta']>,
    agentOptions: NonNullable<CreateHostAgentOptions['agentOptions']>, cwd: string, prompt: Array<{ type: 'text'; text: string }>,
    mountPreset: (ctx: HostAgentContext) => Promise<void>, setup: (child: HostAgent) => void,
  ): Promise<{ stopReason: string; detail?: string }> {
    const ownerId = `mnemon-review-owner-v1-${randomUUID()}`
    const owner = await this.ctx.agents.create({ sessionId: ownerId, meta, agentOptions, signal: request.signal, setup: mountPreset })
    let run: HostSubagentRun | undefined
    try {
      run = await withReservedChild(owner.agent, () => startSubagent(this.ctx.subagents, this.ctx.agents, request.provider, {
        parent: owner.agent, label: 'Idle review', cwd, prompt, agentOptions, maxDepth: 1, signal: request.signal,
      }, this.ctx, setup), true, request.sessionId)
      const result = await run.result
      return { stopReason: result.stopReason, ...(result.diagnostic === undefined ? {} : { detail: result.diagnostic }) }
    } finally {
      try {
        await run?.dispose()
        await archiveTaskSession(this.ctx, request.sessionId, run?.localAgent?.session, run?.messageId)
      } finally {
        try { await owner.dispose() } finally { await archiveTaskSession(this.ctx, ownerId, owner.agent.session) }
      }
    }
  }
}
