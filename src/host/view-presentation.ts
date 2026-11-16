import { createMemoryWake, type ComposableMemoryTurn, type MemoryWakeBindings } from '../core/turns.ts'
import type { MemoryCompositionGeneration } from '../core/composition.ts'
import type { ComposableMemoryView } from '../core/contracts/index.ts'
import type { MemoryViewInspection } from './view-protocol.ts'
import type { HostAgent } from './dsh.ts'
import type { MnemonRuntimeGraph } from './runtime.ts'
import { memoryTools, namedToolInstance } from './protocol.ts'

/**
 * The named tools bound to each Source type's Routes or Actions, from the tool table: these are
 * existing DSH product-tool bindings, not Core operation names. Tools that share one operation are
 * listed together, in table order, as the View's tool list names them.
 */
function namedBindings(kind: 'route' | 'action', available?: ReadonlySet<string>): Record<string, Record<string, string>> {
  const bindings: Record<string, Record<string, string>> = {}
  for (const [name, tool] of memoryTools()) {
    if (available !== undefined && !available.has(name)) continue
    if (tool.sourceTypeId === undefined || tool.operation === undefined || (tool.kind === 'write') !== (kind === 'action')) continue
    const operations = bindings[tool.sourceTypeId] ??= {}
    const listed = operations[tool.operation]
    operations[tool.operation] = listed === undefined ? name : `${listed} / ${name}`
  }
  return bindings
}
const ROUTE_TOOLS = namedBindings('route')
const ACTION_TOOLS = namedBindings('action')
const NAMED_SOURCE_TYPES = [...new Set([...Object.keys(ROUTE_TOOLS), ...Object.keys(ACTION_TOOLS)])]

function availableMemoryTools(agent?: HostAgent): ReadonlySet<string> | undefined {
  // This public lookup applies the exact Agent's restrictions in native and PTC
  // modes. Model-level schemas in PTC only expose run_code, not its callable SDK.
  const tools = agent?.ctx?.tools
  return typeof tools?.get !== 'function' ? undefined
    : new Set(memoryTools().filter(([name]) => tools.get!(name, agent) !== undefined).map(([name]) => name))
}

/** Use a short availability list only where the Host has the matching named binding.
 * Unbound external operations retain exact ids and schemas in the generic envelope. */
export function modelMemoryWake(graph: MnemonRuntimeGraph, turn: ComposableMemoryTurn, includeRuntime = true, agent?: HostAgent) {
  const generation = graph.memoryComposition.generation(turn.view.runtimeGeneration)
  if (generation === undefined) throw new Error('Cannot present an unpinned Memory generation')
  const available = availableMemoryTools(agent)
  const bindings = memoryWakeBindings(generation, turn.view, available)
  if (includeRuntime && available === undefined) return graph.composableTurns.memoryWake(turn.view.id, bindings)
  let view = turn.view
  if (!includeRuntime) {
    const runtimeSources = new Set(generation.sourceInstances().filter(source => source.sourceTypeId === 'runtime').map(source => source.sourceInstanceKey))
    view = { ...view, projection: view.projection.filter(fragment => !runtimeSources.has(fragment.sourceInstanceKey)) }
  }
  if (available !== undefined) {
    // Only the presentation changes. The pinned View, grants, receipts and
    // captured content retain their original authority and identity.
    view = {
      ...view,
      routes: view.routes.filter(route => bindings.routes?.[route.id] !== undefined || available.has('mnemon_view_route')),
      actionOffers: view.actionOffers.filter(action => bindings.actions?.[action.id] !== undefined || available.has('mnemon_view_action')),
    }
  }
  return createMemoryWake(view, bindings)
}

export function presentMemoryWake(generation: MemoryCompositionGeneration, view: ComposableMemoryView) {
  return createMemoryWake(view, memoryWakeBindings(generation, view))
}

/**
 * Why a generic View tool names no id this turn's View offers, told apart (#390); undefined when
 * the id is offered. It names only what the MNEMON VIEW ROUTES envelope shows: an operation bound
 * to a named tool is offered through that tool, and the envelope does not list its id.
 */
export function unofferedViewId(graph: MnemonRuntimeGraph, turn: ComposableMemoryTurn, kind: 'route' | 'action', id: unknown, agent?: HostAgent): string | undefined {
  const view = turn.view
  const offered = kind === 'route'
    ? view.routes.map(route => ({ id: route.id, operation: route.sourceRouteId }))
    : view.actionOffers.map(offer => ({ id: offer.id, operation: offer.sourceActionId }))
  const label = kind === 'route' ? 'memory View Route' : 'memory ActionOffer'
  if (typeof id !== 'string' || id === '') return `${label} needs ${kind === 'route' ? 'routeId' : 'offerId'}, the exact id of one it offers`
  if (offered.some(entry => entry.id === id)) return undefined
  const generation = graph.memoryComposition.generation(view.runtimeGeneration)
  const bindings = generation === undefined ? {} : memoryWakeBindings(generation, view, availableMemoryTools(agent))
  const named = (kind === 'route' ? bindings.routes : bindings.actions) ?? {}
  const short = id.split('/').at(-1)!
  const tools = [...new Set(offered
    .filter(entry => named[entry.id] !== undefined && (entry.operation === short || entry.id.split('/').at(-1) === short))
    .map(entry => named[entry.id]!))]
  if (tools.length > 0) return `${label} is unavailable: ${id}; this View offers it as ${tools.join(' and ')}, so call that tool`
  const shown = offered.filter(entry => named[entry.id] === undefined).map(entry => entry.id)
  if (shown.length === 0) return `${label} is unavailable: ${id}; MNEMON VIEW ROUTES offers none by id this turn, only the named tools in MNEMON VIEW TOOLS`
  const near = shown.filter(candidate => candidate.split('/').at(-1) === short)
  if (near.length === 1) return `${label} is unavailable: ${id}; ids are exact as MNEMON VIEW ROUTES lists them: ${JSON.stringify(near[0])}`
  // Ids that share the short form come first, so a limited list never leaves them out.
  const listed = [...near, ...shown.filter(candidate => !near.includes(candidate))]
  return `${label} is unavailable: ${id}; MNEMON VIEW ROUTES offers ${listed.slice(0, 12).map(candidate => JSON.stringify(candidate)).join(', ')}${listed.length > 12 ? ` and ${listed.length - 12} more` : ''}`
}

function memoryWakeBindings(generation: MemoryCompositionGeneration, view: ComposableMemoryView, available?: ReadonlySet<string>): MemoryWakeBindings {
  const routeTools = available === undefined ? ROUTE_TOOLS : namedBindings('route', available)
  const actionTools = available === undefined ? ACTION_TOOLS : namedBindings('action', available)
  const instances = generation.sourceInstances()
  const routes: Record<string, string> = {}, actions: Record<string, string> = {}
  for (const typeId of NAMED_SOURCE_TYPES) {
    const selected = namedToolInstance(instances.filter(source => source.sourceTypeId === typeId), typeId)
    if (selected === undefined) continue
    for (const route of view.routes.filter(route => route.sourceInstanceKey === selected.sourceInstanceKey)) {
      const grant = view.readGrants.find(grant => grant.id === route.readGrantId)
      if (grant?.schema !== `dsh-mnemon.${typeId}/v1`) continue
      const tool = routeTools[typeId]?.[route.sourceRouteId]
      if (tool !== undefined) routes[route.id] = tool
    }
    for (const action of view.actionOffers.filter(action => action.sourceInstanceKey === selected.sourceInstanceKey)) {
      const tool = actionTools[typeId]?.[action.sourceActionId]
      if (tool !== undefined) actions[action.id] = tool
    }
  }
  return { routes, actions, ...(available === undefined ? {} : { routingTools: ['mnemon_view_route', 'mnemon_view_action'].filter(name => available.has(name)) }) }
}

/** Explicitly pick display fields; never copy grants, authority, or opaque Source state. */
export function inspectMemoryView(generation: MemoryCompositionGeneration, view: ComposableMemoryView, state: MemoryViewInspection['state'], turn?: number, memoryText?: string): MemoryViewInspection {
  return structuredClone({
    id: view.id, digest: view.digest, generationId: view.runtimeGeneration, createdAt: view.createdAt,
    state, ...(turn === undefined ? {} : { turn }), strategyTypeId: view.strategyTypeId, strategyInstanceKey: view.strategyInstanceKey,
    extensions: view.strategyExtensions ?? [],
    projection: view.projection.map(({ id, sourceInstanceKey, mode, text, revision }) => ({ id, sourceInstanceKey, mode, text, revision })),
    sourcePresentations: view.sourcePresentations ?? [],
    routes: view.routes.map(({ id, sourceInstanceKey, sourceRouteId, description, maxCalls }) => ({ id, sourceInstanceKey, operationId: sourceRouteId, description, maxCalls })),
    actions: view.actionOffers.map(({ id, sourceInstanceKey, sourceActionId, description }) => ({ id, sourceInstanceKey, operationId: sourceActionId, description })),
    memoryText: memoryText ?? presentMemoryWake(generation, view).text,
    ...(view.guidance === undefined ? {} : { guidance: view.guidance }),
    diagnostics: (view.diagnostics ?? []).map(diagnostic => diagnostic.message),
  })
}
