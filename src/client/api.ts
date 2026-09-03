import {
  MNEMON_ACTIVATION_CHANNEL,
  MNEMON_PACK_CHANNEL,
  MNEMON_READ_CHANNEL,
  MNEMON_WRITE_CHANNEL,
  MNEMON_VIEW_CHANNEL,
  MNEMON_VIEW_WRITE_CHANNEL,
  type MemoryViewDashboard,
  type MemoryViewInspection,
  type MemoryViewConfigurationRequest,
  type MemoryPluginInspection,
  type MemoryPluginInstallResult,
  type AssistantMessageText,
  type CreateMemoryBodyRequest,
  type ClientConnectionHandle,
  type DocumentMutation,
  type DocumentMutationResult,
  type DocumentSearchResult,
  type DocumentSnapshot,
  type DocumentView,
  type EntityView,
  type Insight,
  type JsonValue,
  type MemoryBody,
  type MemoryBodyView,
  type MemoryBodyMetadataMaintenanceResult,
  type MemoryBodyCatalog,
  type MemoryProviderServiceCatalog,
  type MemoryProviderServiceView,
  type MemoryGraphSnapshot,
  type MemoryListRequest,
  type MemoryListView,
  type MemoryProviderId,
  type MemoryCompositionStatus,
  type MemoryReadSource,
  type MemorySourceManagementCatalog,
  type MemorySourceManagementResult,
  type MnemonPackExport,
  type MnemonPackImportResult,
  type MnemonPackPreview,
  type MnemonEmbeddingStatus,
  type RememberRequest,
  type RuntimeMemoryImportance,
  type RuntimeMemoryMutationResult,
  type RuntimeMemorySnapshot,
  type RuntimeMemoryTarget,
  type SearchRequest,
  type StatusView,
  type TaskAgentModelCatalog,
  type TurnMemoryActivity,
  type TurnMemoryActivitySnapshot,
  type UpdateMemoryBodyRequest,
  type UpdateMemoryProviderServiceRequest,
  type VersionComponentId,
  type VersionStatus,
  type VersionUpdateResult,
} from "../host/protocol.ts"

interface TurnActivityCacheEntry {
  cursor: number
  activities: Map<number, TurnMemoryActivity>
  inFlight?: Promise<TurnMemoryActivitySnapshot>
}

const turnActivityCache = new WeakMap<ClientConnectionHandle, Map<string, TurnActivityCacheEntry>>()

function isActivationOnly(request: UpdateMemoryBodyRequest): request is UpdateMemoryBodyRequest & { active: boolean } {
  return typeof request.active === 'boolean'
    && Object.entries(request).every(([field, value]) => field === 'active' || value === undefined)
}

async function loadTurnActivities(connection: ClientConnectionHandle, sessionId: string | undefined, requiredCursor: number): Promise<TurnMemoryActivitySnapshot> {
  let sessions = turnActivityCache.get(connection)
  if (sessions === undefined) {
    sessions = new Map()
    turnActivityCache.set(connection, sessions)
  }
  const key = sessionId ?? ''
  let entry = sessions.get(key)
  if (entry === undefined) {
    entry = { cursor: -1, activities: new Map() }
    sessions.set(key, entry)
  }
  if (entry.cursor >= requiredCursor) return { cursor: entry.cursor, activities: [...entry.activities.values()] }
  if (entry.inFlight !== undefined) {
    const snapshot = await entry.inFlight
    return snapshot.cursor >= requiredCursor ? snapshot : loadTurnActivities(connection, sessionId, requiredCursor)
  }

  const request = connection.rpc.call(MNEMON_READ_CHANNEL, 'turn-activities', sessionId === undefined ? {} : { sessionId })
    .then(response => {
      if (!response.ok) throw new Error(response.error.message)
      const snapshot = response.value as TurnMemoryActivitySnapshot
      entry!.cursor = snapshot.cursor
      entry!.activities = new Map(snapshot.activities.map(activity => [activity.turn, activity]))
      return snapshot
    })
    .finally(() => { delete entry!.inFlight })
  entry.inFlight = request
  return request
}

export interface SearchResponse {
  query: string
  mode: string
  results: Insight[]
  hint?: string
  /** Omitted only when talking to a pre-provider-aware Host. */
  sources?: MemoryReadSource[]
}

export interface AgentSearchResponse extends SearchResponse {
  answer: string
  citations: string[]
  delegation: { runId: string; provider: string }
}

export class MnemonClient {
  constructor(private readonly connection: ClientConnectionHandle, private readonly sessionId?: string, private readonly workspaceId?: string) {}

  private async call<T>(channel: string, endpoint: string, payload: unknown): Promise<T> {
    const response = await this.connection.rpc.call(channel, endpoint, payload)
    if (!response.ok) throw new Error(response.error.message)
    return response.value as T
  }

  private scoped<T extends object = Record<string, never>>(payload: T = {} as T): T & { sessionId?: string; workspaceId?: string } {
    return {
      ...payload,
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(this.workspaceId === undefined ? {} : { workspaceId: this.workspaceId }),
    }
  }

  status(): Promise<StatusView> {
    return this.call(MNEMON_READ_CHANNEL, 'status', this.scoped())
  }

  statusSummary(): Promise<StatusView> {
    return this.call(MNEMON_READ_CHANNEL, 'status-summary', this.scoped())
  }

  embeddingStatus(): Promise<MnemonEmbeddingStatus> {
    return this.call(MNEMON_READ_CHANNEL, 'embedding-status', this.scoped())
  }

  memorySystem(): Promise<MemoryCompositionStatus> {
    return this.call(MNEMON_READ_CHANNEL, 'memory-system', this.scoped())
  }

  viewDashboard(): Promise<MemoryViewDashboard> { return this.call(MNEMON_VIEW_CHANNEL, 'dashboard', this.scoped()) }
  previewView(configuration: MemoryViewConfigurationRequest): Promise<MemoryViewInspection> {
    return this.call(MNEMON_VIEW_CHANNEL, 'preview', this.scoped({ configuration }))
  }
  applyView(configuration: MemoryViewConfigurationRequest): Promise<{ saved: true }> {
    return this.call(MNEMON_VIEW_WRITE_CHANNEL, 'apply', this.scoped({ configuration, confirmed: true }))
  }
  inspectMemoryPlugin(packageName: string): Promise<MemoryPluginInspection> {
    return this.call(MNEMON_VIEW_CHANNEL, 'inspect-plugin', { packageName })
  }
  installMemoryPlugin(packageName: string, version: string): Promise<MemoryPluginInstallResult> {
    return this.call(MNEMON_VIEW_WRITE_CHANNEL, 'install-plugin', { packageName, version, confirmed: true })
  }
  setSourceMemoryPluginEnabled(entryId: string, enabled: boolean): Promise<{ saved: true }> {
    return this.call(MNEMON_VIEW_WRITE_CHANNEL, 'set-source-plugin-enabled', { entryId, enabled, confirmed: true })
  }

  sourceManagementCatalog(): Promise<MemorySourceManagementCatalog> {
    return this.call(MNEMON_READ_CHANNEL, 'source-management-catalog', this.scoped())
  }

  readSourceManagement(sourceInstanceKey: string, operation: string, input: JsonValue = null): Promise<MemorySourceManagementResult> {
    return this.call(MNEMON_READ_CHANNEL, 'source-management-read', this.scoped({ sourceInstanceKey, operation, input }))
  }

  mutateSourceManagement(sourceInstanceKey: string, operation: string, input: JsonValue, expectedRevision: string, confirmed: boolean): Promise<MemorySourceManagementResult> {
    return this.call(MNEMON_WRITE_CHANNEL, 'source-management-mutate', this.scoped({ sourceInstanceKey, operation, input, expectedRevision, confirmed }))
  }

  assistSource(sourceInstanceKey: string, operation: string, input: JsonValue, expectedRevision: string, confirmed: boolean): Promise<MemorySourceManagementResult> {
    return this.call(operation === 'activation' ? MNEMON_ACTIVATION_CHANNEL : confirmed ? MNEMON_WRITE_CHANNEL : MNEMON_READ_CHANNEL, 'source-assistance', this.scoped({ sourceInstanceKey, operation, input, expectedRevision, confirmed }))
  }

  taskAgentModels(includeCatalog?: boolean): Promise<TaskAgentModelCatalog> {
    return this.call(MNEMON_READ_CHANNEL, 'task-agent-models', includeCatalog === undefined ? {} : { includeCatalog })
  }

  versions(): Promise<VersionStatus> {
    return this.call(MNEMON_READ_CHANNEL, 'versions', {})
  }

  updateVersion(component: VersionComponentId): Promise<VersionUpdateResult> {
    return this.call(MNEMON_WRITE_CHANNEL, 'version-update', { component })
  }

  runtimeMemory(): Promise<RuntimeMemorySnapshot> {
    return this.call(MNEMON_READ_CHANNEL, 'runtime-memory', this.scoped())
  }

  mutateRuntimeMemory(request: {
    action: 'add' | 'replace' | 'remove'
    target: RuntimeMemoryTarget
    content?: string
    old_text?: string
    importance?: RuntimeMemoryImportance
    branches?: string[]
  }): Promise<RuntimeMemoryMutationResult> {
    return this.call(MNEMON_WRITE_CHANNEL, 'runtime-memory', this.scoped(request))
  }

  documents(): Promise<DocumentSnapshot> {
    return this.call(MNEMON_READ_CHANNEL, 'documents', this.scoped())
  }

  document(id: string): Promise<DocumentView> {
    return this.call(MNEMON_READ_CHANNEL, 'document', this.scoped({ id }))
  }

  searchDocuments(query: string, includeArchived = false, limit = 50): Promise<DocumentSearchResult> {
    return this.call(MNEMON_READ_CHANNEL, 'document-search', this.scoped({ query, includeArchived, limit }))
  }

  mutateDocument(request: DocumentMutation): Promise<DocumentMutationResult> {
    return this.call(MNEMON_WRITE_CHANNEL, 'document', this.scoped(request))
  }

  archiveDocument(id: string): Promise<DocumentMutationResult> {
    return this.call(MNEMON_WRITE_CHANNEL, 'document', this.scoped({ action: 'archive', id }))
  }

  bodies(): Promise<MemoryBodyCatalog> {
    return this.call(MNEMON_READ_CHANNEL, 'bodies', this.scoped())
  }

  bodyDirectory(): Promise<MemoryBodyCatalog> {
    return this.call(MNEMON_READ_CHANNEL, 'body-directory', this.scoped())
  }

  providerServices(): Promise<MemoryProviderServiceCatalog> {
    return this.call(MNEMON_READ_CHANNEL, 'provider-services', this.scoped())
  }

  updateProviderService(request: UpdateMemoryProviderServiceRequest): Promise<MemoryProviderServiceView> {
    return this.call(MNEMON_WRITE_CHANNEL, 'provider-service-update', this.scoped(request))
  }

  graph(memoryBodyIds?: string[]): Promise<MemoryGraphSnapshot> {
    return this.call(MNEMON_READ_CHANNEL, 'graph', this.scoped(memoryBodyIds === undefined ? {} : { memoryBodyIds }))
  }

  list(request: MemoryListRequest = {}): Promise<MemoryListView> {
    return this.call(MNEMON_READ_CHANNEL, 'list', this.scoped(request))
  }

  entities(entity?: string, limit?: number): Promise<EntityView> {
    return this.call(MNEMON_READ_CHANNEL, 'entities', this.scoped({
      ...(entity === undefined ? {} : { entity }),
      ...(limit === undefined ? {} : { limit }),
    }))
  }

  search(request: SearchRequest): Promise<SearchResponse> {
    return this.call(MNEMON_READ_CHANNEL, 'search', this.scoped(request))
  }

  agentSearch(request: SearchRequest): Promise<AgentSearchResponse> {
    return this.call(MNEMON_READ_CHANNEL, 'agent-search', this.scoped(request))
  }

  related(id: string, memoryBodyId?: string): Promise<Insight[]> {
    return this.call(MNEMON_READ_CHANNEL, 'related', this.scoped({ id, depth: 2, ...(memoryBodyId === undefined ? {} : { memoryBodyId }) }))
  }

  /** Settled memory-tool activity of one turn, shared across all mounted tails. */
  async turnActivity(turn: number, cursor = 0): Promise<TurnMemoryActivity | null> {
    const snapshot = await loadTurnActivities(this.connection, this.sessionId, cursor)
    return snapshot.activities.find(activity => activity.turn === turn) ?? null
  }

  /** Plain text of one finalized assistant message; null when absent or empty. */
  assistantMessageText(messageId: string): Promise<AssistantMessageText | null> {
    return this.call(MNEMON_READ_CHANNEL, 'assistant-message', { sessionId: this.sessionId, messageId })
  }

  remember(request: RememberRequest): Promise<Record<string, unknown>> {
    return this.call(MNEMON_WRITE_CHANNEL, 'remember', this.scoped(request))
  }

  supervise(content: string, idempotencyKey?: string): Promise<{ delegated: true; sessionId: string; runId: string; provider: string; summary: string; action: string; memoryBodyIds: string[] }> {
    return this.call(MNEMON_WRITE_CHANNEL, 'supervise', this.scoped({ content, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }))
  }

  forget(id: string, memoryBodyId?: string): Promise<Record<string, unknown>> {
    return this.call(MNEMON_WRITE_CHANNEL, 'forget', this.scoped({ id, ...(memoryBodyId === undefined ? {} : { memoryBodyId }) }))
  }

  createBody(request: CreateMemoryBodyRequest): Promise<MemoryBody> {
    return this.call(MNEMON_WRITE_CHANNEL, 'body-create', this.scoped(request))
  }

  updateBody(memoryBodyId: string, request: UpdateMemoryBodyRequest): Promise<MemoryBody> {
    return isActivationOnly(request)
      ? this.call(MNEMON_ACTIVATION_CHANNEL, 'body', this.scoped({ memoryBodyId, active: request.active }))
      : this.call(MNEMON_WRITE_CHANNEL, 'body-update', this.scoped({ memoryBodyId, ...request }))
  }

  reconnectBody(memoryBodyId: string): Promise<MemoryBodyView> {
    return this.call(MNEMON_READ_CHANNEL, 'body-reconnect', this.scoped({ memoryBodyId }))
  }

  maintainBodyMetadata(memoryBodyIds: string[]): Promise<MemoryBodyMetadataMaintenanceResult> {
    return this.call(MNEMON_WRITE_CHANNEL, 'body-metadata-maintain', this.scoped({ memoryBodyIds }))
  }

  deleteBody(memoryBodyId: string): Promise<MemoryBody> {
    return this.call(MNEMON_WRITE_CHANNEL, 'body-delete', this.scoped({ memoryBodyId }))
  }

  packTarget(): Promise<{ root: string; scope: 'global' | 'workspace' | 'custom' }> {
    return this.call(MNEMON_PACK_CHANNEL, 'target', this.scoped())
  }

  exportPack(): Promise<MnemonPackExport> {
    return this.call(MNEMON_PACK_CHANNEL, 'export', this.scoped())
  }

  inspectPack(base64: string, fileName?: string): Promise<MnemonPackPreview> {
    return this.call(MNEMON_PACK_CHANNEL, 'inspect', this.scoped({ base64, ...(fileName === undefined ? {} : { fileName }) }))
  }

  importPack(base64: string): Promise<MnemonPackImportResult> {
    return this.call(MNEMON_PACK_CHANNEL, 'import', this.scoped({ base64 }))
  }
}
