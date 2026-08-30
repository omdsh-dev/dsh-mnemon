import type { MemoryBody, MemoryProviderConnection, MemoryProviderDescriptor } from './contracts.ts'
import { MemoryProviderCatalog } from './providers/catalog.ts'
import type { MemorySpaceAuthority } from './providers/registry.ts'

/** Driver fixture only: real descriptor validation, no Core or service singleton. */
export function createMemorySpaceProviderFixture(
  descriptor: MemoryProviderDescriptor,
  input: MemoryProviderConnection = {},
  options: { dataDir: string; instanceId?: string; memoryBodyId?: string },
): { body: MemoryBody; authority: MemorySpaceAuthority; connection: MemoryProviderConnection } {
  const instanceId = options.instanceId ?? descriptor.id
  const catalog = new MemoryProviderCatalog([{
    ...descriptor, id: instanceId,
    ...(instanceId === descriptor.id ? {} : { typeId: descriptor.id }),
  }])
  const connection = catalog.normalize(instanceId, input)
  const publicConnection = catalog.public(instanceId, connection)
  const body: MemoryBody = {
    id: options.memoryBodyId ?? 'test-memory', name: 'Test memory', description: 'Provider-owned test fixture',
    active: true, dbPath: '', createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
    provider: {
      id: instanceId,
      ...(instanceId === descriptor.id ? {} : { typeId: descriptor.id }),
      label: descriptor.label, kind: descriptor.kind, origin: descriptor.origin,
      location: String(connection.endpoint ?? options.dataDir),
      apiKeyConfigured: publicConnection.configuredSecrets.includes('apiKey'),
      ...publicConnection, capabilities: structuredClone(descriptor.capabilities),
    },
  }
  const authority: MemorySpaceAuthority = {
    runner: { effectiveDataDir: () => options.dataDir },
    list: () => [body],
    providerConnection(id, expectedProviderId) {
      if (id !== body.id || expectedProviderId !== undefined && expectedProviderId !== instanceId) {
        throw new Error('Provider attempted to cross its test authority boundary')
      }
      return structuredClone(connection)
    },
  }
  return { body, authority, connection }
}
