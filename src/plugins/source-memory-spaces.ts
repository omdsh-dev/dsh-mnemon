import type { Context } from '@deepseek-ai/cordis'
import { installMemory } from '../../packages/extension-sdk/src/index.ts'
import { createMemorySpacesSource, MEMORY_SPACES_SOURCE } from '../composable/source-memory-spaces.ts'
import { MemoryProviderAdapterRegistry } from '../providers/registry.ts'
import { BUILTIN_MEMORY_SPACE_PROVIDER_FACTORIES, createMemorySpaceProviderPlugin } from './memory-space-providers.ts'

export const name = 'dsh-mnemon-source-memory-spaces'
export const inject = ['mnemonMemory']

export async function apply(ctx: Context): Promise<void> {
  const privateHost = new MemoryProviderAdapterRegistry()
  const children = BUILTIN_MEMORY_SPACE_PROVIDER_FACTORIES.map(factory => ctx.plugin(createMemorySpaceProviderPlugin(factory, privateHost)))
  await Promise.all(children.map(child => child.await()))
  installMemory(ctx, { sources: [createMemorySpacesSource(privateHost)] }, {
    effectiveDigest: `providers:${privateHost.ids().join(',')}`,
  })
}

export { MEMORY_SPACES_SOURCE }
