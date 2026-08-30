import { MemoryProviderAdapterRegistry, type MemoryProviderAdapterFactory } from '../../plugins/dsh-mnemon-source-memory-spaces/src/providers/registry.ts'
import { BUILTIN_MEMORY_SPACE_PROVIDER_DEFINITIONS } from '../memory-spaces/builtin-providers.ts'
export { MemoryProviderAdapterRegistry } from '../../plugins/dsh-mnemon-source-memory-spaces/src/providers/registry.ts'
export type { MemoryProviderAdapterFactory, MemoryProviderAdapterFactoryContext } from '../../plugins/dsh-mnemon-source-memory-spaces/src/providers/registry.ts'

/** Legacy factory surface over the explicit default Provider modules. */
export const BUILTIN_MEMORY_PROVIDER_ADAPTER_FACTORIES: readonly MemoryProviderAdapterFactory[] = BUILTIN_MEMORY_SPACE_PROVIDER_DEFINITIONS.map(definition => ({
  id: definition.manifest.typeId,
  scoreSemantics: definition.manifest.scoreSemantics,
  create: context => definition.create({ ...context, manifest: definition.manifest, providerInstanceId: definition.manifest.typeId }),
}))

export function createBuiltinMemoryProviderAdapterRegistry(): MemoryProviderAdapterRegistry {
  return new MemoryProviderAdapterRegistry(BUILTIN_MEMORY_PROVIDER_ADAPTER_FACTORIES)
}

/** @deprecated Default-bundle compatibility registry, not a Core contribution. */
export const memoryProviderAdapterFactories = createBuiltinMemoryProviderAdapterRegistry()
export function registerMemoryProviderAdapterFactory(factory: MemoryProviderAdapterFactory): () => void {
  return memoryProviderAdapterFactories.register(factory)
}
