import z from 'schemastery'
import { isAbsolute } from 'node:path'
import {
  DEFAULT_IDLE_REVIEW_MS,
  DEFAULT_EMBEDDING_ENDPOINT,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_PROTOCOL,
  DEFAULT_RECALL_CANDIDATE_MULTIPLIER,
  DEFAULT_RECALL_HIGH_SCORE_THRESHOLD,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RECALL_LOW_SCORE_THRESHOLD,
  DEFAULT_RECALL_MAX_MEDIUM_RESULTS,
  DEFAULT_RECALL_MAX_UNKNOWN_RESULTS,
  DEFAULT_RECALL_QUALITY_POLICY,
  DEFAULT_RUNTIME_MAINTENANCE_MAX_TOKENS,
  DEFAULT_RUNTIME_MEMORY_LIMIT_BYTES,
  DEFAULT_RUNTIME_USER_LIMIT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_RUNTIME_MAINTENANCE_MAX_TOKENS,
  MAX_RUNTIME_MEMORY_LIMIT_BYTES,
  MNEMON_EMBEDDING_PROTOCOLS,
} from './config-values.ts'
import type {
  Config as SharedConfig,
  CustomPackConfig as SharedCustomPackConfig,
  InteractionConfig as SharedInteractionConfig,
  MemoryPersistenceStrategy,
  MemoryTopologyConfig,
  MemoryPlacementCapability,
  MemoryPlacementPreference,
  MemoryProviderConnection,
  MemoryProviderId,
  RecallQualityConfig,
  ResolvedConfig as SharedResolvedConfig,
  ResolvedInteractionConfig as SharedResolvedInteractionConfig,
  RuntimeMemoryConfig,
  ResolvedTaskAgentModelConfig,
  TaskAgentModelConfig,
} from './shared/contracts.ts'

export {
  DEFAULT_IDLE_REVIEW_MS,
  DEFAULT_EMBEDDING_ENDPOINT,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_PROTOCOL,
  DEFAULT_RECALL_CANDIDATE_MULTIPLIER,
  DEFAULT_RECALL_HIGH_SCORE_THRESHOLD,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RECALL_LOW_SCORE_THRESHOLD,
  DEFAULT_RECALL_MAX_MEDIUM_RESULTS,
  DEFAULT_RECALL_MAX_UNKNOWN_RESULTS,
  DEFAULT_RECALL_QUALITY_POLICY,
  DEFAULT_RUNTIME_MAINTENANCE_MAX_TOKENS,
  DEFAULT_RUNTIME_MEMORY_LIMIT_BYTES,
  DEFAULT_RUNTIME_USER_LIMIT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_RUNTIME_MAINTENANCE_MAX_TOKENS,
  MAX_RUNTIME_MEMORY_LIMIT_BYTES,
} from './config-values.ts'
export type Config = SharedConfig
export type CustomPackConfig = SharedCustomPackConfig
export type InteractionConfig = SharedInteractionConfig
export type ResolvedConfig = SharedResolvedConfig
export type ResolvedInteractionConfig = SharedResolvedInteractionConfig

export const InteractionConfig: z<InteractionConfig> = z.object({
  turnBar: z.boolean().default(true),
  saveAction: z.boolean().default(true),
})

const MEMORY_PROVIDER_IDS = ['mnemon-native', 'openviking', 'honcho', 'mem0', 'hindsight', 'holographic', 'retaindb', 'byterover', 'supermemory'] as const
const MEMORY_PLACEMENT_CAPABILITIES = ['graph', 'entities', 'related', 'exact-write', 'link', 'forget'] as const

const MemoryProviderConnectionSchema: z<MemoryProviderConnection> = z.dict(z.union([z.string(), z.number(), z.boolean()]))
const MemoryPersistenceStrategySchema: z<MemoryPersistenceStrategy> = z.object({
  mode: z.union(['manual', 'automatic'] as const),
  providerId: z.union(MEMORY_PROVIDER_IDS),
  prompt: z.string(),
  rules: z.object({
    allowedProviderIds: z.array(z.union(MEMORY_PROVIDER_IDS)),
    dataBoundary: z.union(['allow-remote', 'local-only'] as const),
    requiredCapabilities: z.array(z.union(MEMORY_PLACEMENT_CAPABILITIES)),
    preference: z.union(['balanced', 'local-first', 'shared-first'] as const),
  }),
  providerConnections: z.dict(MemoryProviderConnectionSchema),
})

const TaskAgentModelSchema: z<TaskAgentModelConfig> = z.object({
  mode: z.union(['inherit', 'fixed'] as const),
  provider: z.string(),
  model: z.string(),
})

const MnemonEmbeddingSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().default(DEFAULT_EMBEDDING_ENDPOINT),
  model: z.string().default(DEFAULT_EMBEDDING_MODEL),
  apiKey: z.string().default(''),
  protocol: z.union(MNEMON_EMBEDDING_PROTOCOLS).default(DEFAULT_EMBEDDING_PROTOCOL),
})

const RecallQualitySchema: z<RecallQualityConfig> = z.object({
  policy: z.string().default(DEFAULT_RECALL_QUALITY_POLICY),
  lowScoreThreshold: z.number().min(0).max(1).default(DEFAULT_RECALL_LOW_SCORE_THRESHOLD),
  highScoreThreshold: z.number().min(0).max(1).default(DEFAULT_RECALL_HIGH_SCORE_THRESHOLD),
  candidateMultiplier: z.number().step(1).min(1).max(5).default(DEFAULT_RECALL_CANDIDATE_MULTIPLIER),
  maxMediumResults: z.number().step(1).min(0).max(50).default(DEFAULT_RECALL_MAX_MEDIUM_RESULTS),
  maxUnknownResults: z.number().step(1).min(0).max(50).default(DEFAULT_RECALL_MAX_UNKNOWN_RESULTS),
})

const RuntimeMemorySchema: z<RuntimeMemoryConfig> = z.object({
  memoryLimitBytes: z.number().step(1).min(1).max(MAX_RUNTIME_MEMORY_LIMIT_BYTES).default(DEFAULT_RUNTIME_MEMORY_LIMIT_BYTES),
  userLimitBytes: z.number().step(1).min(1).max(MAX_RUNTIME_MEMORY_LIMIT_BYTES).default(DEFAULT_RUNTIME_USER_LIMIT_BYTES),
  maintenanceMaxTokens: z.number().step(1).min(1).max(MAX_RUNTIME_MAINTENANCE_MAX_TOKENS).default(DEFAULT_RUNTIME_MAINTENANCE_MAX_TOKENS),
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

export const Config: z<Config> = z.object({
  // Keep this optional in the schema so legacy dataDir-only installs still
  // resolve to the custom scope instead of being silently reset to global.
  storageScope: z.union(['global', 'workspace', 'custom'] as const),
  runtimeUserScope: z.union(['storage', 'global'] as const).default('storage'),
  cliPath: z.string(),
  dataDir: z.string(),
  customPackId: z.string(),
  customPacks: z.array(z.object({
    id: z.string(),
    name: z.string(),
    dataDir: z.string(),
  })).default([]),
  store: z.string(),
  timeoutMs: z.number().step(1).min(100).max(120_000).default(DEFAULT_TIMEOUT_MS),
  defaultRecallLimit: z.number().step(1).min(1).max(50).default(DEFAULT_RECALL_LIMIT),
  runtimeMemory: RuntimeMemorySchema.default({
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
  recallQuality: RecallQualitySchema.default({
    policy: DEFAULT_RECALL_QUALITY_POLICY,
    lowScoreThreshold: DEFAULT_RECALL_LOW_SCORE_THRESHOLD,
    highScoreThreshold: DEFAULT_RECALL_HIGH_SCORE_THRESHOLD,
    candidateMultiplier: DEFAULT_RECALL_CANDIDATE_MULTIPLIER,
    maxMediumResults: DEFAULT_RECALL_MAX_MEDIUM_RESULTS,
    maxUnknownResults: DEFAULT_RECALL_MAX_UNKNOWN_RESULTS,
  }),
  routingGuidance: z.boolean().default(true),
  displayMode: z.union(['sidebar', 'buildin'] as const).default('sidebar'),
  tabEnabled: z.boolean().default(true),
  writeEnabled: z.boolean().default(true),
  remoteAccess: z.union(['read-only', 'trusted-host'] as const).default('read-only'),
  lifecycleEnabled: z.boolean().default(true),
  recallMode: z.union(['guided', 'off'] as const).default('guided'),
  writebackMode: z.union(['guided', 'off'] as const).default('guided'),
  idleReviewMs: z.number().step(1).min(5_000).max(600_000).default(DEFAULT_IDLE_REVIEW_MS),
  // Conversation surfaces default on and remain independently switchable live.
  conversationInteraction: z.object({
    toolviews: z.boolean().default(false),
    turnBar: z.boolean().default(true),
    saveAction: z.boolean().default(true),
  }).default({ toolviews: false, turnBar: true, saveAction: true }),
  persistenceStrategy: MemoryPersistenceStrategySchema,
  taskAgentModel: TaskAgentModelSchema,
})

export function resolveInteractionConfig(config: InteractionConfig = {}): ResolvedInteractionConfig {
  return {
    turnBar: config.turnBar ?? true,
    saveAction: config.saveAction ?? true,
  }
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

const CUSTOM_PACK_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

function validateCustomDataDir(value: string): string {
  const dataDir = optionalText(value)
  if (dataDir === undefined) throw new Error('dsh-mnemon: custom Pack dataDir is required')
  if (!isAbsolute(dataDir) && dataDir !== '~' && !dataDir.startsWith('~/')) {
    throw new Error('dsh-mnemon: custom Pack dataDir must be absolute or start with ~/')
  }
  return dataDir
}

function resolveCustomPacks(value: CustomPackConfig[] | undefined, legacyDataDir: string | undefined): CustomPackConfig[] {
  const packs: CustomPackConfig[] = []
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

const MEMORY_PROVIDER_ID_SET = new Set<string>(MEMORY_PROVIDER_IDS)
const MEMORY_PLACEMENT_CAPABILITY_SET = new Set<string>(MEMORY_PLACEMENT_CAPABILITIES)
const MEMORY_PLACEMENT_PREFERENCE_SET = new Set<string>(['balanced', 'local-first', 'shared-first'])

function resolvePersistenceStrategy(value: MemoryPersistenceStrategy | undefined): SharedResolvedConfig['persistenceStrategy'] {
  const mode = value?.mode ?? 'manual'
  if (mode !== 'manual' && mode !== 'automatic') throw new Error(`dsh-mnemon: unsupported persistence strategy mode: ${String(mode)}`)
  const providerId = value?.providerId ?? 'mnemon-native'
  if (!MEMORY_PROVIDER_ID_SET.has(providerId)) throw new Error(`dsh-mnemon: unsupported persistence strategy provider: ${String(providerId)}`)
  const prompt = value?.prompt?.trim() ?? ''
  if (prompt.length > 4000) throw new Error('dsh-mnemon: persistence strategy prompt is too long (max 4000 characters)')
  const configuredProviderIds = value?.rules?.allowedProviderIds
  const allowedProviderIds = [...new Set(configuredProviderIds === undefined || (configuredProviderIds.length === 0 && mode === 'manual') ? ['mnemon-native'] : configuredProviderIds)]
  if (allowedProviderIds.length === 0) throw new Error('dsh-mnemon: persistence strategy requires at least one allowed provider')
  for (const id of allowedProviderIds) if (!MEMORY_PROVIDER_ID_SET.has(id)) throw new Error(`dsh-mnemon: unsupported persistence strategy provider: ${String(id)}`)
  const dataBoundary = value?.rules?.dataBoundary ?? 'allow-remote'
  if (dataBoundary !== 'allow-remote' && dataBoundary !== 'local-only') throw new Error(`dsh-mnemon: unsupported persistence data boundary: ${String(dataBoundary)}`)
  const requiredCapabilities = [...new Set(value?.rules?.requiredCapabilities ?? [])]
  for (const capability of requiredCapabilities) if (!MEMORY_PLACEMENT_CAPABILITY_SET.has(capability)) throw new Error(`dsh-mnemon: unsupported persistence capability: ${String(capability)}`)
  const preference = value?.rules?.preference ?? 'balanced'
  if (!MEMORY_PLACEMENT_PREFERENCE_SET.has(preference)) throw new Error(`dsh-mnemon: unsupported persistence preference: ${String(preference)}`)
  const providerConnections = Object.fromEntries(Object.entries(value?.providerConnections ?? {}).flatMap(([id, connection]) => {
    if (!MEMORY_PROVIDER_ID_SET.has(id) || connection === undefined) return []
    const normalized = Object.fromEntries(Object.entries(connection).filter((entry): entry is [string, string | number | boolean] => ['string', 'number', 'boolean'].includes(typeof entry[1])))
    return [[id, normalized]]
  })) as Partial<Record<MemoryProviderId, MemoryProviderConnection>>
  return {
    mode,
    providerId,
    prompt,
    rules: {
      allowedProviderIds: allowedProviderIds as MemoryProviderId[],
      dataBoundary,
      requiredCapabilities: requiredCapabilities as MemoryPlacementCapability[],
      preference: preference as MemoryPlacementPreference,
    },
    providerConnections,
  }
}

function resolveTaskAgentModel(value: TaskAgentModelConfig | undefined): ResolvedTaskAgentModelConfig {
  const mode = value?.mode ?? 'inherit'
  if (mode !== 'inherit' && mode !== 'fixed') throw new Error(`dsh-mnemon: unsupported task Agent model mode: ${String(mode)}`)
  if (mode === 'inherit') return { mode }
  const provider = optionalText(value?.provider)
  const model = optionalText(value?.model)
  if (provider === undefined || model === undefined) throw new Error('dsh-mnemon: a fixed task Agent model requires both provider and model')
  if (provider.length > 200 || model.length > 300) throw new Error('dsh-mnemon: task Agent provider or model id is too long')
  return { mode, provider, model }
}

function resolveEmbedding(value: SharedConfig['embedding']): SharedResolvedConfig['embedding'] {
  const endpoint = optionalText(value?.endpoint) ?? DEFAULT_EMBEDDING_ENDPOINT
  if (endpoint.length > 2048) throw new Error('dsh-mnemon: embedding endpoint is too long')
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error('dsh-mnemon: embedding endpoint must be an absolute HTTP or HTTPS URL')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username !== '' || parsed.password !== ''
    || endpoint.includes('?') || endpoint.includes('#')) {
    throw new Error('dsh-mnemon: embedding endpoint must be an absolute HTTP or HTTPS URL without credentials, query, or fragment')
  }
  const normalizedEndpoint = endpoint.replace(/\/+$/u, '')
  const model = optionalText(value?.model) ?? DEFAULT_EMBEDDING_MODEL
  if (model.length > 200 || /[\u0000-\u001f\u007f]/u.test(model)) throw new Error('dsh-mnemon: embedding model must contain 1..200 characters without control characters')
  const apiKey = optionalText(value?.apiKey) ?? ''
  if (apiKey.length > 2048 || /[\u0000-\u001f\u007f]/u.test(apiKey)) throw new Error('dsh-mnemon: embedding API key must contain 0..2048 characters without control characters')
  const protocol = value?.protocol ?? DEFAULT_EMBEDDING_PROTOCOL
  if (!MNEMON_EMBEDDING_PROTOCOLS.includes(protocol)) throw new Error(`dsh-mnemon: unsupported embedding protocol: ${String(protocol)}`)
  return { enabled: value?.enabled === true, endpoint: normalizedEndpoint, model, apiKey, protocol }
}

function resolveRecallQuality(value: RecallQualityConfig | undefined): SharedResolvedConfig['recallQuality'] {
  const policy = optionalText(value?.policy) ?? DEFAULT_RECALL_QUALITY_POLICY
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(policy)) throw new Error('dsh-mnemon: recall quality policy id must match [a-z][a-z0-9-]{0,63}')
  const lowScoreThreshold = value?.lowScoreThreshold ?? DEFAULT_RECALL_LOW_SCORE_THRESHOLD
  const highScoreThreshold = value?.highScoreThreshold ?? DEFAULT_RECALL_HIGH_SCORE_THRESHOLD
  const candidateMultiplier = value?.candidateMultiplier ?? DEFAULT_RECALL_CANDIDATE_MULTIPLIER
  const maxMediumResults = value?.maxMediumResults ?? DEFAULT_RECALL_MAX_MEDIUM_RESULTS
  const maxUnknownResults = value?.maxUnknownResults ?? DEFAULT_RECALL_MAX_UNKNOWN_RESULTS
  if (!Number.isFinite(lowScoreThreshold) || lowScoreThreshold < 0 || lowScoreThreshold > 1) throw new Error('dsh-mnemon: recall low score threshold must be within 0..1')
  if (!Number.isFinite(highScoreThreshold) || highScoreThreshold < 0 || highScoreThreshold > 1) throw new Error('dsh-mnemon: recall high score threshold must be within 0..1')
  if (lowScoreThreshold >= highScoreThreshold) throw new Error('dsh-mnemon: recall low score threshold must be less than the high score threshold')
  if (!Number.isInteger(candidateMultiplier) || candidateMultiplier < 1 || candidateMultiplier > 5) throw new Error('dsh-mnemon: recall candidate multiplier must be an integer within 1..5')
  if (!Number.isInteger(maxMediumResults) || maxMediumResults < 0 || maxMediumResults > 50) throw new Error('dsh-mnemon: recall max medium results must be an integer within 0..50')
  if (!Number.isInteger(maxUnknownResults) || maxUnknownResults < 0 || maxUnknownResults > 50) throw new Error('dsh-mnemon: recall max unknown results must be an integer within 0..50')
  return { policy, lowScoreThreshold, highScoreThreshold, candidateMultiplier, maxMediumResults, maxUnknownResults }
}

function resolveRuntimeMemory(value: RuntimeMemoryConfig | undefined): SharedResolvedConfig['runtimeMemory'] {
  const memoryLimitBytes = value?.memoryLimitBytes ?? DEFAULT_RUNTIME_MEMORY_LIMIT_BYTES
  const userLimitBytes = value?.userLimitBytes ?? DEFAULT_RUNTIME_USER_LIMIT_BYTES
  const maintenanceMaxTokens = value?.maintenanceMaxTokens ?? DEFAULT_RUNTIME_MAINTENANCE_MAX_TOKENS
  if (!Number.isInteger(memoryLimitBytes) || memoryLimitBytes < 1 || memoryLimitBytes > MAX_RUNTIME_MEMORY_LIMIT_BYTES) {
    throw new Error(`dsh-mnemon: Runtime MEMORY.md limit must be an integer within 1..${MAX_RUNTIME_MEMORY_LIMIT_BYTES} bytes`)
  }
  if (!Number.isInteger(userLimitBytes) || userLimitBytes < 1 || userLimitBytes > MAX_RUNTIME_MEMORY_LIMIT_BYTES) {
    throw new Error(`dsh-mnemon: Runtime USER.md limit must be an integer within 1..${MAX_RUNTIME_MEMORY_LIMIT_BYTES} bytes`)
  }
  if (!Number.isInteger(maintenanceMaxTokens) || maintenanceMaxTokens < 1 || maintenanceMaxTokens > MAX_RUNTIME_MAINTENANCE_MAX_TOKENS) {
    throw new Error(`dsh-mnemon: Runtime maintenance maxTokens must be an integer within 1..${MAX_RUNTIME_MAINTENANCE_MAX_TOKENS}`)
  }
  return { memoryLimitBytes, userLimitBytes, maintenanceMaxTokens }
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

export function resolveConfig(config: Config = {}): ResolvedConfig {
  const cliPath = optionalText(config.cliPath)
  const legacyDataDir = optionalText(config.dataDir)
  const legacyPacks = resolveCustomPacks(config.customPacks, legacyDataDir)
  const requestedPackId = optionalText(config.customPackId)
  if (requestedPackId !== undefined && !CUSTOM_PACK_ID.test(requestedPackId)) throw new Error('dsh-mnemon: customPackId is invalid')
  const store = optionalText(config.store)
  const storageScope = config.storageScope ?? (legacyDataDir === undefined && legacyPacks.length === 0 ? 'global' : 'custom')
  const runtimeUserScope = config.runtimeUserScope ?? 'storage'
  if (runtimeUserScope !== 'storage' && runtimeUserScope !== 'global') throw new Error(`dsh-mnemon: unsupported Runtime USER.md scope: ${String(runtimeUserScope)}`)
  const selectedPack = requestedPackId === undefined
    ? legacyPacks.find(pack => pack.dataDir === legacyDataDir) ?? (legacyPacks.length === 1 ? legacyPacks[0] : undefined)
    : legacyPacks.find(pack => pack.id === requestedPackId)
  if (requestedPackId !== undefined && selectedPack === undefined) throw new Error(`dsh-mnemon: unknown custom Pack: ${requestedPackId}`)
  const dataDir = selectedPack?.dataDir ?? legacyDataDir
  if (storageScope === 'custom' && dataDir === undefined) throw new Error('dsh-mnemon: a custom dataDir is required when storageScope is custom')
  if (store !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(store)) {
    throw new Error('dsh-mnemon: store must match [a-zA-Z0-9][a-zA-Z0-9_-]*')
  }
  return {
    storageScope,
    runtimeUserScope,
    ...(cliPath === undefined ? {} : { cliPath }),
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(store === undefined ? {} : { store }),
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    defaultRecallLimit: config.defaultRecallLimit ?? DEFAULT_RECALL_LIMIT,
    runtimeMemory: resolveRuntimeMemory(config.runtimeMemory),
    embedding: resolveEmbedding(config.embedding),
    memoryTopology: resolveMemoryTopology(config.memoryTopology),
    recallQuality: resolveRecallQuality(config.recallQuality),
    routingGuidance: config.routingGuidance ?? true,
    displayMode: config.displayMode ?? 'sidebar',
    tabEnabled: config.tabEnabled ?? true,
    writeEnabled: config.writeEnabled ?? true,
    remoteAccess: config.remoteAccess ?? 'read-only',
    lifecycleEnabled: config.lifecycleEnabled ?? true,
    recallMode: config.recallMode ?? 'guided',
    writebackMode: config.writebackMode ?? 'guided',
    idleReviewMs: config.idleReviewMs ?? DEFAULT_IDLE_REVIEW_MS,
    conversationInteraction: {
      toolviews: config.conversationInteraction?.toolviews ?? false,
      turnBar: config.conversationInteraction?.turnBar ?? true,
      saveAction: config.conversationInteraction?.saveAction ?? true,
    },
    persistenceStrategy: resolvePersistenceStrategy(config.persistenceStrategy),
    taskAgentModel: resolveTaskAgentModel(config.taskAgentModel),
  }
}
