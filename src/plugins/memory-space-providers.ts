import type { Context } from '@deepseek-ai/cordis'
import type { MemoryProviderAdapterFactory, MemoryProviderAdapterRegistry } from '../providers/registry.ts'
import { BUILTIN_MEMORY_PROVIDER_ADAPTER_FACTORIES } from '../providers/registry.ts'

/**
 * Build an ordinary child plugin whose only capability is a closure-held
 * registration into its Memory Spaces parent. No ctx.mnemonProvider service
 * exists, and core cannot resolve this host.
 */
export function createMemorySpaceProviderPlugin(
  factory: MemoryProviderAdapterFactory,
  host: MemoryProviderAdapterRegistry,
) {
  return {
    name: `dsh-mnemon-provider-${factory.id}`,
    apply(ctx: Context) {
      ctx.effect(() => host.register(factory), `dsh-mnemon: mount private Provider ${factory.id}`)
    },
  }
}

export const BUILTIN_MEMORY_SPACE_PROVIDER_FACTORIES = BUILTIN_MEMORY_PROVIDER_ADAPTER_FACTORIES
