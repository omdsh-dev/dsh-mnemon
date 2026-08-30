import type {
  MemoryBudgetMetric, MemoryBudgetSupport, MemoryBudgetUsage, MemoryCapability,
  MemoryOperationSelection, MemoryOperationSemantics, MemoryResolvedBudget, MemoryResultSemantics,
} from './contracts/index.ts'
import {
  canonicalMemoryJson, jsonClone, positiveInteger, requiredText,
  MEMORY_REPRESENTATIONS as REPRESENTATIONS, validateMemorySemanticMember as member,
  validateMemoryBudgetMetric as metric, memoryBudgetMetricKey as metricKey, validateMemoryBudgetSupports as supports,
} from './definitions.ts'

/** Semantic effects narrow capability permissions; a read label cannot hide writes/deletes. */
export function operationCapabilities(capability: MemoryCapability, semantics?: MemoryOperationSemantics): MemoryCapability[] {
  return [...new Set<MemoryCapability>([capability, ...(semantics?.effects ?? []).map(effect =>
    effect.mode === 'delete' || effect.mode === 'invalidate' ? 'forget' as const : 'write' as const)])]
}

export interface ResolvedSelection {
  representation?: MemoryResultSemantics['representation']
  budgets: MemoryResolvedBudget[]
}

export function resolveSelection(selection: MemoryOperationSelection | undefined, semantics: MemoryOperationSemantics | undefined, ceilings: MemoryBudgetSupport[]): ResolvedSelection {
  const representation = selection?.representation
  if (representation !== undefined && !semantics?.representations.includes(representation)) throw new Error(`memory Strategy selected unsupported representation: ${representation}`)
  const available = new Map(supports(ceilings).map(value => [metricKey(value), value]))
  for (const support of semantics?.budgets ?? []) {
    const previous = available.get(metricKey(support))
    available.set(metricKey(support), previous === undefined ? support : {
      ...support, maximum: Math.min(previous.maximum, support.maximum), default: Math.min(previous.default, support.default),
    })
  }
  const requested = new Map<string, MemoryResolvedBudget>()
  for (const value of selection?.budgets ?? []) {
    const normalized = metric(value)
    const key = metricKey(normalized)
    if (requested.has(key)) throw new Error(`duplicated memory Strategy budget: ${key}`)
    const support = available.get(key)
    if (support === undefined) throw new Error(`memory Strategy selected unsupported budget: ${key}`)
    let max = support.default
    let preferredMin: number | undefined
    if (value.amount !== 'auto') {
      max = positiveInteger(value.amount?.max, 'requested budget max', 1_000_000_000)
      if (value.amount.min !== undefined) {
        if (!Number.isInteger(value.amount.min) || value.amount.min < 0 || value.amount.min > max) throw new Error('invalid memory preferred budget range')
        preferredMin = value.amount.min
      }
    }
    requested.set(key, { ...normalized, max: Math.min(max, support.maximum), ...(preferredMin === undefined ? {} : { preferredMin }) })
  }
  for (const [key, support] of available) {
    if (!requested.has(key)) requested.set(key, { ...metric(support), max: Math.min(support.default, support.maximum) })
  }
  return jsonClone({ ...(representation === undefined ? {} : { representation }), budgets: [...requested.values()] }, 'memory resolved operation')
}

export function outputCeilings(characters: number, items?: number, calls?: number): MemoryBudgetSupport[] {
  return [
    { resource: 'output', unit: 'characters', measurement: 'exact', default: characters, maximum: characters },
    ...(items === undefined ? [] : [{ resource: 'output' as const, unit: 'items' as const, measurement: 'exact' as const, default: items, maximum: items }]),
    ...(calls === undefined ? [] : [{ resource: 'cost' as const, unit: 'calls' as const, measurement: 'exact' as const, default: calls, maximum: calls }]),
  ]
}

export function budgetLimit(budgets: readonly MemoryResolvedBudget[], resource: MemoryBudgetMetric['resource'], unit: MemoryBudgetMetric['unit'], fallback: number): number {
  return Math.min(fallback, ...budgets.filter(value => value.resource === resource && value.unit === unit && value.measurement === 'exact').map(value => value.max))
}

export function validateResult(value: MemoryResultSemantics | undefined, semantics?: MemoryOperationSemantics, representation?: MemoryResultSemantics['representation']): MemoryResultSemantics | undefined {
  if (value === undefined) {
    if (semantics !== undefined) throw new Error('memory result semantics are required for a described operation')
    return undefined
  }
  member(value.representation, REPRESENTATIONS, 'result representation')
  if (value.sourceRepresentation !== undefined) member(value.sourceRepresentation, REPRESENTATIONS, 'original result representation')
  member(value.coverage, ['complete', 'partial', 'unknown'], 'result coverage')
  if (semantics !== undefined && !semantics.representations.includes(value.representation)) throw new Error('memory result uses an undeclared representation')
  if (representation !== undefined && value.representation !== representation) throw new Error('memory result does not match the selected representation')
  if (value.omitted !== undefined) requiredText(value.omitted, 'result omissions', 2_000)
  if (value.coverage === 'complete' && value.omitted !== undefined) throw new Error('complete memory result cannot declare omissions')
  if (value.state !== undefined) member(value.state, ['active', 'candidate', 'archived'], 'result state')
  if (value.score !== undefined) {
    requiredText(value.score.basis, 'score basis', 300)
    requiredText(value.score.meaning, 'score meaning', 1_000)
  }
  if (value.expansion !== undefined) {
    if ('unavailable' in value.expansion) requiredText(value.expansion.unavailable, 'expansion unavailable reason', 1_000)
    else {
      requiredText(value.expansion.routeId, 'expansion Route id', 500)
      canonicalMemoryJson(value.expansion.input, 'expansion input')
    }
  }
  return jsonClone(value, 'memory result semantics')
}

/** No splitting UTF-16 pairs or UTF-8 characters while applying mechanical limits. */
export function boundedText(value: string, characters: number, bytes = Infinity): string {
  let length = Math.min(value.length, characters)
  if (Buffer.byteLength(value.slice(0, length), 'utf8') > bytes) {
    let low = 0
    let high = length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= bytes) low = mid
      else high = mid - 1
    }
    length = low
  }
  if (length > 0 && length < value.length && /[\uD800-\uDBFF]/u.test(value[length - 1]!)) length -= 1
  return value.slice(0, length)
}

/** Output/call measurements are Core-owned; other supported budgets require a Source report. */
export function normalizeUsage(values: MemoryBudgetUsage[] | undefined, budgets: readonly MemoryResolvedBudget[], texts: readonly string[], calls?: number): MemoryBudgetUsage[] {
  const reported = new Map<string, MemoryBudgetUsage>()
  for (const value of values ?? []) {
    const key = metricKey(metric(value))
    if (reported.has(key) || !budgets.some(budget => metricKey(budget) === key)) throw new Error('memory usage reports an undeclared or duplicate metric')
    if (!Number.isFinite(value.used) || value.used < 0) throw new Error('memory usage must be finite and non-negative')
    reported.set(key, value)
  }
  return budgets.map(budget => {
    let used: number | undefined
    if (budget.measurement === 'exact' && budget.resource === 'output') {
      if (budget.unit === 'characters') used = texts.reduce((sum, text) => sum + text.length, 0)
      if (budget.unit === 'bytes') used = texts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0)
      if (budget.unit === 'items') used = texts.length
    }
    if (budget.resource === 'cost' && budget.unit === 'calls' && budget.measurement === 'exact') used = calls
    used ??= reported.get(metricKey(budget))?.used
    if (used === undefined) throw new Error(`memory Source did not report required usage: ${metricKey(budget)}`)
    if (used > budget.max) throw new Error(`memory operation exceeded budget: ${metricKey(budget)}`)
    return { ...metric(budget), used }
  })
}
