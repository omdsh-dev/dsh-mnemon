import { MEMORY_CONTEXT_POLICY_FORMAT, type MemoryAvailableSource, type MemoryContextDecisionTrace, type MemoryContextPolicy, type MemoryContextSelection, type MemoryJsonValue, type MemoryStrategyContribution, type MemoryViewGuidance, type MemoryViewSourceSpec } from './contracts/index.ts'
import { id, jsonClone, positiveInteger, requiredText, uniqueIds } from './definitions.ts'
import { validateMemoryContext } from './operation-contracts.ts'

function record(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} has unsupported fields`)
}
function keys(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error(`${label} must be a bounded list`)
  const result = value.map(item => requiredText(item, label, 300))
  if (result.some(item => !/^source:[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,292}$/u.test(item)) || new Set(result).size !== result.length) throw new Error(`${label} must contain distinct Source instance keys`)
  return result
}
export function validateMemoryContextSelection(value: MemoryContextSelection): MemoryContextSelection {
  record(value, ['sourceKeys', 'writableSourceKeys', 'maxProjectionCharacters'], 'Context selection')
  const sourceKeys = value.sourceKeys === undefined ? undefined : keys(value.sourceKeys, 'Selected Sources')
  const writableSourceKeys = value.writableSourceKeys === undefined ? undefined : keys(value.writableSourceKeys, 'Writable Sources')
  if (sourceKeys && writableSourceKeys?.some(key => !sourceKeys.includes(key))) throw new Error('Writable Sources must be a selected subset')
  return jsonClone({ ...(sourceKeys === undefined ? {} : { sourceKeys }), ...(writableSourceKeys === undefined ? {} : { writableSourceKeys }),
    ...(value.maxProjectionCharacters === undefined ? {} : { maxProjectionCharacters: positiveInteger(value.maxProjectionCharacters, 'Context character budget', 10_000_000) }),
  }, 'Context selection')
}
export function validateMemoryContextPolicy(value: MemoryContextPolicy | MemoryJsonValue, sources?: readonly MemoryAvailableSource[]): MemoryContextPolicy {
  record(value, ['format', 'selection', 'decisions'], 'Context policy')
  if (value.format !== MEMORY_CONTEXT_POLICY_FORMAT || !Array.isArray(value.decisions) || value.decisions.length > 128) throw new Error('Invalid context policy format or decision limit')
  const seen = new Set<string>()
  const decisions = value.decisions.map(raw => {
    record(raw, ['id', 'sourceInstanceKey', 'ready', 'reason', 'requires', 'context', 'instruction'], 'Context decision')
    const decisionId = id(raw.id, 'Context decision id'), sourceInstanceKey = keys([raw.sourceInstanceKey], 'Decision Source')[0]!
    const identity = `${sourceInstanceKey}/${decisionId}`
    if (seen.has(identity)) throw new Error('Duplicate context decision: ' + identity)
    seen.add(identity)
    if (typeof raw.ready !== 'boolean') throw new Error('Context decision ready must be boolean')
    record(raw.reason, ['en', 'zh-CN'], 'Decision reason')
    const reason = { en: requiredText(raw.reason.en, 'Decision reason', 1000), 'zh-CN': requiredText(raw.reason['zh-CN'], 'Decision reason', 1000) }
    let requires: { routeIds?: string[]; actionIds?: string[] } | undefined
    if (raw.requires !== undefined) {
      record(raw.requires, ['routeIds', 'actionIds'], 'Decision prerequisites')
      requires = {}
      for (const key of ['routeIds', 'actionIds'] as const) {
        if (raw.requires[key] !== undefined) {
          if (!Array.isArray(raw.requires[key]) || raw.requires[key].length > 128) throw new Error('Decision prerequisite limit exceeded')
          requires[key] = uniqueIds(raw.requires[key].map(item => id(item, 'Decision prerequisite')), 'Decision ' + key)
        }
      }
    }
    if (sources) {
      const source = sources.find(source => source.sourceInstanceKey === sourceInstanceKey)
      if (!source) throw new Error('Context decision refers to an unavailable Source: ' + sourceInstanceKey)
      // A policy receives only Host-filtered facts. It cannot invent hidden operations.
      if (requires?.routeIds?.some(id => !source.routeIds.includes(id)) || requires?.actionIds?.some(id => !source.actionIds.includes(id))) throw new Error('Context decision requests an unavailable operation')
    }
    return { id: decisionId, sourceInstanceKey, ready: raw.ready, reason,
      ...(requires === undefined ? {} : { requires }),
      ...(raw.context === undefined ? {} : { context: validateMemoryContext(raw.context as never) }),
      ...(raw.instruction === undefined ? {} : { instruction: requiredText(raw.instruction, 'Decision instruction', 4000) }),
    }
  })
  const selection = value.selection === undefined ? undefined : validateMemoryContextSelection(value.selection as MemoryContextSelection)
  if (sources && [...selection?.sourceKeys ?? [], ...selection?.writableSourceKeys ?? []].some(key => !sources.some(source => source.sourceInstanceKey === key))) throw new Error('Context selection refers to an unavailable Source')
  return jsonClone({ format: MEMORY_CONTEXT_POLICY_FORMAT, decisions, ...(selection === undefined ? {} : { selection }) }, 'Context policy')
}

/** Bind instructions only after all required operations survive Source projection. */
export function resolveMemoryDecisionGuidance(guidance: MemoryViewGuidance | undefined, traces: MemoryContextDecisionTrace[] | undefined, contributions: readonly MemoryStrategyContribution[]): MemoryViewGuidance | undefined {
  const instructions = new Map<string, string[]>()
  for (const trace of traces ?? []) {
    if (trace.state !== 'applied') continue
    const contribution = contributions.find(item => item.instanceKey === trace.contributionInstanceKey)!
    const decision = validateMemoryContextPolicy(contribution.value).decisions.find(item => item.id === trace.id && item.sourceInstanceKey === trace.sourceInstanceKey)!
    if (!decision.instruction) continue
    const keys = instructions.get(decision.instruction) ?? []
    if (!keys.includes(trace.sourceInstanceKey)) keys.push(trace.sourceInstanceKey)
    instructions.set(decision.instruction, keys)
  }
  const blocks = [guidance?.system ?? ''].filter(Boolean)
  for (const [instruction, keys] of instructions) blocks.push(instruction + '\nSources: ' + keys.join(', '))
  const system = blocks.join('\n\n')
  if (system.length > 16_384) throw new Error('Applied context instructions exceed the guidance budget')
  return guidance === undefined && !system ? undefined : { ...guidance, ...(system ? { system } : {}) }
}

export function validateMemoryDecisionTraces(values: MemoryContextDecisionTrace[], selected: readonly MemoryViewSourceSpec[], contributions: readonly MemoryStrategyContribution[]): MemoryContextDecisionTrace[] {
  if (!Array.isArray(values) || values.length > 512) throw new Error('Context decision trace limit exceeded')
  const seen = new Set<string>()
  return values.map(value => {
    record(value, ['id', 'contributionInstanceKey', 'sourceInstanceKey', 'state', 'reason', 'routeIds', 'actionIds'], 'Context decision trace')
    const contribution = contributions.find(item => item.instanceKey === value.contributionInstanceKey)
    const policy = contribution ? validateMemoryContextPolicy(contribution.value) : undefined
    const decision = policy?.decisions.find(item => item.id === value.id && item.sourceInstanceKey === value.sourceInstanceKey)
    if (!decision) throw new Error('Context decision trace has no originating proposal')
    const identity = `${value.contributionInstanceKey}/${value.sourceInstanceKey}/${value.id}`
    if (seen.has(identity)) throw new Error('Duplicate context decision trace')
    seen.add(identity)
    if (!['applied', 'deferred', 'excluded', 'budget', 'unavailable'].includes(value.state)) throw new Error('Unsupported context decision trace state')
    const routeIds = uniqueIds(value.routeIds, 'Decision trace routes'), actionIds = uniqueIds(value.actionIds, 'Decision trace actions')
    if (JSON.stringify(routeIds) !== JSON.stringify(decision.requires?.routeIds ?? []) || JSON.stringify(actionIds) !== JSON.stringify(decision.requires?.actionIds ?? [])) throw new Error('Context decision trace changes its prerequisites')
    if (value.state === 'applied') {
      const source = selected.find(source => source.sourceInstanceKey === value.sourceInstanceKey)
      if (!decision.ready || !source || routeIds.some(id => !source.routeIds?.includes(id)) || actionIds.some(id => !source.actionIds?.includes(id))) throw new Error('Context decision cannot be applied without its selected prerequisites')
    }
    return jsonClone({ id: decision.id, contributionInstanceKey: contribution!.instanceKey, sourceInstanceKey: decision.sourceInstanceKey, state: value.state, reason: decision.reason, routeIds, actionIds }, 'Context decision trace')
  })
}
