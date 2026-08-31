import type { ComposableMemoryTurn, MemoryWakeBindings } from '../core/turns.ts'
import type { MnemonRuntimeGraph } from './runtime.ts'
import { isDefaultSourceInstance } from './protocol.ts'

/** These are existing DSH product-tool bindings, not Core operation names. */
const ROUTE_TOOLS: Record<string, Record<string, string>> = {
  documents: { search: 'mnemon_document_search' },
  'memory-spaces': { inspect: 'mnemon_memory_bodies / mnemon_status', recall: 'mnemon_recall', related: 'mnemon_related' },
}
const ACTION_TOOLS: Record<string, Record<string, string>> = {
  runtime: { mutate: 'mnemon_runtime_memory' },
  documents: { manage: 'mnemon_document_manage' },
  'memory-spaces': { remember: 'mnemon_remember', link: 'mnemon_link', forget: 'mnemon_forget',
    'manage-spaces': 'mnemon_memory_body_create / mnemon_memory_body_update / mnemon_memory_body_merge' },
}

/** Use a short availability list only where the Host has the matching named binding.
 * Unbound external operations retain exact ids and schemas in the generic envelope. */
export function modelMemoryWake(graph: MnemonRuntimeGraph, turn: ComposableMemoryTurn) {
  const generation = graph.memoryComposition.generation(turn.view.runtimeGeneration)
  if (generation === undefined) throw new Error('Cannot present an unpinned Memory generation')
  const instances = generation.sourceInstances()
  const routes: Record<string, string> = {}, actions: Record<string, string> = {}
  for (const typeId of Object.keys(ACTION_TOOLS)) {
    const candidates = instances.filter(source => source.sourceTypeId === typeId)
    const selected = candidates.find(source => isDefaultSourceInstance(source.sourceInstanceKey, typeId)) ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (selected === undefined) continue
    for (const route of turn.view.routes.filter(route => route.sourceInstanceKey === selected.sourceInstanceKey)) {
      const grant = turn.view.readGrants.find(grant => grant.id === route.readGrantId)
      if (grant?.schema !== `dsh-mnemon.${typeId}/v1`) continue
      const tool = ROUTE_TOOLS[typeId]?.[route.sourceRouteId]
      if (tool !== undefined) routes[route.id] = tool
    }
    for (const action of turn.view.actionOffers.filter(action => action.sourceInstanceKey === selected.sourceInstanceKey)) {
      const tool = ACTION_TOOLS[typeId]?.[action.sourceActionId]
      if (tool !== undefined) actions[action.id] = tool
    }
  }
  return graph.composableTurns.memoryWake(turn.view.id, { routes, actions } satisfies MemoryWakeBindings)
}
