import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ResolvedConfig } from './config.ts'
import type {
  CreateHostAgentOptions,
  HostAgent,
  HostAgentHandle,
  HostContextShape,
  HostLlmService,
  HostPreStepDecision,
  HostSessionEvent,
  HostUserMessage,
} from "./dsh.ts"
import type { Insight, RememberRequest, SearchRequest } from 'dsh-mnemon-source-memory-spaces/contracts'
import type { RuntimeMemoryMutation } from 'dsh-mnemon-source-runtime/contracts'
import type { DocumentMutation } from 'dsh-mnemon-source-documents/contracts'
import { IdleReviewError, MnemonSubagentCoordinator } from './subagent.ts'
import { scoreReviewActivity } from './review-activity.ts'
import { idleReviewBlockReason } from './review-tools.ts'
import { TurnActivityProjection, type TurnMemoryActivity, type TurnMemoryActivitySnapshot } from './activity.ts'
import { applyMemoryViewGuidance } from './guidance.ts'
import { modelMemoryWake } from './view-presentation.ts'
import { strategyDrives, viewStrategy } from './strategy-workflows.ts'
import { mainStrategyTypeId } from './main-strategy.ts'
import { AgentMemoryTurn, openAgentTurn, type DelegatedMemoryView } from './agent-memory-turn.ts'
import type { AssistantMessageText, LifecycleAgentSnapshot, LifecycleCounters, LifecyclePhase, LifecycleSnapshot, ReviewActivityScore, SkillActivitySnapshot, SupervisedWritebackResult, TaskAgentModelCatalog } from "./protocol.ts"
import type { PreparedMemoryPlacement } from 'dsh-mnemon-source-memory-spaces/contracts'
import type { MemoryWake } from "../core/contracts/index.ts"
import { agentScope, type MnemonAgentRuntimeSource } from './runtime.ts'
import { createPluginMessage, MNEMON_PLUGIN_SOURCE } from './plugin-message.ts'
import type { SkillEvolution } from './skill-evolution.ts'
import { IdleReviewWatermarkStore } from './idle-review-watermark.ts'
import { activationOwned, isCreatingChild, isRootAgent, isTaskRecord, rootAgents, titleTask } from './agent-compat.ts'

type AgentRuntimeSource = Pick<MnemonAgentRuntimeSource, 'forAgent' | 'executions' | 'onChanged'>

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

function isMnemonMessageSource(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const { kind, plugin } = source as { kind?: unknown; plugin?: unknown }
  // V3-to-V4 migrates the legacy plugin wrapper to `plugin:dsh-mnemon`.
  return kind === MNEMON_PLUGIN_SOURCE
    || kind === `plugin:${MNEMON_PLUGIN_SOURCE}`
    || (kind === 'plugin' && plugin === MNEMON_PLUGIN_SOURCE)
}

/**
 * Whether an event is a durable user message this plugin produced.
 */
function isOwnUserMessageEvent(event: HostSessionEvent | undefined): boolean {
  if (event?.type !== 'user/message') return false
  return isMnemonMessageSource(event.data.source)
}

function eventTurn(event: HostSessionEvent): number | undefined {
  return typeof event.data.turn === 'number' ? event.data.turn : undefined
}

function memoryToolCalls(events: readonly HostSessionEvent[], turn?: number): number {
  return events.filter(event => event.type === 'tool/call'
    && (turn === undefined || eventTurn(event) === turn)
    && typeof event.data.name === 'string'
    && event.data.name.startsWith('mnemon_')).length
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

function completedToolActivity(events: readonly HostSessionEvent[], turn: number): { count: number; names: Set<string> } {
  const count = events.filter(event => event.type === 'tool/result' && eventTurn(event) === turn).length
  const names = new Set(events
    .filter(event => event.type === 'tool/call' && eventTurn(event) === turn && typeof event.data.name === 'string')
    .map(event => String(event.data.name)))
  return { count, names }
}

/** Join the text content of an `assistant/message` event whose message id matches. */
function assistantMessageText(events: readonly HostSessionEvent[], messageId: string): AssistantMessageText | null {
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
  private readonly memoryActivity = new TurnActivityProjection()
  private readonly turnActivity = new Map<number, {
    messageIds: Set<string>
    userTextLength: number
    toolCallCount: number
    toolNames: Set<string>
    explicitCandidate: boolean
    noMaintenance: boolean
  }>()
  /**
   * Text of the runtime memory snapshot most recently injected as this
   * plugin's own message. `.context()` used to get supersede-on-change for free
   * from the host's runtime-context projection; carrying the snapshot as an own
   * message means re-emitting on change is this plugin's responsibility, and
   * the rendered text (which carries the revision digest) is the key.
   */
  private injectedMemoryText: string | undefined
  private idleReviewTimer: ReturnType<typeof setTimeout> | undefined
  private reviewController: AbortController | undefined
  private reviewRunning = false
  private reviewAccessBlocked = false
  private lastReviewAt: string | undefined
  private lastReviewAction: string | undefined
  private lastReviewScore: number | undefined
  private lastReviewDocumentIds: string[] | undefined
  private disposed = false
  private reviewEpoch = 0
  private observedReviewPolicy: string | undefined
  private watermarkEnabled = false
  /** Only this Agent's observed usage, attributed to the graph that composed each checkpoint. */
  private readonly reviewUsage = new Map<string, { attempts: number; lastReviewAttemptAt: number | null }>()
  private watermarkKey: string | undefined
  private watermarkStore: IdleReviewWatermarkStore | undefined
  private watermarkError: string | undefined
  private restoredAttempts = 0
  private idleReviewAttempts = 0
  private lastReviewAttemptAt: number | undefined
  private lastReviewFailure: LifecycleAgentSnapshot['lastReviewFailure']
  private lastPhase: LifecyclePhase = 'idle'
  private lastAt: string | undefined
  private lastError: string | undefined
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
      this.agent.ctx.on('session/event', ((session: HostAgent['session'], event: HostSessionEvent) => this.sessionEvent(session, event)) as never),
      this.agent.ctx.on('system-prompt/assemble', ((assembly: PromptAssembly, context: PromptAssemblyContext, next: () => Promise<PromptAssembly>) => this.assemblePrompt(assembly, context, next)) as never),
      // `prepend: true` makes this the outermost pre-step participant, so it
      // observes the fully assembled batch and appends after every other
      // contributor's context. The snapshot therefore has no byte-stable
      // context behind it, and `recordTurnMessages` sees the complete batch
      // rather than a partial one.
      this.agent.ctx.on('agent/pre-step', ((payload: PreStepPayload, next: () => Promise<HostPreStepDecision>) => this.preStep(payload, next)) as never, { prepend: true }),
      this.agent.ctx.on('agent/turn-stopping', ((payload: TurnStoppingPayload) => this.finishTurn(payload)) as never),
    ]
    return () => {
      this.disposed = true
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
      memoryToolCalls: memoryToolCalls(this.agent.session.snapshotEvents()),
      idleReviewPending: this.idleReviewTimer !== undefined,
      reviewRunning: this.reviewRunning,
      reviewActivity: this.reviewActivity(),
      idleReviewAttempts: this.idleReviewAttempts,
      ...(this.config.idleReview.persistWatermark ? { idleReviewWatermark: {
        state: this.watermarkError === undefined ? 'ready' as const : 'error' as const,
        restoredAttempts: this.restoredAttempts, maxPerSession: this.config.idleReview.maxPerSession,
        ...(this.watermarkError === undefined ? {} : { error: this.watermarkError }),
      } } : {}),
      ...(idleReviewBlockReason(this.agent, this.config.idleReview.agentTeams) !== undefined
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

  /** Incremental snapshot of settled Mnemon activity in this durable log. */
  turnMemoryActivities(): TurnMemoryActivitySnapshot {
    return this.memoryActivity.snapshot(this.agent.session.snapshotEvents())
  }

  /** Plain text of one finalized assistant message, from this agent's session log. */
  assistantMessageText(messageId: string): AssistantMessageText | null {
    return assistantMessageText(this.agent.session.snapshotEvents(), messageId)
  }

  memoryWake(): MemoryWake | undefined {
    const pinned = this.memoryTurn?.current
    if (pinned === undefined) return undefined
    return modelMemoryWake(pinned.graph, pinned.context)
  }

  /**
   * Whether the reminder is still visible to the model.
   *
   * Read from the surface rather than an Agent-scoped flag, because a rewind
   * is a surface replacement inside the same live Agent: DSH does not recreate
   * the Agent, so a flag would stay set and the reminder would never return.
   * The durable event log cannot answer this either, since it is append-only
   * and still contains the discarded message.
   *
   * Scanning forward is cheap: the reminder sits near the head of the surface,
   * so the loop exits after a few nodes even on a long session.
   */
  private cueAlreadyVisible(): boolean {
    for (const seq of this.agent.session.surface.nodes) {
      if (isOwnUserMessageEvent(this.agent.session.eventAt(seq))) return true
    }
    return false
  }

  /**
   * The runtime memory snapshot, as this plugin's own message, when it changed.
   *
   * `.context()` used to carry this inside the host's shared runtime-context
   * projection. Carrying it here instead attributes it to dsh-mnemon and keeps
   * a memory write from re-emitting other contributors' sections; supersede
   * stays intact because the block is still a complete state replacing its
   * predecessor, keyed on the rendered text's revision digest.
   */
  private memorySnapshotMessage(): HostUserMessage | undefined {
    const wake = this.memoryWake()
    if (wake === undefined) return undefined
    // This message bypasses SystemPrompt interpolation; Source text stays literal.
    const text = wake.text
    if (text.trim() === '' || text === this.injectedMemoryText) return undefined
    this.injectedMemoryText = text
    return createPluginMessage(text, 'recall')
  }

  private async preStep(payload: PreStepPayload, next: () => Promise<HostPreStepDecision>): Promise<HostPreStepDecision> {
    if (payload.step === 1) this.cancelIdleReview(true)
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted) {
      this.releaseView(payload.turn)
      return decision
    }
    // Prompt middleware can return its assembly without visiting later hooks,
    // or Mnemon can load while that waterfall is already running. The accepted
    // Agent step still needs its own durable turn's View before tools or Wake.
    if (!this.disposed && openAgentTurn(this.agent) === payload.turn) await this.memoryTurn?.begin(payload.turn, payload.signal)
    if (!this.config.lifecycleEnabled) return decision
    if (this.config.writeEnabled && this.config.writebackMode === 'guided') {
      this.recordTurnMessages(payload.turn, decision.messages)
    }
    if (payload.step !== 1) return decision

    const ownRequest = decision.messages.some(message => isMnemonMessageSource(message.source))
    if (ownRequest) {
      return decision
    }
    if (decision.messages.length === 0) return decision
    // Independent of the one-shot reminder gate below: memory can change at any
    // point in a session, and each change must supersede the previous snapshot.
    // Appended last so the snapshot sits at the bottom of this plugin's block.
    const snapshot = this.memorySnapshotMessage()
    const withSnapshot = (messages: HostUserMessage[]): HostUserMessage[] =>
      snapshot === undefined ? messages : [...messages, snapshot]

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

  private async assemblePrompt(assembly: PromptAssembly, context: PromptAssemblyContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly> {
    if (context.agent !== undefined && context.agent.id !== this.agent.id) return next()
    const turn = openAgentTurn(this.agent)
    if (turn === undefined) return next()
    // Cancel idle work before prompt assembly; the execution owner drains it.
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
    const tools = completedToolActivity(this.agent.session.snapshotEvents(), payload.turn)
    activity.toolCallCount = tools.count
    activity.toolNames = tools.names
    if (!this.reviewActivity().eligible || !this.reviewAdmitted(payload.turn)) return
    // DSH awaits turn-stopping before writing turn/end. The parent's PTC
    // availability check must finish here, including cancellation/log drains;
    // the later idle timer is never allowed to execute parent tools.
    const controller = new AbortController()
    const signal = AbortSignal.any([payload.signal, controller.signal])
    const epoch = this.reviewEpoch
    const policy = this.reviewPolicy()
    this.reviewController = controller
    this.reviewRunning = true
    let admitted = false
    try {
      const available = await this.coordinator.checkReviewAccess(this.agent, signal)
      if (signal.aborted || epoch !== this.reviewEpoch || policy !== this.reviewPolicy() || !this.idleReviewAllowed()) return
      this.reviewAccessBlocked = !available
      admitted = available
    } catch (error) {
      if (!signal.aborted) this.fail(error)
    } finally {
      if (this.reviewController === controller) {
        this.reviewRunning = false
        this.reviewController = undefined
      }
    }
    if (admitted) this.scheduleIdleReview(payload.turn)
  }

  private sessionEvent(session: HostAgent['session'], event: HostSessionEvent): void {
    if (session !== this.agent.session || event.type !== 'turn/end') return
    const turn = eventTurn(event)
    const current = this.memoryTurn?.current
    const pinned = turn === undefined || current?.turn !== turn ? undefined : current
    if (pinned === undefined) return
    this.releaseView(turn)
  }

  private scheduleIdleReview(turn: number): void {
    this.cancelIdleReview(true)
    if (!this.restoreWatermark() || !this.idleReviewAllowed()) return
    if (!this.reviewActivity().eligible || !this.reviewAdmitted(turn)) return
    const epoch = this.reviewEpoch
    const policy = this.reviewPolicy()
    this.idleReviewTimer = setTimeout(() => {
      this.idleReviewTimer = undefined
      if (epoch !== this.reviewEpoch || policy !== this.reviewPolicy() || !this.idleReviewAllowed() || this.reviewRunning) return
      if (this.lastReviewAttemptAt !== undefined && Date.now() < this.lastReviewAttemptAt + this.config.idleReview.minIntervalMs) {
        this.scheduleIdleReview(turn)
        return
      }
      if (this.agent.status !== 'idle') return
      const completed = this.agent.session.snapshotEvents().some(event => event.type === 'turn/end' && eventTurn(event) === turn)
      if (!completed || !this.reviewActivity().eligible || !this.reviewAdmitted(turn)) return
      void this.runIdleReview()
    }, Math.min(2_147_483_647, Math.max(this.config.idleReviewMs, (this.lastReviewAttemptAt ?? -Infinity) + this.config.idleReview.minIntervalMs - Date.now())))
  }

  /** Resolve only the graph actually serving this parent, never a selected View or startup cwd. */
  private restoreWatermark(): boolean {
    if (!this.config.idleReview.persistWatermark) { this.watermarkEnabled = false; return true }
    try {
      const directory = this.runtimeDirectory?.()
      if (directory === undefined || directory.trim() === '') throw new Error('runtime storage unavailable')
      const key = JSON.stringify([resolve(directory), this.agent.id])
      if (this.watermarkKey === key && this.watermarkEnabled) return this.watermarkError === undefined
      const sameRoot = this.watermarkKey === key
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
    const policy = this.reviewPolicy()
    if (policy !== this.observedReviewPolicy) {
      this.cancelIdleReview(true)
      this.reviewAccessBlocked = false
    }
    this.observedReviewPolicy = policy
    this.restoreWatermark()
  }

  private pauseWatermark(error: unknown): void {
    // Never display a raw filesystem error: it can contain a private root/id.
    const message = error instanceof Error && error.message.startsWith('Idle review watermark unavailable')
      ? error.message
      : "Idle review watermark unavailable. Automatic review is paused. Stop Hosts using this storage root, repair this session's state or lock under state/idle-review, then reopen the session."
    this.watermarkError = message
  }

  /** Policy/root changes invalidate an already queued checkpoint instead of catching up. */
  private reviewPolicy(): string | undefined {
    try { return JSON.stringify([this.config.idleReview.persistWatermark ? this.runtimeDirectory?.() : undefined, this.config.lifecycleEnabled, this.config.writeEnabled,
      this.config.storageScope, this.config.dataDir, this.config.writebackMode, this.config.idleReviewMs, this.config.idleReview, this.config.taskAgentModel, mainStrategyTypeId(this.config)]) } catch (error) {
      if (this.config.idleReview.persistWatermark) this.pauseWatermark(error)
      return undefined
    }
  }

  /** Which Strategy composed the turn, while its View is still pinned, and whether it declares idle review. */
  private recordComposedTurn(turn: number): void {
    if (this.memoryTurn === undefined) return
    const pinned = this.memoryTurn.current
    if (pinned?.turn === turn) {
      const strategy = viewStrategy(pinned.graph.memoryComposition.generation(pinned.context.view.runtimeGeneration), pinned.context.view)
      this.composedTurn = { turn, typeId: strategy.typeId, idleReview: strategyDrives(strategy, 'idle-review'), directory: pinned.graph.directory }
    } else if (this.composedTurn?.turn !== turn) this.composedTurn = undefined
  }

  /**
   * Idle review belongs to a Strategy that declares it, as the Layered
   * strategy does, not to every third-party View Strategy: the configured
   * one, and only after a turn it actually composed. A turn served by a
   * fallback Strategy, or run without memory, has nothing for it to maintain,
   * and a Strategy selected since has its own say. Explicit management
   * remains available.
   */
  private strategyDrivesIdleReview(): boolean {
    const typeId = mainStrategyTypeId(this.config)
    if (this.memoryTurn === undefined) return strategyDrives({ typeId }, 'idle-review')
    return this.composedTurn?.typeId === typeId && this.composedTurn.idleReview
  }

  private idleReviewAllowed(reserved = false): boolean {
    return !this.disposed && (!this.config.idleReview.persistWatermark || this.watermarkError === undefined)
      && this.config.lifecycleEnabled && this.config.writeEnabled && this.config.writebackMode === 'guided'
      && this.config.idleReview.enabled && (reserved || this.idleReviewAttempts < this.config.idleReview.maxPerSession)
      && idleReviewBlockReason(this.agent, this.config.idleReview.agentTeams) === undefined
      && this.strategyDrivesIdleReview()
      && this.coordinator.canReview(this.agent)
  }

  private async runIdleReview(): Promise<void> {
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
      // Cancellation after a commit still needs reconciliation. Never retry a
      // failed child here, even when a different provider is available.
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

  /** Cheap Host signals decide whether an eligible checkpoint is worth an LLM call. */
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
    const assistantTextLength = this.agent.session.snapshotEvents()
      .filter(event => {
        const turn = eventTurn(event)
        return turn !== undefined && turns.has(turn)
      })
      .map(assistantEventTextLength)
      .reduce((total, length) => total + length, 0)
    return explicitCandidate
      || totalUserTextLength >= REVIEW_SUBSTANTIVE_USER_CHARACTERS
      || assistantTextLength >= REVIEW_SUBSTANTIVE_ASSISTANT_CHARACTERS
      || completedNonMemoryTool
  }

  private reviewActivity(): ReviewActivityScore {
    const toolNames = new Set<string>()
    let totalUserTextLength = 0
    let toolCallCount = 0
    for (const activity of this.turnActivity.values()) {
      totalUserTextLength += activity.userTextLength
      toolCallCount += activity.toolCallCount
      for (const name of activity.toolNames) toolNames.add(name)
    }
    return scoreReviewActivity({
      totalUserTextLength,
      turnCount: this.turnActivity.size,
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

/** DSH 0.2.1's per-session working directory; earlier hosts have none. */
interface WorkingDirectoryService {
  set(agent: HostAgent, path: string, signal?: AbortSignal): Promise<string>
}

/** A picked route, optionally with the effort the caller chose for it. */
export type RoutedPick = { provider: string; model: string; reasoningEffort?: string }

/** Explicit model route carried by the task Agent a skill run created. */
export const TASK_ROUTE: unique symbol = Symbol.for('dsh-mnemon.taskRoute')

/**
 * The route a task Agent was created with, when its caller picked one. Skill
 * work started under that Agent hands the same pick to its own children, so a
 * run never falls back to the profile default halfway through.
 */
export function taskRoute(agent: HostAgent): RoutedPick | undefined {
  return (agent as unknown as Record<symbol, RoutedPick | undefined>)[TASK_ROUTE]
}

/** DSH-native owner for per-agent Mnemon lifecycle hooks and UI-triggered LLM work. */
export class MnemonLifecycle {
  private readonly owners = new Map<HostAgent, { lifecycle: MnemonAgentLifecycle; dispose: () => unknown }>()
  private readonly children = new Map<HostAgent, () => unknown>()
  private readonly memoryTurns = new Map<HostAgent, AgentMemoryTurn>()
  private readonly counters: LifecycleCounters = { primes: 0, recallCues: 0, writebackCues: 0, supervisedRequests: 0, failures: 0 }
  /** Creation ids reserved before DSH publishes clean task-root Agents. */
  private readonly taskAgentIds = new Set<string>()
  /** Bounded process-local replay fence for finalized-message write actions: the latest text per message. */
  private readonly supervisedWritebacks = new Map<string, { content: string; result: Promise<SupervisedWritebackResult> }>()
  private skillEvolution: SkillEvolution | undefined

  constructor(
    private readonly ctx: HostContextShape,
    private readonly coordinator: MnemonSubagentCoordinator,
    private readonly config: ResolvedConfig,
    private readonly runtimeSource?: AgentRuntimeSource,
  ) {}

  /** Skill evolution observes the same root conversations; set it before `start`. */
  useSkillEvolution(evolution: SkillEvolution): void {
    this.skillEvolution = evolution
  }

  get skills(): SkillEvolution | undefined {
    return this.skillEvolution
  }

  /** Model work for skill evolution under a fresh task Agent, outside any conversation. */
  runSkillTask<T>(workspaceRoot: string | undefined, signal: AbortSignal, operation: (agent: HostAgent) => Promise<T>, route?: RoutedPick): Promise<T> {
    return this.runTaskAgent('', workspaceRoot, signal, operation, route, 'Mnemon · Skills')
  }

  /**
   * What one conversation did with skills, for the bars under its turns. A
   * conversation reopened from history has no live Agent until it continues,
   * so its stored log answers instead, read through DSH without making it live.
   */
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
    // The Skills Source resolves through the conversation's own workspace, as it does for a live Agent.
    const stored = { id, session: { header: log.session } } as unknown as HostAgent
    return this.skillEvolution.activity(stored, log.events)
  }

  /** Review a live conversation's skills now, whatever its score. */
  reviewSkills(sessionId: string) {
    if (this.skillEvolution === undefined) throw new Error('skill evolution is unavailable')
    return this.skillEvolution.reviewNow(this.liveAgent(sessionId))
  }

  start(): () => void {
    // DSH creates a new Agent for startup, resume, clear and compaction alike.
    const stopChanged = this.runtimeSource?.onChanged?.(() => {
      for (const { lifecycle } of this.owners.values()) lifecycle.configurationChanged()
    })
    const stopCreated = this.ctx.on('agent/created', (({ agent, source }: SessionStartPayload) => { this.install(agent, source) }) as never)
    for (const agent of rootAgents(this.ctx.agents, this.ctx.subagents)) this.install(agent, 'adopted')
    return () => {
      stopChanged?.()
      stopCreated()
      for (const dispose of [...this.children.values()].reverse()) dispose()
      for (const owner of [...this.owners.values()].reverse()) owner.dispose()
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

  /**
   * Provider/model directory used by Settings. A session id is the conversation
   * the page was opened from: the catalog reports the route its own delegated
   * work takes, the route an inherited setting takes without following it, and
   * the effective route a task asked from it takes now.
   */
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
        // DSH 0.2.1-rc.3 loads the first-party directory over the network with
        // a default 5-second request budget. Leave room for that response while
        // preserving the existing bound for other Providers.
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

  /** Settled memory-tool activity for all turns, resolved per session. */
  turnActivities(sessionId: string): TurnMemoryActivitySnapshot {
    const agent = this.ctx.agents.get(sessionId.trim())
    const owner = agent === undefined ? undefined : this.owners.get(agent)?.lifecycle
    return owner === undefined ? { cursor: 0, activities: [] } : owner.turnMemoryActivities()
  }

  /** Plain text of one finalized assistant message, resolved per session; null while absent. */
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

  /** Synthesize a Web Agent Query without borrowing a conversation Agent or its history. */
  answerTask(sessionId: string, query: string, evidence: Insight[], workspaceRoot?: string, signal = new AbortController().signal) {
    const root = workspaceRoot?.trim() || this.workspaceRoot(sessionId)
    return this.runTaskAgent(sessionId, root, signal, agent => this.coordinator.answer(agent, query, evidence, signal), undefined, 'Mnemon · Ask Agent')
  }

  /** A write the user sent from the page: a space they picked that is switched off comes back on (#387). */
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

  /**
   * Read the merged memory and let a model propose what a human should review.
   * It writes nothing: every proposal waits in the ledger until it is accepted.
   */
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

  /**
   * The same Document write under a fresh task Agent, for a conversation whose
   * Agent is not loaded: it archives the least recently used Document to make
   * room, as the conversation's Agent would.
   */
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

  /** Choose a new Memory Space's Provider under a fresh task Agent, as Ask Agent does without a loaded conversation Agent. */
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

  /** Run a Web workbench distillation under a fresh top-level task Agent. */
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
    // One entry per message: sending its latest text again replays that result,
    // and a candidate edited after an earlier submission is a request of its own
    // that takes the message's place, so a receipt always answers the text last
    // sent (#342).
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

  /**
   * Run session-independent maintenance under a fresh top-level Agent. Its cwd
   * is the explicit Web workbench scope, so LiveMnemonRuntime resolves the same
   * workspace graph without borrowing conversation history or ownership.
   */
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
      // The Agent carries the route it was created with, so skill work it
      // delegates passes the same pick down instead of asking the resolver again.
      if (route !== undefined) {
        try { (handle.agent as unknown as Record<symbol, RoutedPick>)[TASK_ROUTE] = route } catch { /* a frozen Agent keeps the resolver's route */ }
      }
      return await operation(handle.agent)
    } catch (error) {
      failure = error
      throw error
    } finally {
      if (handle !== undefined) {
        try { await handle.dispose() } catch (error) { if (failure === undefined) throw error }
      }
      this.taskAgentIds.delete(sessionId)
    }
  }

  /**
   * Resolve the same model route and preset composition as an ordinary fresh DSH Agent.
   *
   * DSH persists a task Agent's session like any other. Its sidebar and ACP session
   * list leave out a session whose header has `origin: 'subagent'`, the origin DSH
   * gives its own subagents. Without it the sidebar hides a session that never started
   * a turn only while DSH's projection cache holds a record of it, so a finished task
   * could stay listed as an untitled Ungrouped conversation (#435). No `parentSession`
   * or `delegationDepth`: the task belongs to no conversation, and its children stay
   * one level deep. Activation-owned master requires an ordinary root instead;
   * its persistent task ID and title identify the visible record without enrolling
   * it in conversation automation. Official rc.1 retains the hidden metadata.
   */
  private async taskAgentCreation(
    fallbackSessionId: string,
    workspaceRoot: string | undefined,
    signal: AbortSignal,
    route?: RoutedPick,
  ): Promise<Pick<CreateHostAgentOptions, 'meta' | 'agentOptions' | 'setup'>> {
    const baseOptions = this.taskAgentModelOptions(fallbackSessionId, workspaceRoot)
    // A route the caller picked replaces the whole route, including its
    // reasoning effort: the inherited one belongs to another Provider and its
    // level names are not shared, so passing it on fails the run outright.
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

  /**
   * A task Agent runs outside any conversation, so its caller may hold no
   * workspace at all. DSH 0.2.0's Web persona renders `{{cwd}}`, and an Agent
   * created without one fails prompt assembly before its first step, so the
   * registry's first workspace stands in; a profile that mounts no registry
   * keeps the directory the Host was started in.
   *
   * The `cwd` is also the workspace whose memory Mnemon reads, so it stays
   * even when its folder is gone. DSH 0.2.1 checks the working directory
   * before every step and fails once it and the session's original directory
   * are gone, so the task then works from the first existing workspace, or the
   * Host's directory, as DSH's own subagents do; its children inherit both.
   */
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

  /** Resolve a complete task route for both status admission and actual creation. */
  private taskAgentModelRoute(fallbackSessionId: string, workspaceRoot: string | undefined): { options: NonNullable<CreateHostAgentOptions['agentOptions']>; source: 'fixed' | 'session' | 'dsh-default' | 'active-agent' } | undefined {
    const fallback = this.routeFallback(fallbackSessionId, workspaceRoot)
    const maxTokens = fallback?.options?.maxTokens === undefined ? {} : { maxTokens: fallback.options.maxTokens }
    if (this.config.taskAgentModel.mode === 'fixed') {
      const provider = this.config.taskAgentModel.provider?.trim()
      const model = this.config.taskAgentModel.model?.trim()
      if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
      return { source: 'fixed', options: { provider, model, ...maxTokens } }
    }
    // With the switch on, an inherited route takes the route of the conversation
    // the work belongs to, as that conversation's own delegated work does. Without
    // it, or while that conversation is closed, the route is the DSH new-session
    // default as before.
    const conversation = this.config.taskAgentModel.followConversation === true ? this.conversationRoute(fallbackSessionId) : undefined
    if (conversation !== undefined) return { source: 'session', options: { ...conversation, ...maxTokens } }
    const inherited = this.inheritedRoute(fallback)
    if (inherited === undefined) return undefined
    const { source, ...options } = inherited
    return { source, options: { ...options, ...maxTokens } }
  }

  /** The asking conversation's Agent, else an open one to borrow creation options from. */
  private routeFallback(sessionId: string, workspaceRoot: string | undefined): HostAgent | undefined {
    return this.ctx.agents.get(sessionId.trim()) ?? this.availableAgent(workspaceRoot) ?? this.availableAgent()
  }

  /**
   * The route an inherited setting takes without following a conversation: the
   * DSH new-session default, which DSH sets to the model last picked in any
   * conversation, else an open Agent's creation route when DSH keeps none.
   */
  private inheritedRoute(fallback: HostAgent | undefined): { provider: string; model: string; reasoningEffort?: string; source: 'dsh-default' | 'active-agent' } | undefined {
    let selected: ReturnType<HostDefaultModelService['currentSelection']> | undefined
    try { selected = modelService(this.ctx.get('agentDefaultModel'))?.currentSelection() } catch {}
    const selectedProvider = selected?.provider.trim()
    const selectedModel = selected?.model.trim()
    const provider = selectedProvider || fallback?.options?.provider?.trim()
    const model = selectedModel || fallback?.options?.model?.trim()
    if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
    const fromDefault = selectedProvider !== undefined && selectedProvider !== '' && selectedModel !== undefined && selectedModel !== ''
    // Effort belongs to its provider/model; never borrow it from another route.
    const matchesFallback = provider === fallback?.options?.provider?.trim() && model === fallback?.options?.model?.trim()
    const effort = fromDefault ? selected?.reasoningEffort : matchesFallback ? fallback?.options?.reasoningEffort : undefined
    return { provider, model, ...(typeof effort === 'string' && effort.trim() !== '' ? { reasoningEffort: effort } : {}), source: fromDefault ? 'dsh-default' : 'active-agent' }
  }

  /**
   * The route DSH gives a conversation's own delegated work, idle review
   * included: the provider, model and reasoning effort of its last request,
   * or the route it was created with before its first one. It exists only
   * while the conversation's Agent is loaded; another open conversation never
   * stands in for it.
   */
  private conversationRoute(sessionId: string): { provider: string; model: string; reasoningEffort?: string } | undefined {
    const normalized = sessionId.trim()
    if (normalized === '') return undefined
    const agent = this.ctx.agents.get(normalized)
    if (agent === undefined) return undefined
    const config = agent.session.requestHeader?.()?.config ?? agent.options
    const provider = config?.provider?.trim()
    const model = config?.model?.trim()
    // A half-filled route is no route at all, so both halves travel together.
    if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
    const effort = config?.reasoningEffort
    return { provider, model, ...(typeof effort === 'string' && effort !== '' ? { reasoningEffort: effort } : {}) }
  }

  private taskAgentModelOptions(fallbackSessionId: string, workspaceRoot: string | undefined): NonNullable<CreateHostAgentOptions['agentOptions']> | undefined {
    return this.taskAgentModelRoute(fallbackSessionId, workspaceRoot)?.options
  }

  private install(agent: HostAgent, source: LifecycleAgentSnapshot['startSource']): void {
    if (this.taskAgentIds.has(agent.id) || this.owners.has(agent) || this.children.has(agent)) return
    if ((isTaskRecord(agent.id) || this.coordinator.isFinishedTask(agent.id, agent)) && !isCreatingChild(this.ctx.agents, agent)) {
      // Only fresh user turns can continue a completed task; never register its
      // history with conversation automation or revive the old result callback.
      this.coordinator.continueTask(agent)
      return
    }
    if (agent.session.header?.origin === 'subagent') {
      this.installChild(agent)
      return
    }
    if (!isRootAgent(this.ctx.agents, this.ctx.subagents, agent)) return
    const memoryTurn = this.runtimeSource === undefined ? undefined : new AgentMemoryTurn(agent, this.runtimeSource)
    const lifecycle = new MnemonAgentLifecycle(agent, this.coordinator, this.config, this.counters, source, memoryTurn, () => this.runtimeSource?.forAgent(agent).directory)
    let dispose: () => unknown
    dispose = agent.ctx.effect(() => {
      const stop = lifecycle.start()
      const stopSkills = this.skillEvolution?.watch(agent)
      return () => {
        try {
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

  /** Child memory ownership is independent of root-only reminders and idle review. */
  private installChild(agent: HostAgent): void {
    const runtime = this.runtimeSource
    const parentId = agent.session.header?.parentSession?.trim()
    const parent = parentId === undefined || parentId === '' ? undefined : this.ctx.agents.get(parentId)
    // A lineage string alone is not authority. Orphans get no model Recall pin.
    if (runtime === undefined || parent === undefined || parent === agent) return
    this.coordinator.inheritTaskContinuation(parent, agent)
    const parentMemory = this.memoryTurns.get(parent)
    let delegation: DelegatedMemoryView
    if (parentMemory !== undefined) {
      delegation = parentMemory.delegate()
    } else {
      const graph = runtime.forAgent(parent)
      const parentPin = graph.composableTurns.activeTurn(parent.id)
      delegation = {
        graph,
        scope: parentPin?.scope ?? agentScope(parent, graph.config),
        ...(parentPin === undefined ? {} : { viewId: parentPin.view.id }),
      }
    }
    let dispose: () => unknown
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
          const recovering = memory.current?.turn !== payload.turn
          await memory.begin(payload.turn, payload.signal)
          // A recovered child pin needs the same actionable ids as its View;
          // keep ordinary delegated context unchanged when assembly ran.
          const pinned = memory.current
          if (recovering && payload.step === 1 && this.config.lifecycleEnabled && pinned !== undefined) {
            const wake = modelMemoryWake(pinned.graph, pinned.context)
            if (wake.text.trim() !== '') return { kind: 'enter', messages: [...decision.messages, createPluginMessage(wake.text, 'recall')] }
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
  }
}
