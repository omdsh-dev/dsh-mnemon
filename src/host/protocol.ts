/** Starter Entry ids remain reserved when DSH nests them under an include. */
export function isDefaultSourceInstance(instanceKey: string, sourceTypeId: string): boolean {
  return instanceKey.startsWith('source:') && instanceKey.endsWith(':mnemon-source-' + sourceTypeId)
}
export type MemoryParticipationMode = 'off' | 'manual' | 'automatic'
export type MemoryParticipationChannel = 'recall' | 'write' | 'projection' | 'maintenance'
export type MemoryLayerParticipation = Record<MemoryParticipationChannel, MemoryParticipationMode>
export interface MemoryTopologyDefinition { id: string; strategyId: string; layers: Array<ResolvedMemoryLayerConfig & { id: string }> }
export interface MemoryCompositionStatus {
  /** Whether a composition serves new turns. A rejected change can leave the previous one serving. */
  serving: boolean
  /** The main Strategy composing the serving composition, which a fallback can make differ from the selected one. */
  strategyTypeId?: string
  evaluation: import('../core/contracts/index.ts').MemoryCompositionEvaluationReport
  sources: MemorySourceManagementInstance[]
  configuration: ResolvedMemoryTopologyConfig
}

import type { RecallQualityConfig, ResolvedRecallQualityConfig, MnemonEmbeddingConfig, ResolvedMnemonEmbeddingConfig } from 'dsh-mnemon-source-memory-spaces/contracts'
import type {
  MemoryPersistenceStrategy,
  ResolvedMemoryPersistenceStrategy,
  MemoryProviderRuntimeStatus,
  Source,
  MemoryBodyStats as MemorySpaceStats,
  MemoryBodyView as MemorySpaceView,
} from 'dsh-mnemon-source-memory-spaces/contracts'
import type { ConnectionHandle as DshClientConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { DocumentSnapshot } from 'dsh-mnemon-source-documents/contracts'

export const MNEMON_READ_CHANNEL = '/dsh-mnemon-read'
export const MNEMON_ACTIVATION_CHANNEL = '/dsh-mnemon-activation'
export const MNEMON_WRITE_CHANNEL = '/dsh-mnemon-write'
export const MNEMON_PACK_CHANNEL = '/dsh-mnemon-pack'
export const MNEMON_SYNC_CHANNEL = '/dsh-mnemon-sync'
/**
 * The credential environment variable the sync channel reads before its stored
 * token. The name travels to the browser so the settings form can tell the user
 * which variable wins; the value never does.
 */
export const MNEMON_SYNC_TOKEN_ENV = 'MNEMON_SYNC_GIT_TOKEN'
/**
 * What a storage root publishes before anyone configures it: the branch, the
 * directory inside it, and the commit identity used when no author is set. They
 * are declared with the wire constants because the settings form shows the same
 * defaults the Host would apply to an empty field.
 */
export const MNEMON_SYNC_DEFAULT_BRANCH = 'mnemon-sync'
export const MNEMON_SYNC_DEFAULT_SUBDIR = 'mnemon/'
export const MNEMON_SYNC_DEFAULT_AUTHOR_NAME = 'dsh-mnemon sync'
export const MNEMON_SYNC_DEFAULT_AUTHOR_EMAIL = 'mnemon@localhost'
export const MNEMON_SETTINGS_CHANNEL = '/dsh-mnemon-settings'
/**
 * Reconciliation is the only channel that changes memory after a human read it:
 * it stages proposals into a review ledger, takes opinions, and applies an
 * accepted entry. It is deliberately separate from the write channel.
 */
export const MNEMON_REVIEW_CHANNEL = '/dsh-mnemon-review'
/** DSH API Gateway endpoints used by paired remote Web clients. */
export const MNEMON_REMOTE_CHANNEL = '/api'
export const MNEMON_REMOTE_NAMESPACE = 'dshMnemon'
export const MNEMON_REMOTE_READ_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/read`
export const MNEMON_REMOTE_ACTIVATION_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/activation`
export const MNEMON_REMOTE_WRITE_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/write`
export const MNEMON_REMOTE_PACK_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/pack`
export const MNEMON_REMOTE_SYNC_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/sync`
export const MNEMON_REMOTE_SETTINGS_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/settings`
export const MNEMON_REMOTE_VIEW_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/view`
export const MNEMON_REMOTE_VIEW_WRITE_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/viewWrite`
export const MNEMON_REMOTE_REVIEW_ENDPOINT = `${MNEMON_REMOTE_NAMESPACE}/review`
export const MNEMON_SETTINGS_NAMESPACE = 'mnemon'
export const MNEMON_UI_SETTINGS_NAMESPACE = 'mnemon-ui'
export * from './view-protocol.ts'
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
  assistance?: readonly string[]
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
export type ClientConnectionHandle = Pick<DshClientConnectionHandle, 'rpc' | 'isLoopback'>

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
  mutate(ops: SettingsOperation[]): Promise<void>
}

export type SettingsOperation = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }

export type StorageScopeKind = 'global' | 'workspace' | 'custom' | 'workspaces'

export function isWorkspaceStorageScope(scope: string | undefined): boolean {
  return scope === 'workspace' || scope === 'workspaces'
}

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

export { normalizeDisplayMode } from './display-mode.ts'
export type MnemonDisplayMode = 'sidebar' | 'builtin'

export const DEFAULT_IDLE_REVIEW = {
  enabled: true,
  runtimeMemory: true,
  provider: 'spawn',
  fallback: 'spawn',
  agentTeams: 'pause',
  minIntervalMs: 300_000,
  maxPerSession: 20,
  maxContextChars: 24_000,
  maxTokens: 4_096,
} satisfies ResolvedIdleReviewConfig

export interface ResolvedIdleReviewConfig {
  enabled: boolean
  /** Whether review may change USER.md and MEMORY.md; it can create Documents either way. */
  runtimeMemory: boolean
  provider: 'spawn' | 'fork'
  /** Applies only before a child starts; a failed run is never replayed. */
  fallback: 'spawn' | 'skip'
  /** Explicit opt-in for compatible Team policies; tool isolation is mandatory. */
  agentTeams: 'pause' | 'scoped'
  minIntervalMs: number
  maxPerSession: number
  maxContextChars: number
  maxTokens: number
}

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
  /** Profile-owned plugin choices on DSH 0.1.7 and newer. */
  memoryView?: import('./view-protocol.ts').MemoryViewPreferences
  /** Successful import of this profile's removed settings namespaces. */
  legacySettingsImported?: boolean
  recallQuality?: RecallQualityConfig
  routingGuidance?: boolean
  /** Entry placement only. Legacy `buildin` input is migrated to `builtin`. */
  displayMode?: MnemonDisplayMode | 'buildin'
  tabEnabled?: boolean
  writeEnabled?: boolean
  /** Remote management grant for paired pages; loopback pages keep full access. */
  remoteAccess?: 'read-only' | 'trusted-host'
  lifecycleEnabled?: boolean
  recallMode?: 'guided' | 'off'
  writebackMode?: 'guided' | 'off'
  idleReviewMs?: number
  idleReview?: Partial<ResolvedIdleReviewConfig>
  conversationInteraction?: {
    toolviews?: boolean
    turnBar?: boolean
    saveAction?: boolean
  }
  /** Provider policy used when an Agent must create a new Memory Space while distilling memory. */
  persistenceStrategy?: MemoryPersistenceStrategy
  /** Model route used by clean, session-independent maintenance Agents. */
  taskAgentModel?: TaskAgentModelConfig
  /**
   * Whether this profile runs Git repository sync at all. It lives here rather than
   * in the data directory because the settings page has to draw the block without
   * asking the Host anything: a disabled block must not run a single Git command.
   */
  syncEnabled?: boolean
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
  effective?: { provider: string; model: string; source: 'fixed' | 'session' | 'dsh-default' | 'active-agent' }
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
  /** Remote management grant for paired pages; loopback pages keep full access. */
  remoteAccess: 'read-only' | 'trusted-host'
  lifecycleEnabled: boolean
  recallMode: 'guided' | 'off'
  writebackMode: 'guided' | 'off'
  idleReviewMs: number
  idleReview: ResolvedIdleReviewConfig
  conversationInteraction: {
    toolviews: boolean
    turnBar: boolean
    saveAction: boolean
  }
  persistenceStrategy: ResolvedMemoryPersistenceStrategy
  taskAgentModel: ResolvedTaskAgentModelConfig
  syncEnabled: boolean
}

export interface ResolvedInteractionConfig {
  turnBar: boolean
  saveAction: boolean
}

/**
 * Provider instance identity inside one Memory Spaces Source. Built-in ids
 * remain stable; third-party child modules may contribute additional ids.
 */
export type * from 'dsh-mnemon-source-memory-spaces/contracts'

export type * from 'dsh-mnemon-source-documents/contracts'
export type * from 'dsh-mnemon-source-runtime/contracts'

export interface TurnMemoryActivity {
  turn: number
  count: number
  names: string[]
  recalls: number
  writes: number
  documentSearches: number
  inspections: number
  failures: number
  /** Successful evidence-bearing reads with tool-authored safe previews. */
  retrieved: MemoryActivityRead[]
  /** Only writes whose tool-authored result confirms durable commitment. */
  writebacks: MemoryActivityWriteback[]
}

export interface MemoryActivityItem {
  id: string
  title: string
  excerpt?: string
}

export interface MemoryActivityRead {
  callId: string
  toolName: string
  operationId: string
  reference?: string
  sourceTypeId?: string
  items: MemoryActivityItem[]
}

export interface MemoryActivityWriteback {
  callId: string
  toolName: string
  operationId: string
  reference?: string
  sourceTypeId?: string
  item: MemoryActivityItem
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
  reconciliations: number
  failures: number
  lastRunId?: string
  lastOperation?: 'recall' | 'write' | 'review' | 'placement' | 'migration' | 'compaction' | 'document-archive' | 'metadata-maintenance' | 'reconcile'
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
  idleReviewAttempts?: number
  idleReviewBlocked?: 'agent-team'
  nextReviewAt?: string
  lastReviewFailure?: IdleReviewFailure
  lastAt?: string
  lastError?: string
}

/** Reconciliation metadata only; raw tool arguments and memory content stay private. */
export interface IdleReviewFailure {
  status: 'failed' | 'partial'
  runId?: string
  provider: string
  receipts: Array<{ tool: string; action: string; documentId?: string; target?: string; revision?: string }>
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
  /** The dsh-mnemon version this Host runs, which an installed update replaces only when DSH restarts. */
  dshMnemonVersion?: string
  /** Updates installed while this Host runs; they load when DSH restarts. */
  restartPending?: VersionRestartStatus
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
  memoryBodies: MemorySpaceView[]
  providerServices?: MemoryProviderRuntimeStatus[]
  memorySystem?: MemoryCompositionStatus
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
  stats?: MemorySpaceStats & { dbPath?: string }
}

export type MnemonPackComponent = 'runtime' | 'documents' | 'memory-spaces'
/** The Sources that keep their data in Mnemon's data directory, in the order a backup lists them. */
export const MNEMON_PACK_COMPONENTS = ['runtime', 'documents', 'memory-spaces'] as const satisfies readonly MnemonPackComponent[]
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

/** Where memory lives now, and where the global scope keeps it when no directory is chosen. */
export interface MnemonPackTarget {
  root: string
  scope: StorageScopeKind
  defaultRoot: string
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

/**
 * What a merge did to the runtime entries, stated as counts rather than as a file.
 * A page that reports "added" without this number is guessing, and a merge that
 * leaves an entry out because a tombstone still hides it has to say how many.
 */
export interface MnemonRuntimeMergeReport {
  /** Incoming entries this merge wrote into the data directory. */
  added: number
  /** Incoming entries a tombstone still hides, so the merge left them out. */
  held: number
}

export interface MnemonPackImportResult {
  imported: true
  mode: MnemonPackImportMode
  targetRoot: string
  components: MnemonPackComponent[]
  summary: MnemonPackComponentSummary[]
  /** Present when this import merged runtime entries. */
  runtime?: MnemonRuntimeMergeReport
}

/**
 * The identity one installation signs its entries with. It stays in the data
 * directory's state area, which no Pack component carries, and travels only
 * over the sync channel, never inside a Pack.
 */
export interface MnemonMachineIdentity {
  id: string
  label: string
  createdAt: string
}

/** Which machine wrote one runtime entry, so a merge can tell two installations apart. */
export interface MnemonEntryOrigin {
  machine: string
  label: string
  at: string
}

/** One entry one machine removed, so the removal survives a merge instead of resurrecting. */
export interface MnemonTombstone {
  target: 'memory' | 'user'
  contentHash: string
  deletedAt: string
  machine?: string
}

export interface MnemonTombstoneFile {
  version: 1
  tombstones: MnemonTombstone[]
}

/** What one memory reconciliation proposes, and why. Nothing here is applied until a reviewer accepts it. */
export type MnemonReconcileOperation =
  | { kind: 'runtime-add'; target: 'memory' | 'user'; content: string; importance: 'critical' | 'normal' | 'low'; branches?: string[]; reason: string }
  | { kind: 'runtime-replace'; target: 'memory' | 'user'; oldText: string; content: string; importance?: 'critical' | 'normal' | 'low'; branches?: string[]; reason: string }
  | { kind: 'runtime-remove'; target: 'memory' | 'user'; oldText: string; reason: string }
  | { kind: 'document-archive'; documentId: string; reason: string }

export type MnemonReviewStatus = 'pending' | 'accepted' | 'rejected'

/** One reviewer's opinion on a proposal. Accepting or rejecting never replaces writing what one thinks. */
export interface MnemonReviewOpinion {
  id: string
  author: 'user' | 'agent'
  text: string
  createdAt: string
}

export interface MnemonReviewEntry {
  id: string
  createdAt: string
  updatedAt: string
  status: MnemonReviewStatus
  title: string
  summary: string
  /** The installation that produced the proposal. */
  machine: { id: string; label: string }
  /** Other installations whose entries the proposal touches, so a reviewer sees whose memory is at stake. */
  foreignMachines: string[]
  operations: MnemonReconcileOperation[]
  opinions: MnemonReviewOpinion[]
  decidedAt?: string
  appliedAt?: string
  /**
   * The positions in `operations` that have already run. Applying a plan is repeatable
   * because a reviewer can keep only part of it: a position written here is never offered
   * again, and a plan whose every operation ran is history rather than work.
   */
  appliedOperations?: number[]
  failure?: string
}

export interface MnemonReviewLedgerView {
  path: string
  entries: MnemonReviewEntry[]
  pending: number
  /**
   * The newest proposal, and only it, carried with the list so a caller can read what
   * the last run proposed without a second round trip. Its operations are withheld
   * here: the list is a summary, and one plan can hold `MAX_RECONCILE_OPERATIONS` changes.
   */
  latest?: MnemonReviewEntry
}

export interface MnemonReviewApplyResult {
  entry: MnemonReviewEntry
  applied: number
  failures: string[]
}

/** What a reconciliation run is told beyond the memory it reads. */
export interface MnemonReconcileOptions {
  /**
   * The reviewer's own words: what the plan should accomplish. It shapes the plan and
   * never widens it - the host still decides what an operation may contain.
   */
  guidance?: string
}

/** What one reconciliation run produced. A run with no findings creates no review. */
export interface MnemonReconcileResult {
  /** One line a reviewer scans in the ledger list. */
  title: string
  summary: string
  action: 'planned' | 'none' | 'failed'
  /** How many operations the proposal holds; the review entry carries the details. */
  operations: number
  foreignMachines: string[]
  /** How many entries the branch held that this installation had not merged, when it could be read. */
  remoteEntries?: number
  /** Whether the plan was given the reviewer's own words to follow. */
  guided?: boolean
  entry?: MnemonReviewEntry
  provider: string
  runId: string
}

/**
 * Git repository sync: the Mnemon Pack payload published as readable files on one
 * branch, so a second machine can pull it back. Push and pull are confirmed
 * actions, and the token is read per operation and never leaves the Host.
 */
export interface MnemonSyncConfigView {
  /**
   * Whether this profile syncs at all. It lives in the profile rather than in the
   * data directory so the settings page can draw the block without asking the Host
   * anything - a disabled block must not run a single Git command to render.
   */
  enabled: boolean
  repoUrl?: string
  branch: string
  subdir: string
  /** Whether a credential is available; its value is never part of an answer. */
  hasToken: boolean
  /** Where the credential the channel would authenticate with comes from. */
  credentialSource: MnemonSyncCredentialSource
  /** The GitHub account the stored grant belongs to, when that is the source. */
  credentialLogin?: string
  authorName: string
  authorEmail: string
  /** Minutes between automatic backups; zero means the channel runs only when asked. */
  autoBackupMinutes: number
}

/**
 * The credential the next Git operation authenticates with. The environment
 * wins over the stored token, and the GitHub sign-in is what a user reaches for
 * when neither is set: the order here is the order of resolution.
 */
export type MnemonSyncCredentialSource = 'environment' | 'token' | 'github' | 'none'

/** How far the browser step of a GitHub sign-in has come. */
export type MnemonSyncGitHubFlowStatus = 'pending' | 'expired' | 'denied' | 'error'

export interface MnemonSyncGitHubFlow {
  userCode: string
  verificationUri: string
  /** When the code stops being accepted, as an ISO timestamp. */
  expiresAt: string
  /** The cadence the Host polls at, so the page can match it. */
  intervalMs: number
}

/** The sign-in surface: whether it is possible, and how far it has come. */
export interface MnemonSyncGitHubStatus {
  /** Whether this Host exposes a credentials store the grant can live in. */
  available: boolean
  signedIn: boolean
  /** Whether the store accepts writes, which a read-only source denies. */
  writable: boolean
  login?: string
  scopes?: string[]
  flow?: MnemonSyncGitHubFlow
}

export interface MnemonSyncGitHubPoll {
  status: 'pending' | 'success' | 'expired' | 'denied' | 'error'
  /** The cadence to wait for before asking again. */
  intervalMs?: number
  login?: string
  /** Why the sign-in ended without a grant, when it did. */
  message?: string
}

export interface MnemonSyncGitHubRepository {
  name: string
  fullName: string
  /** The HTTPS address Git clones, which is what the channel stores. */
  url: string
  private: boolean
  defaultBranch: string
  owner: string
  /** Whether the account may push here; a repository it cannot is shown disabled. */
  push: boolean
}

export interface MnemonSyncGitHubRepositoryList {
  login: string
  repositories: MnemonSyncGitHubRepository[]
}

export interface MnemonSyncGitStatus {
  available: boolean
  required: string
  version?: string
  /** Why Git cannot serve the channel, when it cannot. */
  issue?: string
}

export interface MnemonSyncRemoteStatus {
  reachable: boolean
  branchExists: boolean
  commit?: string
  error?: string
}

export interface MnemonSyncCommit {
  id: string
  message: string
  committedAt: string
}

export interface MnemonSyncStatus {
  /** Whether this profile syncs at all; when false nothing else here was checked. */
  enabled: boolean
  configured: boolean
  config: MnemonSyncConfigView
  configPath: string
  /** The disposable Git work tree the channel commits in. */
  mirrorPath: string
  git: MnemonSyncGitStatus
  remote: MnemonSyncRemoteStatus
  /**
   * This installation's identity, which its entries and its commits carry. Absent
   * while sync is switched off: the identity is only ever minted for a channel that
   * runs, and a disabled block writes nothing.
   */
  machine?: MnemonMachineIdentity
  lastCommit?: MnemonSyncCommit
  /** The background cadence this Host keeps; absent when no timer runs for this runtime. */
  autoBackup?: MnemonSyncAutoBackup
}

/**
 * The background cadence one runtime keeps. The timer never writes memory: it
 * repeats the same confirmed push the button runs, and the merge a push
 * performs is the only thing that brings remote entries in.
 */
export interface MnemonSyncAutoBackup {
  /** Whether this Host runs a background backup at all. */
  available: boolean
  /** When the last automatic run finished, as an ISO timestamp. */
  lastAt?: string
  /** When the next automatic run is due, as an ISO timestamp. */
  nextAt?: string
  /** Why the last automatic run failed, when it did. */
  lastError?: string
  /** The commit the last automatic run recorded. */
  lastCommit?: string
  /** Whether the last automatic run reached the branch. */
  lastPushed?: boolean
}

/**
 * What folding the mirror's loose objects into one pack recovered. Git keeps
 * every payload as new blobs until a repack runs, so a mirror that is never
 * repacked grows with every push while the pack is what a clone downloads.
 */
export interface MnemonSyncCompaction {
  /** Loose objects before the repack. */
  loose: number
  /** What those loose objects weighed, in bytes; zero when none were loose. */
  bytes: number
  /** Objects the pack holds afterwards. */
  packed: number
  /**
   * What a clone downloads, in bytes: the pack after the repack, or - when the
   * push wrote nothing new - the pack that was already there.
   */
  packedBytes: number
  /** Why the mirror was left alone, when it was; the push itself still succeeded. */
  warning?: string
}

export interface MnemonSyncPushResult {
  repoUrl: string
  branch: string
  subdir: string
  /** The commit holding this payload in the mirror. */
  commit: string
  /** Whether this run recorded a new commit; a repeat of the same payload does not. */
  committed: boolean
  message: string
  files: number
  bytes: number
  summary: MnemonPackComponentSummary[]
  pushed: boolean
  /**
   * What a push folded in from the branch before publishing. A push never
   * overwrites a remote payload: the remote is merged into this machine first,
   * and the merged result is what the new commit holds.
   */
  merged?: {
    commit: string
    machine?: { id: string; label: string }
    components: MnemonPackComponent[]
    summary: MnemonPackComponentSummary[]
    /** Entries the merge dropped because a tombstone removed them. */
    tombstones: number
  }
  /** Why the branch was not published, when it was not. */
  reason?: string
  /** What folding the mirror's loose objects into a pack recovered, when it ran. */
  compaction?: MnemonSyncCompaction
}

export interface MnemonSyncComponentDelta extends MnemonPackComponentSummary {
  /** Whether the remote payload differs from this machine's for the component. */
  changed: boolean
}

export interface MnemonSyncFileDelta {
  total: number
  changed: number
  added: number
  removed: number
}

export interface MnemonSyncPreview {
  repoUrl: string
  branch: string
  subdir: string
  commit: string
  pushedAt?: string
  manifest: MnemonPackManifest
  archiveBytes: number
  expandedBytes: number
  targetRoot: string
  targetScope: StorageScopeKind
  occupied: Record<MnemonPackComponent, boolean>
  components: MnemonSyncComponentDelta[]
  files: MnemonSyncFileDelta
  /** When this machine's payload was collected for the comparison. */
  localExportAt: string
}

export interface MnemonSyncPullResult {
  imported: true
  mode: MnemonPackImportMode
  repoUrl: string
  branch: string
  subdir: string
  commit: string
  pushedAt?: string
  manifest: MnemonPackManifest
  targetRoot: string
  components: MnemonPackComponent[]
  summary: MnemonPackComponentSummary[]
  /** Present when this pull merged runtime entries. */
  runtime?: MnemonRuntimeMergeReport
}

/**
 * One commit on the sync branch that carries a Mnemon payload. The manifest inside
 * the commit is what says which installation published it and what it held; the
 * commit itself only says when and with which message.
 */
export interface MnemonSyncBackup {
  commit: string
  message: string
  committedAt: string
  /** The installation that published this backup, when the manifest names one. */
  machine?: MnemonMachineIdentity
  pushedAt?: string
  components: MnemonPackComponentSummary[]
}

export interface MnemonSyncBackupList {
  repoUrl: string
  branch: string
  subdir: string
  commits: MnemonSyncBackup[]
  /** Whether commits older than the requested window exist on the branch. */
  truncated: boolean
}

/** One runtime entry, as a difference between this machine and the branch shows it. */
export interface MnemonSyncDiffEntry {
  target: 'memory' | 'user'
  content: string
  importance: 'critical' | 'normal' | 'low'
  /** Which installation wrote it, when that is not this machine. */
  origin?: MnemonEntryOrigin
}

/**
 * One memory this machine holds and the branch holds a different wording of: the same
 * subject written twice, so the two texts cannot both stand. Entries that merely exist
 * on one side are additions, not conflicts, and never appear here.
 */
export interface MnemonSyncDiffConflict {
  target: 'memory' | 'user'
  /** What this machine holds. */
  local: MnemonSyncDiffEntry
  /** What the branch holds, with the installation that wrote it. */
  remote: MnemonSyncDiffEntry
  /** How alike the two texts are, from 0 to 1, after normalization. */
  similarity: number
}

export interface MnemonSyncDiffSide {
  /** The manifest identity of the side: this machine's export, or the commit. */
  exportedAt: string
  entries: number
  machine?: MnemonMachineIdentity
}

/**
 * What this machine holds and the branch tip holds, stated as entries rather than
 * as bytes: which memories are only here, which are only there, and which removals
 * the branch recorded that this machine has not applied.
 */
export interface MnemonSyncDiff {
  repoUrl: string
  branch: string
  subdir: string
  commit: string
  pushedAt?: string
  localExportAt: string
  local: MnemonSyncDiffSide
  remote: MnemonSyncDiffSide
  localOnly: MnemonSyncDiffEntry[]
  remoteOnly: MnemonSyncDiffEntry[]
  /**
   * The same subject recorded differently on both sides. Only these need reconciling;
   * anything that exists on one side alone can simply be added.
   */
  conflicts: MnemonSyncDiffConflict[]
  /** How many entries both sides hold, compared by target and content. */
  shared: number
  /** Whether a side held more differences than this response lists. */
  truncated: boolean
  /**
   * How many of the entries the branch holds and this machine does not are held
   * back by this machine's own tombstones: a merge would leave every one of them
   * out, so a page that offers to add them has to say what that offer would do.
   */
  heldBack: number
  remoteTombstones: MnemonTombstone[]
}

export type VersionPackageId = `dsh-mnemon-${'source' | 'strategy' | 'provider'}-${string}`
export type VersionComponentId = 'mnemon' | 'dsh-mnemon' | VersionPackageId
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
  restartRequired?: boolean
  packages?: VersionPackageStatus[]
}

export interface VersionPackageStatus extends VersionComponentStatus {
  id: VersionPackageId
  kind: 'source' | 'strategy' | 'provider'
  managedBy: 'starter' | 'profile'
  expectedVersion?: string
}

export interface VersionStatus {
  checkedAt: string
  components: VersionComponentStatus[]
  /** How the last update this Host ran from Check versions ended, for a page DSH swapped in meanwhile. */
  lastUpdate?: VersionUpdateOutcome
}

export interface VersionUpdateOutcome {
  at: string
  component: VersionComponentId
  /** The update's reply, when it ended without an error. */
  result?: VersionUpdateResult
  /** Why it failed, when it did. */
  error?: string
}

export interface VersionRestartStatus {
  /** The dsh-mnemon version this Host runs. */
  running: string
  /** The dsh-mnemon version now installed, when it differs, however it was installed: Check versions or `dsh plugin`, for example. */
  installed?: string
  /** Packages Check versions updated on their own. */
  packages?: VersionPackageId[]
}

export interface VersionUpdateResult {
  component: VersionComponentId
  previousVersion?: string
  currentVersion?: string
  updated: boolean
  restartRequired: boolean
  output?: string
}

// Default-product form values; Source configuration is validated again by its owner.
export const CATEGORIES = ['preference', 'decision', 'fact', 'insight', 'context', 'general'] as const
export const SOURCES = ['user', 'agent', 'external'] as const
export const EDGE_TYPES = ['temporal', 'semantic', 'causal', 'entity'] as const
export const INTENTS = ['WHY', 'WHEN', 'ENTITY', 'GENERAL'] as const
export const DEFAULT_EMBEDDING_ENDPOINT = 'http://localhost:11434'
export const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text'
export const DEFAULT_EMBEDDING_PROTOCOL = 'auto'
export const MNEMON_EMBEDDING_PROTOCOLS = ['auto', 'ollama', 'openai'] as const
