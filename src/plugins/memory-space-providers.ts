import type { Context, Plugin } from '@deepseek-ai/cordis'
import {
  PrivateMemorySpaceProviderHost,
  type MemorySpaceProviderEntry,
} from '../memory-spaces/provider-sdk.ts'
import {
  BUILTIN_MEMORY_SPACE_PROVIDER_ENTRIES,
  BUILTIN_MEMORY_SPACE_PROVIDER_MODULES,
} from '../memory-spaces/builtin-providers.ts'

/**
 * Build an ordinary child plugin whose only capability is a closure-held
 * registration into its Memory Spaces parent. No ctx.mnemonProvider service
 * exists, and core cannot resolve this host.
 */
export function createMemorySpaceProviderPlugin<Config>(
  entry: MemorySpaceProviderEntry<Config>,
  host: PrivateMemorySpaceProviderHost,
): Plugin.Object<Config> {
  const boundHost = host.bind(entry.instanceId, entry.module.id, entry.config)
  const plugin: Plugin.Object<Config> = {
    name: `dsh-mnemon-provider-${entry.module.id}`,
    apply(ctx: Context, config: Config = entry.config) {
      return entry.module.apply(ctx, boundHost, config)
    },
  }
  if (entry.module.Config !== undefined) plugin.Config = entry.module.Config
  return plugin
}

export {
  BUILTIN_MEMORY_SPACE_PROVIDER_ENTRIES,
  BUILTIN_MEMORY_SPACE_PROVIDER_MODULES,
}

/** @deprecated Factory-only SPI retained for v0.3 source compatibility. */
export { BUILTIN_MEMORY_PROVIDER_ADAPTER_FACTORIES as BUILTIN_MEMORY_SPACE_PROVIDER_FACTORIES } from '../providers/registry.ts'
