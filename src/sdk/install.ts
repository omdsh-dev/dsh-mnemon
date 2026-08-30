import type { Context } from '@deepseek-ai/cordis'
import type { InstallMemoryOptions, MemoryInstallContribution } from './service.ts'

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

/**
 * Register a plugin's Source and/or Strategy definitions as one Fiber-owned batch.
 * Contribution roles do not dictate package or repository boundaries.
 */
export function installMemory(ctx: Context, contribution: MemoryInstallContribution, options: InstallMemoryOptions = {}): void {
  const entryId = stableEntryId(ctx, options.instanceId)
  ctx.effect(() => ctx.mnemonMemory.installContributions(contribution, {
    ...options, instanceId: entryId,
  }), `dsh-mnemon: install ${entryId}`)
}
