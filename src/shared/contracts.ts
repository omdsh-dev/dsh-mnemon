import type { ConnectionHandle as DshClientConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { MemoryLayerParticipation, MemorySystemDescriptor } from '../memory-system/contracts.ts'
export type {
  MemoryLayerParticipation,
  MemoryParticipationChannel,
  MemoryParticipationMode,
  MemorySystemDescriptor,
  MemoryTopologyDefinition,
} from '../memory-system/contracts.ts'

export const MNEMON_READ_CHANNEL = '/dsh-mnemon-read'
export const MNEMON_ACTIVATION_CHANNEL = '/dsh-mnemon-activation'
export const MNEMON_WRITE_CHANNEL = '/dsh-mnemon-write'
export const MNEMON_PACK_CHANNEL = '/dsh-mnemon-pack'
export const MNEMON_SETTINGS_CHANNEL = '/dsh-mnemon-settings'
export const MNEMON_SETTINGS_NAMESPACE = 'mnemon'
export const MNEMON_UI_SETTINGS_NAMESPACE = 'mnemon-ui'
export const DEFAULT_EMBEDDING_ENDPOINT = 'http://localhost:11434'
export const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text'
export const EMBEDDING_PROTOCOL_AUTO = 'auto'
export const EMBEDDING_PROTOCOL_OLLAMA = 'ollama'
export const EMBEDDING_PROTOCOL_OPENAI = 'openai'
/** Default protocol defers to Mnemon's /v1 auto-detection. */
export const DEFAULT_EMBEDDING_PROTOCOL = EMBEDDING_PROTOCOL_AUTO
/** Wire protocols accepted by the embedding protocol override; single source for schema, resolver, and UI validation. */
export const MNEMON_EMBEDDING_PROTOCOLS = [EMBEDDING_PROTOCOL_AUTO, EMBEDDING_PROTOCOL_OLLAMA, EMBEDDING_PROTOCOL_OPENAI] as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface MemorySourceManagementField {
  key: string
  label: string
  description?: string
  input: 'text' | 'number' | 'boolean' | 'url' | 'secret' | 'select'
  required: boolean
  secret?: boolean
  options?: Array<{ value: string; label: string }>
}

/** Browser-safe descriptor of one Source instance visible in the current scope. */
export interface MemorySourceManagementInstance {
  sourceInstanceKey: string
  sourceTypeId: string
  packageName: string
  role: string
  availability: 'ready' | 'degraded' | 'unavailable'
  revision: string
  capabilities: string[]
  management: {
    label: string
    description: string
    fields?: MemorySourceManagementField[]
    diagnostics?: string[]
  }
  hints?: JsonValue
}

export interface MemorySourceManagementCatalog {
  generationId: string
  sources: MemorySourceManagementInstance[]
}

export interface MemorySourceManagementResult {
  revision: string
  value: JsonValue
}

export type RpcError =
  | { code: 'bad-request'; message: string; details: { issues: JsonValue[] } }
  | { code: 'settings-rejected'; message: string; details: { ns: string } }
  | { code: 'internal'; message: string; details: Record<string, never> }

export type RpcResult<T = JsonValue> =
  | { ok: true; value: T }
  | { ok: false; error: RpcError }

/** Public DSH browser RPC face plus the transport boundary needed to gate local-only writes. */
export type ClientConnectionHandle = Pick<DshClientConnectionHandle, 'rpc'> & Partial<Pick<DshClientConnectionHandle, 'isLoopback'>>

export interface ClientSettingsSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value?: T
  base?: unknown
  user?: unknown
  revision?: number
  writable: boolean
  mode: 'host' | 'memory'
}

export interface ClientSettingsScope<T> {
  getSnapshot(): ClientSettingsSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
  setPath(path: string[], value: unknown): Promise<void>
  unsetPath(path: string[]): Promise<void>
  mutate?(ops: SettingsOperation[]): Promise<void>
}

export type SettingsOperation = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }

export type StorageScopeKind = 'global' | 'workspace' | 'custom'

export interface MemoryLayerConfig {
  enabled?: boolean
  participation?: Partial<MemoryLayerParticipation>
  adapterIds?: string[]
}

export interface MemoryTopologyConfig {
  id?: string
  strategyId?: string
  layers?: Record<string, MemoryLayerConfig>
}

export interface ResolvedMemoryLayerConfig {
  enabled: boolean
  participation: MemoryLayerParticipation
  adapterIds: string[]
}

export interface ResolvedMemoryTopologyConfig {
  id: string
  strategyId: string
  layers: Record<string, ResolvedMemoryLayerConfig>
}

export interface CustomPackConfig {
  id: string
  name: string
  dataDir: string
}

export interface RecallQualityConfig {
  /** Registered deterministic policy id. */
  policy?: string
  lowScoreThreshold?: number
  highScoreThreshold?: number
  /** Provider candidate expansion before quality filtering, from 1 through 5. */
  candidateMultiplier?: number
  /** Maximum medium-relevance rows admitted by the strict policy. */
  maxMediumResults?: number
  /** Maximum unknown-scale or unscored rows admitted by the strict policy. */
  maxUnknownResults?: number
}

export interface RuntimeMemoryConfig {
  /** Maximum UTF-8 bytes projected into MEMORY.md. */
  memoryLimitBytes?: number
  /** Maximum UTF-8 bytes projected into USER.md. */
  userLimitBytes?: number
  /** Completion-token budget for Runtime migration and compaction workers. */
  maintenanceMaxTokens?: number
}

export interface ResolvedRuntimeMemoryConfig {
  memoryLimitBytes: number
  userLimitBytes: number
  maintenanceMaxTokens: number
}

export interface ResolvedRecallQualityConfig {
  policy: string
  lowScoreThreshold: number
  highScoreThreshold: number
  candidateMultiplier: number
  maxMediumResults: number
  maxUnknownResults: number
}

export { normalizeDisplayMode } from './display-mode.ts'
export type MnemonDisplayMode = 'sidebar' | 'builtin'

export interface Config {
  storageScope?: StorageScopeKind
  /** Whether USER.md follows the selected storage root or stays in the global root. */
  runtimeUserScope?: 'storage' | 'global'
  cliPath?: string
  dataDir?: string
  customPackId?: string
  customPacks?: CustomPackConfig[]
  store?: string
  timeoutMs?: number
  defaultRecallLimit?: number
  runtimeMemory?: RuntimeMemoryConfig
  /** Optional DSH-owned overrides injected into every Mnemon CLI process. */
  embedding?: MnemonEmbeddingConfig
  memoryTopology?: MemoryTopologyConfig
  recallQuality?: RecallQualityConfig
  routingGuidance?: boolean
  /** Entry placement only. Legacy `buildin` input is migrated to `builtin`. */
  displayMode?: MnemonDisplayMode | 'buildin'
  tabEnabled?: boolean
  writeEnabled?: boolean
  /** DSH rc.2 management-channel authority; ignored by DSH 0.1.2-alpha.1. */
  remoteAccess?: 'read-only' | 'trusted-host'
  lifecycleEnabled?: boolean
  recallMode?: 'guided' | 'off'
  writebackMode?: 'guided' | 'off'
  idleReviewMs?: number
  conversationInteraction?: {
    toolviews?: boolean
    turnBar?: boolean
    saveAction?: boolean
  }
  /** Provider policy used when an Agent must create a new Memory Space while distilling memory. */
  persistenceStrategy?: MemoryPersistenceStrategy
  /** Model route used by clean, session-independent maintenance Agents. */
  taskAgentModel?: TaskAgentModelConfig
}

export type MnemonEmbeddingProtocol = (typeof MNEMON_EMBEDDING_PROTOCOLS)[number]

export interface MnemonEmbeddingConfig {
  /** When false or omitted, Mnemon keeps its inherited environment and built-in defaults. */
  enabled?: boolean
  endpoint?: string
  model?: string
  /** Optional Bearer token forwarded as MNEMON_EMBED_API_KEY for OpenAI-compatible endpoints. */
  apiKey?: string
  /** Explicit wire-protocol override; 'auto' keeps Mnemon's /v1 auto-detection. */
  protocol?: MnemonEmbeddingProtocol
}

export interface ResolvedMnemonEmbeddingConfig {
  enabled: boolean
  endpoint: string
  model: string
  apiKey: string
  protocol: MnemonEmbeddingProtocol
}

export interface TaskAgentModelConfig {
  mode?: 'inherit' | 'fixed'
  provider?: string
  model?: string
}

export interface ResolvedTaskAgentModelConfig {
  mode: 'inherit' | 'fixed'
  provider?: string
  model?: string
}

export interface TaskAgentModelCatalogModel {
  id: string
  name: string
  description?: string
  /** DSH's merge-extensible model modality ids; absent means capability is unknown. */
  inputModalities?: string[]
}

export interface TaskAgentModelCatalogGroup {
  id: string
  name: string
  models: TaskAgentModelCatalogModel[]
}

export interface TaskAgentModelCatalogFailure {
  id: string
  name: string
  message: string
}

export interface TaskAgentModelCatalog {
  effective?: { provider: string; model: string; source: 'fixed' | 'dsh-default' | 'active-agent' }
  defaultSelection?: { provider: string; model: string }
  groups: TaskAgentModelCatalogGroup[]
  failures: TaskAgentModelCatalogFailure[]
}

export interface InteractionConfig {
  turnBar?: boolean
  saveAction?: boolean
}

export interface ResolvedConfig {
  storageScope: StorageScopeKind
  runtimeUserScope: 'storage' | 'global'
  cliPath?: string
  dataDir?: string
  store?: string
  timeoutMs: number
  defaultRecallLimit: number
  runtimeMemory: ResolvedRuntimeMemoryConfig
  embedding: ResolvedMnemonEmbeddingConfig
  memoryTopology: ResolvedMemoryTopologyConfig
  recallQuality: ResolvedRecallQualityConfig
  routingGuidance: boolean
  displayMode: MnemonDisplayMode
  tabEnabled: boolean
  writeEnabled: boolean
  /** DSH rc.2 management-channel authority; ignored by DSH 0.1.2-alpha.1. */
  remoteAccess: 'read-only' | 'trusted-host'
  lifecycleEnabled: boolean
  recallMode: 'guided' | 'off'
  writebackMode: 'guided' | 'off'
  idleReviewMs: number
  conversationInteraction: {
    toolviews: boolean
    turnBar: boolean
    saveAction: boolean
  }
  persistenceStrategy: ResolvedMemoryPersistenceStrategy
  taskAgentModel: ResolvedTaskAgentModelConfig
}

export interface MnemonEmbeddingStatus {
  available: boolean
  model: string
  /** Protocol Mnemon resolved for the embedding endpoint; omitted when the CLI does not report one. */
  protocol?: string
  totalInsights: number
  embedded: number
  coverage: string
}

export interface ResolvedInteractionConfig {
  turnBar: boolean
  saveAction: boolean
}

export type MemoryProviderId =
  | 'mnemon-native'
  | 'openviking'
  | 'honcho'
  | 'mem0'
  | 'hindsight'
  | 'holographic'
  | 'retaindb'
  | 'byterover'
  | 'supermemory'

export type MemoryProviderConnectionValue = string | number | boolean
export type MemoryProviderConnection = Record<string, MemoryProviderConnectionValue>

export interface MemoryProviderConfigField {
  key: string
  label: string
  /** Service fields are configured once in Settings; memory fields belong to each Memory Space. */
  scope: 'service' | 'memory'
  /** A reusable local data location presented with the same default/custom scope UI as Mnemon Native. */
  role?: 'global-location'
  input: 'text' | 'url' | 'secret' | 'number' | 'boolean' | 'select' | 'path'
  required: boolean
  defaultValue?: MemoryProviderConnectionValue
  placeholder?: string
  help?: string
  options?: Array<{ value: string; label: string }>
}

export type MemoryPlacementCapability = 'graph' | 'entities' | 'related' | 'exact-write' | 'link' | 'forget'
export type MemoryPlacementPreference = 'balanced' | 'local-first' | 'shared-first'

export interface MemoryPlacementRules {
  allowedProviderIds?: MemoryProviderId[]
  dataBoundary?: 'allow-remote' | 'local-only'
  requiredCapabilities?: MemoryPlacementCapability[]
  preference?: MemoryPlacementPreference
}

/** Persistent policy for provider selection during Agent-supervised memory distillation. */
export interface MemoryPersistenceStrategy {
  mode?: 'manual' | 'automatic'
  /** Fixed provider in manual mode. */
  providerId?: MemoryProviderId
  /** User-authored guidance used only after hard rules have filtered automatic candidates. */
  prompt?: string
  rules?: MemoryPlacementRules
  /** Memory-level connection values for providers that may be selected by the policy. */
  providerConnections?: Partial<Record<MemoryProviderId, MemoryProviderConnection>>
}

export interface ResolvedMemoryPersistenceStrategy {
  mode: 'manual' | 'automatic'
  providerId: MemoryProviderId
  prompt: string
  rules: {
    allowedProviderIds: MemoryProviderId[]
    dataBoundary: 'allow-remote' | 'local-only'
    requiredCapabilities: MemoryPlacementCapability[]
    preference: MemoryPlacementPreference
  }
  providerConnections: Partial<Record<MemoryProviderId, MemoryProviderConnection>>
}

export interface AutomaticMemoryPlacementRequest {
  mode: 'automatic'
  /** User-authored routing guidance. Hard rules above always take precedence. */
  prompt?: string
  rules?: MemoryPlacementRules
}

export interface MemoryPlacementDecision {
  mode: 'automatic'
  providerId: MemoryProviderId
  decidedBy: 'rules' | 'llm'
  reason: string
  confidence: 'high' | 'medium' | 'low'
  candidateProviderIds: MemoryProviderId[]
  appliedRules: string[]
  decidedAt: string
  runId?: string
  subagentProvider?: string
}

export interface MemoryProviderCapabilities {
  search: boolean
  browse: boolean
  graph: boolean
  entities: boolean
  related: boolean
  remember: boolean
  link: boolean
  forget: boolean
  writeMode: 'exact' | 'async-extracting'
  deletionMode: 'soft' | 'hard' | 'unsupported'
}

export interface MemoryProviderDescriptor {
  id: MemoryProviderId
  label: string
  kind: 'local' | 'remote'
  /** How the provider data scope reacts when DSH switches workspaces. */
  workspaceBinding: 'automatic' | 'optional-override' | 'provider-global'
  summary: string
  origin: 'native' | 'third-party'
  capabilities: MemoryProviderCapabilities
  fields: MemoryProviderConfigField[]
  /** Runtime projection: whether this scope has a usable saved service configuration. */
  serviceConfigured?: boolean
}

export interface MemoryProviderServiceView {
  providerId: MemoryProviderId
  enabled: boolean
  configured: boolean
  settings: MemoryProviderConnection
  configuredSecrets: string[]
  /** Present only on the settings RPC so its password inputs can use native reveal/hide behavior. */
  secretValues?: MemoryProviderConnection
}

export interface MemoryProviderServiceCatalog {
  providers: MemoryProviderDescriptor[]
  items: MemoryProviderServiceView[]
  generatedAt: string
}

export interface UpdateMemoryProviderServiceRequest {
  providerId: MemoryProviderId
  settings: MemoryProviderConnection
  enabled?: boolean
  clearSecrets?: string[]
}

export interface MemoryProviderRuntimeStatus {
  providerId: MemoryProviderId
  label: string
  enabled: boolean
  configured: boolean
  status: 'disabled' | 'idle' | 'healthy' | 'unhealthy'
  memoryBodyCount: number
  activeMemoryBodyCount: number
  error?: string
}

export interface MemoryBodyProvider {
  id: MemoryProviderId
  label: string
  kind: 'local' | 'remote'
  location: string
  targetUri?: string
  account?: string
  user?: string
  actorPeerId?: string
  apiKeyConfigured: boolean
  settings: MemoryProviderConnection
  configuredSecrets: string[]
  capabilities: MemoryProviderCapabilities
}

export interface OpenVikingBodyConnection {
  endpoint: string
  targetUri: string
  apiKey?: string
  account?: string
  user?: string
  actorPeerId?: string
}

export interface MemoryBody {
  id: string
  name: string
  description: string
  active: boolean
  dbPath: string
  provider: MemoryBodyProvider
  placement?: MemoryPlacementDecision
  createdAt: string
  updatedAt: string
}

export interface CreateMemoryBodyRequest {
  name: string
  description: string
  active?: boolean
  providerId?: MemoryProviderId
  connection?: MemoryProviderConnection
  /** Candidate-specific settings used only while resolving automatic placement. */
  providerConnections?: Partial<Record<MemoryProviderId, MemoryProviderConnection>>
  openViking?: OpenVikingBodyConnection
  placement?: AutomaticMemoryPlacementRequest
}

export interface UpdateMemoryBodyRequest {
  name?: string
  description?: string
  active?: boolean
  connection?: MemoryProviderConnection
  clearSecrets?: string[]
  openViking?: Partial<OpenVikingBodyConnection> & { clearApiKey?: boolean }
}

export interface MemoryBodyMetadataUpdate {
  memoryBodyId: string
  title: string
  description: string
}

export interface MemoryBodyMetadataMaintenanceResult {
  delegated: true
  runId: string
  provider: string
  summary: string
  updates: MemoryBodyMetadataUpdate[]
}

export type Category = 'preference' | 'decision' | 'fact' | 'insight' | 'context' | 'general'
export const CATEGORIES = ['preference', 'decision', 'fact', 'insight', 'context', 'general'] as const satisfies readonly Category[]
export type Source = 'user' | 'agent' | 'external'
export const SOURCES = ['user', 'agent', 'external'] as const satisfies readonly Source[]
export type EdgeType = 'temporal' | 'semantic' | 'causal' | 'entity'
export const EDGE_TYPES = ['temporal', 'semantic', 'causal', 'entity'] as const satisfies readonly EdgeType[]
export type Intent = 'WHY' | 'WHEN' | 'ENTITY' | 'GENERAL'
export const INTENTS = ['WHY', 'WHEN', 'ENTITY', 'GENERAL'] as const satisfies readonly Intent[]

export type RecallRelevanceTier = 'high' | 'medium' | 'low' | 'unknown'

export interface Insight {
  id: string
  content: string
  category?: string
  importance?: number
  tags?: string[]
  entities?: string[]
  source?: string
  score?: number
  /** Policy-normalized query relevance; absent for unknown Provider score scales. */
  normalizedScore?: number
  /** Query relevance assigned by the active deterministic recall quality policy. */
  relevanceTier?: RecallRelevanceTier
  /** Comparable rank score only when results were fused across providers. */
  federatedScore?: number
  confidence?: string
  intent?: string
  matchedVia?: string
  createdAt?: string
  depth?: number
  edgeType?: string
  memoryBodyId?: string
  memoryBodyName?: string
  memoryProviderId?: MemoryProviderId
  /** Owning Provider capabilities at read time; safe to expose to clients. */
  memoryCapabilities?: MemoryProviderCapabilities
  externalUri?: string
}

export interface SearchRequest {
  query: string
  mode?: 'smart' | 'keyword' | 'basic'
  limit?: number
  category?: Category
  source?: Source
  intent?: Intent
  memoryBodyIds?: string[]
}

export interface RememberRequest {
  content: string
  category?: Category
  importance?: number
  tags?: string[]
  entities?: string[]
  source?: Source
  memoryBodyId?: string
}

export interface MemoryBodyStats {
  totalInsights: number
  deletedInsights: number
  edgeCount: number
  oplogCount: number
  dbSizeBytes: number
  byCategory: Record<string, number>
  topEntities: Array<{ entity: string; count: number }>
}

export interface MemoryBodyView extends MemoryBody {
  /** True when Mnemon's persisted active-file selection points to this Store. */
  mnemonDefault: boolean
  /** False when an external provider is disabled while its Memory Space registration remains preserved. */
  providerEnabled?: boolean
  healthy: boolean
  /** A fast directory response is visible while provider health resolves independently. */
  statusLoading?: boolean
  error?: string
  stats?: MemoryBodyStats
}

export interface MemoryBodyCatalog {
  items: MemoryBodyView[]
  providers: MemoryProviderDescriptor[]
  /** Sanitized policy exposed to memory workers; provider connection values are never included. */
  persistenceStrategy?: Omit<ResolvedMemoryPersistenceStrategy, 'providerConnections'>
  total: number
  activeCount: number
  directory: string
  generatedAt: string
}

export interface MemoryGraphNode extends Insight {
  color: string
  graphId?: string
  kind?: 'memory' | 'entity' | 'space'
  memoryBodyIds?: string[]
  memoryBodyNames?: string[]
  occurrenceCount?: number
}

export interface MemoryGraphEdge {
  sourceId: string
  targetId: string
  label: string
  color: string
  type?: EdgeType | 'scope'
}

export interface MemoryGraphSnapshot {
  nodes: MemoryGraphNode[]
  edges: MemoryGraphEdge[]
  generatedAt: string
  memoryBodies?: Array<Pick<MemoryBody, 'id' | 'name' | 'active'>>
  /** Per-space observation state for capability-aware overview rendering. */
  sources?: MemoryReadSource[]
}

export type MemoryReadMode = 'search' | 'graph' | 'projection' | 'enumerable' | 'query-only' | 'entities' | 'unsupported'
export type MemoryReadStatus = 'ready' | 'empty' | 'query-required' | 'unsupported' | 'unavailable'

/**
 * One provider-backed Memory Space participating in a read surface.
 *
 * The mode describes what the provider can truthfully expose; status describes
 * the result of this particular read. Keeping those dimensions separate lets
 * the UI distinguish an empty graph from a flat projection, a query-only
 * engine, and an unavailable connection.
 */
export interface MemoryReadSource {
  memoryBodyId: string
  memoryBodyName: string
  providerId: MemoryProviderId
  providerLabel: string
  mode: MemoryReadMode
  status: MemoryReadStatus
  itemCount: number
  edgeCount?: number
  hint?: string
  quality?: RecallQualityStats
}

export interface RecallQualityStats {
  policyId: string
  fallbackFrom?: string
  fetched: number
  retained: number
  selected: number
  droppedLowScore: number
  droppedNonPositiveScore: number
  droppedInvalidScore: number
  unscored: number
  unscaled: number
}

export interface MemoryListRequest {
  query?: string
  category?: Category
  limit?: number
  memoryBodyIds?: string[]
}

export interface MemoryListView {
  items: MemoryGraphNode[]
  total: number
  generatedAt: string
  /** Omitted only when talking to a pre-provider-aware Host. */
  sources?: MemoryReadSource[]
}

export interface EntityView {
  items: Array<{ entity: string; count: number }>
  insights: Insight[]
  selected?: string
  /** Omitted only when talking to a pre-provider-aware Host. */
  sources?: MemoryReadSource[]
}

export type DocumentStatus = 'active' | 'archived'

export interface DocumentRecord {
  id: string
  title: string
  description: string
  status: DocumentStatus
  filename: string
  relativePath: string
  sourcePaths: string[]
  sessionIds: string[]
  createdAt: string
  updatedAt: string
  lastAccessedAt: string
  revision: number
  contentHash: string
  sizeBytes: number
  archivedAt?: string
  archiveSummary?: string
  memoryBodyIds: string[]
}

export interface DocumentView extends DocumentRecord {
  content: string
}

export interface DocumentSnapshot {
  workspaceRoot: string
  directory: string
  indexPath: string
  generatedAt: string
  revision: string
  limitBytes: number
  activeBytes: number
  activeCount: number
  archivedCount: number
  total: number
  documents: Array<DocumentRecord & { healthy: boolean; excerpt: string }>
}

export interface DocumentSearchResult {
  query: string
  includeArchived: boolean
  total: number
  generatedAt: string
  results: Array<DocumentView & { score: number; excerpt: string }>
}

export type DocumentMutation =
  | { action: 'create'; title: string; description?: string; content: string; sourcePaths?: string[]; sessionIds?: string[] }
  | { action: 'update'; id: string; title?: string; description?: string; content?: string; sourcePaths?: string[]; sessionIds?: string[] }

export interface DocumentMutationResult {
  success: true
  action: 'created' | 'updated' | 'archived'
  document: DocumentView
  snapshot: DocumentSnapshot
  maintenance?: { runId: string; provider: string; summary: string; memoryBodyIds: string[]; archivedDocumentIds: string[] }
}

export type RuntimeMemoryTarget = 'memory' | 'user'
export type RuntimeMemoryImportance = 'critical' | 'normal' | 'low'
export type RuntimeMemoryAction = 'add' | 'replace' | 'remove'

export interface RuntimeMemoryEntry {
  content: string
  created_at: string
  updated_at: string
  target: RuntimeMemoryTarget
  importance: RuntimeMemoryImportance
  /** Optional git branch names that limit where this entry is projected. Absent means every branch. */
  branches?: string[]
}

export interface RuntimeMemoryUsage {
  used: number
  limit: number
}

export interface RuntimeMemoryTargetView extends RuntimeMemoryUsage {
  target: RuntimeMemoryTarget
  entryCount: number
  markdownPath: string
}

export interface RuntimeMemorySnapshot {
  directory: string
  sourcePath: string
  revision: string
  generatedAt: string
  entries: RuntimeMemoryEntry[]
  targets: Record<RuntimeMemoryTarget, RuntimeMemoryTargetView>
}

export interface RuntimeMemoryCompactedEntry {
  content: string
  importance: RuntimeMemoryImportance
  /** Branch scope carried through compaction; absent means the entry is visible on every branch. */
  branches?: string[]
}

export interface RuntimeMemoryMutation {
  action: RuntimeMemoryAction
  target: RuntimeMemoryTarget
  content?: string
  oldText?: string
  importance?: RuntimeMemoryImportance
  /** Git branch names limiting where a target=memory entry is projected. Absent keeps the current scope on replace; an empty list clears it. */
  branches?: string[]
}

export type RuntimeMemoryMutationResult = {
  success: true
  message: string
  target: RuntimeMemoryTarget
  entryCount: number
  usage: RuntimeMemoryUsage
  added?: string
  replaced?: { from: string; to: string }
  removed?: string
  maintenance?: {
    kind: 'local-compaction' | 'mnemon-archive'
    runId: string
    provider: string
    summary: string
    memoryBodyIds: string[]
  }
}

export interface TurnMemoryActivity {
  turn: number
  count: number
  names: string[]
  recalls: number
  writes: number
  documentSearches: number
  inspections: number
  failures: number
}

export interface TurnMemoryActivitySnapshot {
  cursor: number
  activities: TurnMemoryActivity[]
}

export interface AssistantMessageText {
  messageId: string
  text: string
}

export type StorageAreaKind = 'runtime' | 'memory-bodies' | 'documents' | 'state'
export type StorageAreaStatus = 'ready' | 'empty' | 'missing' | 'invalid'

export interface StorageAreaInventory {
  kind: StorageAreaKind
  path: string
  status: StorageAreaStatus
  bytes: number
  itemCount: number
  details: Record<string, number | string | boolean>
  issue?: string
}

export interface StorageScopeInventory {
  kind: StorageScopeKind
  root?: string
  configured: boolean
  active: boolean
  available: boolean
  totalBytes: number
  areas: StorageAreaInventory[]
  issue?: string
}

export interface StorageScopeCatalog {
  activeKind: StorageScopeKind
  activeRoot: string
  scopes: StorageScopeInventory[]
  generatedAt: string
}

export interface ReviewActivity {
  totalUserTextLength: number
  turnCount: number
  toolCallCount: number
  uniqueToolCount: number
}

export interface ReviewActivityScore extends ReviewActivity {
  textLengthScore: number
  turnScore: number
  toolCallScore: number
  toolDiversityScore: number
  score: number
  threshold: number
  eligible: boolean
}

export interface SubagentCounters {
  recalls: number
  writes: number
  answers: number
  reviews: number
  placements: number
  migrations: number
  compactions: number
  documentArchives: number
  metadataMaintenances: number
  failures: number
  lastRunId?: string
  lastOperation?: 'recall' | 'write' | 'review' | 'placement' | 'migration' | 'compaction' | 'document-archive' | 'metadata-maintenance'
  lastAt?: string
}

export type LifecyclePhase = 'idle' | 'prime' | 'recall' | 'writeback' | 'review' | 'supervised' | 'error'

export interface LifecycleCounters {
  primes: number
  recallCues: number
  writebackCues: number
  supervisedRequests: number
  failures: number
}

export interface LifecycleAgentSnapshot {
  sessionId: string
  status: 'idle' | 'running'
  startSource: 'startup' | 'resume' | 'clear' | 'compact' | 'adopted'
  primePending: boolean
  guidedTurns: number
  memoryToolCalls: number
  idleReviewPending: boolean
  reviewRunning: boolean
  reviewActivity: ReviewActivityScore
  lastPhase: LifecyclePhase
  lastReviewAt?: string
  lastReviewAction?: string
  lastReviewScore?: number
  lastReviewDocumentIds?: string[]
  lastAt?: string
  lastError?: string
}

export interface LifecycleSnapshot {
  enabled: boolean
  recallMode: 'guided' | 'off'
  writebackMode: 'guided' | 'off'
  idleReviewMs: number
  activeAgents: number
  sessionAvailable: boolean
  /** A session-independent task Agent can be created for WebUI maintenance. */
  taskAgentAvailable: boolean
  counters: LifecycleCounters
  subagents: SubagentCounters
  current?: LifecycleAgentSnapshot
}

export interface StatusView {
  healthy: boolean
  error?: string
  version?: string
  dshMnemonVersion?: string
  cliPath: string
  commandFound: boolean
  dataDir: string
  /** Legacy comma-separated DSH-enabled Store list. */
  store: string
  mnemonDefaultStore: string
  dshActiveStores: string[]
  writeEnabled: boolean
  timeoutMs: number
  defaultRecallLimit: number
  recallQuality: ResolvedRecallQualityConfig
  memoryBodyDirectory: string
  memoryBodies: MemoryBodyView[]
  providerServices?: MemoryProviderRuntimeStatus[]
  memorySystem?: MemorySystemDescriptor
  lifecycle?: LifecycleSnapshot
  documents?: DocumentSnapshot
  storage?: StorageScopeCatalog
  workspaceContext?: {
    mode: StorageScopeKind
    selectedRoot: string
    effectiveRoot: string
    aligned: boolean
    selectedWorkspace?: { id: string; title: string; path: string }
    effectiveWorkspace?: { id: string; title: string; path: string }
  }
  stats?: MemoryBodyStats & { dbPath?: string }
}

export type MnemonPackComponent = 'runtime' | 'documents' | 'memory-spaces'
export type MnemonPackScope = 'full' | MnemonPackComponent
export type MnemonPackImportMode = 'merge' | 'replace'

export interface MnemonPackComponentSummary {
  component: MnemonPackComponent
  files: number
  bytes: number
  items: number
}

export interface MnemonPackManifest {
  format: 'mnemonpack'
  version: 1
  scope: MnemonPackScope
  exportedAt: string
  source: { plugin: 'dsh-mnemon'; pluginVersion: string }
  components: MnemonPackComponent[]
  summary: MnemonPackComponentSummary[]
}

export interface MnemonPackExport {
  fileName: string
  mimeType: 'application/zip'
  bytes: number
  base64: string
  targetRoot: string
  manifest: MnemonPackManifest
}

export interface MnemonPackPreview {
  fileName?: string
  archiveBytes: number
  expandedBytes: number
  targetRoot: string
  targetScope: StorageScopeKind
  manifest: MnemonPackManifest
  occupied: Record<MnemonPackComponent, boolean>
}

export interface MnemonPackImportResult {
  imported: true
  mode: MnemonPackImportMode
  targetRoot: string
  components: MnemonPackComponent[]
  summary: MnemonPackComponentSummary[]
}

export type VersionComponentId = 'mnemon' | 'dsh-mnemon'
export type VersionInstallMode = 'homebrew' | 'go' | 'npm' | 'link' | 'manual' | 'missing'

export interface VersionComponentStatus {
  id: VersionComponentId
  name: string
  executablePath?: string
  installPath?: string
  installProfile?: string
  current?: string
  latest?: string
  outdated: boolean
  installMode: VersionInstallMode
  updateSupported: boolean
  updateHint: string
  checkError?: string
}

export interface VersionStatus {
  checkedAt: string
  components: VersionComponentStatus[]
}

export interface VersionUpdateResult {
  component: VersionComponentId
  previousVersion?: string
  currentVersion?: string
  updated: boolean
  restartRequired: boolean
  output?: string
}
