import type { MemoryCatalog, MemoryLayerRegistration, MemoryStrategyRegistration } from '../../kernel/src/index.ts'
import { participationChannel } from '../../kernel/src/index.ts'
import type {
  MemorySourceFacts,
  MemoryLayerParticipation,
  MemoryPlanRequest,
  MemoryPlanStepProposal,
  MemoryTopologyDefinition,
  MemoryTopologyLayer,
} from '../../contracts/src/index.ts'
import { COMPOSABLE_MEMORY_API_VERSION } from '../../contracts/src/index.ts'
import { defineMemoryStrategy } from '../../kernel/src/composition.ts'
import { RUNTIME_MEMORY_LAYER } from '../../layer-runtime/src/index.ts'
import { DOCUMENTS_MEMORY_LAYER } from '../../layer-documents/src/index.ts'
import { MEMORY_SPACES_LAYER } from '../../layer-memory-spaces/src/index.ts'

export const BUILTIN_MEMORY_LAYERS = [RUNTIME_MEMORY_LAYER, DOCUMENTS_MEMORY_LAYER, MEMORY_SPACES_LAYER] as const

export const DEFAULT_LAYER_PARTICIPATION: Readonly<MemoryLayerParticipation> = Object.freeze({
  recall: 'automatic',
  write: 'automatic',
  projection: 'automatic',
  maintenance: 'automatic',
})

function topologyLayer(id: string): MemoryTopologyLayer {
  return { id, enabled: true, participation: { ...DEFAULT_LAYER_PARTICIPATION }, adapterIds: [] }
}

export const DEFAULT_THREE_TIER_TOPOLOGY: Readonly<MemoryTopologyDefinition> = Object.freeze({
  id: 'default-three-tier',
  strategyId: 'default-three-tier',
  layers: Object.freeze([
    topologyLayer('runtime'),
    topologyLayer('documents'),
    topologyLayer('memory-spaces'),
  ]) as unknown as MemoryTopologyLayer[],
})

function accepts(layer: MemoryTopologyLayer, request: MemoryPlanRequest): boolean {
  if (!layer.enabled) return false
  const mode = layer.participation[participationChannel(request.capability)]
  if (mode === 'off') return false
  if (request.trigger !== 'manual' && mode !== 'automatic') return false
  return true
}

export const DEFAULT_THREE_TIER_STRATEGY: MemoryStrategyRegistration = {
  descriptor: {
    id: 'default-three-tier',
    version: '1',
    label: 'Default three-tier strategy',
    description: 'Routes explicit operations to compatible enabled layers in stable topology order.',
    hooks: ['placement', 'retrieval-planning', 'projection', 'maintenance'],
    deterministic: true,
  },
  propose(request, context) {
    const candidates = request.candidateLayerIds === undefined ? undefined : new Set(request.candidateLayerIds)
    const adapters = request.adapterIds === undefined ? undefined : new Set(request.adapterIds)
    const descriptors = new Map(context.catalog.layers.map(layer => [layer.id, layer]))
    const steps: MemoryPlanStepProposal[] = []
    for (const layer of context.topology.layers) {
      const descriptor = descriptors.get(layer.id)
      if (descriptor === undefined || !descriptor.capabilities.includes(request.capability)) continue
      if (candidates !== undefined && !candidates.has(layer.id)) continue
      if (!accepts(layer, request)) continue
      const selectedAdapters = adapters === undefined ? layer.adapterIds : layer.adapterIds.filter(id => adapters.has(id))
      if (selectedAdapters.length === 0) {
        steps.push({ layerId: layer.id, capability: request.capability, ...(request.input === undefined ? {} : { input: request.input }) })
      } else {
        steps.push(...selectedAdapters.map(adapterId => ({
          layerId: layer.id,
          adapterId,
          capability: request.capability,
          ...(request.input === undefined ? {} : { input: request.input }),
        })))
      }
    }
    return {
      strategyId: this.descriptor.id,
      strategyVersion: this.descriptor.version,
      reason: steps.length === 0
        ? `No enabled layer accepts ${request.capability} for a ${request.trigger} operation.`
        : `Selected ${steps.length} compatible step${steps.length === 1 ? '' : 's'} from the active three-tier topology.`,
      steps,
    }
  },
}

const VIEW_ROLES = ['working-context', 'narrative', 'durable-evidence'] as const

function soleSource(sources: readonly MemorySourceFacts[], role: typeof VIEW_ROLES[number]): MemorySourceFacts | undefined {
  const matches = sources
    .filter(source => source.role === role && source.availability !== 'unavailable')
    .sort((left, right) => left.sourceInstanceKey.localeCompare(right.sourceInstanceKey))
  if (matches.length > 1) throw new Error(`default-three-tier View Strategy found ambiguous ${role} Sources; select an explicit Strategy`)
  return matches[0]
}

/**
 * Composable View counterpart of the v0.3 operation planner. It is pure and
 * selects only facts exposed by Source runtimes; grants and Authority data
 * remain entirely Source-owned.
 */
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
    const selected = [runtime, documents, memorySpaces].filter((source): source is MemorySourceFacts => source !== undefined)
    const projectionBudget = request.budget.maxProjectionCharacters
    const runtimeBudget = runtime === undefined ? 0 : Math.max(1, Math.floor(projectionBudget * 0.9))
    let remaining = Math.max(0, projectionBudget - runtimeBudget)
    const documentsBudget = documents === undefined || remaining === 0 ? 0 : Math.max(1, Math.floor(remaining / (memorySpaces === undefined ? 1 : 2)))
    remaining -= documentsBudget
    const memorySpacesBudget = memorySpaces === undefined ? 0 : remaining
    const allocation = new Map<string, { mode: 'eager' | 'routed'; maxCharacters: number }>()
    if (runtime !== undefined && runtimeBudget > 0) allocation.set(runtime.sourceInstanceKey, { mode: 'eager', maxCharacters: runtimeBudget })
    if (documents !== undefined && documentsBudget > 0) allocation.set(documents.sourceInstanceKey, { mode: 'routed', maxCharacters: documentsBudget })
    if (memorySpaces !== undefined && memorySpacesBudget > 0) allocation.set(memorySpaces.sourceInstanceKey, { mode: 'routed', maxCharacters: memorySpacesBudget })
    return {
      strategyTypeId: 'default-three-tier',
      sources: selected.map(source => ({
        sourceInstanceKey: source.sourceInstanceKey,
        ...(allocation.get(source.sourceInstanceKey) === undefined ? {} : { projection: allocation.get(source.sourceInstanceKey)! }),
        routeIds: source.routeIds.filter(route => route === 'search' || route === 'recall' || route === 'related'),
        actionIds: [...source.actionIds],
      })),
      explanation: 'Project exact working context eagerly, expose bounded narrative and durable-evidence covers, then route reads through View-pinned grants.',
    }
  },
})

export function registerDefaultMemorySystem(catalog: MemoryCatalog, layers: Partial<Record<string, Omit<MemoryLayerRegistration, 'descriptor'>>> = {}): () => void {
  const disposers = [
    ...BUILTIN_MEMORY_LAYERS.map(descriptor => catalog.registerLayer({ descriptor: { ...descriptor, capabilities: [...descriptor.capabilities] }, ...layers[descriptor.id] })),
    catalog.registerStrategy(DEFAULT_THREE_TIER_STRATEGY),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
