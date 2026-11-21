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

export function isDefaultSourceInstance(instanceKey: string, sourceTypeId: string): boolean {
  return instanceKey.startsWith('source:') && instanceKey.endsWith(':mnemon-source-' + sourceTypeId)
}
export function namedToolInstance<T extends { sourceInstanceKey: string }>(instances: readonly T[], sourceTypeId: string): T | undefined {
  return instances.find(source => isDefaultSourceInstance(source.sourceInstanceKey, sourceTypeId)) ?? (instances.length === 1 ? instances[0] : undefined)
}

export type MemorySourceManagementField = MemoryManagementField
export type MemorySourceManagementDescriptor = MemoryManagementDescriptor
export type { MemorySourceManagementMode, MemorySourceManagementRequest, MemorySourceManagementResult }

export interface MemorySourceManagementInstance extends Omit<CoreMemorySourceManagementInstance, 'capabilities'> {
  capabilities: string[]
  assistance?: readonly string[]
}

export interface MemorySourceManagementCatalog extends Omit<CoreMemorySourceManagementCatalog, 'sources'> {
  sources: MemorySourceManagementInstance[]
  diagnostics?: MemoryCompositionDiagnostic[]
}

export interface MemoryCompositionStatus {
  serving: boolean
  strategyTypeId?: string
  workflows?: { idleReview: boolean; runtimeCapacity: boolean }
  evaluation: MemoryCompositionEvaluationReport
  sources: MemorySourceManagementInstance[]
  configuration: ResolvedMemoryTopologyConfig
}

export interface TurnSkillUse {
  name: string
  by: 'model' | 'user'
}

export interface TurnSkillReview {
  turn: number
  state: 'scheduled' | 'reviewing' | 'suggested' | 'nothing' | 'error'
  suggestions: Array<{ id: string; skillName: string; action: 'create' | 'update'; status: string }>
  error?: string
}

export interface SkillActivitySnapshot {
  available: boolean
  turns: Array<{ turn: number; skills: TurnSkillUse[] }>
  reviews: TurnSkillReview[]
}

export interface SkillsStatusSummary {
  evolution: boolean
  skills: number
  waiting: number
}

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
  retrieved: MemoryActivityRead[]
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
  skills?: number
  failures: number
  lastRunId?: string
  lastOperation?: 'recall' | 'write' | 'review' | 'placement' | 'migration' | 'compaction' | 'document-archive' | 'metadata-maintenance' | 'reconcile' | 'skill'
  lastAt?: string
}

export interface DelegatedWriteResult {
  delegated: true
  runId: string
  provider: string
  summary: string
  action: string
  memoryBodyIds: string[]
  activatedMemoryBodyIds?: string[]
  documentIds?: string[]
  unembedded?: Array<{ memoryBodyId?: string; id?: string }>
  hint?: string
}

export interface SupervisedWritebackResult extends DelegatedWriteResult { sessionId: string }

export interface DelegatedAnswerResult {
  answer: string
  citations: string[]
  delegation: { runId: string; provider: string }
}

export type CoordinatedDocumentResult = DocumentMutationResult & {
  lineage?: MemoryMigrationLineage[]
  maintenance?: { runId: string; provider: string; summary: string; memoryBodyIds: string[]; archivedDocumentIds: string[] }
}

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

export interface ReviewAccessStatus {
  state: 'unchecked' | 'available' | 'unavailable'
  reason?: 'disposed' | 'executor-unavailable' | 'check-in-flight' | 'no-open-step' | 'approval-required' | 'handler-not-reached' | 'result-rejected' | 'timeout' | 'execution-error' | 'cancelled'
  checkedAt?: string
}

export interface WorkspaceMemoryParticipation {
  excluded: boolean
  reason?: 'workspace-unavailable'
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
  idleReviewBlocked?: 'agent-team' | 'tool-access' | 'write-confirmation'
  idleReviewAccess?: ReviewAccessStatus
  idleReviewWatermark?: { state: 'ready' | 'error'; restoredAttempts: number; maxPerSession: number; error?: string }
  nextReviewAt?: string
  lastReviewFailure?: IdleReviewFailure
  lastAt?: string
  lastError?: string
}

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
  restartPending?: VersionRestartStatus
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
  memoryBodyDirectory: string
  memoryBodies: MemorySpaceView[]
  providerServices?: MemoryProviderRuntimeStatus[]
  memorySystem?: MemoryCompositionStatus
  lifecycle?: LifecycleSnapshot
  documents?: DocumentSnapshot
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
  lastUpdate?: VersionUpdateOutcome
}

export interface VersionUpdateOutcome {
  at: string
  component: VersionComponentId
  result?: VersionUpdateResult
  error?: string
}

export interface VersionRestartStatus {
  running: string
  installed?: string
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
