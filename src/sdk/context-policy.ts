import { MEMORY_CONTEXT_POLICY_FORMAT, type MemoryAvailableSource, type MemoryContextDecision, type MemoryContextDecisionTrace, type MemoryContextPolicy, type MemoryStrategyContribution, type MemoryStrategyExtensionDefinition, type MemoryViewGuidance, type MemoryViewRequest, type MemoryViewSpec } from '../core/contracts/index.ts'
import { defineMemoryStrategyExtension } from '../core/definitions.ts'
import { validateMemoryContextPolicy } from '../core/decision-contracts.ts'

export { validateMemoryContextPolicy, validateMemoryContextSelection } from '../core/decision-contracts.ts'

/** Pure policy factory. Evaluation belongs to the extension, not its host Strategy. */
export function defineMemoryContextPolicy(options: {
  typeId: string; packageName: string; strategyTypeId: string; slot: string
  contribute(request: MemoryViewRequest, sources: readonly MemoryAvailableSource[]): Omit<MemoryContextPolicy, 'format'>
}): MemoryStrategyExtensionDefinition {
  return defineMemoryStrategyExtension({
    manifest: { apiVersion: 'dsh-mnemon/v1', kind: 'strategy-extension', typeId: options.typeId, packageName: options.packageName,
      strategyTypeId: options.strategyTypeId, slot: options.slot, deterministic: true, contributionFormat: MEMORY_CONTEXT_POLICY_FORMAT },
    contribute: (request, sources) => validateMemoryContextPolicy({ format: MEMORY_CONTEXT_POLICY_FORMAT, ...options.contribute(request, sources) }, sources) as unknown as import('../core/contracts/index.ts').MemoryJsonValue,
  })
}

export interface MemoryContextCompositionOptions {
  strategyTypeId: string
  explanation: string
  maxSources?: number
  maxRoutes?: number
  maxActions?: number
  maxProjectionCharacters?: number
  guidance?: MemoryViewGuidance
}

/** Capability-based, deterministic selection. No stores, Source handles, timers or callbacks. */
export function composeMemoryContext(request: MemoryViewRequest, available: readonly MemoryAvailableSource[], contributions: readonly MemoryStrategyContribution[], options: MemoryContextCompositionOptions): MemoryViewSpec {
  const policies = contributions.map(contribution => ({ contribution, policy: validateMemoryContextPolicy(contribution.value, available) }))
  let selected = [...available].filter(source => source.availability !== 'unavailable')
    .sort((a, b) => (b.context?.weight ?? 1) - (a.context?.weight ?? 1) || a.sourceInstanceKey.localeCompare(b.sourceInstanceKey))
  let writable: Set<string> | undefined
  let characters = Math.min(request.budget.maxProjectionCharacters, options.maxProjectionCharacters ?? request.budget.maxProjectionCharacters)
  for (const { policy } of policies) {
    const selection = policy.selection
    if (!selection) continue
    if (selection.sourceKeys !== undefined) {
      const current = new Map(selected.map(source => [source.sourceInstanceKey, source]))
      selected = selection.sourceKeys.flatMap(key => current.has(key) ? [current.get(key)!] : [])
    }
    if (selection.writableSourceKeys !== undefined) {
      const previous = writable
      writable = new Set(selection.writableSourceKeys.filter(key => previous === undefined || previous.has(key)))
    }
    characters = Math.min(characters, selection.maxProjectionCharacters ?? characters)
  }
  selected = selected.slice(0, options.maxSources ?? 1000)
  const decisions = policies.flatMap(({ contribution, policy }) => policy.decisions.map(decision => ({ contribution, decision })))
  const operations = selected.map(source => {
    const offered = source.actions.filter(action => (writable === undefined || writable.has(source.sourceInstanceKey))
      && action.capability !== 'forget' && !(action.operation?.effects.length === 1 && action.operation.effects[0] === 'remove'))
    const ready = decisions.filter(({ decision }) => decision.ready && decision.sourceInstanceKey === source.sourceInstanceKey
      && (decision.requires?.actionIds ?? []).every(id => offered.some(action => action.id === id)))
    const routePriority = new Set(ready.flatMap(({ decision }) => decision.requires?.routeIds ?? []))
    const actionPriority = new Set(ready.flatMap(({ decision }) => decision.requires?.actionIds ?? []))
    return { source, routeIds: [] as string[], actionIds: [] as string[], offered,
      routes: [...source.routes].sort((a, b) => Number(routePriority.has(b.id)) - Number(routePriority.has(a.id))),
      actions: [...offered].sort((a, b) => Number(actionPriority.has(b.id)) - Number(actionPriority.has(a.id))),
    }
  })
  let routes = Math.min(request.budget.maxRoutes, options.maxRoutes ?? request.budget.maxRoutes)
  let actions = Math.min(request.budget.maxActions, options.maxActions ?? request.budget.maxActions)
  // Distribute each round across sources before assigning a second operation.
  const rounds = Math.max(0, ...operations.map(item => Math.max(item.routes.length, item.actions.length)))
  for (let round = 0; round < rounds && (routes > 0 || actions > 0); round++) for (const item of operations) {
    if (routes > 0 && item.routes[round]) { item.routeIds.push(item.routes[round]!.id); routes-- }
    if (actions > 0 && item.actions[round]) { item.actionIds.push(item.actions[round]!.id); actions-- }
  }
  const traces: MemoryContextDecisionTrace[] = decisions.map(({ contribution, decision }) => {
    const source = available.find(source => source.sourceInstanceKey === decision.sourceInstanceKey)!
    const item = operations.find(item => item.source.sourceInstanceKey === decision.sourceInstanceKey)
    const routeIds = decision.requires?.routeIds ?? [], actionIds = decision.requires?.actionIds ?? []
    const state = source.availability === 'unavailable' ? 'unavailable' : !item ? 'excluded' : !decision.ready ? 'deferred'
      : actionIds.some(id => !item.offered.some(action => action.id === id)) ? 'excluded'
        : routeIds.some(id => !item.routeIds.includes(id)) || actionIds.some(id => !item.actionIds.includes(id)) ? 'budget' : 'applied'
    return { id: decision.id, contributionInstanceKey: contribution.instanceKey, sourceInstanceKey: decision.sourceInstanceKey, state, reason: decision.reason, routeIds, actionIds }
  })
  const instructions = new Map<string, number[]>()
  decisions.forEach(({ decision }, index) => {
    if (traces[index]!.state !== 'applied' || !decision.instruction) return
    const indices = instructions.get(decision.instruction) ?? []
    indices.push(index); instructions.set(decision.instruction, indices)
  })
  const system = [options.guidance?.system ?? ''].filter(Boolean)
  let guidanceCharacters = system.join('\n\n').length
  for (const [instruction, indices] of instructions) {
    const keys = [...new Set(indices.map(index => traces[index]!.sourceInstanceKey))]
    const block = instruction + '\nSources: ' + keys.join(', ')
    if (guidanceCharacters + block.length + 2 > 16_384) { for (const index of indices) traces[index]!.state = 'budget'; continue }
    // Core binds these instructions after optional Sources have projected successfully.
    guidanceCharacters += block.length + 2
  }
  const profile = (source: MemoryAvailableSource) => {
    let mode = source.context?.mode ?? 'routed', weight = source.context?.weight ?? 1
    decisions.forEach(({ decision }, index) => {
      if (traces[index]!.state !== 'applied' || decision.sourceInstanceKey !== source.sourceInstanceKey || !decision.context) return
      if (decision.context.mode === 'eager') mode = 'eager'
      weight = Math.max(weight, decision.context.weight)
    })
    return { mode, weight }
  }
  const total = selected.filter(source => source.capabilities.includes('project')).reduce((sum, source) => sum + profile(source).weight, 0)
  return {
    strategyTypeId: options.strategyTypeId, explanation: options.explanation,
    sources: operations.map(({ source, routeIds, actionIds }) => {
      const context = profile(source), allocation = total && source.capabilities.includes('project') ? Math.floor(characters * context.weight / total) : 0
      return { sourceInstanceKey: source.sourceInstanceKey, required: false, routeIds, actionIds,
        ...(allocation > 0 ? { projection: { mode: context.mode, maxCharacters: allocation } } : {}),
      }
    }),
    ...(traces.length ? { decisions: traces } : {}),
    guidance: { ...options.guidance, ...(system.length ? { system: system.join('\n\n') } : {}) },
  }
}

/** Small helper for Source-authored coarse hints; never reads private Source data. */
export function memoryContextHints(source: MemoryAvailableSource): Readonly<Record<string, import('../core/contracts/index.ts').MemoryJsonValue>> {
  return source.hints && typeof source.hints === 'object' && !Array.isArray(source.hints) ? source.hints : {}
}
