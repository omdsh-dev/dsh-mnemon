import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import { installMemorySpaces as installSource, resolveMemorySpaceProviderEntries as resolveEntries, MemorySpaceProviderDeclarationSchema, type Config as SourceConfig, type InstallMemorySpacesOptions, type MemorySpaceProviderDeclaration } from '../../plugins/dsh-mnemon-source-memory-spaces/src/index.ts'
import { MemorySpacesConfig } from '../../plugins/dsh-mnemon-source-memory-spaces/src/config.ts'
import type { MemorySpaceProviderEntry } from '../../plugins/dsh-mnemon-source-memory-spaces/src/providers/host.ts'
import { BUILTIN_MEMORY_SPACE_PROVIDER_ENTRIES } from '../memory-spaces/builtin-providers.ts'
export { name, inject } from '../../plugins/dsh-mnemon-source-memory-spaces/src/index.ts'
export { MEMORY_SPACES_SOURCE } from '../composable/source-memory-spaces.ts'
export type { InstallMemorySpacesOptions, MemorySpaceProviderDeclaration }
export type Config = SourceConfig
const defaults = BUILTIN_MEMORY_SPACE_PROVIDER_ENTRIES.map(entry => entry.instanceId)
export const Config = z.intersect([MemorySpacesConfig, z.object({
  providers: z.array(z.union([z.string(), MemorySpaceProviderDeclarationSchema] as const)).default(defaults),
})]) as unknown as z<Config>

/** Default-bundle compatibility entry; the Source itself has no built-in imports. */
export const resolveMemorySpaceProviderEntries = (ctx: Context, declarations: readonly (string | MemorySpaceProviderDeclaration)[]) => resolveEntries(ctx, declarations, BUILTIN_MEMORY_SPACE_PROVIDER_ENTRIES)
export const installMemorySpaces = (ctx: Context, entries: readonly MemorySpaceProviderEntry[] = BUILTIN_MEMORY_SPACE_PROVIDER_ENTRIES, options: InstallMemorySpacesOptions = {}) => installSource(ctx, entries, options)
export async function apply(ctx: Context, config: Config = { providers: [...defaults] }): Promise<void> {
  const { providers, ...sourceConfig } = config
  await installSource(ctx, await resolveMemorySpaceProviderEntries(ctx, providers), { config: sourceConfig })
}
