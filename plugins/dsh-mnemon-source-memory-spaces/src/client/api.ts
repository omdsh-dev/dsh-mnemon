import type { CreateMemorySpaceRequest, EntityMemoriesView, EntityRelatedView, EntityView, Insight, MemorySpace, MemorySpaceView, MemorySpaceMetadataMaintenanceResult, MemorySpaceCatalog, MemorySpaceRediscovery, MemoryGraphSnapshot, MemoryListRequest, MemoryListView, MemoryProviderViewRequest, MemoryProviderViewResult, MemoryReadSource, MemorySpaceWritePolicy, RememberRequest, SearchRequest, UpdateMemorySpaceRequest } from '../contracts.ts'

/**
 * Source-owned structural page API; the default bundle may supply agent-assisted callbacks.
 * body/bodies method and wire-field spellings remain compatible with existing
 * v0.5.x page clients. All of them operate on the canonical MemorySpace model.
 */
export interface MemorySpacesPageClient {
  bodies(): Promise<MemorySpaceCatalog>
  bodyDirectory(): Promise<MemorySpaceCatalog>
  graph(memoryBodyIds?: string[]): Promise<MemoryGraphSnapshot>
  list(request?: MemoryListRequest): Promise<MemoryListView>
  entities(entity?: string, limit?: number): Promise<EntityView>
  /** Optional for page clients written against an older Source; the Entities page then lists entities(entity) only. */
  entityMemories?(entity: string, offset?: number, limit?: number): Promise<EntityMemoriesView>
  /** view: one id per page view; its next selection cancels the related read it is still waiting for. */
  entityRelated?(entity: string, limit?: number, view?: string): Promise<EntityRelatedView>
  search(request: SearchRequest): Promise<SearchResponse>
  agentSearch(request: SearchRequest): Promise<AgentSearchResponse>
  related(id: string, memoryBodyId?: string): Promise<Insight[]>
  remember(request: RememberRequest): Promise<Record<string, unknown>>
  supervise(content: string, idempotencyKey?: string): Promise<{ delegated: true; sessionId: string; runId: string; provider: string; summary: string; action: string; memoryBodyIds: string[]; unembedded?: Array<{ memoryBodyId?: string; id?: string }> }>
  forget(id: string, memoryBodyId?: string): Promise<Record<string, unknown>>
  createBody(request: CreateMemorySpaceRequest): Promise<MemorySpace>
  updateBody(memoryBodyId: string, request: UpdateMemorySpaceRequest): Promise<MemorySpace>
  /** One view the space's Provider declares; optional for page clients written against an older Source. */
  providerView?(memoryBodyId: string, request: MemoryProviderViewRequest): Promise<MemoryProviderViewResult>
  /** Whether DSH may write to the space's namespace; optional for page clients written against an older Source (#434). */
  setWritePolicy?(memoryBodyId: string, policy: MemorySpaceWritePolicy): Promise<MemorySpace>
  /** Forget every write choice when the file cannot be read; optional for page clients written against an older Source. */
  resetWritePolicy?(): Promise<MemorySpaceCatalog>
  reconnectBody(memoryBodyId: string): Promise<MemorySpaceView>
  maintainBodyMetadata(memoryBodyIds: string[]): Promise<MemorySpaceMetadataMaintenanceResult>
  deleteBody(memoryBodyId: string): Promise<MemorySpace>
  /** Ask every enabled Provider again for namespaces it gained; optional for page clients written against an older Source. */
  rediscoverBodies?(): Promise<MemorySpaceRediscovery>
}

export interface SearchResponse { results: Insight[]; sources?: MemoryReadSource[] }
export interface AgentSearchResponse extends SearchResponse { answer: string; citations: string[]; delegation: { runId: string } }
