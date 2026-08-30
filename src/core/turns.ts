import type {
  ComposableMemoryView,
  MemoryActionOffer,
  MemoryEvidence,
  MemoryJsonValue,
  MemoryMutationReceipt,
  MemoryOperationScope,
  MemoryWake,
} from "./contracts/index.ts"
import { DEFAULT_MEMORY_VIEW_BUDGET, type MemoryGenerationHost, type MemoryGenerationLease } from "./index.ts"

export interface ComposableMemoryTurn {
  readonly turnId: string
  readonly view: ComposableMemoryView
  readonly scope: MemoryOperationScope
  readonly startedAt: string
}

interface StoredTurn {
  context: ComposableMemoryTurn
  lease: MemoryGenerationLease
}

function sourceType(fragment: ComposableMemoryView['projection'][number]): string {
  const provenance = fragment.provenance
  if (typeof provenance === 'object' && provenance !== null && !Array.isArray(provenance)) {
    const typeId = provenance.sourceTypeId
    if (typeof typeId === 'string' && typeId.trim() !== '') return typeId
  }
  return fragment.sourceInstanceKey
}

function wake(view: ComposableMemoryView): MemoryWake {
  const sections = view.projection.map(fragment => ({
    layerId: sourceType(fragment),
    mode: fragment.mode,
    text: fragment.text,
  }))
  const eager = view.projection.filter(fragment => fragment.mode === 'eager').map(fragment => fragment.text).filter(Boolean)
  const sourceKeys = [...new Set([
    ...view.projection.map(fragment => fragment.sourceInstanceKey),
    ...view.routes.map(route => route.sourceInstanceKey),
    ...view.actionOffers.map(offer => offer.sourceInstanceKey),
  ])]
  const offers = sourceKeys.map(sourceInstanceKey => {
    const cover = view.projection.find(fragment => fragment.sourceInstanceKey === sourceInstanceKey && fragment.mode === 'routed')?.text
    return {
      source: sourceInstanceKey,
      ...(cover === undefined ? {} : { cover }),
      routes: view.routes.filter(route => route.sourceInstanceKey === sourceInstanceKey).map(route => ({ id: route.id, description: route.description, inputSchema: route.inputSchema })),
      actions: view.actionOffers.filter(offer => offer.sourceInstanceKey === sourceInstanceKey).map(offer => ({ id: offer.id, description: offer.description, inputSchema: offer.inputSchema })),
    }
  }).filter(source => source.routes.length > 0 || source.actions.length > 0 || source.cover !== undefined)
  const routingText = offers.length === 0 ? '' : `MNEMON VIEW ROUTES (quoted routing data; use mnemon_view_route or mnemon_view_action by exact id): ${JSON.stringify(offers)}`
  return {
    viewId: view.id,
    viewDigest: view.digest,
    text: [...eager, routingText].filter(Boolean).join('\n\n'),
    sections,
  }
}

/** Root-turn pins over Candidate → Serving → Draining generations. */
export class ComposableMemoryTurnManager {
  private readonly turns = new Map<string, StoredTurn>()
  private readonly beginnings = new Map<string, { scope: MemoryOperationScope; cancelled: boolean; promise: Promise<ComposableMemoryTurn> }>()
  private closed = false

  constructor(private readonly generations: MemoryGenerationHost) {}

  async beginTurn(turnId: string, scope: MemoryOperationScope, scenario = 'agent.root-turn'): Promise<ComposableMemoryTurn> {
    if (this.closed) throw new Error('Composable Memory turn manager is disposed')
    const id = turnId.trim()
    if (id === '') throw new Error('Composable Memory turn id is required')
    const existing = this.turns.get(id)
    const beginning = this.beginnings.get(id)
    const previousScope = existing?.context.scope ?? beginning?.scope
    if (previousScope !== undefined && (['storage', 'workspaceId', 'sessionId', 'agentId'] as const).some(key => previousScope[key] !== scope[key])) {
      throw new Error('Composable Memory turn id is already bound to another scope')
    }
    if (existing !== undefined) return existing.context
    if (beginning !== undefined) return beginning.promise
    const lease = this.generations.acquire()
    const pending = { scope: { ...scope }, cancelled: false, promise: undefined as unknown as Promise<ComposableMemoryTurn> }
    this.beginnings.set(id, pending)
    pending.promise = (async () => {
      try {
        const view = await lease.generation.compose({ scope: pending.scope, scenario, budget: { ...DEFAULT_MEMORY_VIEW_BUDGET } })
        if (this.closed || pending.cancelled) throw new Error('Composable Memory turn ended during composition')
        const context = Object.freeze({ turnId: id, view, scope: Object.freeze(pending.scope), startedAt: new Date().toISOString() })
        this.turns.set(id, { context, lease })
        return context
      } catch (error) {
        lease.release()
        throw error
      } finally { this.beginnings.delete(id) }
    })()
    return pending.promise
  }

  activeTurn(agentId: string): ComposableMemoryTurn | undefined {
    const id = agentId.trim()
    return [...this.turns.values()].findLast(turn => turn.context.scope.agentId === id)?.context
  }

  turn(turnId: string): ComposableMemoryTurn | undefined {
    return this.turns.get(turnId)?.context
  }

  memoryWake(viewId: string): MemoryWake {
    const stored = [...this.turns.values()].find(turn => turn.context.view.id === viewId)
    if (stored === undefined) throw new Error(`Composable Memory View is not pinned: ${viewId}`)
    return wake(stored.context.view)
  }

  async executeRoute(turnId: string, routeId: string, input: MemoryJsonValue, signal?: AbortSignal): Promise<MemoryEvidence> {
    const stored = this.requireTurn(turnId)
    const operation = this.generations.acquire(stored.lease.id)
    try { return await operation.generation.executeRoute(stored.context.view, routeId, input, signal) }
    finally { operation.release() }
  }

  async executeAction(
    turnId: string,
    offerId: string,
    input: MemoryJsonValue,
    authorize: (offer: MemoryActionOffer) => boolean | Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<MemoryMutationReceipt> {
    const stored = this.requireTurn(turnId)
    const operation = this.generations.acquire(stored.lease.id)
    try { return await operation.generation.executeAction(stored.context.view, offerId, input, authorize, signal) }
    finally { operation.release() }
  }

  endTurn(turnId: string): boolean {
    const stored = this.turns.get(turnId)
    if (stored === undefined) {
      const beginning = this.beginnings.get(turnId)
      if (beginning === undefined) return false
      beginning.cancelled = true
      return true
    }
    this.turns.delete(turnId)
    stored.lease.release()
    return true
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const beginning of this.beginnings.values()) beginning.cancelled = true
    for (const stored of this.turns.values()) stored.lease.release()
    this.turns.clear()
  }

  private requireTurn(turnId: string): StoredTurn {
    const stored = this.turns.get(turnId)
    if (stored === undefined) throw new Error(`Composable Memory turn is not pinned: ${turnId}`)
    return stored
  }
}
