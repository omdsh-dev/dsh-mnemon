import { createMemorySpacesSource as createSource } from '../../plugins/dsh-mnemon-source-memory-spaces/src/source.ts'
import { MemorySpaceProviderSnapshot } from '../../plugins/dsh-mnemon-source-memory-spaces/src/providers/host.ts'
import type { MemoryProviderAdapterRegistry } from '../providers/registry.ts'
import type { MemorySpacesService } from '../../plugins/dsh-mnemon-source-memory-spaces/src/service.ts'
import { BUILTIN_MEMORY_BINDINGS } from './bindings.ts'

/** @deprecated Pre-composable object-binding adapter, never used by standalone plugins. */
export function createMemorySpacesSource(providerInput?: MemoryProviderAdapterRegistry | MemorySpaceProviderSnapshot) {
  const snapshot = providerInput !== undefined && 'adapterRegistry' in providerInput ? providerInput : new MemorySpaceProviderSnapshot([])
  return createSource(snapshot, {}, context => {
    const service = context.binding<MemorySpacesService>(BUILTIN_MEMORY_BINDINGS.memorySpaces)
    if (service === undefined) throw new Error('Legacy Memory Spaces Source requires its private Host binding')
    if (providerInput === undefined) return { service, owned: false }
    const registry = 'adapterRegistry' in providerInput ? providerInput.adapterRegistry() : providerInput
    return { service: service.withProviderAdapterRegistry(registry, 'descriptors' in providerInput ? providerInput.descriptors() : undefined), owned: true }
  })
}
export const MEMORY_SPACES_SOURCE = createMemorySpacesSource()
