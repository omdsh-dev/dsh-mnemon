import { defineMemoryStrategy, type MemorySourceFacts } from 'dsh-mnemon/extension-sdk'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { createThreeTierTurn } from './retrieval.ts'
import { ROUTING_GUIDANCE, RUNTIME_MEMORY_PROTOCOL, THREE_TIER_REMINDERS } from './guidance.ts'

const VIEW_ROLES = ['working-context', 'narrative', 'durable-evidence'] as const

function soleSource(sources: readonly MemorySourceFacts[], role: typeof VIEW_ROLES[number]): MemorySourceFacts | undefined {
  const matches = sources
    .filter(source => source.role === role && source.availability !== 'unavailable')
    .sort((left, right) => left.sourceInstanceKey.localeCompare(right.sourceInstanceKey))
  if (matches.length > 1) throw new Error(`default-three-tier View Strategy found ambiguous ${role} Sources; select an explicit Strategy`)
  return matches[0]
}

/** Pure View composition; no dependency on any Source implementation. */
export const DEFAULT_THREE_TIER_VIEW_STRATEGY = defineMemoryStrategy({
  createTurn: createThreeTierTurn,
  manifest: {
    apiVersion: COMPOSABLE_MEMORY_API_VERSION,
    kind: 'strategy',
    typeId: 'default-three-tier',
    packageName: 'dsh-mnemon-strategy-default-three-tier',
    deterministic: true,
    supportedSourceRoles: [...VIEW_ROLES],
    maxSources: 3,
    maxRoutes: 4,
    maxActions: 7,
  },
  compose(request, sources) {
    const runtime = soleSource(sources, 'working-context')
    const documents = soleSource(sources, 'narrative')
    const memorySpaces = soleSource(sources, 'durable-evidence')
    const classicSources = runtime?.sourceTypeId === 'runtime' && documents?.sourceTypeId === 'documents' && memorySpaces?.sourceTypeId === 'memory-spaces'
    const selected = [runtime, documents, memorySpaces].filter((source): source is MemorySourceFacts => source !== undefined)
    const projectionBudget = request.budget.maxProjectionCharacters
    const runtimeBudget = runtime === undefined || !runtime.capabilities.includes('project') ? 0 : Math.max(1, Math.floor(projectionBudget * 0.9))
    let remaining = Math.max(0, projectionBudget - runtimeBudget)
    const documentsBudget = documents === undefined || !documents.capabilities.includes('project') || remaining === 0 ? 0 : Math.max(1, Math.floor(remaining / (memorySpaces === undefined ? 1 : 2)))
    remaining -= documentsBudget
    const memorySpacesBudget = memorySpaces === undefined || !memorySpaces.capabilities.includes('project') ? 0 : remaining
    const allocation = new Map<string, { mode: 'eager' | 'routed'; maxCharacters: number }>()
    if (runtime !== undefined && runtimeBudget > 0) allocation.set(runtime.sourceInstanceKey, { mode: 'eager', maxCharacters: runtimeBudget })
    if (documents !== undefined && documentsBudget > 0) allocation.set(documents.sourceInstanceKey, { mode: 'routed', maxCharacters: documentsBudget })
    if (memorySpaces !== undefined && memorySpacesBudget > 0) allocation.set(memorySpaces.sourceInstanceKey, { mode: 'routed', maxCharacters: memorySpacesBudget })
    return {
      strategyTypeId: 'default-three-tier',
      guidance: {
        ...(classicSources ? { routing: ROUTING_GUIDANCE, reminders: THREE_TIER_REMINDERS } : {}),
        ...(runtime?.sourceTypeId === 'runtime' && runtime.capabilities.includes('project') ? { system: RUNTIME_MEMORY_PROTOCOL } : {}),
      },
      sources: selected.map(source => ({
        sourceInstanceKey: source.sourceInstanceKey,
        required: false,
        ...(allocation.get(source.sourceInstanceKey) === undefined ? {} : { projection: allocation.get(source.sourceInstanceKey)! }),
        routeIds: source.routeIds.filter(route => route === 'inspect' || route === 'search' || route === 'recall' || route === 'related'),
        actionIds: [...source.actionIds],
      })),
      explanation: 'Project exact working context eagerly, expose bounded narrative and durable-evidence covers, then route reads through View-pinned grants.',
    }
  },
})
