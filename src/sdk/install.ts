import type { Context } from '@deepseek-ai/cordis'
import type { InstallMemoryOptions, MemoryInstallContribution } from './service.ts'

interface LoaderLike {
  locate(fiber?: unknown): string | undefined
}

function locatedEntryId(ctx: Context): string | undefined {
  const loader = ctx.get('loader', false) as LoaderLike | undefined
  const located = loader?.locate(ctx.fiber)?.trim()
  return located === '' ? undefined : located
}

function stableEntryId(ctx: Context, explicit: string | undefined): string {
  const configured = explicit?.trim()
  if (configured !== undefined && configured !== '') return configured
  const located = locatedEntryId(ctx)
  if (located !== undefined) return located
  throw new Error('installMemory requires a stable Loader Entry id; pass options.instanceId for direct ctx.plugin() mounts')
}

const MARKET_CLIENT_SHIM = /(?:^|:)mkt-client-[^:]*$/u

export function installMemory(ctx: Context, contribution: MemoryInstallContribution, options: InstallMemoryOptions = {}): void {
  if (MARKET_CLIENT_SHIM.test(locatedEntryId(ctx) ?? '')) return
  const entryId = stableEntryId(ctx, options.instanceId)
  ctx.effect(() => ctx.mnemonMemory.installContributions(contribution, {
    ...options, instanceId: entryId,
  }), `dsh-mnemon: install ${entryId}`)
}
