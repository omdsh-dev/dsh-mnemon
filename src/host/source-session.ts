import { isDefaultSourceInstance } from './protocol.ts'
import type { MemoryActionOffer, MemoryEvidence, MemoryJsonValue, MemoryMutationReceipt, MemoryOperationScope, MemorySourceManagementRequest } from '../core/contracts/index.ts'
import type { MemoryGenerationHost } from '../core/index.ts'
import type { ComposableMemoryTurn, ComposableMemoryTurnManager } from '../core/turns.ts'

/** Host-side caller of a Source's JSON protocol, never its implementation. */
export class SourceSession {
  constructor(
    private readonly generations: MemoryGenerationHost,
    private readonly turns: ComposableMemoryTurnManager,
    readonly typeId: string,
    readonly scope: MemoryOperationScope,
  ) {}

  read<T>(operation: string, input: unknown = null, signal?: AbortSignal): Promise<T> {
    return this.execute<T>('read', operation, input, signal)
  }
  mutate<T>(operation: string, input: unknown, signal?: AbortSignal): Promise<T> {
    return this.execute<T>('mutate', operation, input, signal)
  }

  /** Model tools always use the offered Route, never the management channel. */
  async route(routeId: string, input: unknown, signal?: AbortSignal): Promise<MemoryEvidence> {
    const turn = this.requireTurn()
    const source = await this.selected(turn)
    const route = turn.view.routes.find(item => item.sourceInstanceKey === source.sourceInstanceKey && item.sourceRouteId === routeId)
    if (route === undefined) throw new Error('Source Route is not offered by the current View: ' + this.typeId + '/' + routeId)
    return this.turns.executeRoute(turn.turnId, route.id, json(input), signal)
  }
  async action(actionId: string, input: unknown, authorize: (offer: MemoryActionOffer) => boolean, signal?: AbortSignal): Promise<MemoryMutationReceipt> {
    const turn = this.requireTurn()
    const source = await this.selected(turn)
    const offer = turn.view.actionOffers.find(item => item.sourceInstanceKey === source.sourceInstanceKey && item.sourceActionId === actionId)
    if (offer === undefined) throw new Error('Source Action is not offered by the current View: ' + this.typeId + '/' + actionId)
    return this.turns.executeAction(turn.turnId, offer.id, json(input), authorize, signal)
  }
  private activeTurn(): ComposableMemoryTurn | undefined {
    return this.scope.agentId === undefined ? undefined : this.turns.activeTurn(this.scope.agentId)
  }
  private requireTurn(): ComposableMemoryTurn {
    const turn = this.activeTurn()
    if (turn === undefined) throw new Error('Memory operation requires the View pinned to the current turn')
    return turn
  }
  private async selected(turn?: ComposableMemoryTurn) {
    const lease = this.generations.acquire(turn?.view.runtimeGeneration)
    try { return await this.select(lease.generation) } finally { lease.release() }
  }
  private async select(generation: import('../core/composition.ts').MemoryCompositionGeneration) {
    const catalog = await generation.managementCatalog(this.scope)
    const candidates = catalog.sources.filter(source => source.sourceTypeId === this.typeId)
    const source = candidates.find(source => isDefaultSourceInstance(source.sourceInstanceKey, this.typeId))
      ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (source === undefined) throw new Error('Source ' + this.typeId + ' is ' + (candidates.length === 0 ? 'not installed' : 'ambiguous; select an explicit instance'))
    return source
  }
  private async execute<T>(mode: MemorySourceManagementRequest['mode'], operation: string, input: unknown, signal?: AbortSignal): Promise<T> {
    const lease = this.generations.acquire(this.activeTurn()?.view.runtimeGeneration)
    try {
      const source = await this.select(lease.generation)
      const result = await lease.generation.executeManagement({
        sourceInstanceKey: source.sourceInstanceKey, scope: this.scope, mode, operation, input: json(input),
        confirmed: mode === 'mutate',
        ...(mode === 'mutate' ? { expectedRevision: source.revision } : {}),
        ...(signal === undefined ? {} : { signal }),
      })
      return result.value as T
    } finally { lease.release() }
  }
}

function json(input: unknown): MemoryJsonValue {
  return JSON.parse(JSON.stringify(input)) as MemoryJsonValue
}

/** Error codes are part of the Source protocol; its private Error classes are not. */
export function sourceFailure<T extends { code: string }>(value: unknown, code: T['code']): value is Error & T {
  return value instanceof Error && 'code' in value && value.code === code
}
