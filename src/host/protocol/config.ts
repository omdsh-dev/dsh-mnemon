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
  /** Maximum total UTF-8 bytes of active Project Documents. */
  limitBytes?: number
}

export interface ResolvedDocumentsConfig {
  limitBytes: number
}

export interface RuntimeMemoryConfig {
  /** Automatically project Runtime memory into newly created child Agents; off by default. */
  inheritToSubagents?: boolean
  /** Maximum UTF-8 bytes projected into MEMORY.md. */
  memoryLimitBytes?: number
  /** Maximum UTF-8 bytes projected into USER.md. */
  userLimitBytes?: number
  /** Completion-token budget for Runtime migration and compaction workers. */
  maintenanceMaxTokens?: number
}

export interface ResolvedRuntimeMemoryConfig {
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
  /** Whether review may change USER.md and MEMORY.md; it can create Documents either way. */
  runtimeMemory: boolean
  /** Preserve attempt quota and cooling time for the same persisted parent session. */
  persistWatermark: boolean
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
  /** Optional DSH-owned overrides injected into every Mnemon CLI process. */
  embedding?: MnemonEmbeddingConfig
  memoryTopology?: MemoryTopologyConfig
  /** Profile-owned plugin choices. */
  memoryView?: MemoryViewPreferences
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
    /** @deprecated Switches nothing. Stored profiles may still hold it; the resolved config leaves it out. */
    toolviews?: boolean
    turnBar?: boolean
    saveAction?: boolean
  }
  /** 技能管理: skill evolution and where the page shows. */
  skills?: SkillsConfig
  /** Provider policy used when an Agent must create a new Memory Space while distilling memory. */
  persistenceStrategy?: MemoryPersistenceStrategy
  /** Model route used by clean, session-independent maintenance Agents. */
  taskAgentModel?: TaskAgentModelConfig
  /** Additional provider names for Hosts without enumeration and opaque provider plugins. */
  subagentProviderNames?: string[]
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
  /**
   * With `inherit`, run on the model the conversation that asked for the work
   * last used, while that conversation is open. Off by default; a switch
   * rather than a third mode, so a release that does not know it keeps
   * reading `inherit` as before.
   */
  followConversation?: boolean
}

export interface ResolvedTaskAgentModelConfig {
  mode: 'inherit' | 'fixed'
  provider?: string
  model?: string
  /** Present, and true, only on an inherited route that follows its conversation. */
  followConversation?: true
}

// The model directory lives in the browser-safe contract module so a plugin's
// client can name it; re-exported here so one declaration serves both sides.
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
  /** Remote management grant for paired pages; loopback pages keep full access. */
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

/** 技能管理's settings, as stored; every key is optional and falls back to its default. */
export type SkillsConfig = Partial<ResolvedSkillsConfig>

export interface ResolvedSkillsConfig {
  /** Review finished conversations in the background and suggest new or better skills. */
  evolution: boolean
  /** Allow reviews to suggest new skills. Existing suggestions remain actionable. */
  allowCreate: boolean
  /** Allow reviews to suggest changes to existing skills. */
  allowUpdate: boolean
  /** Opt in to editing the original targets of linked existing skills. */
  allowLinkedUpdates: boolean
  /** Destination for new skill proposals; user preserves the pre-setting behavior. */
  targetScope: 'storage' | 'user' | 'project'
  /** Backtest a draft against the current version as soon as it is written. */
  autoBacktest: boolean
  /** Opt-in automatic drafting and evaluated adoption of new idle-review suggestions. */
  autoAdopt: boolean
  /** Candidates admitted each calendar day, shared by the Skills storage root. */
  autoAdoptDailyLimit: number
  /** IANA time zone, or local for the Host process time zone. */
  autoAdoptTimeZone: string
  /** Output budget for a complete skill draft, including model reasoning. */
  draftMaxTokens: number
  /** One fresh attempt after truncation, only when larger than draftMaxTokens. */
  draftRetryMaxTokens: number
  /** The one-line skills bar under a finished turn. */
  hints: boolean
  /** 技能管理 as a sidebar entry of its own instead of a Memory System page. */
  sidebar: boolean
  /** The post-turn score a conversation's window needs before it is reviewed. */
  reviewThreshold: number
  /** How long a conversation sits idle before its review runs. */
  idleSeconds: number
  /** The least time between two reviews of one conversation. */
  cooldownSeconds: number
  /** Suggestions below this confidence are dropped. */
  minConfidence: number
  /** A pending suggestion expires after this many days. */
  expiryDays: number
  /** At most this many pending suggestions from one conversation. */
  maxPendingPerSession: number
  casesPerRun: number
  /** Custom DSH home directory used to discover user skills; defaults to ~/.dsh. */
  dshHome?: string
  /** Custom shared Agents home directory used to discover user skills; defaults to ~/.agents. */
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

/** Shared validation without exposing Host environment values to the browser. */
export function validSkillsTimeZone(value: string): boolean {
  if (value === 'local') return true
  if (!value || value.length > 100) return false
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true } catch { return false }
}
