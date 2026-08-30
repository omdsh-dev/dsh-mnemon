import type { Context } from '@deepseek-ai/cordis'
import type {
  InstalledMemorySource,
  InstalledMemoryStrategy,
  MemoryPackageProvenance,
  MemorySourceDefinition,
  MemoryStrategyDefinition,
} from "../core/contracts/index.ts"
import type { MemoryRuntime } from './index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The only Mnemon-wide Cordis Service. */
    mnemonMemory: MemoryRuntime
  }
}

export interface MemoryInstallContribution {
  sources?: readonly MemorySourceDefinition[]
  strategies?: readonly MemoryStrategyDefinition[]
}

export interface InstallMemoryOptions {
  /** Required for a direct ctx.plugin() mount that has no stable Loader Entry. */
  instanceId?: string
  artifactDigest?: string
  /** Source-private dependency digest, opaque to Mnemon core. */
  effectiveDigest?: string
}

interface LoaderLike {
  locate(fiber?: unknown): string | undefined
}

interface EntryLike {
  options?: { id?: unknown }
}

function stableEntryId(ctx: Context, explicit: string | undefined): string {
  const configured = explicit?.trim()
  if (configured !== undefined && configured !== '') return configured
  const loader = ctx.get('loader', false) as LoaderLike | undefined
  const located = loader?.locate(ctx.fiber)?.trim()
  if (located !== undefined && located !== '') return located
  const entryId = ((ctx.fiber as unknown as { entry?: EntryLike }).entry?.options?.id)
  if (typeof entryId === 'string' && entryId.trim() !== '') return entryId.trim()
  throw new Error('installMemory requires a stable Loader Entry id; pass options.instanceId for direct ctx.plugin() mounts')
}

function provenance(packageName: string, entryId: string, artifactDigest: string | undefined): MemoryPackageProvenance {
  return {
    packageName,
    entryId,
    ...(artifactDigest === undefined ? {} : { artifactDigest }),
  }
}

function installedSources(definitions: readonly MemorySourceDefinition[], entryId: string, options: InstallMemoryOptions): InstalledMemorySource[] {
  const several = definitions.length > 1
  return definitions.map(definition => ({
    kind: 'source',
    instanceKey: `source:${entryId}${several ? `/${definition.manifest.typeId}` : ''}`,
    provenance: provenance(definition.manifest.packageName, entryId, options.artifactDigest),
    definition,
    ...(options.effectiveDigest === undefined ? {} : { effectiveDigest: options.effectiveDigest }),
  }))
}

function installedStrategies(definitions: readonly MemoryStrategyDefinition[], entryId: string, options: InstallMemoryOptions): InstalledMemoryStrategy[] {
  const several = definitions.length > 1
  return definitions.map(definition => ({
    kind: 'strategy',
    instanceKey: `strategy:${entryId}${several ? `/${definition.manifest.typeId}` : ''}`,
    provenance: provenance(definition.manifest.packageName, entryId, options.artifactDigest),
    definition,
  }))
}

/**
 * Register one plugin's primary contribution and bind it to the calling Fiber.
 * Source and Strategy packages intentionally use the same installation path.
 */
export function installMemory(ctx: Context, contribution: MemoryInstallContribution, options: InstallMemoryOptions = {}): void {
  const sources = [...(contribution.sources ?? [])]
  const strategies = [...(contribution.strategies ?? [])]
  if (sources.length > 0 && strategies.length > 0) {
    throw new Error('one dsh-mnemon plugin cannot install both a Source and a Strategy')
  }
  const entryId = stableEntryId(ctx, options.instanceId)
  ctx.effect(() => ctx.mnemonMemory.installContributions({
    sources: installedSources(sources, entryId, options),
    strategies: installedStrategies(strategies, entryId, options),
  }), `dsh-mnemon: install ${entryId}`)
}
