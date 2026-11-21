import type { SkillCreationConfig } from 'dsh-mnemon-source-skills/contracts'
import type {
  MemoryPersistenceStrategy,
  MnemonEmbeddingConfig,
  RecallQualityConfig,
  ResolvedMemoryPersistenceStrategy,
  ResolvedMnemonEmbeddingConfig,
  ResolvedRecallQualityConfig,
} from 'dsh-mnemon-source-memory-spaces/contracts'
import type { MemoryViewPreferences } from '../view-protocol.ts'

export type StorageScopeKind = 'global' | 'workspace' | 'custom' | 'workspaces'

export function isWorkspaceStorageScope(scope: string | undefined): boolean {
  return scope === 'workspace' || scope === 'workspaces'
}

export type MemoryParticipationMode = 'off' | 'manual' | 'automatic'
export type MemoryParticipationChannel = 'recall' | 'write' | 'projection' | 'maintenance'
export type MemoryLayerParticipation = Record<MemoryParticipationChannel, MemoryParticipationMode>

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

export const DEFAULT_RUNTIME_MAINTENANCE_MAX_TOKENS = 8_192
export const DOCUMENTS_DEFAULT_LIMIT_BYTES = 10 * 1024 * 1024
export const DOCUMENTS_MAX_LIMIT_BYTES = 100 * 1024 * 1024

export interface DocumentsConfig {
  limitBytes?: number
}

export interface ResolvedDocumentsConfig {
  limitBytes: number
}

export interface RuntimeMemoryConfig {
  bm25Recall?: boolean
  indexPush?: boolean
  deferLowPriority?: boolean
  inheritToSubagents?: boolean
  memoryLimitBytes?: number
  userLimitBytes?: number
  maintenanceMaxTokens?: number
}

export interface ResolvedRuntimeMemoryConfig {
  bm25Recall: boolean
  indexPush: boolean
  deferLowPriority: boolean
  inheritToSubagents: boolean
  memoryLimitBytes: number
  userLimitBytes: number
  maintenanceMaxTokens: number
}

export { STARTER_COMPONENT_ROWS } from '../starter-components.ts'
export { normalizeDisplayMode } from '../display-mode.ts'
export type MnemonDisplayMode = 'sidebar' | 'builtin'

export const DEFAULT_IDLE_REVIEW = {
  enabled: true,
  silent: true,
  runtimeMemory: true,
  persistWatermark: false,
  provider: 'spawn',
  fallback: 'spawn',
  agentTeams: 'pause',
  minIntervalMs: 300_000,
  maxPerSession: 20,
  maxContextChars: 24_000,
  maxTokens: 16_384,
} satisfies ResolvedIdleReviewConfig

export interface ResolvedIdleReviewConfig {
  enabled: boolean
  silent: boolean
  runtimeMemory: boolean
  persistWatermark: boolean
  provider: 'spawn' | 'fork'
  fallback: 'spawn' | 'skip'
  agentTeams: 'pause' | 'scoped'
  minIntervalMs: number
  maxPerSession: number
  maxContextChars: number
  maxTokens: number
}

export interface Config {
  storageScope?: StorageScopeKind
  runtimeUserScope?: 'storage' | 'global'
  documentsScope?: 'storage' | 'global'
  memorySpacesScope?: 'storage' | 'global'
  excludedWorkspaces?: string[]
  cliPath?: string
  dataDir?: string
  customPackId?: string
  customPacks?: CustomPackConfig[]
  store?: string
  timeoutMs?: number
  defaultRecallLimit?: number
  documents?: DocumentsConfig
  runtimeMemory?: RuntimeMemoryConfig
  embedding?: MnemonEmbeddingConfig
  memoryTopology?: MemoryTopologyConfig
  memoryView?: MemoryViewPreferences
  legacySettingsImported?: boolean
  recallQuality?: RecallQualityConfig
  routingGuidance?: boolean
  displayMode?: MnemonDisplayMode | 'buildin'
  tabEnabled?: boolean
  writeEnabled?: boolean
  confirmWrites?: boolean
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
  skills?: SkillsConfig
  persistenceStrategy?: MemoryPersistenceStrategy
  taskAgentModel?: TaskAgentModelConfig
  subagentProviderNames?: string[]
  syncEnabled?: boolean
}

export interface TaskAgentModelConfig {
  mode?: 'inherit' | 'fixed'
  provider?: string
  model?: string
  followConversation?: boolean
}

export interface ResolvedTaskAgentModelConfig {
  mode: 'inherit' | 'fixed'
  provider?: string
  model?: string
  followConversation?: true
}

export type {
  TaskAgentModelCatalog, TaskAgentModelCatalogFailure, TaskAgentModelCatalogGroup, TaskAgentModelCatalogModel,
} from '../../core/contracts/task-agent-model.ts'

export interface InteractionConfig {
  turnBar?: boolean
  saveAction?: boolean
}

export interface ResolvedConfig {
  storageScope: StorageScopeKind
  runtimeUserScope: 'storage' | 'global'
  documentsScope: 'storage' | 'global'
  memorySpacesScope: 'storage' | 'global'
  excludedWorkspaces: string[]
  cliPath?: string
  dataDir?: string
  store?: string
  timeoutMs: number
  defaultRecallLimit: number
  documents: ResolvedDocumentsConfig
  runtimeMemory: ResolvedRuntimeMemoryConfig
  embedding: ResolvedMnemonEmbeddingConfig
  memoryTopology: ResolvedMemoryTopologyConfig
  recallQuality: ResolvedRecallQualityConfig
  routingGuidance: boolean
  displayMode: MnemonDisplayMode
  tabEnabled: boolean
  writeEnabled: boolean
  confirmWrites: boolean
  remoteAccess: 'read-only' | 'trusted-host'
  lifecycleEnabled: boolean
  recallMode: 'guided' | 'off'
  writebackMode: 'guided' | 'off'
  idleReviewMs: number
  idleReview: ResolvedIdleReviewConfig
  conversationInteraction: {
    turnBar: boolean
    saveAction: boolean
  }
  skills: ResolvedSkillsConfig
  persistenceStrategy: ResolvedMemoryPersistenceStrategy
  taskAgentModel: ResolvedTaskAgentModelConfig
  subagentProviderNames: string[]
  syncEnabled: boolean
}

export interface ResolvedInteractionConfig {
  turnBar: boolean
  saveAction: boolean
}

export type SkillsConfig = Partial<ResolvedSkillsConfig>

export interface ResolvedSkillsConfig {
  skillRoots?: SkillCreationConfig
  evolution: boolean
  allowCreate: boolean
  allowUpdate: boolean
  allowLinkedUpdates: boolean
  targetScope: 'storage' | 'user' | 'project'
  autoBacktest: boolean
  autoAdopt: boolean
  autoAdoptDailyLimit: number
  autoAdoptTimeZone: string
  draftMaxTokens: number
  draftRetryMaxTokens: number
  hints: boolean
  sidebar: boolean
  reviewThreshold: number
  idleSeconds: number
  cooldownSeconds: number
  minConfidence: number
  expiryDays: number
  maxPendingPerSession: number
  casesPerRun: number
  dshHome?: string
  agentsHome?: string
}

export const DEFAULT_SKILLS_CONFIG: Readonly<ResolvedSkillsConfig> = Object.freeze({
  evolution: false,
  allowCreate: true,
  allowUpdate: true,
  allowLinkedUpdates: false,
  targetScope: 'user',
  autoBacktest: true,
  autoAdopt: false,
  autoAdoptDailyLimit: 2,
  autoAdoptTimeZone: 'local',
  draftMaxTokens: 32_768,
  draftRetryMaxTokens: 65_536,
  hints: true,
  sidebar: false,
  reviewThreshold: 5,
  idleSeconds: 20,
  cooldownSeconds: 150,
  minConfidence: 0.6,
  expiryDays: 7,
  maxPendingPerSession: 5,
  casesPerRun: 8,
})

export function validSkillsTimeZone(value: string): boolean {
  if (value === 'local') return true
  if (!value || value.length > 100) return false
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true } catch { return false }
}
