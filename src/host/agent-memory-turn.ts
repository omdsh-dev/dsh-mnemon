import { resolve } from 'node:path'
import type { MemoryOperationScope } from '../core/contracts/index.ts'
import type { ComposableMemoryTurn, ComposableMemoryTurnManager } from '../core/turns.ts'
import type { HostAgent } from './dsh.ts'
import type { MnemonAgentRuntimeSource, MnemonRuntimeGraph } from './runtime.ts'
import { inspectMemoryView, modelMemoryWake } from './view-presentation.ts'
import type { MemoryViewInspection } from './view-protocol.ts'

/** Host-owned authority captured before a child activation starts executing. */
export interface DelegatedMemoryView {
  readonly graph: MnemonRuntimeGraph
  readonly scope: MemoryOperationScope
  readonly viewId?: string
}

export interface PinnedAgentMemoryTurn {
  readonly turn: number
  readonly graph: MnemonRuntimeGraph
  readonly manager: ComposableMemoryTurnManager
  readonly context: ComposableMemoryTurn
  readonly releaseRuntime?: () => void
}

export function agentMemoryScope(agent: HostAgent, graph: MnemonRuntimeGraph): MemoryOperationScope {
  const cwd = agent.session.header?.cwd?.trim()
  return {
    storage: graph.config.storageScope,
    ...(cwd === undefined || cwd === '' ? {} : { workspaceId: resolve(cwd) }),
    sessionId: agent.id,
    agentId: agent.id,
  }
}

/** The durable log, not a parent session id, identifies the executing turn. */
export function openAgentTurn(agent: HostAgent): number | undefined {
  let open: number | undefined
  for (const event of hostSessionEvents(agent.session)) {
    const turn = typeof event.data.turn === 'number' ? event.data.turn : undefined
    if (event.type === 'turn/start' && turn !== undefined) open = turn
    else if (event.type === 'turn/end' && turn === open) open = undefined
  }
  return open
}

/**
 * One Agent owns each turn pin. A child additionally retains its delegation
 * across parent completion, collection, and runtime swaps until it is disposed.
 */
export class AgentMemoryTurn {
  private pinned: PinnedAgentMemoryTurn | undefined
  private pending: { turn: number; generation: number; controller: AbortController; result: Promise<void> } | undefined
  private generation = 0
  private closed = false
  private lastInspection: MemoryViewInspection | undefined
  private lastWorkspace: string | undefined
  private readonly releaseDelegation: (() => void) | undefined

  constructor(
    private readonly agent: HostAgent,
    private readonly runtime: Pick<MnemonAgentRuntimeSource, 'forAgent' | 'bindAgentRuntime'>,
    private readonly delegation?: DelegatedMemoryView,
  ) {
    if (delegation === undefined) return
    const releaseView = delegation.viewId === undefined ? undefined : delegation.graph.composableTurns.retainView(delegation.viewId)
    try {
      const releaseRuntime = runtime.bindAgentRuntime(agent.id, delegation.graph)
      this.releaseDelegation = () => {
        try { releaseView?.() } finally { releaseRuntime() }
      }
    } catch (error) {
      releaseView?.()
      throw error
    }
  }

  get current(): PinnedAgentMemoryTurn | undefined {
    return this.pinned
  }

  inspect(workspaceRoot?: string): MemoryViewInspection | undefined {
    if (this.lastInspection === undefined) return undefined
    if (workspaceRoot !== undefined && resolve(workspaceRoot) !== this.lastWorkspace) return undefined
    return structuredClone({ ...this.lastInspection, state: this.pinned === undefined ? 'recent' : 'active' })
  }

  clearInspection(): void { this.lastInspection = undefined; this.lastWorkspace = undefined }

  /** Capture now; descendants must not resolve a later parent turn on demand. */
  delegate(): DelegatedMemoryView {
    if (this.closed) throw new Error('memory Agent lifetime has ended')
    if (this.pinned !== undefined) {
      return { graph: this.pinned.graph, scope: this.pinned.context.scope, viewId: this.pinned.context.view.id }
    }
    if (this.delegation !== undefined) return this.delegation
    const graph = this.runtime.forAgent(this.agent)
    // Explicit Host background operations have no model turn to inherit. Their
    // child creates a fresh scoped View, never a historical owner-latest View.
    return { graph, scope: agentMemoryScope(this.agent, graph) }
  }

  async begin(turn: number, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('memory Agent lifetime has ended')
    signal?.throwIfAborted()
    if (this.pinned?.turn === turn) return
    if (this.pending?.turn === turn) return this.pending.result
    this.end()
    const generation = this.generation
    const controller = new AbortController()
    const abort = () => controller.abort(signal!.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const result = this.pin(turn, generation, controller.signal)
    this.pending = { turn, generation, controller, result }
    try {
      await result
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.pending?.generation === generation) this.pending = undefined
    }
  }

  end(turn?: number): void {
    if (turn !== undefined && this.pinned?.turn !== turn && this.pending?.turn !== turn) return
    this.generation += 1
    this.pending?.controller.abort(new Error('memory turn ended during View preparation'))
    this.pending = undefined
    const pinned = this.pinned
    this.pinned = undefined
    if (pinned === undefined) return
    try {
      if (pinned.manager.turn(pinned.context.turnId) === pinned.context) pinned.manager.endTurn(pinned.context.turnId)
    } finally {
      pinned.releaseRuntime?.()
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.clearInspection()
    try { this.end() } finally { this.releaseDelegation?.() }
  }

  private async pin(turn: number, generation: number, signal?: AbortSignal): Promise<void> {
    const graph = this.delegation?.graph ?? this.runtime.forAgent(this.agent)
    const manager = graph.composableTurns
    const scope = this.delegation === undefined
      ? agentMemoryScope(this.agent, graph)
      : { ...this.delegation.scope, sessionId: this.agent.id, agentId: this.agent.id }
    const turnId = `${this.agent.id}:${turn}`
    const context = this.delegation?.viewId === undefined
      ? await manager.beginTurn(turnId, scope, 'agent.root-turn', signal)
      : manager.pinTurn(turnId, scope, this.delegation.viewId)
    let releaseRuntime: (() => void) | undefined
    try {
      if (this.closed || this.generation !== generation) throw new Error('memory turn ended during View preparation')
      signal?.throwIfAborted()
      if (this.delegation === undefined) releaseRuntime = this.runtime.bindAgentRuntime(this.agent.id, graph)
      const inspection = inspectMemoryView(graph.memoryComposition.generation(context.view.runtimeGeneration)!, context.view, 'active', turn, modelMemoryWake(graph, context).text)
      this.pinned = { turn, graph, manager, context, ...(releaseRuntime === undefined ? {} : { releaseRuntime }) }
      this.lastInspection = inspection
      this.lastWorkspace = context.scope.workspaceId === undefined ? undefined : resolve(context.scope.workspaceId)
    } catch (error) {
      if (manager.turn(context.turnId) === context) manager.endTurn(context.turnId)
      releaseRuntime?.()
      throw error
    }
  }
}
