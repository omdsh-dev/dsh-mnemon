import { defineMemoryStrategy, type MemoryAvailableSource } from 'dsh-mnemon/extension-sdk'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'

const VIEW_ROLES = ['working-context', 'narrative', 'durable-evidence'] as const

function soleSource(sources: readonly MemoryAvailableSource[], role: typeof VIEW_ROLES[number]): MemoryAvailableSource | undefined {
  const matches = sources
    .filter(source => source.role === role && source.availability !== 'unavailable')
    .sort((left, right) => left.sourceInstanceKey.localeCompare(right.sourceInstanceKey))
  if (matches.length > 1) throw new Error(`default-three-tier View Strategy found ambiguous ${role} Sources; select an explicit Strategy`)
  return matches[0]
}

/** Pure View composition; no dependency on any Source implementation. */
export const DEFAULT_THREE_TIER_VIEW_STRATEGY = defineMemoryStrategy({
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
    const selected = [runtime, documents, memorySpaces].filter((source): source is MemoryAvailableSource => source !== undefined)
    const canProject = (source: MemoryAvailableSource | undefined) => source?.projection?.actions.includes('wake') === true
    const projectionBudget = request.budget.maxProjectionCharacters
    const runtimeBudget = !canProject(runtime) ? 0 : Math.max(1, Math.floor(projectionBudget * 0.9))
    let remaining = Math.max(0, projectionBudget - runtimeBudget)
    const documentsBudget = !canProject(documents) || remaining === 0 ? 0 : Math.max(1, Math.floor(remaining / (!canProject(memorySpaces) ? 1 : 2)))
    remaining -= documentsBudget
    const memorySpacesBudget = !canProject(memorySpaces) ? 0 : remaining
    const allocation = new Map<string, { mode: 'eager' | 'routed'; maxCharacters: number }>()
    if (runtime !== undefined && runtimeBudget > 0) allocation.set(runtime.sourceInstanceKey, { mode: 'eager', maxCharacters: runtimeBudget })
    if (documents !== undefined && documentsBudget > 0) allocation.set(documents.sourceInstanceKey, { mode: 'routed', maxCharacters: documentsBudget })
    if (memorySpaces !== undefined && memorySpacesBudget > 0) allocation.set(memorySpaces.sourceInstanceKey, { mode: 'routed', maxCharacters: memorySpacesBudget })
    let remainingRoutes = Math.min(4, request.budget.maxRoutes)
    let remainingActions = Math.min(7, request.budget.maxActions)
    return {
      strategyTypeId: 'default-three-tier',
      sources: selected.map(source => {
        const routeIds = source.routes.filter(route => route.semantics?.actions.includes('read')).slice(0, remainingRoutes).map(route => route.id)
        const actionIds = source.actions.filter(action => action.semantics?.actions.some(action => ['record', 'compress', 'forget'].includes(action))).slice(0, remainingActions).map(action => action.id)
        remainingRoutes -= routeIds.length
        remainingActions -= actionIds.length
        return {
          sourceInstanceKey: source.sourceInstanceKey,
          required: false,
          ...(allocation.get(source.sourceInstanceKey) === undefined ? {} : { projection: allocation.get(source.sourceInstanceKey)! }),
          routeIds,
          actionIds,
        }
      }),
      explanation: 'Project bounded working context eagerly, expose narrative/durable catalog covers (not content summaries), then select described reads and writes through View-pinned grants.',
    }
  },
})
