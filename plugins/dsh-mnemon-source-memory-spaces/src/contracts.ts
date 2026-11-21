export type { MemoryJsonValue as JsonValue } from 'dsh-mnemon/contracts'
import type { MemoryReadGrant } from 'dsh-mnemon/contracts'

export type MemoryProviderId = string

export const NATIVE_PROVIDER_ID = 'mnemon-native'

export const DEFAULT_TIMEOUT_MS = 10_000
export const DEFAULT_RECALL_LIMIT = 10
export const DEFAULT_RECALL_QUALITY_POLICY = 'strict-v1'

export function isNativeProvider(provider: { readonly id: MemoryProviderId; readonly typeId?: string | undefined }): boolean {
  return (provider.typeId ?? provider.id) === NATIVE_PROVIDER_ID
}

export type MemoryProviderConnectionValue = string | number | boolean
export type MemoryProviderConnection = Record<string, MemoryProviderConnectionValue>

export interface MemoryProviderIcon {
  kind: 'brand' | 'data-url' | 'glyph'
  value: string
}

export interface MemoryProviderConfigOption {
  value: string
  label: string
  i18nKey?: string
}

export interface MemoryProviderConfigField {
  key: string
  label: string
  i18nKey?: string
  scope: 'service' | 'memory'
  role?: 'global-location'
  input: 'text' | 'url' | 'secret' | 'number' | 'boolean' | 'select' | 'path'
  required: boolean
  defaultValue?: MemoryProviderConnectionValue
  placeholder?: string
  help?: string
  min?: number
  max?: number
  maxLength?: number
  pattern?: string
  normalize?: 'trim-trailing-slash'
  validationMessage?: string
  discoveryDefaultFrom?: string
  options?: MemoryProviderConfigOption[]
}

export const MEMORY_PLACEMENT_CAPABILITIES = ['graph', 'entities', 'related', 'exact-write', 'link', 'forget'] as const
export type MemoryPlacementCapability = (typeof MEMORY_PLACEMENT_CAPABILITIES)[number]
export type MemoryPlacementPreference = 'balanced' | 'local-first' | 'shared-first'

export interface MemoryPlacementRules {
  allowedProviderIds?: MemoryProviderId[]
  dataBoundary?: 'allow-remote' | 'local-only'
  requiredCapabilities?: MemoryPlacementCapability[]
  preference?: MemoryPlacementPreference
}

export interface MemoryPersistenceStrategy {
  mode?: 'manual' | 'automatic'
  providerId?: MemoryProviderId
  prompt?: string
  rules?: MemoryPlacementRules
  providerConnections?: Partial<Record<MemoryProviderId, MemoryProviderConnection>>
}

export interface ResolvedMemoryPersistenceStrategy {
  mode: 'manual' | 'automatic'
  providerId: MemoryProviderId
  providerDefaulted?: true
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
  typeId?: string
  id: MemoryProviderId
  label: string
  icon?: MemoryProviderIcon
  kind: 'local' | 'remote'
  workspaceBinding: 'automatic' | 'optional-override' | 'provider-global'
  summary: string
  summaryI18nKey?: string
  origin: 'native' | 'third-party'
  capabilities: MemoryProviderCapabilities
  fields: MemoryProviderConfigField[]
  serviceConfigured?: boolean
}

export interface MemoryProviderServiceView {
  providerId: MemoryProviderId
  enabled: boolean
  configured: boolean
  settings: MemoryProviderConnection
  configuredSecrets: string[]
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
  icon?: MemoryProviderIcon
  enabled: boolean
  configured: boolean
  status: 'disabled' | 'idle' | 'healthy' | 'unhealthy'
  memoryBodyCount: number
  activeMemoryBodyCount: number
  error?: string
}

export interface MemorySpaceProvider {
  id: MemoryProviderId
  typeId?: string
  label: string
  icon?: MemoryProviderIcon
  origin?: 'native' | 'third-party'
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

export interface OpenVikingSpaceConnection {
  endpoint: string
  targetUri: string
  apiKey?: string
  account?: string
  user?: string
  actorPeerId?: string
}

export interface MemorySpace {
  id: string
  name: string
  description: string
  active: boolean
  dbPath: string
  provider: MemorySpaceProvider
  placement?: MemoryPlacementDecision
  createdAt: string
  updatedAt: string
}

export interface CreateMemorySpaceRequest {
  name: string
  description: string
  active?: boolean
  providerId?: MemoryProviderId
  connection?: MemoryProviderConnection
  providerConnections?: Partial<Record<MemoryProviderId, MemoryProviderConnection>>
  openViking?: OpenVikingSpaceConnection
  placement?: AutomaticMemoryPlacementRequest
}

export interface UpdateMemorySpaceRequest {
  name?: string
  description?: string
  active?: boolean
  connection?: MemoryProviderConnection
  clearSecrets?: string[]
  openViking?: Partial<OpenVikingSpaceConnection> & { clearApiKey?: boolean }
}

export interface MemorySpaceMetadataUpdate {
  memoryBodyId: string
  title: string
  description: string
}

export interface MemorySpaceMetadataMaintenanceResult {
  delegated: true
  runId: string
  provider: string
  summary: string
  updates: MemorySpaceMetadataUpdate[]
}

export type Category = 'preference' | 'decision' | 'fact' | 'insight' | 'context' | 'general'
export const CATEGORIES = ['preference', 'decision', 'fact', 'insight', 'context', 'general'] as const satisfies readonly Category[]
export type Source = 'user' | 'agent' | 'external'
export const SOURCES = ['user', 'agent', 'external'] as const satisfies readonly Source[]
export type EdgeType = 'temporal' | 'semantic' | 'causal' | 'entity'
export const EDGE_TYPES = ['temporal', 'semantic', 'causal', 'entity'] as const satisfies readonly EdgeType[]
export type Intent = 'WHY' | 'WHEN' | 'ENTITY' | 'GENERAL'
export const INTENTS = ['WHY', 'WHEN', 'ENTITY', 'GENERAL'] as const satisfies readonly Intent[]

export type RecallRelevanceTier = 'high' | 'medium' | 'ranked' | 'low' | 'unknown'

export function normalizeEntityKey(entity: string): string {
  return entity.normalize('NFKC').trim().toLocaleLowerCase()
}

export interface Insight {
  id: string
  content: string
  category?: string
  importance?: number
  tags?: string[]
  entities?: string[]
  source?: string
  score?: number
  normalizedScore?: number
  relevanceTier?: RecallRelevanceTier
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
  memoryProviderLabel?: string
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
  inspect?: boolean
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

export interface MemorySpaceStats {
  totalInsights: number
  deletedInsights: number
  edgeCount: number
  oplogCount: number
  dbSizeBytes: number
  byCategory: Record<string, number>
  topEntities: Array<{ entity: string; count: number }>
}

export interface MemorySpaceView extends MemorySpace {
  mnemonDefault: boolean
  providerEnabled?: boolean
  healthy: boolean
  statusLoading?: boolean
  error?: string
  stats?: MemorySpaceStats
}

export interface MemorySpaceWriteScopeRequest {
  viewId: string
  grant: MemoryReadGrant
}

export interface MemorySpaceWriteScope {
  viewId: string
  sourceInstanceKey: string
  memoryBodyIds: string[]
}

export interface MemorySpaceCatalog {
  items: MemorySpaceView[]
  providers: MemoryProviderDescriptor[]
  persistenceStrategy?: Omit<ResolvedMemoryPersistenceStrategy, 'providerConnections'>
  total: number
  activeCount: number
  directory: string
  generatedAt: string
  writeScope?: MemorySpaceWriteScope
  rediscovery?: { running: boolean; last?: MemorySpaceRediscovery }
}

export interface MemorySpaceRediscoveryResult {
  providerId: MemoryProviderId
  label: string
  found: number
  added: Array<{ id: string; name: string }>
  disconnected: number
  error?: string
  timedOut?: boolean
}

export interface MemorySpaceRediscovery {
  at: string
  trigger: 'startup' | 'manual'
  results: MemorySpaceRediscoveryResult[]
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
  memoryBodies?: Array<Pick<MemorySpace, 'id' | 'name' | 'active'>>
  sources?: MemoryReadSource[]
}

export type MemoryReadMode = 'search' | 'graph' | 'projection' | 'enumerable' | 'query-only' | 'entities' | 'unsupported'
export type MemoryReadStatus = 'ready' | 'empty' | 'query-required' | 'unsupported' | 'unavailable' | 'loading'

export interface MemoryReadSource {
  memoryBodyId: string
  memoryBodyName: string
  providerId: MemoryProviderId
  providerLabel: string
  mode: MemoryReadMode
  status: MemoryReadStatus
  itemCount: number
  edgeCount?: number
  memoryCount?: number
  complete?: boolean
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
  ranked?: number
  outOfRange?: number
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
  sources?: MemoryReadSource[]
}

export interface MemorySpaceMetadataSample {
  memoryBodyId: string
  name: string
  description: string
  providerId: MemorySpace['provider']['id']
  providerLabel: string
  method: 'native-basic' | 'browse' | 'search'
  evidence: Array<Pick<Insight, 'content' | 'category' | 'entities'>>
}

export interface MemoryPlacementCandidate {
  id: MemoryProviderId
  label: string
  kind: 'local' | 'remote'
  configured: boolean
  summary: string
  capabilities: MemoryProviderCapabilities
}

export interface PreparedMemoryPlacement {
  prompt: string
  candidates: MemoryPlacementCandidate[]
  appliedRules: string[]
  selectorBrief: string
}

export interface LlmMemoryPlacementSelection {
  providerId: string
  reason: string
  confidence: string
}

export const DEFAULT_EMBEDDING_ENDPOINT = 'http://localhost:11434'
export const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text'
export const EMBEDDING_PROTOCOL_AUTO = 'auto'
export const EMBEDDING_PROTOCOL_OLLAMA = 'ollama'
export const EMBEDDING_PROTOCOL_OPENAI = 'openai'
export const DEFAULT_EMBEDDING_PROTOCOL = EMBEDDING_PROTOCOL_AUTO
export const MNEMON_EMBEDDING_PROTOCOLS = [EMBEDDING_PROTOCOL_AUTO, EMBEDDING_PROTOCOL_OLLAMA, EMBEDDING_PROTOCOL_OPENAI] as const

export interface RecallQualityConfig {
  policy?: string
  lowScoreThreshold?: number
  highScoreThreshold?: number
  candidateMultiplier?: number
  maxMediumResults?: number
  maxRankedResults?: number
  maxUnknownResults?: number
}

export interface ResolvedRecallQualityConfig {
  policy: string
  lowScoreThreshold: number
  highScoreThreshold: number
  candidateMultiplier: number
  maxMediumResults: number
  maxRankedResults: number
  maxUnknownResults: number
}

export type MnemonEmbeddingProtocol = (typeof MNEMON_EMBEDDING_PROTOCOLS)[number]

export interface MnemonEmbeddingConfig {
  enabled?: boolean
  endpoint?: string
  model?: string
  apiKey?: string
  apiKeyEnv?: string
  apiKeyRef?: string
  protocol?: MnemonEmbeddingProtocol
}

export interface ResolvedMnemonEmbeddingConfig {
  enabled: boolean
  endpoint: string
  model: string
  apiKey: string
  apiKeyEnv?: string
  apiKeyRef?: string
  protocol: MnemonEmbeddingProtocol
}

export interface MnemonEmbeddingSettingsView extends MnemonEmbeddingConfig {
  apiKeyStorage?: 'none' | 'legacy' | 'environment' | 'credentials'
  apiKeyConfigured?: boolean
}

export const EMBEDDING_CREDENTIAL_PREFIX = 'dsh-mnemon/embedding-'
export const EMBEDDING_CREDENTIAL_REFERENCE = /^dsh-mnemon\/embedding-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
export const EMBEDDING_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u

export interface MnemonEmbeddingCredential {
  version: 1
  endpoint: string
  apiKey: string
}

export interface MnemonEmbeddingStatus {
  available: boolean
  model: string
  protocol?: string
  totalInsights: number
  embedded: number
  coverage: string
  spaces?: MnemonEmbeddingSpaceStatus[]
}

export interface MnemonEmbeddingSpaceStatus {
  memoryBodyId: string
  name: string
  active: boolean
  totalInsights: number
  embedded: number
  coverage: string
  error?: string
}

export interface MnemonEmbeddingFill {
  memoryBodyId: string
  filled: number
  remaining: number
  model: string
  stopped?: 'time' | 'refused'
}

export interface MemorySpacesStatus {
  healthy: boolean
  error?: string
  version?: string
  cliPath: string
  commandFound: boolean
  dataDir: string
  store: string
  mnemonDefaultStore: string
  dshActiveStores: string[]
  writeEnabled: boolean
  timeoutMs: number
  defaultRecallLimit: number
  recallQuality: ResolvedRecallQualityConfig
  embeddingManaged?: boolean
  memoryBodyDirectory: string
  memoryBodies: MemorySpaceView[]
  providerServices?: MemoryProviderRuntimeStatus[]
  stats?: MemorySpaceStats & { dbPath?: string }
}

export interface EntityView {
  items: Array<{ entity: string; count: number }>
  insights: Insight[]
  selected?: string
  sources?: MemoryReadSource[]
  total?: number
  complete?: boolean
}

export interface EntityMemoriesView {
  entity: string
  total: number
  offset: number
  items: Insight[]
  complete: boolean
  sources: MemoryReadSource[]
}

export interface EntityRelatedView {
  entity: string
  items: Insight[]
  sources: MemoryReadSource[]
}

export const MEMORY_SPACES_DIRECTORY = 'data'
export const MEMORY_SPACE_REGISTRY_FILE = '.dsh-memory-bodies.json'
export const MEMORY_SPACE_DATABASE_FILE = 'mnemon.db'
export const MEMORY_SPACE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
export const MEMORY_SPACE_NAME_MAX_LENGTH = 100
export const MEMORY_SPACE_DESCRIPTION_MAX_LENGTH = 1000
export const MNEMON_ACTIVE_STORE_FILE = 'active'
export const MEMORY_PROVIDER_REGISTRY_FILE = 'memory-providers.json'

export interface MemorySpaceRegistryEntry {
  id: string
  name: string
  description: string
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface MemorySpaceRegistryFile {
  version: 1
  bodies: MemorySpaceRegistryEntry[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseMemorySpaceRegistry(value: unknown): MemorySpaceRegistryFile {
  const registry = isObject(value) ? value : undefined
  if (registry?.version !== 1 || !Array.isArray(registry.bodies)) throw new Error('Memory Space registry is invalid')
  const ids = new Set<string>()
  const bodies = registry.bodies.map((raw): MemorySpaceRegistryEntry => {
    const body = isObject(raw) ? raw : undefined
    if (typeof body?.id !== 'string' || !MEMORY_SPACE_ID_PATTERN.test(body.id) || ids.has(body.id)) throw new Error('Memory Space registry contains an invalid or duplicate id')
    if (typeof body.name !== 'string' || body.name.trim() === '' || body.name.length > MEMORY_SPACE_NAME_MAX_LENGTH
      || typeof body.description !== 'string' || body.description.length > MEMORY_SPACE_DESCRIPTION_MAX_LENGTH) throw new Error('Memory Space registry contains invalid metadata')
    if (typeof body.createdAt !== 'string' || typeof body.updatedAt !== 'string') throw new Error('Memory Space registry contains invalid timestamps')
    ids.add(body.id)
    return { id: body.id, name: body.name, description: body.description, active: body.active === true, createdAt: body.createdAt, updatedAt: body.updatedAt }
  })
  return { version: 1, bodies }
}

export interface MemorySpaceRegistrySummary {
  valid: boolean
  spaces: number
  active: number
}

export function summarizeMemorySpaceRegistry(value: unknown): MemorySpaceRegistrySummary {
  const registry = isObject(value) ? value : undefined
  const listed = registry?.bodies
  const spaces = Array.isArray(listed) ? listed.filter(isObject) : []
  return {
    valid: registry?.version === 1 && Array.isArray(listed),
    spaces: spaces.length,
    active: spaces.filter(space => space.active === true).length,
  }
}

export interface MemoryProviderRegistrySummary {
  valid: boolean
  services: number
  connections: number
}

export function summarizeMemoryProviderRegistry(value: unknown): MemoryProviderRegistrySummary {
  const registry = isObject(value) ? value : undefined
  const services = registry?.services
  const listed = registry?.bodies
  return {
    valid: registry !== undefined,
    services: isObject(services) ? Object.keys(services).length : 0,
    connections: Array.isArray(listed) ? listed.length : 0,
  }
}

export type CreateMemoryBodyRequest = CreateMemorySpaceRequest
export type UpdateMemoryBodyRequest = UpdateMemorySpaceRequest
export type MemoryBody = MemorySpace
export type MemoryBodyCatalog = MemorySpaceCatalog
export type MemoryBodyDirectory = MemorySpaceCatalog
export type MemoryBodyMetadataMaintenanceResult = MemorySpaceMetadataMaintenanceResult
export type MemoryBodyMetadataSample = MemorySpaceMetadataSample
export type MemoryBodyMetadataUpdate = MemorySpaceMetadataUpdate
export type MemoryBodyProvider = MemorySpaceProvider
export type MemoryBodyStats = MemorySpaceStats
export type MemoryBodyView = MemorySpaceView
export type OpenVikingBodyConnection = OpenVikingSpaceConnection
