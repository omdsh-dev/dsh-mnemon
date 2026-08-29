import type {
  MemoryProviderCapabilities,
  MemoryProviderConfigField,
  MemoryProviderConnection,
  MemoryProviderDescriptor,
  MemoryProviderId,
  MemoryProviderIcon,
} from '../shared/contracts.ts'

const NATIVE_CAPABILITIES: MemoryProviderCapabilities = {
  search: true,
  browse: true,
  graph: true,
  entities: true,
  related: true,
  remember: true,
  link: true,
  forget: true,
  writeMode: 'exact',
  deletionMode: 'soft',
}

const REMOTE_EXACT_CAPABILITIES: MemoryProviderCapabilities = {
  search: true,
  browse: true,
  graph: false,
  entities: false,
  related: false,
  remember: true,
  link: false,
  forget: true,
  writeMode: 'exact',
  deletionMode: 'hard',
}

const FIELD_I18N_KEYS: Readonly<Record<string, string>> = {
  endpoint: 'overview.providerEndpoint', apiKey: 'overview.providerApiKey', targetUri: 'overview.providerTargetUri', account: 'overview.providerAccount', user: 'overview.providerUser', actorPeerId: 'overview.providerActorPeer',
  workspace: 'overview.providerField.workspace', userId: 'overview.providerField.userId', agentId: 'overview.providerField.agentId', mode: 'overview.providerField.mode', rerank: 'overview.providerField.rerank',
  bankId: 'overview.providerField.bankId', budget: 'overview.providerField.budget', dataPath: 'overview.providerField.dataPath', defaultTrust: 'overview.providerField.defaultTrust', minTrust: 'overview.providerField.minTrust',
  project: 'overview.providerField.project', cliPath: 'overview.providerField.cliPath', defaultDirectory: 'overview.providerField.defaultDirectory', workingDirectory: 'overview.providerField.workingDirectory', containerTag: 'overview.providerField.containerTag', searchMode: 'overview.providerField.searchMode',
}

const field = (value: MemoryProviderConfigField): MemoryProviderConfigField => ({
  ...value,
  ...(FIELD_I18N_KEYS[value.key] === undefined ? {} : { i18nKey: FIELD_I18N_KEYS[value.key] }),
  ...(value.options === undefined ? {} : {
    options: value.options.map(option => ({ ...option, i18nKey: `overview.providerOption.${option.value}` })),
  }),
})

const brand = (value: string): MemoryProviderIcon => ({ kind: 'brand', value })

export const MEMORY_PROVIDER_IDS = [
  'mnemon-native',
  'openviking',
  'honcho',
  'mem0',
  'hindsight',
  'holographic',
  'retaindb',
  'byterover',
  'supermemory',
] as const satisfies readonly MemoryProviderId[]

export const MEMORY_PROVIDER_ID_SET = new Set<MemoryProviderId>(MEMORY_PROVIDER_IDS)

export const MEMORY_PROVIDER_CATALOG: readonly MemoryProviderDescriptor[] = [
  {
    id: 'mnemon-native',
    label: 'mnemon',
    icon: brand('mnemon'),
    kind: 'local',
    workspaceBinding: 'automatic',
    summary: 'Official local-first memory with exact writes, typed graph relations, and soft deletion.',
    summaryI18nKey: 'overview.providerSummary.mnemon-native',
    origin: 'native',
    capabilities: NATIVE_CAPABILITIES,
    fields: [],
  },
  {
    id: 'openviking',
    label: 'OpenViking',
    icon: brand('openviking'),
    kind: 'remote',
    workspaceBinding: 'provider-global',
    summary: 'Filesystem-shaped shared memory with tiered reads and automatic semantic extraction.',
    summaryI18nKey: 'overview.providerSummary.openviking',
    origin: 'third-party',
    capabilities: {
      ...REMOTE_EXACT_CAPABILITIES,
      writeMode: 'async-extracting',
    },
    fields: [
      field({ key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'http://127.0.0.1:1933', placeholder: 'http://127.0.0.1:1933' }),
      field({ key: 'targetUri', label: 'Memory URI', scope: 'memory', input: 'text', required: true, defaultValue: 'viking://user/memories', placeholder: 'viking://user/memories', pattern: '^viking://user(?:/[^/]+)?/memories$', normalize: 'trim-trailing-slash', validationMessage: 'OpenViking memory URI must be a viking://user/.../memories root' }),
      field({ key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: false }),
      field({ key: 'account', label: 'Account', scope: 'service', input: 'text', required: false }),
      field({ key: 'user', label: 'User', scope: 'memory', input: 'text', required: false }),
      field({ key: 'actorPeerId', label: 'Agent peer', scope: 'memory', input: 'text', required: false, defaultValue: 'dsh' }),
    ],
  },
  {
    id: 'honcho',
    label: 'Honcho',
    icon: brand('honcho'),
    kind: 'remote',
    workspaceBinding: 'provider-global',
    summary: 'Cross-session user modelling, peer profiles, dialectic reasoning, and persistent conclusions.',
    summaryI18nKey: 'overview.providerSummary.honcho',
    origin: 'third-party',
    capabilities: REMOTE_EXACT_CAPABILITIES,
    fields: [
      field({ key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'https://api.honcho.dev' }),
      field({ key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: false }),
      field({ key: 'workspace', label: 'Workspace', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh' }),
      field({ key: 'userId', label: 'User peer', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh-user' }),
      field({ key: 'agentId', label: 'Agent peer', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh' }),
    ],
  },
  {
    id: 'mem0',
    label: 'Mem0',
    icon: brand('mem0'),
    kind: 'remote',
    workspaceBinding: 'provider-global',
    summary: 'Automatic fact extraction, semantic retrieval, reranking, and deduplication.',
    summaryI18nKey: 'overview.providerSummary.mem0',
    origin: 'third-party',
    capabilities: { ...REMOTE_EXACT_CAPABILITIES, writeMode: 'async-extracting' },
    fields: [
      field({ key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'https://api.mem0.ai' }),
      field({ key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: false }),
      field({ key: 'mode', label: 'Mode', scope: 'service', input: 'select', required: true, defaultValue: 'platform', options: [{ value: 'platform', label: 'Mem0 Platform' }, { value: 'self-hosted', label: 'Self-hosted server' }] }),
      field({ key: 'userId', label: 'User ID', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh-user' }),
      field({ key: 'agentId', label: 'Agent ID', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh' }),
      field({ key: 'rerank', label: 'Rerank search results', scope: 'memory', input: 'boolean', required: false, defaultValue: false }),
    ],
  },
  {
    id: 'hindsight',
    label: 'Hindsight',
    icon: brand('hindsight'),
    kind: 'remote',
    workspaceBinding: 'provider-global',
    summary: 'Knowledge-graph memory with entity resolution, observations, multi-strategy recall, and reflection.',
    summaryI18nKey: 'overview.providerSummary.hindsight',
    origin: 'third-party',
    capabilities: {
      ...REMOTE_EXACT_CAPABILITIES,
      graph: true,
      entities: true,
      related: true,
      writeMode: 'async-extracting',
      deletionMode: 'soft',
    },
    fields: [
      field({ key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'https://api.hindsight.vectorize.io' }),
      field({ key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: false }),
      field({ key: 'bankId', label: 'Memory bank', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh' }),
      field({ key: 'budget', label: 'Recall budget', scope: 'memory', input: 'select', required: true, defaultValue: 'mid', options: [{ value: 'low', label: 'Low' }, { value: 'mid', label: 'Medium' }, { value: 'high', label: 'High' }] }),
    ],
  },
  {
    id: 'holographic',
    label: 'Holographic',
    icon: brand('holographic'),
    kind: 'local',
    workspaceBinding: 'optional-override',
    summary: 'Local structured fact memory with trust scoring, entity resolution, and compositional retrieval.',
    summaryI18nKey: 'overview.providerSummary.holographic',
    origin: 'third-party',
    capabilities: {
      ...NATIVE_CAPABILITIES,
      link: false,
      deletionMode: 'hard',
    },
    fields: [
      field({ key: 'dataPath', label: 'Fact store path', scope: 'service', role: 'global-location', input: 'path', required: false }),
      field({ key: 'defaultTrust', label: 'Default trust', scope: 'memory', input: 'number', required: true, defaultValue: 0.5, min: 0, max: 1 }),
      field({ key: 'minTrust', label: 'Minimum recall trust', scope: 'memory', input: 'number', required: true, defaultValue: 0.3, min: 0, max: 1 }),
    ],
  },
  {
    id: 'retaindb',
    label: 'RetainDB',
    icon: brand('retaindb'),
    kind: 'remote',
    workspaceBinding: 'provider-global',
    summary: 'Cloud memory with hybrid vector/BM25 retrieval, profiles, and typed durable facts.',
    summaryI18nKey: 'overview.providerSummary.retaindb',
    origin: 'third-party',
    capabilities: REMOTE_EXACT_CAPABILITIES,
    fields: [
      field({ key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'https://api.retaindb.com' }),
      field({ key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: true }),
      field({ key: 'project', label: 'Project', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh' }),
      field({ key: 'userId', label: 'User ID', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh-user' }),
    ],
  },
  {
    id: 'byterover',
    label: 'ByteRover',
    icon: brand('byterover'),
    kind: 'local',
    workspaceBinding: 'optional-override',
    summary: 'Local-first hierarchical knowledge tree accessed through the brv CLI.',
    summaryI18nKey: 'overview.providerSummary.byterover',
    origin: 'third-party',
    capabilities: {
      ...REMOTE_EXACT_CAPABILITIES,
      browse: false,
      forget: false,
      writeMode: 'async-extracting',
      deletionMode: 'unsupported',
    },
    fields: [
      field({ key: 'cliPath', label: 'brv executable', scope: 'service', input: 'path', required: false, defaultValue: 'brv' }),
      field({ key: 'defaultDirectory', label: 'Default knowledge directory', scope: 'service', role: 'global-location', input: 'path', required: false, discoveryDefaultFrom: 'workingDirectory' }),
      field({ key: 'workingDirectory', label: 'Knowledge directory', scope: 'memory', input: 'path', required: false }),
      field({ key: 'apiKey', label: 'Cloud API key', scope: 'service', input: 'secret', required: false }),
    ],
  },
  {
    id: 'supermemory',
    label: 'Supermemory',
    icon: brand('supermemory'),
    kind: 'remote',
    workspaceBinding: 'provider-global',
    summary: 'Semantic memory, persistent profiles, conversation ingest, and multi-container recall.',
    summaryI18nKey: 'overview.providerSummary.supermemory',
    origin: 'third-party',
    capabilities: { ...REMOTE_EXACT_CAPABILITIES, writeMode: 'async-extracting', deletionMode: 'soft' },
    fields: [
      field({ key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'https://api.supermemory.ai' }),
      field({ key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: true }),
      field({ key: 'containerTag', label: 'Container tag', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh', maxLength: 100, pattern: '^[a-zA-Z0-9_:-]+$' }),
      field({ key: 'searchMode', label: 'Search mode', scope: 'memory', input: 'select', required: true, defaultValue: 'hybrid', options: [{ value: 'hybrid', label: 'Hybrid' }, { value: 'memories', label: 'Memories' }, { value: 'documents', label: 'Documents' }] }),
    ],
  },
]

export function memoryProviderDescriptor(id: MemoryProviderId, catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG): MemoryProviderDescriptor {
  const descriptor = catalog.find(candidate => candidate.id === id)
  if (descriptor === undefined) throw new Error(`unsupported memory provider: ${String(id)}`)
  return descriptor
}

export function isMemoryProviderId(value: unknown): value is MemoryProviderId {
  return typeof value === 'string' && MEMORY_PROVIDER_ID_SET.has(value as MemoryProviderId)
}

function normalizeUrl(value: string, label: string): string {
  const normalized = value.trim().replace(/\/+$/u, '')
  let url: URL
  try { url = new URL(normalized) } catch { throw new Error(`${label} must be a valid http(s) URL`) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${label} must use http or https`)
  if (url.username !== '' || url.password !== '') throw new Error(`${label} must not contain credentials`)
  return normalized
}

function normalizeString(value: unknown, field: MemoryProviderConfigField): string {
  let normalized = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim()
  if (field.normalize === 'trim-trailing-slash') normalized = normalized.replace(/\/+$/u, '')
  const maximum = field.maxLength ?? (field.input === 'secret' ? 8000 : 2000)
  if (normalized.length > maximum) throw new Error(`${field.label} is too long (max ${maximum} characters)`)
  if (field.required && normalized === '') throw new Error(`${field.label} is required`)
  if (field.input === 'url' && normalized !== '') return normalizeUrl(normalized, field.label)
  if (field.options !== undefined && normalized !== '' && !field.options.some(option => option.value === normalized)) {
    throw new Error(`${field.label} has an unsupported value`)
  }
  if (field.pattern !== undefined && normalized !== '' && !new RegExp(field.pattern, 'u').test(normalized)) {
    throw new Error(field.validationMessage ?? `${field.label.charAt(0).toLowerCase()}${field.label.slice(1)} has an invalid format`)
  }
  return normalized
}

function validateFieldBounds(field: MemoryProviderConfigField, value: number): void {
  if (field.min !== undefined && field.max !== undefined && (value < field.min || value > field.max)) {
    throw new Error(`${field.label.charAt(0).toLowerCase()}${field.label.slice(1)} must be within ${field.min}..${field.max}`)
  }
  if (field.min !== undefined && value < field.min) throw new Error(`${field.label} must be at least ${field.min}`)
  if (field.max !== undefined && value > field.max) throw new Error(`${field.label} must be at most ${field.max}`)
}

function normalizeScopedProviderConnection(
  providerId: MemoryProviderId,
  scope: MemoryProviderConfigField['scope'],
  input: MemoryProviderConnection | undefined,
  previous: MemoryProviderConnection = {},
  clearSecrets: readonly string[] = [],
  catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG,
): MemoryProviderConnection {
  const descriptor = memoryProviderDescriptor(providerId, catalog)
  if ((descriptor.typeId ?? descriptor.id) === 'mnemon-native') return {}
  const fields = descriptor.fields.filter(item => item.scope === scope)
  const allowed = new Set(fields.map(item => item.key))
  for (const key of Object.keys(input ?? {})) if (!allowed.has(key)) throw new Error(`unsupported ${descriptor.label} ${scope} setting: ${key}`)
  for (const key of clearSecrets) {
    const configField = fields.find(item => item.key === key)
    if (configField?.input !== 'secret') throw new Error(`cannot clear non-secret ${descriptor.label} ${scope} setting: ${key}`)
  }
  const output: MemoryProviderConnection = {}
  for (const configField of fields) {
    if (clearSecrets.includes(configField.key)) {
      output[configField.key] = ''
      continue
    }
    const supplied = input?.[configField.key]
    const value = supplied ?? previous[configField.key] ?? configField.defaultValue
    if (configField.input === 'boolean') {
      if (value === undefined) continue
      if (typeof value === 'boolean') output[configField.key] = value
      else if (value === 'true' || value === 'false') output[configField.key] = value === 'true'
      else throw new Error(`${configField.label} must be true or false`)
      continue
    }
    if (configField.input === 'number') {
      if (value === undefined || value === '') continue
      const parsed = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(parsed)) throw new Error(`${configField.label} must be a finite number`)
      validateFieldBounds(configField, parsed)
      output[configField.key] = parsed
      continue
    }
    const normalized = normalizeString(value, configField)
    if (normalized !== '' || configField.required || configField.input === 'secret') output[configField.key] = normalized
  }
  return output
}

export function providerServiceFields(providerId: MemoryProviderId, catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG): MemoryProviderConfigField[] {
  return memoryProviderDescriptor(providerId, catalog).fields.filter(field => field.scope === 'service')
}

export function providerMemoryFields(providerId: MemoryProviderId, catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG): MemoryProviderConfigField[] {
  return memoryProviderDescriptor(providerId, catalog).fields.filter(field => field.scope === 'memory')
}

export function splitProviderConnection(providerId: MemoryProviderId, connection: MemoryProviderConnection | undefined, catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG): {
  service: MemoryProviderConnection
  memory: MemoryProviderConnection
} {
  const serviceKeys = new Set(providerServiceFields(providerId, catalog).map(field => field.key))
  return {
    service: Object.fromEntries(Object.entries(connection ?? {}).filter(([key]) => serviceKeys.has(key))),
    memory: Object.fromEntries(Object.entries(connection ?? {}).filter(([key]) => !serviceKeys.has(key))),
  }
}

export function normalizeProviderServiceConnection(providerId: MemoryProviderId, input: MemoryProviderConnection | undefined, previous: MemoryProviderConnection = {}, clearSecrets: readonly string[] = [], catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG): MemoryProviderConnection {
  return normalizeScopedProviderConnection(providerId, 'service', input, previous, clearSecrets, catalog)
}

export function normalizeProviderMemoryConnection(providerId: MemoryProviderId, input: MemoryProviderConnection | undefined, previous: MemoryProviderConnection = {}, catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG): MemoryProviderConnection {
  return normalizeScopedProviderConnection(providerId, 'memory', input, previous, [], catalog)
}

export function normalizeProviderConnection(
  providerId: MemoryProviderId,
  input: MemoryProviderConnection | undefined,
  previous: MemoryProviderConnection = {},
  clearSecrets: readonly string[] = [],
  catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG,
): MemoryProviderConnection {
  const descriptor = memoryProviderDescriptor(providerId, catalog)
  if ((descriptor.typeId ?? descriptor.id) === 'mnemon-native') return {}
  const allowed = new Set(descriptor.fields.map(item => item.key))
  for (const key of Object.keys(input ?? {})) if (!allowed.has(key)) throw new Error(`unsupported ${descriptor.label} setting: ${key}`)
  for (const key of clearSecrets) {
    const configField = descriptor.fields.find(item => item.key === key)
    if (configField?.input !== 'secret') throw new Error(`cannot clear non-secret ${descriptor.label} setting: ${key}`)
  }

  const output: MemoryProviderConnection = {}
  for (const configField of descriptor.fields) {
    if (clearSecrets.includes(configField.key)) {
      output[configField.key] = ''
      continue
    }
    const supplied = input?.[configField.key]
    const fallback = previous[configField.key] ?? configField.defaultValue
    const value = supplied ?? fallback
    if (configField.input === 'boolean') {
      if (value === undefined) continue
      if (typeof value === 'boolean') output[configField.key] = value
      else if (value === 'true' || value === 'false') output[configField.key] = value === 'true'
      else throw new Error(`${configField.label} must be true or false`)
      continue
    }
    if (configField.input === 'number') {
      if (value === undefined || value === '') continue
      const parsed = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(parsed)) throw new Error(`${configField.label} must be a finite number`)
      validateFieldBounds(configField, parsed)
      output[configField.key] = parsed
      continue
    }
    const normalized = normalizeString(value, configField)
    if (normalized !== '' || configField.required || configField.input === 'secret') output[configField.key] = normalized
  }
  return output
}

export function publicScopedProviderConnection(providerId: MemoryProviderId, scope: MemoryProviderConfigField['scope'], connection: MemoryProviderConnection, catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG): {
  settings: MemoryProviderConnection
  configuredSecrets: string[]
} {
  const descriptor = memoryProviderDescriptor(providerId, catalog)
  const fields = descriptor.fields.filter(item => item.scope === scope)
  const keys = new Set(fields.map(item => item.key))
  const secrets = new Set(fields.filter(item => item.input === 'secret').map(item => item.key))
  return {
    settings: Object.fromEntries(Object.entries(connection).filter(([key]) => keys.has(key) && !secrets.has(key))),
    configuredSecrets: [...secrets].filter(key => String(connection[key] ?? '') !== ''),
  }
}

export function publicProviderConnection(providerId: MemoryProviderId, connection: MemoryProviderConnection, catalog: readonly MemoryProviderDescriptor[] = MEMORY_PROVIDER_CATALOG): {
  settings: MemoryProviderConnection
  configuredSecrets: string[]
} {
  const descriptor = memoryProviderDescriptor(providerId, catalog)
  const secrets = new Set(descriptor.fields.filter(item => item.input === 'secret').map(item => item.key))
  return {
    settings: Object.fromEntries(Object.entries(connection).filter(([key]) => !secrets.has(key))),
    configuredSecrets: [...secrets].filter(key => String(connection[key] ?? '') !== ''),
  }
}

/** Immutable descriptor/config normalizer scoped to one Provider snapshot. */
export class MemoryProviderCatalog {
  readonly providers: readonly MemoryProviderDescriptor[]

  constructor(providers: readonly MemoryProviderDescriptor[]) {
    const ids = new Set<string>()
    this.providers = Object.freeze(providers.map(provider => {
      if (ids.has(provider.id)) throw new Error(`memory provider descriptor is already registered: ${provider.id}`)
      ids.add(provider.id)
      return Object.freeze(structuredClone(provider))
    }))
  }

  has(id: unknown): id is MemoryProviderId {
    return typeof id === 'string' && this.providers.some(provider => provider.id === id)
  }

  descriptor(id: MemoryProviderId): MemoryProviderDescriptor { return memoryProviderDescriptor(id, this.providers) }
  serviceFields(id: MemoryProviderId): MemoryProviderConfigField[] { return providerServiceFields(id, this.providers) }
  memoryFields(id: MemoryProviderId): MemoryProviderConfigField[] { return providerMemoryFields(id, this.providers) }
  split(id: MemoryProviderId, connection: MemoryProviderConnection | undefined) { return splitProviderConnection(id, connection, this.providers) }
  normalizeService(id: MemoryProviderId, input: MemoryProviderConnection | undefined, previous: MemoryProviderConnection = {}, clearSecrets: readonly string[] = []) {
    return normalizeProviderServiceConnection(id, input, previous, clearSecrets, this.providers)
  }
  normalizeMemory(id: MemoryProviderId, input: MemoryProviderConnection | undefined, previous: MemoryProviderConnection = {}) {
    return normalizeProviderMemoryConnection(id, input, previous, this.providers)
  }
  normalize(id: MemoryProviderId, input: MemoryProviderConnection | undefined, previous: MemoryProviderConnection = {}, clearSecrets: readonly string[] = []) {
    return normalizeProviderConnection(id, input, previous, clearSecrets, this.providers)
  }
  publicScoped(id: MemoryProviderId, scope: MemoryProviderConfigField['scope'], connection: MemoryProviderConnection) {
    return publicScopedProviderConnection(id, scope, connection, this.providers)
  }
  public(id: MemoryProviderId, connection: MemoryProviderConnection) { return publicProviderConnection(id, connection, this.providers) }
}

export const BUILTIN_MEMORY_PROVIDER_CATALOG = new MemoryProviderCatalog(MEMORY_PROVIDER_CATALOG)
