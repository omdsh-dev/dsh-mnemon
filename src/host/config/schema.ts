import z from '@deepseek-ai/schemastery'
import { MEMORY_PLACEMENT_CAPABILITIES } from 'dsh-mnemon-source-memory-spaces/contracts'
import type { MemoryJsonValue } from '../../core/contracts/index.ts'
import { isPlainObject } from '../../core/json.ts'
import type {
  Config as SharedConfig,
  DocumentsConfig,
  InteractionConfig as SharedInteractionConfig,
  MemoryPersistenceStrategy,
  MemoryProviderConnection,
  MemoryTopologyConfig,
  RecallQualityConfig,
  ResolvedSkillsConfig,
  RuntimeMemoryConfig,
  TaskAgentModelConfig,
} from '../protocol.ts'
import type { MemoryViewPreferences } from '../view-protocol.ts'
import {
  DEFAULT_EMBEDDING_ENDPOINT,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_PROTOCOL,
  DEFAULT_IDLE_REVIEW,
  DEFAULT_IDLE_REVIEW_MS,
  DEFAULT_INTERACTION_CONFIG,
  DEFAULT_RECALL_CANDIDATE_MULTIPLIER,
  DEFAULT_RECALL_HIGH_SCORE_THRESHOLD,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RECALL_LOW_SCORE_THRESHOLD,
  DEFAULT_RECALL_MAX_MEDIUM_RESULTS,
  DEFAULT_RECALL_MAX_RANKED_RESULTS,
  DEFAULT_RECALL_MAX_UNKNOWN_RESULTS,
  DEFAULT_RECALL_QUALITY_POLICY,
  DEFAULT_RUNTIME_MAINTENANCE_MAX_TOKENS,
  DEFAULT_RUNTIME_MEMORY_LIMIT_BYTES,
  DEFAULT_RUNTIME_USER_LIMIT_BYTES,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_TIMEOUT_MS,
  DOCUMENTS_DEFAULT_LIMIT_BYTES,
  DOCUMENTS_MAX_LIMIT_BYTES,
  IDLE_REVIEW_BOUNDS,
  MAX_IDLE_REVIEW_MS,
  MAX_RECALL_LIMIT,
  MAX_RUNTIME_MAINTENANCE_MAX_TOKENS,
  MAX_RUNTIME_MEMORY_LIMIT_BYTES,
  MAX_TIMEOUT_MS,
  MIN_DOCUMENTS_LIMIT_BYTES,
  MIN_IDLE_REVIEW_MS,
  MIN_RECALL_LIMIT,
  MIN_RUNTIME_MAINTENANCE_MAX_TOKENS,
  MIN_RUNTIME_MEMORY_LIMIT_BYTES,
  MIN_TIMEOUT_MS,
  MNEMON_EMBEDDING_PROTOCOLS,
  RECALL_QUALITY_BOUNDS,
  SKILLS_BOUNDS,
} from './defaults.ts'

export const MemoryViewSchema: z<MemoryViewPreferences> = z.object({
  strategyTypeId: z.string(),
  entries: z.dict(z.object({ enabled: z.boolean(), config: z.dict(z.any()).default({}) })).default({}),
})

const ENTRY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,299}$/u
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function assertPlainJsonValue(value: unknown, depth = 0): void {
  if (depth > 48) throw new Error('Plugin configuration is nested too deeply')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Plugin configuration contains a non-finite number')
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertPlainJsonValue(item, depth + 1)
    return
  }
  if (!isPlainObject(value)) throw new Error('Plugin configuration must be an object')
  for (const key of Object.keys(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe plugin configuration key')
    const item = value[key]
    if (item !== undefined) assertPlainJsonValue(item, depth + 1)
  }
}

function record(value: unknown): Record<string, MemoryJsonValue> {
  if (!isPlainObject(value)) throw new Error('Plugin configuration must be an object')
  assertPlainJsonValue(value)
  const json = JSON.stringify(value)
  if (json.length > 64 * 1024) throw new Error('Plugin configuration exceeds 64 KiB')
  const parsed = JSON.parse(json) as Record<string, MemoryJsonValue>
  for (const key of Object.keys(parsed)) if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe plugin configuration key')
  return parsed
}

export function validateMemoryViewPreferences(value: MemoryViewPreferences): MemoryViewPreferences {
  if (!isPlainObject(value)) throw new Error('Plugin configuration must be an object')
  if (value.strategyTypeId !== undefined && (typeof value.strategyTypeId !== 'string' || !/^[a-z][a-z0-9-]{0,127}$/u.test(value.strategyTypeId))) {
    throw new Error('Invalid Strategy type id')
  }
  const rawEntries = value.entries ?? {}
  if (!isPlainObject(rawEntries)) throw new Error('Plugin configuration must be an object')
  if (Object.keys(rawEntries).length > 64) throw new Error('At most 64 memory plugin Entries can be configured')
  for (const [entryId, rawItem] of Object.entries(rawEntries)) {
    if (!ENTRY_ID.test(entryId)) throw new Error('Invalid memory plugin Entry id')
    if (!isPlainObject(rawItem)) throw new Error('Plugin configuration must be an object')
    if (rawItem.enabled !== undefined && typeof rawItem.enabled !== 'boolean') throw new Error('Plugin enabled must be boolean')
    record(rawItem.config)
  }
  record(rawEntries)
  return clone(value)
}

export type Config = SharedConfig
export type InteractionConfig = SharedInteractionConfig

export const InteractionConfig: z<InteractionConfig> = z.object({
  turnBar: z.boolean().default(DEFAULT_INTERACTION_CONFIG.turnBar),
  saveAction: z.boolean().default(DEFAULT_INTERACTION_CONFIG.saveAction),
})

/** 技能管理's settings, with the ranges its page accepts. */
export const SkillsConfig: z<Partial<ResolvedSkillsConfig>, ResolvedSkillsConfig> = z.object({
  evolution: z.boolean().default(DEFAULT_SKILLS_CONFIG.evolution),
  allowCreate: z.boolean().default(DEFAULT_SKILLS_CONFIG.allowCreate),
  allowUpdate: z.boolean().default(DEFAULT_SKILLS_CONFIG.allowUpdate),
  targetScope: z.union(['storage', 'user', 'project'] as const).default(DEFAULT_SKILLS_CONFIG.targetScope),
  allowLinkedUpdates: z.boolean().default(DEFAULT_SKILLS_CONFIG.allowLinkedUpdates),
  autoBacktest: z.boolean().default(DEFAULT_SKILLS_CONFIG.autoBacktest),
  autoAdopt: z.boolean().default(DEFAULT_SKILLS_CONFIG.autoAdopt),
  autoAdoptDailyLimit: z.number().step(1).min(SKILLS_BOUNDS.autoAdoptDailyLimit.min).max(SKILLS_BOUNDS.autoAdoptDailyLimit.max).default(DEFAULT_SKILLS_CONFIG.autoAdoptDailyLimit),
  autoAdoptTimeZone: z.transform(z.string(), value => {
    // Cordis serializes transforms; this callback must not capture module bindings.
    if (value === 'local') return value
    if (!value || value.length > 100) throw new Error('skills.autoAdoptTimeZone must be an IANA time zone or local')
    try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0) } catch { throw new Error('skills.autoAdoptTimeZone must be an IANA time zone or local') }
    return value
  }).default(DEFAULT_SKILLS_CONFIG.autoAdoptTimeZone),
  draftMaxTokens: z.number().step(1).min(SKILLS_BOUNDS.draftMaxTokens.min).max(SKILLS_BOUNDS.draftMaxTokens.max).default(DEFAULT_SKILLS_CONFIG.draftMaxTokens),
  draftRetryMaxTokens: z.number().step(1).min(SKILLS_BOUNDS.draftRetryMaxTokens.min).max(SKILLS_BOUNDS.draftRetryMaxTokens.max).default(DEFAULT_SKILLS_CONFIG.draftRetryMaxTokens),
  hints: z.boolean().default(DEFAULT_SKILLS_CONFIG.hints),
  sidebar: z.boolean().default(DEFAULT_SKILLS_CONFIG.sidebar),
  reviewThreshold: z.number().step(1).min(SKILLS_BOUNDS.reviewThreshold.min).max(SKILLS_BOUNDS.reviewThreshold.max).default(DEFAULT_SKILLS_CONFIG.reviewThreshold),
  idleSeconds: z.number().step(1).min(SKILLS_BOUNDS.idleSeconds.min).max(SKILLS_BOUNDS.idleSeconds.max).default(DEFAULT_SKILLS_CONFIG.idleSeconds),
  cooldownSeconds: z.number().step(1).min(SKILLS_BOUNDS.cooldownSeconds.min).max(SKILLS_BOUNDS.cooldownSeconds.max).default(DEFAULT_SKILLS_CONFIG.cooldownSeconds),
  minConfidence: z.number().min(SKILLS_BOUNDS.minConfidence.min).max(SKILLS_BOUNDS.minConfidence.max).default(DEFAULT_SKILLS_CONFIG.minConfidence),
  expiryDays: z.number().step(1).min(SKILLS_BOUNDS.expiryDays.min).max(SKILLS_BOUNDS.expiryDays.max).default(DEFAULT_SKILLS_CONFIG.expiryDays),
  maxPendingPerSession: z.number().step(1).min(SKILLS_BOUNDS.maxPendingPerSession.min).max(SKILLS_BOUNDS.maxPendingPerSession.max).default(DEFAULT_SKILLS_CONFIG.maxPendingPerSession),
  casesPerRun: z.number().step(1).min(SKILLS_BOUNDS.casesPerRun.min).max(SKILLS_BOUNDS.casesPerRun.max).default(DEFAULT_SKILLS_CONFIG.casesPerRun),
  dshHome: z.transform(z.string(), value => {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }),
  agentsHome: z.transform(z.string(), value => {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }),
}) as unknown as z<Partial<ResolvedSkillsConfig>, ResolvedSkillsConfig>

const MemoryProviderConnectionSchema: z<MemoryProviderConnection> = z.dict(z.union([z.string(), z.number(), z.boolean()]))
const MemoryPersistenceStrategySchema = z.object({
  mode: z.union(['manual', 'automatic'] as const),
  providerId: z.string(),
  prompt: z.string(),
  rules: z.object({
    allowedProviderIds: z.array(z.string()),
    dataBoundary: z.union(['allow-remote', 'local-only'] as const),
    requiredCapabilities: z.array(z.union(MEMORY_PLACEMENT_CAPABILITIES)),
    preference: z.union(['balanced', 'local-first', 'shared-first'] as const),
  }),
  providerConnections: z.dict(MemoryProviderConnectionSchema),
}) as unknown as z<MemoryPersistenceStrategy>

const TaskAgentModelSchema: z<TaskAgentModelConfig> = z.object({
  mode: z.union(['inherit', 'fixed'] as const),
  provider: z.string(),
  model: z.string(),
  followConversation: z.boolean(),
})

const MnemonEmbeddingSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().default(DEFAULT_EMBEDDING_ENDPOINT),
  model: z.string().default(DEFAULT_EMBEDDING_MODEL),
  apiKey: z.string().role('secret').default(''),
  apiKeyEnv: z.string(),
  apiKeyRef: z.string(),
  protocol: z.union(MNEMON_EMBEDDING_PROTOCOLS).default(DEFAULT_EMBEDDING_PROTOCOL),
})

const RecallQualitySchema: z<RecallQualityConfig> = z.object({
  policy: z.string().default(DEFAULT_RECALL_QUALITY_POLICY),
  lowScoreThreshold: z.number().min(RECALL_QUALITY_BOUNDS.scoreThreshold.min).max(RECALL_QUALITY_BOUNDS.scoreThreshold.max).default(DEFAULT_RECALL_LOW_SCORE_THRESHOLD),
  highScoreThreshold: z.number().min(RECALL_QUALITY_BOUNDS.scoreThreshold.min).max(RECALL_QUALITY_BOUNDS.scoreThreshold.max).default(DEFAULT_RECALL_HIGH_SCORE_THRESHOLD),
  candidateMultiplier: z.number().step(1).min(RECALL_QUALITY_BOUNDS.candidateMultiplier.min).max(RECALL_QUALITY_BOUNDS.candidateMultiplier.max).default(DEFAULT_RECALL_CANDIDATE_MULTIPLIER),
  maxMediumResults: z.number().step(1).min(RECALL_QUALITY_BOUNDS.maxResults.min).max(RECALL_QUALITY_BOUNDS.maxResults.max).default(DEFAULT_RECALL_MAX_MEDIUM_RESULTS),
  maxRankedResults: z.number().step(1).min(RECALL_QUALITY_BOUNDS.maxResults.min).max(RECALL_QUALITY_BOUNDS.maxResults.max).default(DEFAULT_RECALL_MAX_RANKED_RESULTS),
  maxUnknownResults: z.number().step(1).min(RECALL_QUALITY_BOUNDS.maxResults.min).max(RECALL_QUALITY_BOUNDS.maxResults.max).default(DEFAULT_RECALL_MAX_UNKNOWN_RESULTS),
})

export const DocumentsSchema: z<DocumentsConfig> = z.object({
  limitBytes: z.number().step(1).min(MIN_DOCUMENTS_LIMIT_BYTES).max(DOCUMENTS_MAX_LIMIT_BYTES).default(DOCUMENTS_DEFAULT_LIMIT_BYTES),
})

export const RuntimeMemorySchema: z<RuntimeMemoryConfig> = z.object({
  inheritToSubagents: z.boolean().default(false),
  memoryLimitBytes: z.number().step(1).min(MIN_RUNTIME_MEMORY_LIMIT_BYTES).max(MAX_RUNTIME_MEMORY_LIMIT_BYTES).default(DEFAULT_RUNTIME_MEMORY_LIMIT_BYTES),
  userLimitBytes: z.number().step(1).min(MIN_RUNTIME_MEMORY_LIMIT_BYTES).max(MAX_RUNTIME_MEMORY_LIMIT_BYTES).default(DEFAULT_RUNTIME_USER_LIMIT_BYTES),
  maintenanceMaxTokens: z.number().step(1).min(MIN_RUNTIME_MAINTENANCE_MAX_TOKENS).max(MAX_RUNTIME_MAINTENANCE_MAX_TOKENS).default(DEFAULT_RUNTIME_MAINTENANCE_MAX_TOKENS),
})

export const IdleReviewSchema = z.object({
  enabled: z.boolean().default(DEFAULT_IDLE_REVIEW.enabled),
  runtimeMemory: z.boolean().default(DEFAULT_IDLE_REVIEW.runtimeMemory),
  persistWatermark: z.boolean().default(DEFAULT_IDLE_REVIEW.persistWatermark),
  provider: z.union(['spawn', 'fork'] as const).default(DEFAULT_IDLE_REVIEW.provider),
  fallback: z.union(['spawn', 'skip'] as const).default(DEFAULT_IDLE_REVIEW.fallback),
  agentTeams: z.union(['pause', 'scoped'] as const).default(DEFAULT_IDLE_REVIEW.agentTeams),
  minIntervalMs: z.number().step(1).min(IDLE_REVIEW_BOUNDS.minIntervalMs.min).max(IDLE_REVIEW_BOUNDS.minIntervalMs.max).default(DEFAULT_IDLE_REVIEW.minIntervalMs),
  maxPerSession: z.number().step(1).min(IDLE_REVIEW_BOUNDS.maxPerSession.min).max(IDLE_REVIEW_BOUNDS.maxPerSession.max).default(DEFAULT_IDLE_REVIEW.maxPerSession),
  maxContextChars: z.number().step(1).min(IDLE_REVIEW_BOUNDS.maxContextChars.min).max(IDLE_REVIEW_BOUNDS.maxContextChars.max).default(DEFAULT_IDLE_REVIEW.maxContextChars),
  maxTokens: z.number().step(1).min(IDLE_REVIEW_BOUNDS.maxTokens.min).max(IDLE_REVIEW_BOUNDS.maxTokens.max).default(DEFAULT_IDLE_REVIEW.maxTokens),
})

const MemoryParticipationModeSchema = z.union(['off', 'manual', 'automatic'] as const)
const MemoryLayerConfigSchema = z.object({
  enabled: z.boolean(),
  participation: z.object({
    recall: MemoryParticipationModeSchema,
    write: MemoryParticipationModeSchema,
    projection: MemoryParticipationModeSchema,
    maintenance: MemoryParticipationModeSchema,
  }),
  adapterIds: z.array(z.string()),
})
const MemoryTopologySchema: z<MemoryTopologyConfig> = z.object({
  id: z.string(),
  strategyId: z.string(),
  layers: z.dict(MemoryLayerConfigSchema),
})

export const Config: z<SharedConfig> = z.object({
  // Bundle wiring, not an end-user memory setting. Keep the legacy root
  // behavior by default while allowing cordis.patch.yml to compose the public
  // Source/Strategy Entries without double registration.
  // Keep this optional in the schema so legacy dataDir-only installs still
  // resolve to the custom scope instead of being silently reset to global.
  storageScope: z.union(['global', 'workspace', 'custom', 'workspaces'] as const),
  runtimeUserScope: z.union(['storage', 'global'] as const).default('storage'),
  excludedWorkspaces: z.array(z.string()).default([]),
  cliPath: z.string(),
  dataDir: z.string(),
  customPackId: z.string(),
  customPacks: z.array(z.object({
    id: z.string(),
    name: z.string(),
    dataDir: z.string(),
  })).default([]),
  store: z.string(),
  // Memory Spaces' own configuration takes 1-600,000 ms for the same value. One range for both is
  // on the roadmap (docs/plans/review-gaps-2026-10.md, item 4); until then each keeps its own,
  // so that stored values validate as they did.
  timeoutMs: z.number().step(1).min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
  defaultRecallLimit: z.number().step(1).min(MIN_RECALL_LIMIT).max(MAX_RECALL_LIMIT).default(DEFAULT_RECALL_LIMIT),
  documents: DocumentsSchema.default({
    limitBytes: DOCUMENTS_DEFAULT_LIMIT_BYTES,
  }),
  runtimeMemory: RuntimeMemorySchema.default({
    inheritToSubagents: false,
    memoryLimitBytes: DEFAULT_RUNTIME_MEMORY_LIMIT_BYTES,
    userLimitBytes: DEFAULT_RUNTIME_USER_LIMIT_BYTES,
    maintenanceMaxTokens: DEFAULT_RUNTIME_MAINTENANCE_MAX_TOKENS,
  }),
  embedding: MnemonEmbeddingSchema.default({
    enabled: false,
    endpoint: DEFAULT_EMBEDDING_ENDPOINT,
    model: DEFAULT_EMBEDDING_MODEL,
    apiKey: '',
    protocol: DEFAULT_EMBEDDING_PROTOCOL,
  }),
  memoryTopology: MemoryTopologySchema,
  memoryView: MemoryViewSchema,
  legacySettingsImported: z.boolean(),
  recallQuality: RecallQualitySchema.default({
    policy: DEFAULT_RECALL_QUALITY_POLICY,
    lowScoreThreshold: DEFAULT_RECALL_LOW_SCORE_THRESHOLD,
    highScoreThreshold: DEFAULT_RECALL_HIGH_SCORE_THRESHOLD,
    candidateMultiplier: DEFAULT_RECALL_CANDIDATE_MULTIPLIER,
    maxMediumResults: DEFAULT_RECALL_MAX_MEDIUM_RESULTS,
    maxRankedResults: DEFAULT_RECALL_MAX_RANKED_RESULTS,
    maxUnknownResults: DEFAULT_RECALL_MAX_UNKNOWN_RESULTS,
  }),
  routingGuidance: z.boolean().default(true),
  // Retain the raw alias here so startup can migrate the exact stored field.
  displayMode: z.union(['sidebar', 'builtin', 'buildin'] as const).default('sidebar'),
  tabEnabled: z.boolean().default(true),
  writeEnabled: z.boolean().default(true),
  remoteAccess: z.union(['read-only', 'trusted-host'] as const).default('read-only'),
  lifecycleEnabled: z.boolean().default(true),
  recallMode: z.union(['guided', 'off'] as const).default('guided'),
  writebackMode: z.union(['guided', 'off'] as const).default('guided'),
  idleReviewMs: z.number().step(1).min(MIN_IDLE_REVIEW_MS).max(MAX_IDLE_REVIEW_MS).default(DEFAULT_IDLE_REVIEW_MS),
  idleReview: IdleReviewSchema.default(DEFAULT_IDLE_REVIEW),
  // Conversation surfaces default on and remain independently switchable live.
  // `toolviews` switches nothing. Its declaration only keeps the form DSH
  // generates from this schema, and the default it fills in, as they were:
  // stored values would validate without it, since undeclared keys pass
  // through. Settings writes refuse it and the resolved config leaves it out.
  conversationInteraction: z.object({
    toolviews: z.boolean().default(false),
    turnBar: z.boolean().default(DEFAULT_INTERACTION_CONFIG.turnBar),
    saveAction: z.boolean().default(DEFAULT_INTERACTION_CONFIG.saveAction),
  }).default({ toolviews: false, turnBar: DEFAULT_INTERACTION_CONFIG.turnBar, saveAction: DEFAULT_INTERACTION_CONFIG.saveAction }),
  // Declared so DSH applies a change live, as it does every other key here.
  skills: SkillsConfig.default({ ...DEFAULT_SKILLS_CONFIG }),
  persistenceStrategy: MemoryPersistenceStrategySchema,
  taskAgentModel: TaskAgentModelSchema,
  subagentProviderNames: z.array(z.string()).default([]),
  // Git sync is off until a user switches it on: the block stays a title and a
  // switch, and nothing about Git is probed while it is off.
  syncEnabled: z.boolean().default(false),
})

export const PlainConfig = Config
export { MemoryViewSchema as schema, validateMemoryViewPreferences as preferences }
