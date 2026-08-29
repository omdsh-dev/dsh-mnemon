import { createHash } from 'node:crypto'
import type {
  ComposableMemoryView,
  InstalledMemorySource,
  InstalledMemoryStrategy,
  MemoryActionOffer,
  MemoryCompositionDiagnostic,
  MemoryCompositionEvaluationReport,
  MemoryContributionSnapshot,
  MemoryEvidence,
  MemoryEvidenceItem,
  MemoryJsonValue,
  MemoryMutationReceipt,
  MemoryPackageProvenance,
  MemoryReadGrant,
  MemorySourceActionManifest,
  MemorySourceDefinition,
  MemorySourceFacts,
  MemorySourceManifest,
  MemorySourceManagementCatalog,
  MemorySourceManagementRequest,
  MemorySourceManagementResult,
  MemorySourceRouteManifest,
  MemorySourceRuntime,
  MemoryStrategyDefinition,
  MemoryStrategyManifest,
  MemoryViewBudget,
  MemoryViewContribution,
  MemoryViewFragment,
  MemoryViewRequest,
  MemoryViewRoute,
  MemoryViewSourceSpec,
  MemoryViewSpec,
} from '../../contracts/src/index.ts'
import { COMPOSABLE_MEMORY_API_VERSION, MEMORY_CAPABILITIES } from '../../contracts/src/index.ts'

const ID = /^[a-z][a-z0-9-]{0,127}$/u
const INSTANCE_KEY = /^(?:source|strategy):[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,299}$/u
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const CAPABILITIES = new Set<string>(MEMORY_CAPABILITIES)

export const DEFAULT_MEMORY_VIEW_BUDGET: Readonly<MemoryViewBudget> = Object.freeze({
  maxProjectionCharacters: 64 * 1024,
  maxRoutes: 16,
  maxActions: 16,
  maxEvidenceResults: 16,
  maxEvidenceCharacters: 16 * 1024,
})

function requiredText(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const normalized = value.trim()
  if (normalized === '') throw new Error(`${label} is required`)
  if (normalized.length > maximum) throw new Error(`${label} is too long (max ${maximum} characters)`)
  return normalized
}

function id(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 128)
  if (!ID.test(normalized)) throw new Error(`${label} must match [a-z][a-z0-9-]{0,127}`)
  return normalized
}

function instanceKey(value: unknown, kind: 'source' | 'strategy'): string {
  const normalized = requiredText(value, `${kind} instanceKey`, 300)
  if (!INSTANCE_KEY.test(normalized) || !normalized.startsWith(`${kind}:`)) {
    throw new Error(`${kind} instanceKey must start with ${kind}: and contain only stable identifier characters`)
  }
  return normalized
}

function positiveInteger(value: unknown, label: string, maximum = 1_000_000): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${label} must be an integer within 1..${maximum}`)
  }
  return value as number
}

/** Canonical JSON representation shared by validation, digest, and replay. */
export function canonicalMemoryJson(value: unknown, label = 'memory value', ancestors = new Set<object>(), depth = 0): string {
  if (depth > 48) throw new Error(`${label} is nested too deeply`)
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`)
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new Error(`${label} contains a non-JSON value`)
  if (ancestors.has(value)) throw new Error(`${label} contains a cycle`)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return `[${value.map(item => canonicalMemoryJson(item, label, ancestors, depth + 1)).join(',')}]`
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} contains a non-JSON object`)
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalMemoryJson(item, label, ancestors, depth + 1)}`).join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalMemoryJson(value)).digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

function jsonClone<T>(value: T, label: string): T {
  canonicalMemoryJson(value, label)
  return deepFreeze(structuredClone(value))
}

function uniqueIds(values: readonly string[], label: string): string[] {
  const output: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const normalized = id(value, label)
    if (seen.has(normalized)) throw new Error(`${label} is duplicated: ${normalized}`)
    seen.add(normalized)
    output.push(normalized)
  }
  return output
}

function validateProvenance(value: MemoryPackageProvenance, expectedPackage: string): MemoryPackageProvenance {
  const packageName = requiredText(value.packageName, 'memory package name', 214)
  if (!PACKAGE.test(packageName)) throw new Error(`invalid memory package name: ${packageName}`)
  if (packageName !== expectedPackage) throw new Error(`memory package provenance does not match manifest: ${packageName} != ${expectedPackage}`)
  const entryId = requiredText(value.entryId, 'memory Entry id', 300)
  const artifactDigest = value.artifactDigest === undefined ? undefined : requiredText(value.artifactDigest, 'memory artifact digest', 500)
  return deepFreeze({ packageName, entryId, ...(artifactDigest === undefined ? {} : { artifactDigest }) })
}

function validateCapabilities(values: readonly string[], label: string): MemorySourceManifest['capabilities'] {
  const normalized = uniqueIds(values, label)
  for (const capability of normalized) {
    if (!CAPABILITIES.has(capability)) throw new Error(`${label} contains unsupported capability: ${capability}`)
  }
  return normalized as MemorySourceManifest['capabilities']
}

function validateRoute(route: MemorySourceRouteManifest): MemorySourceRouteManifest {
  const normalized = {
    id: id(route.id, 'memory Source route id'),
    description: requiredText(route.description, 'memory Source route description', 2_000),
    capability: id(route.capability, 'memory Source route capability') as MemorySourceRouteManifest['capability'],
    inputSchema: jsonClone(route.inputSchema, 'memory Source route input schema'),
    maxCalls: positiveInteger(route.maxCalls, 'memory Source route maxCalls', 100),
    ...(route.maxResults === undefined ? {} : { maxResults: positiveInteger(route.maxResults, 'memory Source route maxResults', 10_000) }),
    ...(route.maxCharacters === undefined ? {} : { maxCharacters: positiveInteger(route.maxCharacters, 'memory Source route maxCharacters', 10_000_000) }),
  }
  if (!CAPABILITIES.has(normalized.capability)) throw new Error(`unsupported memory Source route capability: ${normalized.capability}`)
  return deepFreeze(normalized)
}

function validateAction(action: MemorySourceActionManifest): MemorySourceActionManifest {
  const normalized = {
    id: id(action.id, 'memory Source action id'),
    description: requiredText(action.description, 'memory Source action description', 2_000),
    capability: id(action.capability, 'memory Source action capability') as MemorySourceActionManifest['capability'],
    inputSchema: jsonClone(action.inputSchema, 'memory Source action input schema'),
    ...(action.authority === undefined ? {} : { authority: requiredText(action.authority, 'memory Source action authority', 300) }),
  }
  if (!CAPABILITIES.has(normalized.capability)) throw new Error(`unsupported memory Source action capability: ${normalized.capability}`)
  return deepFreeze(normalized)
}

export function defineMemorySource<T extends MemorySourceDefinition>(definition: T): T {
  const manifest = definition.manifest
  if (manifest.apiVersion !== COMPOSABLE_MEMORY_API_VERSION) throw new Error(`unsupported memory Source API: ${String(manifest.apiVersion)}`)
  if (manifest.kind !== 'source') throw new Error('memory Source manifest kind must be source')
  const typeId = id(manifest.typeId, 'memory Source typeId')
  const packageName = requiredText(manifest.packageName, 'memory Source packageName', 214)
  if (!PACKAGE.test(packageName)) throw new Error(`invalid memory Source packageName: ${packageName}`)
  const role = id(manifest.role, 'memory Source role')
  if (manifest.consistency !== 'exact-snapshot' && manifest.consistency !== 'namespace-pinned-live-read') {
    throw new Error(`unsupported memory Source consistency: ${String(manifest.consistency)}`)
  }
  if (typeof definition.create !== 'function') throw new Error(`memory Source create() is required: ${typeId}`)
  const routes = (manifest.routes ?? []).map(validateRoute)
  uniqueIds(routes.map(route => route.id), 'memory Source route id')
  const actions = (manifest.actions ?? []).map(validateAction)
  uniqueIds(actions.map(action => action.id), 'memory Source action id')
  const normalizedManifest = jsonClone({
    ...manifest,
    typeId,
    packageName,
    role,
    capabilities: validateCapabilities(manifest.capabilities, 'memory Source capability'),
    routes,
    actions,
  }, 'memory Source manifest')
  return Object.freeze({ manifest: normalizedManifest, create: definition.create }) as T
}

export function defineMemoryStrategy<T extends MemoryStrategyDefinition>(definition: T): T {
  const manifest = definition.manifest
  if (manifest.apiVersion !== COMPOSABLE_MEMORY_API_VERSION) throw new Error(`unsupported memory Strategy API: ${String(manifest.apiVersion)}`)
  if (manifest.kind !== 'strategy') throw new Error('memory Strategy manifest kind must be strategy')
  const typeId = id(manifest.typeId, 'memory Strategy typeId')
  const packageName = requiredText(manifest.packageName, 'memory Strategy packageName', 214)
  if (!PACKAGE.test(packageName)) throw new Error(`invalid memory Strategy packageName: ${packageName}`)
  if (manifest.deterministic !== true) throw new Error('memory Strategy must declare deterministic: true')
  if (typeof definition.compose !== 'function') throw new Error(`memory Strategy compose() is required: ${typeId}`)
  const normalizedManifest = jsonClone({
    ...manifest,
    typeId,
    packageName,
    supportedSourceRoles: uniqueIds(manifest.supportedSourceRoles, 'memory Strategy supported Source role'),
    maxSources: positiveInteger(manifest.maxSources, 'memory Strategy maxSources', 1_000),
    maxRoutes: positiveInteger(manifest.maxRoutes, 'memory Strategy maxRoutes', 1_000),
    maxActions: positiveInteger(manifest.maxActions, 'memory Strategy maxActions', 1_000),
  }, 'memory Strategy manifest')
  return Object.freeze({ manifest: normalizedManifest, compose: definition.compose }) as T
}

function captureSource(source: InstalledMemorySource): InstalledMemorySource {
  const definition = defineMemorySource(source.definition)
  const key = instanceKey(source.instanceKey, 'source')
  const effectiveDigest = source.effectiveDigest === undefined ? undefined : requiredText(source.effectiveDigest, 'memory Source effective digest', 500)
  return Object.freeze({
    kind: 'source',
    instanceKey: key,
    provenance: validateProvenance(source.provenance, definition.manifest.packageName),
    definition,
    ...(effectiveDigest === undefined ? {} : { effectiveDigest }),
  })
}

function captureStrategy(strategy: InstalledMemoryStrategy): InstalledMemoryStrategy {
  const definition = defineMemoryStrategy(strategy.definition)
  return Object.freeze({
    kind: 'strategy',
    instanceKey: instanceKey(strategy.instanceKey, 'strategy'),
    provenance: validateProvenance(strategy.provenance, definition.manifest.packageName),
    definition,
  })
}

export function captureMemoryContributionSnapshot(snapshot: MemoryContributionSnapshot): MemoryContributionSnapshot {
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) throw new Error('memory contribution revision must be a non-negative integer')
  const sources = snapshot.sources.map(captureSource)
  const strategies = snapshot.strategies.map(captureStrategy)
  const keys = new Set<string>()
  for (const contribution of [...sources, ...strategies]) {
    if (keys.has(contribution.instanceKey)) throw new Error(`memory contribution instanceKey is duplicated: ${contribution.instanceKey}`)
    keys.add(contribution.instanceKey)
  }
  return Object.freeze({ revision: snapshot.revision, sources: Object.freeze(sources) as unknown as InstalledMemorySource[], strategies: Object.freeze(strategies) as unknown as InstalledMemoryStrategy[] })
}

export interface CompileMemoryGenerationOptions {
  strategyInstanceKey?: string
  strategyTypeId?: string
  bindings?: ReadonlyMap<string, unknown>
  now?: () => Date
}

interface RuntimeSource {
  installed: InstalledMemorySource
  runtime: MemorySourceRuntime
}

function selectStrategy(strategies: readonly InstalledMemoryStrategy[], options: CompileMemoryGenerationOptions): InstalledMemoryStrategy {
  if (options.strategyInstanceKey !== undefined) {
    const key = instanceKey(options.strategyInstanceKey, 'strategy')
    const selected = strategies.find(strategy => strategy.instanceKey === key)
    if (selected === undefined) throw new Error(`selected memory Strategy instance is unavailable: ${key}`)
    return selected
  }
  if (options.strategyTypeId !== undefined) {
    const type = id(options.strategyTypeId, 'selected memory Strategy typeId')
    const matches = strategies.filter(strategy => strategy.definition.manifest.typeId === type)
    if (matches.length === 0) throw new Error(`selected memory Strategy type is unavailable: ${type}`)
    if (matches.length > 1) throw new Error(`selected memory Strategy type is ambiguous: ${type}`)
    return matches[0]!
  }
  if (strategies.length !== 1) throw new Error(`exactly one memory Strategy must be selected; found ${strategies.length}`)
  return strategies[0]!
}

function normalizeBudget(value: MemoryViewBudget): MemoryViewBudget {
  return deepFreeze({
    maxProjectionCharacters: positiveInteger(value.maxProjectionCharacters, 'memory View maxProjectionCharacters', 10_000_000),
    maxRoutes: positiveInteger(value.maxRoutes, 'memory View maxRoutes', 10_000),
    maxActions: positiveInteger(value.maxActions, 'memory View maxActions', 10_000),
    maxEvidenceResults: positiveInteger(value.maxEvidenceResults, 'memory View maxEvidenceResults', 10_000),
    maxEvidenceCharacters: positiveInteger(value.maxEvidenceCharacters, 'memory View maxEvidenceCharacters', 10_000_000),
  })
}

function normalizeFacts(source: InstalledMemorySource, facts: MemorySourceFacts): MemorySourceFacts {
  const manifest = source.definition.manifest
  if (facts.sourceInstanceKey !== source.instanceKey) throw new Error(`memory Source facts instance mismatch: ${facts.sourceInstanceKey} != ${source.instanceKey}`)
  if (facts.sourceTypeId !== manifest.typeId) throw new Error(`memory Source facts type mismatch: ${facts.sourceTypeId} != ${manifest.typeId}`)
  if (facts.role !== manifest.role) throw new Error(`memory Source facts role mismatch: ${facts.role} != ${manifest.role}`)
  if (!['ready', 'degraded', 'unavailable'].includes(facts.availability)) throw new Error(`unsupported memory Source availability: ${String(facts.availability)}`)
  const capabilities = validateCapabilities(facts.capabilities, `memory Source facts capability for ${source.instanceKey}`)
  const allowedCapabilities = new Set(manifest.capabilities)
  for (const capability of capabilities) {
    if (!allowedCapabilities.has(capability)) throw new Error(`memory Source facts expand manifest capability: ${source.instanceKey}/${capability}`)
  }
  const routeIds = uniqueIds(facts.routeIds, `memory Source facts route id for ${source.instanceKey}`)
  const allowedRoutes = new Set((manifest.routes ?? []).map(route => route.id))
  for (const routeId of routeIds) if (!allowedRoutes.has(routeId)) throw new Error(`memory Source facts expose undeclared route: ${source.instanceKey}/${routeId}`)
  const actionIds = uniqueIds(facts.actionIds, `memory Source facts action id for ${source.instanceKey}`)
  const allowedActions = new Set((manifest.actions ?? []).map(action => action.id))
  for (const actionId of actionIds) if (!allowedActions.has(actionId)) throw new Error(`memory Source facts expose undeclared action: ${source.instanceKey}/${actionId}`)
  return jsonClone({
    ...facts,
    revision: requiredText(facts.revision, `memory Source facts revision for ${source.instanceKey}`, 500),
    capabilities,
    routeIds,
    actionIds,
  }, `memory Source facts for ${source.instanceKey}`)
}

function normalizeViewSpec(value: MemoryViewSpec, strategy: InstalledMemoryStrategy, facts: ReadonlyMap<string, MemorySourceFacts>, budget: MemoryViewBudget): MemoryViewSpec {
  if (value.strategyTypeId !== strategy.definition.manifest.typeId) throw new Error('memory ViewSpec strategyTypeId does not match the selected Strategy')
  const maxSources = Math.min(strategy.definition.manifest.maxSources, facts.size)
  if (!Array.isArray(value.sources) || value.sources.length > maxSources) throw new Error(`memory Strategy selected too many Sources (max ${maxSources})`)
  const seen = new Set<string>()
  let routes = 0
  let actions = 0
  const normalizedSources: MemoryViewSourceSpec[] = value.sources.map(source => {
    const key = instanceKey(source.sourceInstanceKey, 'source')
    if (seen.has(key)) throw new Error(`memory Strategy selected Source twice: ${key}`)
    seen.add(key)
    const sourceFacts = facts.get(key)
    if (sourceFacts === undefined) throw new Error(`memory Strategy selected unavailable Source: ${key}`)
    if (sourceFacts.availability === 'unavailable') throw new Error(`memory Strategy selected unavailable Source runtime: ${key}`)
    const routeIds = uniqueIds(source.routeIds ?? [], `memory ViewSpec route id for ${key}`)
    const availableRoutes = new Set(sourceFacts.routeIds)
    for (const routeId of routeIds) if (!availableRoutes.has(routeId)) throw new Error(`memory Strategy selected unavailable route: ${key}/${routeId}`)
    const actionIds = uniqueIds(source.actionIds ?? [], `memory ViewSpec action id for ${key}`)
    const availableActions = new Set(sourceFacts.actionIds)
    for (const actionId of actionIds) if (!availableActions.has(actionId)) throw new Error(`memory Strategy selected unavailable action: ${key}/${actionId}`)
    routes += routeIds.length
    actions += actionIds.length
    const projection = source.projection === undefined ? undefined : {
      mode: source.projection.mode,
      maxCharacters: Math.min(positiveInteger(source.projection.maxCharacters, `memory projection budget for ${key}`, 10_000_000), budget.maxProjectionCharacters),
    }
    if (projection !== undefined && projection.mode !== 'eager' && projection.mode !== 'routed') throw new Error(`unsupported memory projection mode: ${String(projection.mode)}`)
    return deepFreeze({ sourceInstanceKey: key, ...(projection === undefined ? {} : { projection }), routeIds, actionIds })
  })
  if (routes > Math.min(strategy.definition.manifest.maxRoutes, budget.maxRoutes)) throw new Error('memory Strategy selected too many Routes')
  if (actions > Math.min(strategy.definition.manifest.maxActions, budget.maxActions)) throw new Error('memory Strategy selected too many ActionOffers')
  return deepFreeze({ strategyTypeId: value.strategyTypeId, sources: normalizedSources, explanation: requiredText(value.explanation, 'memory ViewSpec explanation', 4_000) })
}

function normalizeContribution(source: RuntimeSource, spec: MemoryViewSourceSpec, facts: MemorySourceFacts, value: MemoryViewContribution): MemoryViewContribution {
  const fragments = value.fragments.map((fragment, index) => {
    if (fragment.sourceInstanceKey !== source.installed.instanceKey) throw new Error(`memory View fragment Source mismatch: ${fragment.sourceInstanceKey}`)
    if (spec.projection === undefined) throw new Error(`memory Source returned projection without a Strategy request: ${source.installed.instanceKey}`)
    if (fragment.mode !== spec.projection.mode) throw new Error(`memory View fragment mode mismatch: ${source.installed.instanceKey}`)
    const text = typeof fragment.text === 'string' ? fragment.text : ''
    if (text.length > spec.projection.maxCharacters) throw new Error(`memory View fragment exceeds Source projection budget: ${source.installed.instanceKey}`)
    return jsonClone({
      ...fragment,
      id: requiredText(fragment.id, `memory View fragment id ${index}`, 300),
      text,
      revision: requiredText(fragment.revision, 'memory View fragment revision', 500),
    }, `memory View fragment for ${source.installed.instanceKey}`)
  })
  let readGrant: MemoryReadGrant | undefined
  if (value.readGrant !== undefined) {
    const grant = value.readGrant
    if (grant.sourceInstanceKey !== source.installed.instanceKey) throw new Error(`memory ReadGrant Source mismatch: ${grant.sourceInstanceKey}`)
    if (grant.consistency !== source.installed.definition.manifest.consistency) throw new Error(`memory ReadGrant consistency expands Source manifest: ${source.installed.instanceKey}`)
    readGrant = jsonClone({
      ...grant,
      id: requiredText(grant.id, 'memory ReadGrant id', 300),
      schema: requiredText(grant.schema, 'memory ReadGrant schema', 300),
      revision: requiredText(grant.revision, 'memory ReadGrant revision', 500),
    }, `memory ReadGrant for ${source.installed.instanceKey}`)
  }
  if ((spec.routeIds?.length ?? 0) > 0 && readGrant === undefined) throw new Error(`memory Source did not return a ReadGrant for selected Routes: ${source.installed.instanceKey}`)
  if (facts.availability === 'unavailable' && (fragments.length > 0 || readGrant !== undefined)) throw new Error(`unavailable memory Source returned a View contribution: ${source.installed.instanceKey}`)
  return deepFreeze({ fragments, ...(readGrant === undefined ? {} : { readGrant }) })
}

function routeFor(source: RuntimeSource, routeId: string, grant: MemoryReadGrant, budget: MemoryViewBudget): MemoryViewRoute {
  const manifest = source.installed.definition.manifest.routes?.find(route => route.id === routeId)
  if (manifest === undefined) throw new Error(`memory Source Route manifest disappeared: ${source.installed.instanceKey}/${routeId}`)
  return deepFreeze({
    id: `${source.installed.instanceKey}/${routeId}`,
    sourceInstanceKey: source.installed.instanceKey,
    sourceRouteId: routeId,
    description: manifest.description,
    capability: manifest.capability,
    inputSchema: manifest.inputSchema,
    readGrantId: grant.id,
    maxCalls: manifest.maxCalls,
    maxResults: Math.min(manifest.maxResults ?? budget.maxEvidenceResults, budget.maxEvidenceResults),
    maxCharacters: Math.min(manifest.maxCharacters ?? budget.maxEvidenceCharacters, budget.maxEvidenceCharacters),
  })
}

function actionFor(source: RuntimeSource, actionId: string): MemoryActionOffer {
  const manifest = source.installed.definition.manifest.actions?.find(action => action.id === actionId)
  if (manifest === undefined) throw new Error(`memory Source Action manifest disappeared: ${source.installed.instanceKey}/${actionId}`)
  return deepFreeze({
    id: `${source.installed.instanceKey}/${actionId}`,
    sourceInstanceKey: source.installed.instanceKey,
    sourceActionId: actionId,
    description: manifest.description,
    capability: manifest.capability,
    inputSchema: manifest.inputSchema,
    ...(manifest.authority === undefined ? {} : { authority: manifest.authority }),
  })
}

function assertInputSchema(schemaValue: MemoryJsonValue, value: MemoryJsonValue, label: string): void {
  if (typeof schemaValue !== 'object' || schemaValue === null || Array.isArray(schemaValue)) return
  const schema = schemaValue as Record<string, MemoryJsonValue>
  const expected = schema.type
  if (expected === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
    const record = value as Record<string, MemoryJsonValue>
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []
    for (const key of required) if (!(key in record)) throw new Error(`${label} is missing required property: ${key}`)
    const properties = typeof schema.properties === 'object' && schema.properties !== null && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, MemoryJsonValue>
      : {}
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) if (!(key in properties)) throw new Error(`${label} contains unsupported property: ${key}`)
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in record) assertInputSchema(propertySchema, record[key]!, `${label}.${key}`)
    }
  } else if (expected === 'string' && typeof value !== 'string') {
    throw new Error(`${label} must be a string`)
  } else if ((expected === 'number' || expected === 'integer') && (typeof value !== 'number' || !Number.isFinite(value) || (expected === 'integer' && !Number.isInteger(value)))) {
    throw new Error(`${label} must be ${expected}`)
  } else if (expected === 'boolean' && typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`)
  } else if (expected === 'array' && !Array.isArray(value)) {
    throw new Error(`${label} must be an array`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => canonicalMemoryJson(candidate) === canonicalMemoryJson(value))) {
    throw new Error(`${label} is not an allowed value`)
  }
}

function normalizeEvidence(value: MemoryEvidence, view: ComposableMemoryView, route: MemoryViewRoute, budget: MemoryViewBudget, now: () => Date): MemoryEvidence {
  if (value.viewId !== view.id || value.routeId !== route.id || value.sourceInstanceKey !== route.sourceInstanceKey) {
    throw new Error('memory Evidence is not bound to the requested View Route')
  }
  const resultLimit = Math.min(route.maxResults ?? budget.maxEvidenceResults, budget.maxEvidenceResults)
  const characterLimit = Math.min(route.maxCharacters ?? budget.maxEvidenceCharacters, budget.maxEvidenceCharacters)
  const items: MemoryEvidenceItem[] = []
  let characters = 0
  let truncated = value.truncated || value.items.length > resultLimit
  for (const item of value.items) {
    if (items.length >= resultLimit) break
    const text = typeof item.text === 'string' ? item.text : ''
    if (characters + text.length > characterLimit) {
      const remaining = Math.max(0, characterLimit - characters)
      if (remaining > 0) items.push(jsonClone({ ...item, id: requiredText(item.id, 'memory Evidence item id', 500), text: text.slice(0, remaining) }, 'memory Evidence item'))
      truncated = true
      break
    }
    items.push(jsonClone({ ...item, id: requiredText(item.id, 'memory Evidence item id', 500), text }, 'memory Evidence item'))
    characters += text.length
  }
  return jsonClone({
    ...value,
    id: requiredText(value.id, 'memory Evidence id', 500),
    observedAt: typeof value.observedAt === 'string' && value.observedAt.trim() !== '' ? value.observedAt : now().toISOString(),
    items,
    truncated,
    ...(value.unavailable === undefined ? {} : { unavailable: requiredText(value.unavailable, 'memory Evidence unavailable reason', 2_000) }),
  }, 'memory Evidence')
}

export class MemoryCompositionGeneration {
  readonly id: string
  readonly report: MemoryCompositionEvaluationReport
  readonly strategy: InstalledMemoryStrategy
  private readonly sources: ReadonlyMap<string, RuntimeSource>
  private readonly now: () => Date
  private readonly routeCalls = new Map<string, number>()
  private disposed = false

  constructor(snapshotValue: MemoryContributionSnapshot, options: CompileMemoryGenerationOptions = {}) {
    const snapshot = captureMemoryContributionSnapshot(snapshotValue)
    if (snapshot.sources.length === 0) throw new Error('memory composition requires at least one Source')
    if (snapshot.strategies.length === 0) throw new Error('memory composition requires a Strategy')
    this.strategy = selectStrategy(snapshot.strategies, options)
    this.now = options.now ?? (() => new Date())
    const bindings = options.bindings ?? new Map<string, unknown>()
    const created = new Map<string, RuntimeSource>()
    try {
      for (const installed of snapshot.sources) {
        const runtime = installed.definition.create({
          sourceInstanceKey: installed.instanceKey,
          provenance: installed.provenance,
          binding: <T = unknown>(key: string): T | undefined => bindings.get(key) as T | undefined,
        })
        if (typeof runtime !== 'object' || runtime === null || typeof runtime.facts !== 'function' || typeof runtime.project !== 'function') {
          throw new Error(`memory Source factory returned an invalid runtime: ${installed.instanceKey}`)
        }
        created.set(installed.instanceKey, { installed, runtime })
      }
    } catch (error) {
      for (const source of [...created.values()].reverse()) void source.runtime.dispose?.()
      throw error
    }
    this.sources = created
    const generationInput = {
      contributionRevision: snapshot.revision,
      strategy: {
        instanceKey: this.strategy.instanceKey,
        manifest: this.strategy.definition.manifest,
        provenance: this.strategy.provenance,
      },
      sources: snapshot.sources.map(source => ({
        instanceKey: source.instanceKey,
        manifest: source.definition.manifest,
        provenance: source.provenance,
        effectiveDigest: source.effectiveDigest ?? null,
      })),
    }
    this.id = `generation:${digest(generationInput)}`
    this.report = deepFreeze({
      state: 'ready',
      contributionRevision: snapshot.revision,
      generationId: this.id,
      strategyInstanceKey: this.strategy.instanceKey,
      sourceInstanceKeys: [...this.sources.keys()],
      diagnostics: [],
    })
  }

  async compose(requestValue: MemoryViewRequest): Promise<ComposableMemoryView> {
    this.assertOpen()
    const request = jsonClone({ ...requestValue, scenario: requiredText(requestValue.scenario, 'memory View scenario', 300), budget: normalizeBudget(requestValue.budget) }, 'memory View request')
    const facts = new Map<string, MemorySourceFacts>()
    for (const source of this.sources.values()) {
      facts.set(source.installed.instanceKey, normalizeFacts(source.installed, await source.runtime.facts(request)))
    }
    const factsList = deepFreeze([...facts.values()].map(value => jsonClone(value, 'memory Source facts')))
    const proposed = this.strategy.definition.compose(request, factsList)
    const replayed = this.strategy.definition.compose(request, factsList)
    if (canonicalMemoryJson(proposed, 'memory ViewSpec') !== canonicalMemoryJson(replayed, 'replayed memory ViewSpec')) {
      throw new Error(`memory Strategy is not deterministic: ${this.strategy.instanceKey}`)
    }
    const spec = normalizeViewSpec(proposed, this.strategy, facts, request.budget)
    const projection: MemoryViewFragment[] = []
    const grants: MemoryReadGrant[] = []
    const routes: MemoryViewRoute[] = []
    const actions: MemoryActionOffer[] = []
    let projectionCharacters = 0
    for (const sourceSpec of spec.sources) {
      const source = this.sources.get(sourceSpec.sourceInstanceKey)!
      const sourceFacts = facts.get(sourceSpec.sourceInstanceKey)!
      const contribution = normalizeContribution(source, sourceSpec, sourceFacts, await source.runtime.project({
        scope: request.scope,
        sourceInstanceKey: source.installed.instanceKey,
        includeProjection: sourceSpec.projection !== undefined,
        mode: sourceSpec.projection?.mode ?? 'routed',
        maxCharacters: sourceSpec.projection?.maxCharacters ?? 1,
      }))
      for (const fragment of contribution.fragments) {
        projectionCharacters += fragment.text.length
        if (projectionCharacters > request.budget.maxProjectionCharacters) throw new Error('memory View projection exceeds the root-turn budget')
        projection.push(fragment)
      }
      if (contribution.readGrant !== undefined) {
        if (grants.some(grant => grant.id === contribution.readGrant!.id)) throw new Error(`memory ReadGrant id is duplicated: ${contribution.readGrant.id}`)
        grants.push(contribution.readGrant)
        for (const routeId of sourceSpec.routeIds ?? []) routes.push(routeFor(source, routeId, contribution.readGrant, request.budget))
      }
      for (const actionId of sourceSpec.actionIds ?? []) actions.push(actionFor(source, actionId))
    }
    const sourceRevisions = Object.fromEntries([...facts].map(([key, value]) => [key, value.revision]))
    const modes = new Set(spec.sources.map(source => this.sources.get(source.sourceInstanceKey)!.installed.definition.manifest.consistency))
    const consistency = { mode: modes.size === 1 ? [...modes][0]! : 'mixed' as const, sourceRevisions }
    const body = {
      runtimeGeneration: this.id,
      strategyInstanceKey: this.strategy.instanceKey,
      strategyTypeId: this.strategy.definition.manifest.typeId,
      scope: request.scope,
      projection,
      routes,
      readGrants: grants,
      actionOffers: actions,
      consistency,
      explanation: spec.explanation,
    }
    const viewDigest = digest(body)
    return deepFreeze({ id: `view:${viewDigest}`, digest: viewDigest, createdAt: this.now().toISOString(), ...body })
  }

  /**
   * Project the current scope's visible Source instances for the human
   * management plane. The returned catalog contains only JSON-safe manifest
   * metadata and SourceFacts; runtime objects and grants remain Host-only.
   */
  async managementCatalog(scope: MemoryViewRequest['scope']): Promise<MemorySourceManagementCatalog> {
    this.assertOpen()
    const request = jsonClone({
      scope,
      scenario: 'management.catalog',
      budget: DEFAULT_MEMORY_VIEW_BUDGET,
    }, 'memory management catalog request')
    const sources = []
    for (const source of this.sources.values()) {
      const descriptor = source.installed.definition.manifest.management
      if (descriptor === undefined) continue
      const facts = normalizeFacts(source.installed, await source.runtime.facts(request))
      sources.push({
        sourceInstanceKey: source.installed.instanceKey,
        sourceTypeId: source.installed.definition.manifest.typeId,
        packageName: source.installed.definition.manifest.packageName,
        role: source.installed.definition.manifest.role,
        availability: facts.availability,
        revision: facts.revision,
        capabilities: facts.capabilities,
        management: descriptor,
        ...(facts.hints === undefined ? {} : { hints: facts.hints }),
      })
    }
    return jsonClone({ generationId: this.id, sources }, 'memory Source management catalog')
  }

  /** Execute one short-lived, explicitly scoped management operation. */
  async executeManagement(requestValue: MemorySourceManagementRequest): Promise<MemorySourceManagementResult> {
    this.assertOpen()
    const sourceInstanceKey = instanceKey(requestValue.sourceInstanceKey, 'source')
    const operation = id(requestValue.operation, 'memory Source management operation')
    if (requestValue.mode !== 'read' && requestValue.mode !== 'mutate') throw new Error(`unsupported memory Source management mode: ${String(requestValue.mode)}`)
    if (requestValue.mode === 'mutate') {
      if (requestValue.confirmed !== true) throw new Error('memory Source management mutation requires explicit confirmation')
      requiredText(requestValue.expectedRevision, 'memory Source management expectedRevision', 500)
    }
    const source = this.sources.get(sourceInstanceKey)
    if (source?.runtime.manage === undefined || source.installed.definition.manifest.management === undefined) {
      throw new Error(`memory Source does not expose management operations: ${sourceInstanceKey}`)
    }
    const facts = normalizeFacts(source.installed, await source.runtime.facts(jsonClone({
      scope: requestValue.scope,
      scenario: `management.${requestValue.mode}`,
      budget: DEFAULT_MEMORY_VIEW_BUDGET,
    }, 'memory Source management facts request')))
    if (facts.availability === 'unavailable') throw new Error(`memory Source is unavailable in the requested management scope: ${sourceInstanceKey}`)
    if (requestValue.mode === 'mutate' && requestValue.expectedRevision !== facts.revision) {
      throw new Error(`memory Source management revision conflict: expected ${requestValue.expectedRevision}, current ${facts.revision}`)
    }
    const request: MemorySourceManagementRequest = {
      scope: jsonClone(requestValue.scope, 'memory Source management scope'),
      sourceInstanceKey,
      mode: requestValue.mode,
      operation,
      input: jsonClone(requestValue.input, 'memory Source management input'),
      ...(requestValue.expectedRevision === undefined ? {} : { expectedRevision: requiredText(requestValue.expectedRevision, 'memory Source management expectedRevision', 500) }),
      confirmed: requestValue.confirmed === true,
      ...(requestValue.signal === undefined ? {} : { signal: requestValue.signal }),
    }
    const result = await source.runtime.manage(request)
    return jsonClone({
      revision: requiredText(result.revision, 'memory Source management result revision', 500),
      value: result.value,
    }, 'memory Source management result')
  }

  async executeRoute(view: ComposableMemoryView, routeId: string, input: MemoryJsonValue, signal?: AbortSignal, budget: MemoryViewBudget = DEFAULT_MEMORY_VIEW_BUDGET): Promise<MemoryEvidence> {
    this.assertOpen()
    if (view.runtimeGeneration !== this.id) throw new Error('memory View belongs to a different runtime generation')
    const route = view.routes.find(candidate => candidate.id === routeId)
    if (route === undefined) throw new Error(`memory View Route is unavailable: ${routeId}`)
    const grant = view.readGrants.find(candidate => candidate.id === route.readGrantId && candidate.sourceInstanceKey === route.sourceInstanceKey)
    if (grant === undefined) throw new Error(`memory View Route has no valid ReadGrant: ${routeId}`)
    assertInputSchema(route.inputSchema, input, 'memory Route input')
    const counter = `${view.id}\u0000${route.id}`
    const calls = this.routeCalls.get(counter) ?? 0
    if (calls >= route.maxCalls) throw new Error(`memory View Route call budget is exhausted: ${route.id}`)
    const source = this.sources.get(route.sourceInstanceKey)
    if (source?.runtime.query === undefined) throw new Error(`memory Source cannot execute Route: ${route.sourceInstanceKey}`)
    this.routeCalls.set(counter, calls + 1)
    try {
      return normalizeEvidence(await source.runtime.query({ view, route, grant, input, ...(signal === undefined ? {} : { signal }) }), view, route, normalizeBudget(budget), this.now)
    } catch (error) {
      if (calls === 0) this.routeCalls.delete(counter)
      else this.routeCalls.set(counter, calls)
      throw error
    }
  }

  async executeAction(view: ComposableMemoryView, offerId: string, input: MemoryJsonValue, authorize: (offer: MemoryActionOffer) => boolean | Promise<boolean>, signal?: AbortSignal): Promise<MemoryMutationReceipt> {
    this.assertOpen()
    if (view.runtimeGeneration !== this.id) throw new Error('memory View belongs to a different runtime generation')
    const offer = view.actionOffers.find(candidate => candidate.id === offerId)
    if (offer === undefined) throw new Error(`memory ActionOffer is unavailable: ${offerId}`)
    assertInputSchema(offer.inputSchema, input, 'memory Action input')
    if (!await authorize(offer)) throw new Error(`memory ActionOffer is not currently authorized: ${offer.id}`)
    const source = this.sources.get(offer.sourceInstanceKey)
    if (source?.runtime.mutate === undefined) throw new Error(`memory Source cannot execute ActionOffer: ${offer.sourceInstanceKey}`)
    const receipt = await source.runtime.mutate({ view, offer, input, ...(signal === undefined ? {} : { signal }) })
    if (receipt.viewId !== view.id || receipt.offerId !== offer.id || receipt.sourceInstanceKey !== offer.sourceInstanceKey) {
      throw new Error('memory mutation Receipt is not bound to the requested ActionOffer')
    }
    return jsonClone({
      ...receipt,
      id: requiredText(receipt.id, 'memory mutation Receipt id', 500),
      committedAt: typeof receipt.committedAt === 'string' && receipt.committedAt.trim() !== '' ? receipt.committedAt : this.now().toISOString(),
    }, 'memory mutation Receipt')
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.routeCalls.clear()
    const failures: unknown[] = []
    for (const source of [...this.sources.values()].reverse()) {
      try {
        await source.runtime.dispose?.()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `memory generation disposal failed: ${this.id}`)
  }

  sourceRuntime<T extends MemorySourceRuntime = MemorySourceRuntime>(sourceInstanceKey: string): T | undefined {
    return this.sources.get(sourceInstanceKey)?.runtime as T | undefined
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error(`memory runtime generation is disposed: ${this.id}`)
  }
}

export interface MemoryCompositionRunnerInput {
  contributions: MemoryContributionSnapshot
  request?: MemoryViewRequest
  bindings?: ReadonlyMap<string, unknown>
  strategyInstanceKey?: string
  strategyTypeId?: string
}

export interface MemoryCompositionRunnerResult {
  report: MemoryCompositionEvaluationReport
  generation?: MemoryCompositionGeneration
  view?: ComposableMemoryView
}

/**
 * Test/dev runner analogous to Spring's context runner. It is deliberately not
 * a production Service: plugins, CI, registry checks, and RSI candidates all
 * pass through the same compiler without gaining a bypass.
 */
export class MemoryCompositionRunner {
  async run(input: MemoryCompositionRunnerInput): Promise<MemoryCompositionRunnerResult> {
    let snapshot: MemoryContributionSnapshot
    try {
      snapshot = captureMemoryContributionSnapshot(input.contributions)
    } catch (error) {
      return { report: rejectedReport(input.contributions.revision, error) }
    }
    if (snapshot.sources.length === 0 || snapshot.strategies.length === 0) {
      const diagnostics: MemoryCompositionDiagnostic[] = []
      if (snapshot.sources.length === 0) diagnostics.push({ code: 'missing-source', message: 'No Memory Source contribution is installed.' })
      if (snapshot.strategies.length === 0) diagnostics.push({ code: 'missing-strategy', message: 'No Memory Strategy contribution is installed.' })
      return {
        report: deepFreeze({
          state: 'incomplete',
          contributionRevision: snapshot.revision,
          sourceInstanceKeys: snapshot.sources.map(source => source.instanceKey),
          diagnostics,
        }),
      }
    }
    let generation: MemoryCompositionGeneration | undefined
    try {
      generation = new MemoryCompositionGeneration(snapshot, {
        ...(input.bindings === undefined ? {} : { bindings: input.bindings }),
        ...(input.strategyInstanceKey === undefined ? {} : { strategyInstanceKey: input.strategyInstanceKey }),
        ...(input.strategyTypeId === undefined ? {} : { strategyTypeId: input.strategyTypeId }),
      })
      if (input.request === undefined) return { report: generation.report, generation }
      const view = await generation.compose(input.request)
      return { report: generation.report, generation, view }
    } catch (error) {
      await generation?.dispose().catch(() => {})
      return { report: rejectedReport(snapshot.revision, error, snapshot.sources.map(source => source.instanceKey)) }
    }
  }
}

function rejectedReport(revision: number, error: unknown, sources: string[] = []): MemoryCompositionEvaluationReport {
  return deepFreeze({
    state: 'rejected',
    contributionRevision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    sourceInstanceKeys: sources,
    diagnostics: [{ code: 'composition-rejected', message: error instanceof Error ? error.message : String(error) }],
  })
}
