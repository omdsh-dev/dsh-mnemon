import type { ComposableMemoryView, MemoryStrategyManifest, MemoryStrategyWorkflow } from '../core/contracts/index.ts'

export type StrategyDeclaration = Pick<MemoryStrategyManifest, 'typeId' | 'workflows'>

const LAYERED_STRATEGY = 'default-three-tier'

export function strategyDrives(strategy: StrategyDeclaration, workflow: MemoryStrategyWorkflow): boolean {
  return strategy.workflows === undefined ? strategy.typeId === LAYERED_STRATEGY : strategy.workflows.includes(workflow)
}

export function runtimeCapacityWrite(strategy: StrategyDeclaration, sourceTypeId: string, actionId: string): boolean {
  return sourceTypeId === 'runtime' && actionId === 'mutate' && strategyDrives(strategy, 'runtime-capacity')
}

export function viewStrategy(
  generation: { strategy?: { instanceKey: string; definition: { manifest: MemoryStrategyManifest } } } | undefined,
  view: Pick<ComposableMemoryView, 'strategyInstanceKey' | 'strategyTypeId'>,
): StrategyDeclaration {
  const strategy = generation?.strategy
  return strategy?.instanceKey === view.strategyInstanceKey ? strategy.definition.manifest : { typeId: view.strategyTypeId }
}
