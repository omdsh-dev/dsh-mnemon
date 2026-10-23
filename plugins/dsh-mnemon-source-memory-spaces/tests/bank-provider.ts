import { defineMemorySpaceProvider, MEMORY_SPACE_PROVIDER_API_VERSION, NORMALIZED_RELEVANCE_SCORE, type MemoryProviderDescriptor } from '../src/provider-sdk.ts'
import type { MemorySpace } from '../src/contracts.ts'

// A Provider whose namespaces are banks, as Hindsight's are, for the write-policy tests (#434).

export interface Row { id: string; content: string; score: number }

export const capabilities: MemoryProviderDescriptor['capabilities'] = { search: true, browse: true, graph: false, entities: false, related: true,
  remember: true, link: true, forget: true, writeMode: 'exact', deletionMode: 'hard' }
export const fields: MemoryProviderDescriptor['fields'] = [{ key: 'bankId', label: 'Bank', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh' }]
export const bankDescriptor: MemoryProviderDescriptor = { id: 'bank', label: 'Bank fixture', kind: 'remote', origin: 'third-party',
  workspaceBinding: 'provider-global', summary: 'One namespace per bank.', fields, capabilities }

/** A Provider with one namespace per bank, as Hindsight has; it records every call that would change a bank. */
export function bankProvider(banks: Record<string, Row[]>) {
  const writes: string[] = []
  const bankOf = (body: MemorySpace) => String(body.provider.settings.bankId ?? 'dsh')
  const module = defineMemorySpaceProvider<undefined>({ id: 'bank', apply(ctx, host) {
    host.install(ctx, {
      manifest: { apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION, kind: 'provider', typeId: 'bank',
        packageName: 'dsh-mnemon-provider-bank-test', version: '1.0.0', label: bankDescriptor.label, summary: bankDescriptor.summary,
        origin: 'third-party', locality: 'remote', workspaceBinding: 'provider-global', fields, secrets: [], scoreSemantics: 'normalized-relevance', capabilities },
      create: () => ({ id: 'bank', scoreSemantics: NORMALIZED_RELEVANCE_SCORE,
        discover: async () => Object.keys(banks).map(bank => ({ externalId: bank, name: bank, description: `The ${bank} bank`, connection: { bankId: bank } })),
        status: async () => ({ healthy: true }),
        list: async body => [...(banks[bankOf(body)] ?? [])],
        search: async body => ({ results: [...(banks[bankOf(body)] ?? [])] }),
        graph: async () => ({ nodes: [], edges: [], generatedAt: new Date().toISOString() }),
        get: async (body, id) => banks[bankOf(body)]?.find(row => row.id === id),
        related: async () => [],
        remember: async (body, request) => {
          writes.push(`remember:${bankOf(body)}`)
          const id = `new-${writes.length}`
          banks[bankOf(body)]?.push({ id, content: request.content, score: 1 })
          return { action: 'stored', id }
        },
        rememberMany: async (body, requests) => requests.map(() => {
          writes.push(`remember-many:${bankOf(body)}`)
          return { action: 'stored', id: `batch-${writes.length}` }
        }),
        forget: async body => { writes.push(`forget:${bankOf(body)}`); return { action: 'deleted' } },
        link: async body => { writes.push(`link:${bankOf(body)}`); return { action: 'linked' } },
      }),
    })
  } })
  return { module, writes }
}
