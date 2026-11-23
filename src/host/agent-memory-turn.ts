import { resolve } from 'node:path'
import { DEFAULT_MEMORY_VIEW_BUDGET, type MemoryOperationScope } from '../core/contracts/index.ts'
import { isMemoryCompositionUnavailable } from '../core/generation.ts'
import type { ComposableMemoryTurn } from '../core/turns.ts'
import type { HostAgent, HostSession } from './dsh.ts'
import { bm25View } from './bm25-recall.ts'
import { memorySnapshotState } from './memory-snapshot-state.ts'
import type { SnapshotAuthority } from './snapshot-compaction.ts'
import { findSessionEvent, sessionEvents, sessionLength } from './session-events.ts'
import { agentScope, type MnemonAgentRuntimeSource, type MnemonRuntimeGraph } from './runtime.ts'
import { inspectMemoryView, modelMemoryWake } from './view-presentation.ts'
import type { MemoryViewInspection } from './view-protocol.ts'

export interface DelegatedMemoryView {
  readonly graph: MnemonRuntimeGraph
  readonly scope: MemoryOperationScope
  readonly viewId?: string
}

export interface PinnedAgentMemoryTurn {
  readonly turn: number
  readonly graph: MnemonRuntimeGraph
  readonly context: ComposableMemoryTurn
  release(): void
}

interface SessionPosition {
  offset: number
  lastSeq: number | undefined
  turn: number | undefined
  step: { turn: number; step: number } | undefined
}
const positions = new WeakMap<HostSession, SessionPosition>()

function sessionPosition(session: HostSession): SessionPosition {
  const end = sessionLength(session)
  let position = positions.get(session)
  if (position === undefined || end < position.offset || (position.offset > 0 && session.eventAt(position.offset - 1)?.seq !== position.lastSeq)) {
    const boundary = findSessionEvent(session, event => event.type === 'turn/start' || event.type === 'turn/end')
    position = { offset: boundary?.seq ?? end, lastSeq: boundary === undefined && end > 0 ? session.eventAt(end - 1)?.seq : undefined, turn: undefined, step: undefined }
    positions.set(session, position)
  }
  for (const event of sessionEvents(session, position.offset, end)) {
    if (event.type === 'turn/start') {
      position.turn = typeof event.data.turn === 'number' ? event.data.turn : undefined
      position.step = undefined
    } else if (event.type === 'turn/end' && event.data.turn === position.turn) {
      position.turn = undefined; position.step = undefined
    } else if (event.type === 'step/start' && position.turn !== undefined && event.data.turn === position.turn && typeof event.data.step === 'number') {
      position.step = { turn: position.turn, step: event.data.step }
    } else if (event.type === 'step/end' && position.step?.turn === event.data.turn && position.step?.step === event.data.step) {
      position.step = undefined
    }
    position.offset++
    position.lastSeq = event.seq
  }
  return position
}

export function openAgentTurn(agent: HostAgent): number | undefined {
  return sessionPosition(agent.session).turn
}

export function openAgentStep(agent: HostAgent): { turn: number; step: number } | undefined {
  const step = sessionPosition(agent.session).step
  return step === undefined ? undefined : { ...step }
}

export class AgentMemoryTurn {
  private pinned: PinnedAgentMemoryTurn | undefined
  private unavailable: { turn: number; reason: string } | undefined
  private warned: string | undefined
  private pending: { turn: number; generation: number; controller: AbortController; result: Promise<void> } | undefined
  private generation = 0
  private closed = false
  private lastInspection: MemoryViewInspection | undefined
  private lastWorkspace: string | undefined
  private readonly releaseDelegation: (() => void) | undefined
  private readonly includeRuntime: boolean

  constructor(
    private readonly agent: HostAgent,
    private readonly runtime: Pick<MnemonAgentRuntimeSource, 'config' | 'forAgent' | 'executions' | 'memoryParticipation'>,
    private readonly delegation?: DelegatedMemoryView,
    private readonly independent = false,
  ) {
    this.includeRuntime = delegation === undefined || runtime.config.runtimeMemory.inheritToSubagents
    if (delegation === undefined) return
    this.releaseDelegation = runtime.executions.retain(agent, delegation)
  }

  get current(): PinnedAgentMemoryTurn | undefined {
    return this.pinned
  }

  modelWake() {
    const pinned = this.pinned
    return pinned === undefined ? undefined : modelMemoryWake(pinned.graph, pinned.context, this.includeRuntime, this.agent)
  }

  get unavailableReason(): string | undefined {
    return this.unavailable?.reason
  }

  inspect(workspaceRoot?: string): MemoryViewInspection | undefined {
    if (this.lastInspection === undefined) return undefined
    if (workspaceRoot !== undefined && resolve(workspaceRoot) !== this.lastWorkspace) return undefined
    return structuredClone({ ...this.lastInspection, state: this.pinned === undefined ? 'recent' : 'active' })
  }

  clearInspection(): void { this.lastInspection = undefined; this.lastWorkspace = undefined }

  delegate(): DelegatedMemoryView {
    if (this.closed) throw new Error('memory Agent lifetime has ended')
    if (this.pinned !== undefined) {
      return { graph: this.pinned.graph, scope: this.pinned.context.scope, viewId: this.pinned.context.view.id }
    }
    if (this.delegation !== undefined) return this.delegation
    const graph = this.runtime.forAgent(this.agent)
    return { graph, scope: agentScope(this.agent, graph.config) }
  }

  get excluded(): boolean { return this.runtime.memoryParticipation?.(this.agent).excluded === true }

  async snapshotAuthority(signal?: AbortSignal): Promise<SnapshotAuthority | undefined> {
    if (this.closed || this.excluded || !this.runtime.config.lifecycleEnabled) return undefined
    try {
      const graph = this.runtime.forAgent(this.agent, { independent: true })
      const lease = graph.memoryComposition.acquire()
      try {
        const view = await lease.generation.compose({
          scope: agentScope(this.agent, graph.config), scenario: 'agent.root-turn', budget: { ...DEFAULT_MEMORY_VIEW_BUDGET },
        }, signal)
        if (this.closed || this.excluded || !this.runtime.config.lifecycleEnabled
          || this.runtime.forAgent(this.agent, { independent: true }) !== graph
          || graph.memoryComposition.current() !== lease.generation) return undefined
        const recall = (this.runtime.config.runtimeMemory.bm25Recall || this.runtime.config.runtimeMemory.indexPush) ? bm25View(view) : undefined
        return { state: memorySnapshotState(recall?.view ?? view, this.runtime.config.runtimeMemory.snapshotRefresh), recall }
      } finally { lease.release() }
    } catch {
      signal?.throwIfAborted()
      return undefined
    }
  }

  async begin(turn: number, signal?: AbortSignal): Promise<void> {
    if (this.excluded) { this.end(); return }
    if (this.closed) throw new Error('memory Agent lifetime has ended')
    signal?.throwIfAborted()
    if (this.pinned?.turn === turn || this.unavailable?.turn === turn) return
    if (this.pending?.turn === turn) return this.pending.result
    this.end()
    const generation = this.generation
    const controller = new AbortController()
    const abort = () => controller.abort(signal!.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const result = this.pin(turn, generation, controller.signal).catch((error: unknown) => {
      if (this.excluded) { this.clearInspection(); return }
      if (!isMemoryCompositionUnavailable(error) || this.closed || this.generation !== generation) throw error
      this.unavailable = { turn, reason: error.message }
      this.clearInspection()
      if (this.warned !== error.message) console.warn(`[dsh-mnemon] this turn runs without memory: ${error.message}`)
      this.warned = error.message
    })
    this.pending = { turn, generation, controller, result }
    try {
      await result
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.pending?.generation === generation) this.pending = undefined
    }
  }

  end(turn?: number): void {
    if (turn !== undefined && this.pinned?.turn !== turn && this.pending?.turn !== turn && this.unavailable?.turn !== turn) return
    this.generation += 1
    this.unavailable = undefined
    this.pending?.controller.abort(new Error('memory turn ended during View preparation'))
    this.pending = undefined
    const pinned = this.pinned
    this.pinned = undefined
    pinned?.release()
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.clearInspection()
    try { this.end() } finally { this.releaseDelegation?.() }
  }

  private async pin(turn: number, generation: number, signal: AbortSignal): Promise<void> {
    const execution = await this.runtime.executions.turn(this.agent, turn, signal, this.delegation, this.independent)
    const { graph, context } = execution
    try {
      if (this.closed || this.generation !== generation) throw new Error('memory turn ended during View preparation')
      signal?.throwIfAborted()
      const inspection = inspectMemoryView(graph.memoryComposition.generation(context.view.runtimeGeneration)!, context.view, 'active', turn, modelMemoryWake(graph, context, this.includeRuntime, this.agent).text)
      this.pinned = { turn, graph, context, release: execution.release }
      this.warned = undefined
      this.lastInspection = inspection
      this.lastWorkspace = context.scope.workspaceId === undefined ? undefined : resolve(context.scope.workspaceId)
    } catch (error) {
      execution.release()
      throw error
    }
  }
}
