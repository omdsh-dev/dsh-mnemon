import { ByteRoverProvider } from './byterover.ts'
import { HindsightProvider } from './hindsight.ts'
import { HolographicProvider } from './holographic.ts'
import { HonchoProvider } from './honcho.ts'
import { Mem0Provider } from './mem0.ts'
import { OpenVikingProvider } from './openviking.ts'
import { RetainDbProvider } from './retaindb.ts'
import { SupermemoryProvider } from './supermemory.ts'
import { MemoryProviderAdapterRegistry, type MemoryProviderAdapterFactory } from '../../plugins/dsh-mnemon-source-memory-spaces/src/providers/registry.ts'
export { MemoryProviderAdapterRegistry } from '../../plugins/dsh-mnemon-source-memory-spaces/src/providers/registry.ts'
export type { MemoryProviderAdapterFactory, MemoryProviderAdapterFactoryContext } from '../../plugins/dsh-mnemon-source-memory-spaces/src/providers/registry.ts'

export const BUILTIN_MEMORY_PROVIDER_ADAPTER_FACTORIES: readonly MemoryProviderAdapterFactory[] = [
  { id: 'mnemon-native', scoreSemantics: 'normalized-relevance', create: context => context.nativeAdapter },
  {
    id: 'openviking',
    scoreSemantics: 'normalized-relevance',
    create: context => new OpenVikingProvider(context.memoryBodies, {
      requestTimeoutMs: context.config.timeoutMs,
      settlementTimeoutMs: context.config.timeoutMs,
    }),
  },
  { id: 'honcho', scoreSemantics: 'provider-native', create: context => new HonchoProvider(context.memoryBodies, { requestTimeoutMs: context.config.timeoutMs }) },
  { id: 'mem0', scoreSemantics: 'normalized-relevance', create: context => new Mem0Provider(context.memoryBodies, { requestTimeoutMs: context.config.timeoutMs }) },
  { id: 'hindsight', scoreSemantics: 'normalized-relevance', create: context => new HindsightProvider(context.memoryBodies, { requestTimeoutMs: context.config.timeoutMs }) },
  { id: 'holographic', scoreSemantics: 'normalized-relevance', create: context => new HolographicProvider(context.memoryBodies) },
  { id: 'retaindb', scoreSemantics: 'normalized-relevance', create: context => new RetainDbProvider(context.memoryBodies, { requestTimeoutMs: context.config.timeoutMs }) },
  { id: 'byterover', scoreSemantics: 'normalized-relevance', create: context => new ByteRoverProvider(context.memoryBodies, { queryTimeoutMs: context.config.timeoutMs }) },
  { id: 'supermemory', scoreSemantics: 'normalized-relevance', create: context => new SupermemoryProvider(context.memoryBodies, { requestTimeoutMs: context.config.timeoutMs }) },
]

export function createBuiltinMemoryProviderAdapterRegistry(): MemoryProviderAdapterRegistry {
  return new MemoryProviderAdapterRegistry(BUILTIN_MEMORY_PROVIDER_ADAPTER_FACTORIES)
}

/** Global extension registry sampled when a runtime generation is constructed. */
export const memoryProviderAdapterFactories = createBuiltinMemoryProviderAdapterRegistry()

export function registerMemoryProviderAdapterFactory(factory: MemoryProviderAdapterFactory): () => void {
  return memoryProviderAdapterFactories.register(factory)
}
