import type { MemoryCatalog, MemoryLayerRegistration, MemoryStrategyRegistration } from '../../kernel/src/index.ts'
import { participationChannel } from '../../kernel/src/index.ts'
import type {
  MemoryLayerParticipation,
  MemoryPlanRequest,
  MemoryPlanStepProposal,
  MemoryTopologyDefinition,
  MemoryTopologyLayer,
} from '../../contracts/src/index.ts'
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

/** Compatibility alias; the View Strategy lives in its standalone plugin. */
export { DEFAULT_THREE_TIER_VIEW_STRATEGY } from '../../../plugins/dsh-mnemon-strategy-default-three-tier/src/strategy.ts'

export function registerDefaultMemorySystem(catalog: MemoryCatalog, layers: Partial<Record<string, Omit<MemoryLayerRegistration, 'descriptor'>>> = {}): () => void {
  const disposers = [
    ...BUILTIN_MEMORY_LAYERS.map(descriptor => catalog.registerLayer({ descriptor: { ...descriptor, capabilities: [...descriptor.capabilities] }, ...layers[descriptor.id] })),
    catalog.registerStrategy(DEFAULT_THREE_TIER_STRATEGY),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
