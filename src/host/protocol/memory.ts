import type { DocumentMutationResult, DocumentSnapshot } from 'dsh-mnemon-source-documents/contracts'
import type {
  MemoryProviderRuntimeStatus,
  MemorySpaceStats,
  MemorySpaceView,
  ResolvedRecallQualityConfig,
} from 'dsh-mnemon-source-memory-spaces/contracts'
import type { RuntimeMemoryMutationResult } from 'dsh-mnemon-source-runtime/contracts'
import type {
  MemoryCompositionDiagnostic,
  MemoryCompositionEvaluationReport,
  MemoryManagementDescriptor,
  MemoryManagementField,
  MemoryMigrationLineage,
  MemoryMutationReceipt,
  MemorySourceManagementCatalog as CoreMemorySourceManagementCatalog,
  MemorySourceManagementInstance as CoreMemorySourceManagementInstance,
  MemorySourceManagementMode,
  MemorySourceManagementRequest,
  MemorySourceManagementResult,
} from '../../core/contracts/index.ts'
import type { ResolvedMemoryTopologyConfig, StorageScopeKind } from './config.ts'

/** Starter Entry ids remain reserved when DSH nests them under an include. */
export function isDefaultSourceInstance(instanceKey: string, sourceTypeId: string): boolean {
  return instanceKey.startsWith('source:') && instanceKey.endsWith(':mnemon-source-' + sourceTypeId)
}
/**
 * The Source of one type a named tool works on: the Starter instance, the Entry
 * `mnemon-source-<type>` also when nested under an include, or the only instance there
 * is. Among several others there is none, and each keeps its exact offers.
 */
export function namedToolInstance<T extends { sourceInstanceKey: string }>(instances: readonly T[], sourceTypeId: string): T | undefined {
  return instances.find(source => isDefaultSourceInstance(source.sourceInstanceKey, sourceTypeId)) ?? (instances.length === 1 ? instances[0] : undefined)
}

export type MemorySourceManagementField = MemoryManagementField
export type MemorySourceManagementDescriptor = MemoryManagementDescriptor
export type { MemorySourceManagementMode, MemorySourceManagementRequest, MemorySourceManagementResult }

/** Browser-safe descriptor of one Source instance visible in the current scope. */
export interface MemorySourceManagementInstance extends Omit<CoreMemorySourceManagementInstance, 'capabilities'> {
  capabilities: string[]
  assistance?: readonly string[]
}

export interface MemorySourceManagementCatalog extends Omit<CoreMemorySourceManagementCatalog, 'sources'> {
  sources: MemorySourceManagementInstance[]
  diagnostics?: MemoryCompositionDiagnostic[]
}

export interface MemoryCompositionStatus {
  /** Whether a composition serves new turns. A rejected change can leave the previous one serving. */
  serving: boolean
  /** The main Strategy composing the serving composition, which a fallback can make differ from the selected one. */
  strategyTypeId?: string
  /** Strategy support only; session policy and review settings can still prevent a run. */
  workflows?: { idleReview: boolean; runtimeCapacity: boolean }
  evaluation: MemoryCompositionEvaluationReport
  sources: MemorySourceManagementInstance[]
  configuration: ResolvedMemoryTopologyConfig
}

/** One skill a turn used: the model loaded it, or the user asked for it with `/name`. */
export interface TurnSkillUse {
  name: string
  by: 'model' | 'user'
}

/** A skill review of a conversation, placed under the turn its window ended with. */
export interface TurnSkillReview {
  turn: number
  /** `scheduled` waits for the conversation to sit idle; the others say how it went. */
  state: 'scheduled' | 'reviewing' | 'suggested' | 'nothing' | 'error'
  /** The suggestions it left that still exist, newest first. */
  suggestions: Array<{ id: string; skillName: string; action: 'create' | 'update'; status: string }>
  error?: string
}

/** What one conversation did with skills: each turn's uses and each review, for the turn bars. */
export interface SkillActivitySnapshot {
  /** Whether a skills bar has anything to read: the Skills Source runs for this conversation. */
  available: boolean
  turns: Array<{ turn: number; skills: TurnSkillUse[] }>
  reviews: TurnSkillReview[]
}

/** What the Status page says about 技能管理. */
export interface SkillsStatusSummary {
  evolution: boolean
  skills: number
  /** Suggestions and drafts waiting for the user. */
  waiting: number
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
  /** Skill reviews, drafts, backtest runs and case derivations. */
  skills?: number
  failures: number
  lastRunId?: string
  lastOperation?: 'recall' | 'write' | 'review' | 'placement' | 'migration' | 'compaction' | 'document-archive' | 'metadata-maintenance' | 'reconcile' | 'skill'
  lastAt?: string
}

/** What a delegated memory write did, as the write task Agent's receipts show it. */
export interface DelegatedWriteResult {
  delegated: true
  runId: string
  provider: string
  summary: string
  action: string
  /** Where the memory went: the spaces its receipts name, else what the writer reported. */
  memoryBodyIds: string[]
  /** Spaces that were inactive and that this write switched on. */
  activatedMemoryBodyIds?: string[]
  documentIds?: string[]
  /** Memories saved without a vector, as the Provider's receipt says (#388). */
  unembedded?: Array<{ memoryBodyId?: string; id?: string }>
  hint?: string
}

/** The `supervise` RPC result: a delegated write for the conversation that asked for it. */
export interface SupervisedWritebackResult extends DelegatedWriteResult { sessionId: string }

/** What a task Agent answered from the evidence a search recalled, as `agent-search` adds it to the results. */
export interface DelegatedAnswerResult {
  answer: string
  citations: string[]
  delegation: { runId: string; provider: string }
}

/** A Document write or archive the Host ran: the Documents Source's result, and the archival it ran, for the archive or to make room for the write. */
export type CoordinatedDocumentResult = DocumentMutationResult & {
  lineage?: MemoryMigrationLineage[]
  maintenance?: { runId: string; provider: string; summary: string; memoryBodyIds: string[]; archivedDocumentIds: string[] }
}

/** A runtime memory write the Host ran: the Runtime Source's result, and the capacity maintenance that ran with it. */
export type CoordinatedRuntimeMemoryResult = RuntimeMemoryMutationResult & {
  revision?: string
  maintenance?: { runId: string; provider: string; summary: string; memoryBodyIds: string[] }
  memoryReceipt?: Pick<MemoryMutationReceipt, 'status' | 'completion' | 'committedAt'>
}

export type LifecyclePhase = 'idle' | 'prime' | 'recall' | 'writeback' | 'review' | 'supervised' | 'error'

export interface LifecycleCounters {
  primes: number
  recallCues: number
  writebackCues: number
  supervisedRequests: number
  failures: number
}

/** Last automatic-review tool check for one live Agent, without raw errors or arguments. */
export interface ReviewAccessStatus {
  state: 'unchecked' | 'available' | 'unavailable'
  reason?: 'disposed' | 'executor-unavailable' | 'check-in-flight' | 'no-open-step' | 'approval-required' | 'handler-not-reached' | 'result-rejected' | 'timeout' | 'execution-error' | 'cancelled'
  checkedAt?: string
}

export interface WorkspaceMemoryParticipation {
  excluded: boolean
  reason?: 'workspace-unavailable'
  /** Zero-based positions of ignored invalid/unavailable configuration entries. */
  invalidEntries?: number[]
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
  idleReviewBlocked?: 'agent-team' | 'tool-access'
  idleReviewAccess?: ReviewAccessStatus
  idleReviewWatermark?: { state: 'ready' | 'error'; restoredAttempts: number; maxPerSession: number; error?: string }
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
  /** 技能管理, when its Source runs for this scope. */
  skills?: SkillsStatusSummary
  storage?: StorageScopeCatalog
  workspaceContext?: {
    participation?: WorkspaceMemoryParticipation
    workspaces?: Array<{ id: string; participation: WorkspaceMemoryParticipation }>
    mode: StorageScopeKind
    selectedRoot: string
    effectiveRoot: string
    aligned: boolean
    selectedWorkspace?: { id: string; title: string; path: string }
    effectiveWorkspace?: { id: string; title: string; path: string }
  }
  stats?: MemorySpaceStats & { dbPath?: string }
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
