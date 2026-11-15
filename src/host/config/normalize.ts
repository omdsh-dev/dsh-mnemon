import { isAbsolute } from 'node:path'
import { resolveEmbedding, resolvePersistenceStrategy, resolveRecallQuality } from 'dsh-mnemon-source-memory-spaces'
import { MEMORY_SPACE_ID_PATTERN } from 'dsh-mnemon-source-memory-spaces/contracts'
import { normalizeDisplayMode } from '../display-mode.ts'
import type {
  Config as SharedConfig,
  CustomPackConfig as SharedCustomPackConfig,
  DocumentsConfig,
  InteractionConfig as SharedInteractionConfig,
  MemoryTopologyConfig,
  ResolvedConfig as SharedResolvedConfig,
  ResolvedInteractionConfig as SharedResolvedInteractionConfig,
  ResolvedSkillsConfig,
  ResolvedTaskAgentModelConfig,
  RuntimeMemoryConfig,
  TaskAgentModelConfig,
} from '../protocol.ts'
import type { MemoryViewPreferences } from '../view-protocol.ts'
import {
  DEFAULT_IDLE_REVIEW_MS,
  DEFAULT_INTERACTION_CONFIG,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RUNTIME_MAINTENANCE_MAX_TOKENS,
  DEFAULT_RUNTIME_MEMORY_LIMIT_BYTES,
  DEFAULT_RUNTIME_USER_LIMIT_BYTES,
  DEFAULT_TIMEOUT_MS,
  DOCUMENTS_DEFAULT_LIMIT_BYTES,
  DOCUMENTS_MAX_LIMIT_BYTES,
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
} from './defaults.ts'
import { isUserHomePath } from './paths.ts'
import { IdleReviewSchema, SkillsConfig, validateMemoryViewPreferences } from './schema.ts'

export { normalizeDisplayMode }
export { resolveEmbedding, resolvePersistenceStrategy, resolveRecallQuality }

/** The resolved config with the profile's main Strategy choice applied; without a choice the topology's id stays. */
export function withMainStrategy(config: SharedResolvedConfig, view: Pick<MemoryViewPreferences, 'strategyTypeId'>): SharedResolvedConfig {
  const selected = view.strategyTypeId
  return selected === undefined ? config : { ...config, memoryTopology: { ...config.memoryTopology, strategyId: selected } }
}

/** The type id of the main Strategy the Host composes the View with. */
export function mainStrategyTypeId(config: Pick<SharedResolvedConfig, 'memoryTopology'>): string {
  return config.memoryTopology.strategyId
}

export function resolveSkillsConfig(config: Partial<ResolvedSkillsConfig> | undefined = {}): ResolvedSkillsConfig {
  const resolved = SkillsConfig(config ?? {})
  if (resolved.dshHome === undefined) delete resolved.dshHome
  if (resolved.agentsHome === undefined) delete resolved.agentsHome
  return resolved
}

export function resolveInteractionConfig(config: SharedInteractionConfig = {}): SharedResolvedInteractionConfig {
  return {
    turnBar: config.turnBar ?? DEFAULT_INTERACTION_CONFIG.turnBar,
    saveAction: config.saveAction ?? DEFAULT_INTERACTION_CONFIG.saveAction,
  }
}

function boundedInteger(value: number | undefined | null, fallback: number, min: number, max: number, label: string, unit = ''): number {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`dsh-mnemon: ${label} must be an integer within ${min}..${max}${unit}`)
  }
  return resolved
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

const CUSTOM_PACK_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

export function validateCustomDataDir(value: string): string {
  const dataDir = optionalText(value)
  if (dataDir === undefined) throw new Error('dsh-mnemon: custom Pack dataDir is required')
  if (dataDir.includes('\0')) throw new Error('dsh-mnemon: dataDir must not contain a null byte')
  if (!isAbsolute(dataDir) && !isUserHomePath(dataDir)) {
    throw new Error('dsh-mnemon: custom Pack dataDir must be absolute or start with ~/')
  }
  return dataDir
}

function resolveCustomPacks(value: SharedCustomPackConfig[] | undefined, legacyDataDir: string | undefined): SharedCustomPackConfig[] {
  const packs: SharedCustomPackConfig[] = []
  const ids = new Set<string>()
  for (const candidate of value ?? []) {
    const id = optionalText(candidate.id)
    const name = optionalText(candidate.name)
    if (id === undefined || !CUSTOM_PACK_ID.test(id)) throw new Error('dsh-mnemon: custom Pack id must match [a-zA-Z0-9][a-zA-Z0-9_-]*')
    if (ids.has(id)) throw new Error(`dsh-mnemon: duplicate custom Pack id: ${id}`)
    if (name === undefined || name.length > 100) throw new Error('dsh-mnemon: custom Pack name must contain 1..100 characters')
    ids.add(id)
    packs.push({ id, name, dataDir: validateCustomDataDir(candidate.dataDir) })
  }
  if (packs.length > 32) throw new Error('dsh-mnemon: at most 32 custom Packs may be configured')
  if (legacyDataDir !== undefined && !packs.some(pack => pack.dataDir === legacyDataDir)) {
    let id = 'legacy'
    let suffix = 2
    while (ids.has(id)) id = `legacy-${suffix++}`
    packs.push({ id, name: 'Custom Pack', dataDir: validateCustomDataDir(legacyDataDir) })
  }
  return packs
}

function resolveSubagentProviderNames(value: string[] | undefined): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 32 || value.some(name => typeof name !== 'string' || !name.trim() || name.length > 128)) {
    throw new Error('dsh-mnemon: subagentProviderNames must contain at most 32 nonempty provider names of at most 128 characters')
  }
  return [...new Set(value.map(name => name.trim()))]
}

function resolveTaskAgentModel(value: TaskAgentModelConfig | undefined): ResolvedTaskAgentModelConfig {
  const mode = value?.mode ?? 'inherit'
  if (mode !== 'inherit' && mode !== 'fixed') throw new Error(`dsh-mnemon: unsupported task Agent model mode: ${String(mode)}`)
  const follow = value?.followConversation
  if (follow !== undefined && typeof follow !== 'boolean') throw new Error('dsh-mnemon: taskAgentModel.followConversation must be a boolean')
  // A fixed route names its own model, so only an inherited one can follow a conversation.
  if (mode === 'inherit') return follow === true ? { mode, followConversation: true } : { mode }
  const provider = optionalText(value?.provider)
  const model = optionalText(value?.model)
  if (provider === undefined || model === undefined) throw new Error('dsh-mnemon: a fixed task Agent model requires both provider and model')
  if (provider.length > 200 || model.length > 300) throw new Error('dsh-mnemon: task Agent provider or model id is too long')
  return { mode, provider, model }
}

function resolveDocuments(value: DocumentsConfig | undefined): SharedResolvedConfig['documents'] {
  return {
    limitBytes: boundedInteger(value?.limitBytes, DOCUMENTS_DEFAULT_LIMIT_BYTES, MIN_DOCUMENTS_LIMIT_BYTES, DOCUMENTS_MAX_LIMIT_BYTES, 'Documents limit', ' bytes'),
  }
}

function resolveRuntimeMemory(value: RuntimeMemoryConfig | undefined): SharedResolvedConfig['runtimeMemory'] {
  const inheritToSubagents = value?.inheritToSubagents ?? false
  if (typeof inheritToSubagents !== 'boolean') throw new Error('dsh-mnemon: Runtime inheritToSubagents must be a boolean')
  return {
    inheritToSubagents,
    memoryLimitBytes: boundedInteger(value?.memoryLimitBytes, DEFAULT_RUNTIME_MEMORY_LIMIT_BYTES, MIN_RUNTIME_MEMORY_LIMIT_BYTES, MAX_RUNTIME_MEMORY_LIMIT_BYTES, 'Runtime MEMORY.md limit', ' bytes'),
    userLimitBytes: boundedInteger(value?.userLimitBytes, DEFAULT_RUNTIME_USER_LIMIT_BYTES, MIN_RUNTIME_MEMORY_LIMIT_BYTES, MAX_RUNTIME_MEMORY_LIMIT_BYTES, 'Runtime USER.md limit', ' bytes'),
    maintenanceMaxTokens: boundedInteger(value?.maintenanceMaxTokens, DEFAULT_RUNTIME_MAINTENANCE_MAX_TOKENS, MIN_RUNTIME_MAINTENANCE_MAX_TOKENS, MAX_RUNTIME_MAINTENANCE_MAX_TOKENS, 'Runtime maintenance maxTokens'),
  }
}

const MEMORY_COMPONENT_ID = /^[a-z][a-z0-9-]{0,127}$/u
const MEMORY_PARTICIPATION_MODES = new Set(['off', 'manual', 'automatic'])

function memoryComponentId(value: string | undefined, fallback: string, label: string): string {
  const id = optionalText(value) ?? fallback
  if (!MEMORY_COMPONENT_ID.test(id)) throw new Error(`dsh-mnemon: ${label} must match [a-z][a-z0-9-]{0,127}`)
  return id
}

function resolveMemoryTopology(value: MemoryTopologyConfig | undefined): SharedResolvedConfig['memoryTopology'] {
  const defaults: NonNullable<MemoryTopologyConfig['layers']> = {
    runtime: {},
    documents: {},
    'memory-spaces': {},
  }
  const candidates = { ...defaults, ...value?.layers }
  const entries = Object.entries(candidates)
  if (entries.length > 64) throw new Error('dsh-mnemon: memory topology accepts at most 64 layers')
  const layers = Object.fromEntries(entries.map(([rawId, candidate]) => {
    const id = memoryComponentId(rawId, rawId, 'memory layer id')
    const participation = {
      recall: candidate?.participation?.recall ?? 'automatic',
      write: candidate?.participation?.write ?? 'automatic',
      projection: candidate?.participation?.projection ?? 'automatic',
      maintenance: candidate?.participation?.maintenance ?? 'automatic',
    }
    for (const [channel, mode] of Object.entries(participation)) {
      if (!MEMORY_PARTICIPATION_MODES.has(mode)) throw new Error(`dsh-mnemon: unsupported ${channel} participation mode: ${String(mode)}`)
    }
    const adapterIds = [...new Set(candidate?.adapterIds?.map(adapterId => memoryComponentId(adapterId, adapterId, 'memory adapter id')) ?? [])]
    return [id, { enabled: candidate?.enabled ?? true, participation, adapterIds }]
  }))
  return {
    id: memoryComponentId(value?.id, 'default-three-tier', 'memory topology id'),
    strategyId: memoryComponentId(value?.strategyId, 'default-three-tier', 'memory strategy id'),
    layers,
  }
}

export function resolveConfig(config: SharedConfig = {}): SharedResolvedConfig {
  if (config.memoryView !== undefined) validateMemoryViewPreferences(config.memoryView)
  const cliPath = optionalText(config.cliPath)
  const legacyDataDir = optionalText(config.dataDir)
  const legacyPacks = resolveCustomPacks(config.customPacks, legacyDataDir)
  const requestedPackId = optionalText(config.customPackId)
  if (requestedPackId !== undefined && !CUSTOM_PACK_ID.test(requestedPackId)) throw new Error('dsh-mnemon: customPackId is invalid')
  const store = optionalText(config.store)
  const storageScope = config.storageScope ?? (legacyDataDir === undefined && legacyPacks.length === 0 ? 'global' : 'custom')
  if (!['global', 'workspace', 'custom', 'workspaces'].includes(storageScope)) throw new Error('dsh-mnemon: unsupported storageScope')
  const runtimeUserScope = config.runtimeUserScope ?? 'storage'
  if (runtimeUserScope !== 'storage' && runtimeUserScope !== 'global') throw new Error(`dsh-mnemon: unsupported Runtime USER.md scope: ${String(runtimeUserScope)}`)
  const selectedPack = requestedPackId === undefined
    ? legacyPacks.find(pack => pack.dataDir === legacyDataDir) ?? (legacyPacks.length === 1 ? legacyPacks[0] : undefined)
    : legacyPacks.find(pack => pack.id === requestedPackId)
  if (requestedPackId !== undefined && selectedPack === undefined) throw new Error(`dsh-mnemon: unknown custom Pack: ${requestedPackId}`)
  const dataDir = selectedPack?.dataDir ?? legacyDataDir
  if (storageScope === 'custom' && dataDir === undefined) throw new Error('dsh-mnemon: a custom dataDir is required when storageScope is custom')
  if (store !== undefined && !MEMORY_SPACE_ID_PATTERN.test(store)) {
    throw new Error('dsh-mnemon: store must match [a-zA-Z0-9][a-zA-Z0-9_-]*')
  }
  return {
    storageScope,
    runtimeUserScope,
    excludedWorkspaces: [...new Set((config.excludedWorkspaces ?? []).map(path => path.trim()).filter(Boolean))],
    ...(cliPath === undefined ? {} : { cliPath }),
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(store === undefined ? {} : { store }),
    timeoutMs: boundedInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 'timeoutMs'),
    defaultRecallLimit: boundedInteger(config.defaultRecallLimit, DEFAULT_RECALL_LIMIT, MIN_RECALL_LIMIT, MAX_RECALL_LIMIT, 'defaultRecallLimit'),
    documents: resolveDocuments(config.documents),
    runtimeMemory: resolveRuntimeMemory(config.runtimeMemory),
    embedding: resolveEmbedding(config.embedding),
    memoryTopology: resolveMemoryTopology(config.memoryTopology),
    recallQuality: resolveRecallQuality(config.recallQuality),
    routingGuidance: config.routingGuidance ?? true,
    displayMode: normalizeDisplayMode(config.displayMode),
    tabEnabled: config.tabEnabled ?? true,
    writeEnabled: config.writeEnabled ?? true,
    remoteAccess: config.remoteAccess ?? 'read-only',
    lifecycleEnabled: config.lifecycleEnabled ?? true,
    recallMode: config.recallMode ?? 'guided',
    writebackMode: config.writebackMode ?? 'guided',
    idleReviewMs: boundedInteger(config.idleReviewMs, DEFAULT_IDLE_REVIEW_MS, MIN_IDLE_REVIEW_MS, MAX_IDLE_REVIEW_MS, 'idleReviewMs'),
    idleReview: IdleReviewSchema(config.idleReview ?? {}),
    conversationInteraction: resolveInteractionConfig(config.conversationInteraction),
    skills: resolveSkillsConfig(config.skills),
    persistenceStrategy: resolvePersistenceStrategy(config.persistenceStrategy),
    taskAgentModel: resolveTaskAgentModel(config.taskAgentModel),
    subagentProviderNames: resolveSubagentProviderNames(config.subagentProviderNames),
    syncEnabled: config.syncEnabled ?? false,
  }
}
