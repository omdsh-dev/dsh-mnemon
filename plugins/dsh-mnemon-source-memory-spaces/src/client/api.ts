import type { CreateMemoryBodyRequest, EntityView, Insight, MemoryBody, MemoryBodyView, MemoryBodyMetadataMaintenanceResult, MemoryBodyCatalog, MemoryGraphSnapshot, MemoryListRequest, MemoryListView, MemoryReadSource, RememberRequest, SearchRequest, UpdateMemoryBodyRequest } from '../contracts.ts'

/** Source-owned structural page API; the default bundle may supply agent-assisted callbacks. */
export interface MemorySpacesPageClient {
  bodies(): Promise<MemoryBodyCatalog>
  bodyDirectory(): Promise<MemoryBodyCatalog>
  graph(memoryBodyIds?: string[]): Promise<MemoryGraphSnapshot>
  list(request?: MemoryListRequest): Promise<MemoryListView>
  entities(entity?: string, limit?: number): Promise<EntityView>
  search(request: SearchRequest): Promise<SearchResponse>
  agentSearch(request: SearchRequest): Promise<AgentSearchResponse>
  related(id: string, memoryBodyId?: string): Promise<Insight[]>
  remember(request: RememberRequest): Promise<Record<string, unknown>>
  supervise(content: string, idempotencyKey?: string): Promise<{ delegated: true; sessionId: string; runId: string; provider: string; summary: string; action: string; memoryBodyIds: string[] }>
  forget(id: string, memoryBodyId?: string): Promise<Record<string, unknown>>
  createBody(request: CreateMemoryBodyRequest): Promise<MemoryBody>
  updateBody(memoryBodyId: string, request: UpdateMemoryBodyRequest): Promise<MemoryBody>
  reconnectBody(memoryBodyId: string): Promise<MemoryBodyView>
  maintainBodyMetadata(memoryBodyIds: string[]): Promise<MemoryBodyMetadataMaintenanceResult>
  deleteBody(memoryBodyId: string): Promise<MemoryBody>
}

export interface SearchResponse { results: Insight[]; sources?: MemoryReadSource[] }
export interface AgentSearchResponse extends SearchResponse { answer: string; citations: string[]; delegation: { runId: string } }
