import type { MemoryComponentHost } from 'dsh-mnemon/client'
import type { MemoryProviderServiceCatalog, MemoryProviderServiceView, MnemonEmbeddingFill, MnemonEmbeddingStatus, UpdateMemoryProviderServiceRequest } from '../contracts.ts'

export interface MemorySpacesSettingsClient {
  statusSummary(): Promise<{ commandFound: boolean }>
  providerServices(): Promise<MemoryProviderServiceCatalog>
  updateProviderService(request: UpdateMemoryProviderServiceRequest): Promise<MemoryProviderServiceView>
  embeddingStatus(): Promise<MnemonEmbeddingStatus>
  fillEmbeddings(memoryBodyId: string): Promise<MnemonEmbeddingFill>
}

type Operations = NonNullable<MemoryComponentHost['operations']>

const clients = new WeakMap<Operations, MemorySpacesSettingsClient>()

export function memorySpacesSettingsClient(operations: Operations): MemorySpacesSettingsClient {
  let client = clients.get(operations)
  if (client === undefined) {
    client = {
      statusSummary: () => operations.read('status-summary') as Promise<{ commandFound: boolean }>,
      providerServices: () => operations.read('provider-services') as Promise<MemoryProviderServiceCatalog>,
      updateProviderService: request => operations.write('provider-service-update', JSON.parse(JSON.stringify(request))) as Promise<MemoryProviderServiceView>,
      embeddingStatus: () => operations.read('embedding-status') as Promise<MnemonEmbeddingStatus>,
      fillEmbeddings: memoryBodyId => operations.write('embedding-fill', { memoryBodyId }) as Promise<MnemonEmbeddingFill>,
    }
    clients.set(operations, client)
  }
  return client
}
