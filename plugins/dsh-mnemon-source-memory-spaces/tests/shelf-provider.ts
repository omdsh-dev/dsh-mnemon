import { defineMemorySpaceProvider, MEMORY_SPACE_PROVIDER_API_VERSION, NORMALIZED_RELEVANCE_SCORE, type MemoryProviderAdapter } from '../src/provider-sdk.ts'
import type { MemoryProviderViewRequest, MemoryProviderViewResult, MemorySpaceIntegration } from '../src/contracts.ts'
import type { MemorySpaceProviderProfile } from '../src/providers/profile.ts'
import { capabilities, fields } from './bank-provider.ts'

// A Provider that declares views and may report a vendor plugin beside it, for the Provider view tests.

export const SHELF_VIEWS = [{ id: 'shelf', kind: 'files' as const, label: 'Shelf' }, { id: 'log', kind: 'changes' as const, label: 'Log' }]

export function shelfProvider(view: (request: MemoryProviderViewRequest) => MemoryProviderViewResult, integration?: MemorySpaceIntegration & Record<string, unknown>) {
  const lent: Array<MemorySpaceProviderProfile | undefined> = []
  const writes: string[] = []
  const manifest = { apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION, kind: 'provider' as const, typeId: 'shelf',
    packageName: 'dsh-mnemon-provider-shelf-test', version: '1.0.0', label: 'Shelf fixture', summary: 'One namespace per shelf.',
    origin: 'third-party' as const, locality: 'remote' as const, workspaceBinding: 'provider-global' as const, fields, secrets: [],
    scoreSemantics: 'normalized-relevance' as const, capabilities, views: SHELF_VIEWS }
  const module = defineMemorySpaceProvider<undefined>({ id: 'shelf', apply(ctx, host) {
    host.install(ctx, { manifest, create: context => {
      lent.push(context.profile)
      const adapter: MemoryProviderAdapter = { id: 'shelf', scoreSemantics: NORMALIZED_RELEVANCE_SCORE,
        discover: async () => [{ externalId: 'main', name: 'main', description: 'The main shelf', connection: { bankId: 'main' } }],
        status: async () => ({ healthy: true, ...(integration === undefined ? {} : { integration }) }),
        list: async () => [], search: async () => ({ results: [] }), graph: async () => ({ nodes: [], edges: [], generatedAt: new Date().toISOString() }),
        related: async () => [],
        remember: async () => { writes.push('remember'); return { action: 'stored' } },
        link: async () => { writes.push('link'); return { action: 'linked' } },
        forget: async () => { writes.push('forget'); return { action: 'deleted' } },
        view: async (_body, request) => structuredClone(view(request)),
      }
      return adapter
    } })
  } })
  return { module, lent, writes }
}
