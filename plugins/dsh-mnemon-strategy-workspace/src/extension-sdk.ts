import { defineMemoryContextPolicy } from 'dsh-mnemon/extension-sdk'
import type { MemoryAvailableSource, MemoryContextPolicy, MemoryStrategyExtensionDefinition, MemoryViewRequest } from 'dsh-mnemon/contracts'

/** Workspace accepts public context policies in independently named slots. */
export function defineWorkspacePolicy(value: {
  typeId: string; packageName: string; slot: string
  contribute(request: MemoryViewRequest, sources: readonly MemoryAvailableSource[]): Omit<MemoryContextPolicy, 'format'>
}): MemoryStrategyExtensionDefinition {
  return defineMemoryContextPolicy({ ...value, strategyTypeId: 'workspace' })
}
export { validateMemoryContextPolicy, validateMemoryContextSelection } from 'dsh-mnemon/extension-sdk'
