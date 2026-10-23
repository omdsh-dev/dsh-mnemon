/**
 * Contracts owned by the Memory Spaces Source, not the Mnemon Core.
 * The canonical model is MemorySpace. Existing memoryBodyId(s), memoryBodies,
 * and related wire fields keep their v0.5.x spelling for installed consumers
 * and persisted Document/Pack lineage; they all refer to memory spaces.
 */
export type { MemoryJsonValue as JsonValue } from 'dsh-mnemon/contracts'
import type { MemoryReadGrant } from 'dsh-mnemon/contracts'

export type MemoryProviderId = string

/**
 * The Mnemon Native Provider's id. Its package names its descriptor and driver
 * with it, the Starter installs it under it, and a stored space that names no
 * Provider belongs to it.
 */
export const NATIVE_PROVIDER_ID = 'mnemon-native'

/** Whether a Provider is Mnemon Native: by its implementation type, else by its id. */
export function isNativeProvider(provider: { readonly id: MemoryProviderId; readonly typeId?: string | undefined }): boolean {
  return (provider.typeId ?? provider.id) === NATIVE_PROVIDER_ID
}

export type MemoryProviderConnectionValue = string | number | boolean
export type MemoryProviderConnection = Record<string, MemoryProviderConnectionValue>

export interface MemoryProviderIcon {
  /** Bundled brand token, self-contained image data, or a short text glyph. */
  kind: 'brand' | 'data-url' | 'glyph'
  value: string
}

export interface MemoryProviderConfigOption {
  value: string
  label: string
  /** Optional Host-provided translation key; clients fall back to label. */
  i18nKey?: string
}

export interface MemoryProviderConfigField {
  key: string
  label: string
  /** Optional Host-provided translation key; clients fall back to label. */
  i18nKey?: string
  /** Service fields are configured once on the dsh-mnemon page under Plugins; memory fields belong to each Memory Space. */
  scope: 'service' | 'memory'
  /** A reusable local data location presented with the same default/custom scope UI as Mnemon Native. */
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
  /** Seed an empty service default from this field on the first discovered Memory Space. */
  discoveryDefaultFrom?: string
  options?: MemoryProviderConfigOption[]
}

/** What a persistence strategy's rules can require of a Provider; the Starter's settings schema takes the same list. */
export const MEMORY_PLACEMENT_CAPABILITIES = ['graph', 'entities', 'related', 'exact-write', 'link', 'forget'] as const
export type MemoryPlacementCapability = (typeof MEMORY_PLACEMENT_CAPABILITIES)[number]
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
  /** Set when no provider was chosen; manual mode then uses whichever provider is ready. */
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
  /** Provider implementation type; omitted when it is identical to id. */
  typeId?: string
  id: MemoryProviderId
  label: string
  icon?: MemoryProviderIcon
  kind: 'local' | 'remote'
  /** How the provider data scope reacts when DSH switches workspaces. */
  workspaceBinding: 'automatic' | 'optional-override' | 'provider-global'
  summary: string
  /** Optional Host-provided translation key; clients fall back to summary. */
  summaryI18nKey?: string
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
  /** Implementation type; differs from id when one module has several child instances. */
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

/**
 * Whether DSH may write to a space's namespace (#434). A read-only namespace is recalled as before
 * and takes no write: no remember, forget, link, capture, archive or merge reaches its Provider.
 */
export type MemorySpaceWritePolicy = 'writable' | 'read-only'

export interface MemorySpace {
  id: string
  name: string
  description: string
  active: boolean
  dbPath: string
  provider: MemorySpaceProvider
  placement?: MemoryPlacementDecision
  /** Present only for a read-only namespace; every other space is writable. */
  writePolicy?: 'read-only'
  createdAt: string
  updatedAt: string
}

export interface CreateMemorySpaceRequest {
  name: string
  description: string
  active?: boolean
  providerId?: MemoryProviderId
  connection?: MemoryProviderConnection
  /** Candidate-specific settings used only while resolving automatic placement. */
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

export type RecallRelevanceTier = 'high' | 'medium' | 'low' | 'unknown'

/**
 * One spelling-insensitive key per entity. The Host's entity index and the Client's graph
 * both count an entity's memories by it, so their numbers agree.
 */
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
  /** Provider label captured with the result so Client UI never needs an id catalog. */
  memoryProviderLabel?: string
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
  /**
   * A look at the memory rather than a use of it, such as the Memory System's
   * own searches. Providers that record reads, as access counts or a query
   * log, leave it out, and may answer from a snapshot that lags a write still
   * in flight; a check that must see a write leaves the flag unset.
   */
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
  /** True when Mnemon's persisted active-file selection points to this Store. */
  mnemonDefault: boolean
  /** False when an external provider is disabled while its Memory Space registration remains preserved. */
  providerEnabled?: boolean
  healthy: boolean
  /** A fast directory response is visible while provider health resolves independently. */
  statusLoading?: boolean
  error?: string
  stats?: MemorySpaceStats
}

/** Optional Host-only body-directory input; the Host binds the grant to its initiating View and exact Source. */
export interface MemorySpaceWriteScopeRequest {
  viewId: string
  grant: MemoryReadGrant
}

/** Source-owned write authority, distinct from the active namespaces pinned for recall. */
export interface MemorySpaceWriteScope {
  viewId: string
  sourceInstanceKey: string
  memoryBodyIds: string[]
}

export interface MemorySpaceCatalog {
  items: MemorySpaceView[]
  providers: MemoryProviderDescriptor[]
  /** Sanitized policy exposed to memory workers; provider connection values are never included. */
  persistenceStrategy?: Omit<ResolvedMemoryPersistenceStrategy, 'providerConnections'>
  total: number
  activeCount: number
  directory: string
  generatedAt: string
  /** Present only when body-directory receives a supported writeScope request. Older Sources omit it. */
  writeScope?: MemorySpaceWriteScope
  /** Provider namespaces asked for again in this process: whether a pass is running, and the last one. Older Sources omit it. */
  rediscovery?: { running: boolean; last?: MemorySpaceRediscovery }
}

/** What one Provider answered when its namespaces were asked for again. */
export interface MemorySpaceRediscoveryResult {
  providerId: MemoryProviderId
  label: string
  /** Namespaces the Provider reported. */
  found: number
  /** Spaces mounted for namespaces this directory had never held. They start inactive. */
  added: Array<{ id: string; name: string }>
  /** Reported namespaces a person disconnected here; they stay disconnected. */
  disconnected: number
  /** Why the Provider could not be asked, as it said. Its spaces stay as they were. */
  error?: string
  /** The Provider said nothing within the time it was given. */
  timedOut?: boolean
}

/** One pass over every enabled Provider service, when the Host starts or from the Memory Spaces page. */
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
  /** Per-space observation state for capability-aware overview rendering. */
  sources?: MemoryReadSource[]
}

export type MemoryReadMode = 'search' | 'graph' | 'projection' | 'enumerable' | 'query-only' | 'entities' | 'unsupported'
/** 'loading' is client-only: a page shows its spaces from the directory while the read runs. */
export type MemoryReadStatus = 'ready' | 'empty' | 'query-required' | 'unsupported' | 'unavailable' | 'loading'

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
  /** Entity reads: the memories the entity index covers in this space. */
  memoryCount?: number
  /** Entity reads: false when the Provider could not index every memory of this space. */
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
/** Default protocol defers to Mnemon's /v1 auto-detection. */
export const DEFAULT_EMBEDDING_PROTOCOL = EMBEDDING_PROTOCOL_AUTO
/** Wire protocols accepted by the embedding protocol override; single source for schema, resolver, and UI validation. */
export const MNEMON_EMBEDDING_PROTOCOLS = [EMBEDDING_PROTOCOL_AUTO, EMBEDDING_PROTOCOL_OLLAMA, EMBEDDING_PROTOCOL_OPENAI] as const


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


export interface ResolvedRecallQualityConfig {
  policy: string
  lowScoreThreshold: number
  highScoreThreshold: number
  candidateMultiplier: number
  maxMediumResults: number
  maxUnknownResults: number
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


export interface MnemonEmbeddingStatus {
  available: boolean
  model: string
  /** Protocol Mnemon resolved for the embedding endpoint; omitted when the CLI does not report one. */
  protocol?: string
  /** Across the spaces in `spaces` that could be counted; 0 when no space has a database. */
  totalInsights: number
  embedded: number
  coverage: string
  /** Each Mnemon Native space with a database, as `mnemon --store <id> embed --status` counts it (#392). */
  spaces?: MnemonEmbeddingSpaceStatus[]
}

/** One Mnemon Native space's vector coverage. */
export interface MnemonEmbeddingSpaceStatus {
  memoryBodyId: string
  name: string
  active: boolean
  /** Present only for a read-only space, whose vectors are not filled in (#434). */
  writePolicy?: 'read-only'
  totalInsights: number
  embedded: number
  coverage: string
  /** Why the space could not be counted; its counts are then 0 and stay out of the total. */
  error?: string
}

/** What one fill of a Mnemon Native space's missing vectors did (#392). */
export interface MnemonEmbeddingFill {
  memoryBodyId: string
  /** Vectors the fill wrote. */
  filled: number
  /** Memories of the space still without a vector when it stopped. */
  remaining: number
  /** The embedding model Mnemon used. */
  model: string
  /**
   * Why it stopped while memories remain: its minute ran out (`time`), or a step wrote no vector,
   * so the embedding service returned none for the memories left (`refused`).
   */
  stopped?: 'time' | 'refused'
}


/** Domain status only; workbench/lifecycle status belongs to the default adapter. */
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
  /**
   * Whether DSH manages Mnemon Native's embedding settings (`embedding.enabled`). While it does
   * not, Mnemon keeps the Host environment and its own defaults. Memory Spaces 0.5.21 and earlier omit it.
   */
  embeddingManaged?: boolean
  memoryBodyDirectory: string
  memoryBodies: MemorySpaceView[]
  providerServices?: MemoryProviderRuntimeStatus[]
  stats?: MemorySpaceStats & { dbPath?: string }
}

/**
 * The entities of the active spaces. Each count is the number of memories that
 * carry the entity, the same set entity-memories lists.
 */
export interface EntityView {
  items: Array<{ entity: string; count: number }>
  /** With a selected entity: the first page of entity-memories, kept for existing callers. */
  insights: Insight[]
  selected?: string
  /** Omitted only when talking to a pre-provider-aware Host. */
  sources?: MemoryReadSource[]
  /** Distinct entities across the active spaces; items may be capped below it. Omitted by older Hosts. */
  total?: number
  /** False when a space's Provider could not index every memory. Omitted by older Hosts. */
  complete?: boolean
}

/** One page of the memories that carry an entity, by importance and then recency. */
export interface EntityMemoriesView {
  /** The entity's most common spelling, or the requested name when no memory carries it. */
  entity: string
  total: number
  offset: number
  items: Insight[]
  complete: boolean
  sources: MemoryReadSource[]
}

/** Memories recall relates to an entity that do not carry it themselves. */
export interface EntityRelatedView {
  entity: string
  items: Insight[]
  sources: MemoryReadSource[]
}

// The files below are this Source's own: Mnemon Native's stores, the registry beside them and the
// third-party Provider registry. A Host that copies them, as a Mnemon Pack or a sync does, or
// counts them for a storage inventory, reads their names and rules from here instead of keeping
// a copy that drifts when the Source changes.

/** The directory under a storage root that holds Mnemon's stores, one per Native space, and their registry. */
export const MEMORY_SPACES_DIRECTORY = 'data'
/** The registry of Native spaces. The published v1 name and its `bodies` key stay for existing stores and Packs. */
export const MEMORY_SPACE_REGISTRY_FILE = '.dsh-memory-bodies.json'
/** A Native space's Mnemon store, in the directory its space id names. */
export const MEMORY_SPACE_DATABASE_FILE = 'mnemon.db'
/** A space id, which also names its store's directory. */
export const MEMORY_SPACE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
/** The most characters a space's name holds. */
export const MEMORY_SPACE_NAME_MAX_LENGTH = 100
/** The most characters a space's routing description holds. */
export const MEMORY_SPACE_DESCRIPTION_MAX_LENGTH = 1000
/** Mnemon's own record of its default store, one space id, at the storage root. */
export const MNEMON_ACTIVE_STORE_FILE = 'active'
/** Third-party Provider services and the spaces they serve, in the storage root's `state` directory. No Pack carries it. */
export const MEMORY_PROVIDER_REGISTRY_FILE = 'memory-providers.json'

/** One Native space as a copy of the registry, such as a Mnemon Pack, carries it. */
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

/**
 * Read a registry as a copy of it carries it: each id unique and usable as a directory name,
 * every name, description and time present, or the whole registry is refused. Only the fields of
 * the entry above are kept, so a copy holds nothing else, and a registry written back from one
 * no longer holds what else an entry recorded, such as a Native space's `placement` decision or
 * `metadataSource`.
 */
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

/** What a stored registry holds, counted without judging each space. */
export interface MemorySpaceRegistrySummary {
  /** Whether it is the version 1 registry this Source writes; a legacy version 2 file, migrated when the Source next loads it, is not. */
  valid: boolean
  /** Every listed space that is an object, whichever version lists it. */
  spaces: number
  active: number
}

/** Count the spaces of a parsed registry for a read-only inventory. It never throws. */
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

/** What a stored Provider registry holds, counted without judging each entry. */
export interface MemoryProviderRegistrySummary {
  /** Whether the file is an object at all. Without one, every count is 0. */
  valid: boolean
  /** Provider services with saved settings, enabled or not. */
  services: number
  /** Spaces a third-party Provider serves: every entry of the list, well-formed or not. */
  connections: number
}

/** Count a parsed Provider registry for a read-only inventory. It never throws. */
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

// Published type spellings retained for independently installed v0.5.x consumers.
/** @deprecated Use CreateMemorySpaceRequest. The wire shape is unchanged. */
export type CreateMemoryBodyRequest = CreateMemorySpaceRequest
/** @deprecated Use UpdateMemorySpaceRequest. The wire shape is unchanged. */
export type UpdateMemoryBodyRequest = UpdateMemorySpaceRequest
/** @deprecated Use MemorySpace. The wire shape is unchanged. */
export type MemoryBody = MemorySpace
/** @deprecated Use MemorySpaceCatalog. The wire shape is unchanged. */
export type MemoryBodyCatalog = MemorySpaceCatalog
/** @deprecated Use MemorySpaceMetadataMaintenanceResult. The wire shape is unchanged. */
export type MemoryBodyMetadataMaintenanceResult = MemorySpaceMetadataMaintenanceResult
/** @deprecated Use MemorySpaceMetadataSample. The wire shape is unchanged. */
export type MemoryBodyMetadataSample = MemorySpaceMetadataSample
/** @deprecated Use MemorySpaceMetadataUpdate. The wire shape is unchanged. */
export type MemoryBodyMetadataUpdate = MemorySpaceMetadataUpdate
/** @deprecated Use MemorySpaceProvider. The wire shape is unchanged. */
export type MemoryBodyProvider = MemorySpaceProvider
/** @deprecated Use MemorySpaceStats. The wire shape is unchanged. */
export type MemoryBodyStats = MemorySpaceStats
/** @deprecated Use MemorySpaceView. The wire shape is unchanged. */
export type MemoryBodyView = MemorySpaceView
/** @deprecated Use OpenVikingSpaceConnection. The wire shape is unchanged. */
export type OpenVikingBodyConnection = OpenVikingSpaceConnection
