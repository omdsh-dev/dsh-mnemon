import { defineMemoryStrategyExtension, memoryInputInteger, memoryInputRecord, memoryInputText } from 'dsh-mnemon/extension-sdk'
import { COMPOSABLE_MEMORY_API_VERSION, type MemoryAvailableSource, type MemoryJsonValue, type MemoryStrategyContribution, type MemoryStrategyExtensionDefinition, type MemoryViewRequest } from 'dsh-mnemon/contracts'

/** These slots belong to the three-tier product. Core does not interpret them. */
export type ThreeTierExtensionValues = {
  selection: { sourceKeys: string[]; writableSourceKeys?: string[] }
  projection: { maxProjectionCharacters: number }
  capture: { instruction: string; actionIds: string[]; sourceKeys?: string[] }
}
export type ThreeTierExtensionSlot = keyof ThreeTierExtensionValues

function keys(value: MemoryJsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(key => typeof key !== 'string' || !/^source:[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,292}$/u.test(key))) {
    throw new Error(`${label} must contain at most 32 exact Source instance keys`)
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicate Source keys`)
  return [...value] as string[]
}

export function validateThreeTierExtension<K extends ThreeTierExtensionSlot>(slot: K, value: MemoryJsonValue): ThreeTierExtensionValues[K] {
  const input = memoryInputRecord(value, `three-tier ${slot} contribution`)
  const allowed = slot === 'selection' ? ['sourceKeys', 'writableSourceKeys'] : slot === 'projection' ? ['maxProjectionCharacters'] : slot === 'capture' ? ['instruction', 'actionIds', 'sourceKeys'] : []
  if (allowed.length === 0) throw new Error(`unsupported three-tier extension slot: ${String(slot)}`)
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`unsupported three-tier ${slot} field: ${key}`)
  let result: ThreeTierExtensionValues[ThreeTierExtensionSlot]
  if (slot === 'selection') {
    const sourceKeys = keys(input.sourceKeys, 'sourceKeys')
    const writableSourceKeys = input.writableSourceKeys === undefined ? undefined : keys(input.writableSourceKeys, 'writableSourceKeys')
    if (writableSourceKeys?.some(key => !sourceKeys.includes(key))) throw new Error('writableSourceKeys must be within selected sourceKeys')
    result = { sourceKeys, ...(writableSourceKeys === undefined ? {} : { writableSourceKeys }) }
  } else if (slot === 'projection') {
    if (input.maxProjectionCharacters === undefined) throw new Error('maxProjectionCharacters is required')
    result = { maxProjectionCharacters: memoryInputInteger(input.maxProjectionCharacters, 4_096, 1, 10_000_000) }
  } else {
    if (!Array.isArray(input.actionIds) || input.actionIds.length === 0 || input.actionIds.length > 32
      || input.actionIds.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/u.test(id))
      || new Set(input.actionIds).size !== input.actionIds.length) throw new Error('capture actionIds must name 1..32 distinct Source-local recording actions')
    result = { instruction: memoryInputText(input.instruction, 'capture instruction', 4_000)!,
      actionIds: [...input.actionIds] as string[],
      ...(input.sourceKeys === undefined ? {} : { sourceKeys: keys(input.sourceKeys, 'capture sourceKeys') }) }
  }
  return result as ThreeTierExtensionValues[K]
}

export function defineThreeTierExtension<K extends ThreeTierExtensionSlot>(definition: {
  typeId: string
  packageName: string
  slot: K
  contribute(request: MemoryViewRequest, sources: readonly MemoryAvailableSource[]): ThreeTierExtensionValues[K]
}): MemoryStrategyExtensionDefinition {
  return defineMemoryStrategyExtension({
    manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy-extension', typeId: definition.typeId,
      packageName: definition.packageName, strategyTypeId: 'default-three-tier', slot: definition.slot, deterministic: true },
    contribute: (request, sources) => validateThreeTierExtension(definition.slot, definition.contribute(request, sources)),
  })
}

export function threeTierContributions(values: readonly MemoryStrategyContribution[]): Partial<ThreeTierExtensionValues> {
  const output: Partial<ThreeTierExtensionValues> = {}
  for (const contribution of values) {
    const slot = contribution.slot as ThreeTierExtensionSlot
    if (Object.hasOwn(output, slot)) throw new Error(`duplicate three-tier extension slot: ${slot}`)
    const value = validateThreeTierExtension(slot, contribution.value)
    Object.assign(output, { [slot]: value })
  }
  return output
}
