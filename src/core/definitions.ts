import type { MemoryBudgetMetric, MemoryBudgetSupport, MemoryOperationSemantics, MemoryPackageProvenance, MemorySourceActionManifest, MemorySourceDefinition, MemorySourceManifest, MemorySourceRouteManifest, MemoryStrategyDefinition } from './contracts/index.ts'
import { COMPOSABLE_MEMORY_API_VERSION, MEMORY_CAPABILITIES } from './contracts/index.ts'

const ID = /^[a-z][a-z0-9-]{0,127}$/u
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const CAPABILITIES = new Set<string>(MEMORY_CAPABILITIES)
const ACTIONS = ['record', 'wake', 'read', 'compress', 'forget']
const TARGETS = ['records', 'representations', 'relations', 'catalog', 'visibility', 'usage', 'candidates']
export const MEMORY_REPRESENTATIONS = ['raw', 'excerpt', 'summary', 'inference', 'structured', 'catalog', 'receipt']

export function validateMemorySemanticMember<T extends string>(value: T, values: readonly string[], label: string): T {
  if (!values.includes(value)) throw new Error(`unsupported memory ${label}: ${String(value)}`)
  return value
}

function semanticMembers<T extends string>(value: T[], values: readonly string[], label: string): T[] {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) throw new Error(`memory ${label} must be a nonempty unique list`)
  return value.map(item => validateMemorySemanticMember(item, values, label))
}

export function validateMemoryBudgetMetric(value: MemoryBudgetMetric): MemoryBudgetMetric {
  const resource = validateMemorySemanticMember(value.resource, ['output', 'input', 'cost'], 'budget resource')
  const unit = validateMemorySemanticMember(value.unit, resource === 'cost' ? ['calls', 'milliseconds', 'tokens'] : ['characters', 'bytes', 'tokens', 'items'], 'budget unit')
  const measurement = validateMemorySemanticMember(value.measurement, ['exact', 'estimated'], 'budget measurement')
  if (unit !== 'tokens' && value.basis !== undefined) throw new Error('only token budgets accept a measurement basis')
  return { resource, unit, measurement, ...(unit === 'tokens' ? { basis: requiredText(value.basis, 'token budget basis', 300) } : {}) }
}

export function memoryBudgetMetricKey(value: MemoryBudgetMetric): string {
  return `${value.resource}/${value.unit}/${value.measurement}/${value.basis ?? ''}`
}

export function validateMemoryBudgetSupports(values: MemoryBudgetSupport[] = []): MemoryBudgetSupport[] {
  const seen = new Set<string>()
  return values.map(value => {
    const normalized = validateMemoryBudgetMetric(value)
    const key = memoryBudgetMetricKey(normalized)
    if (seen.has(key)) throw new Error(`duplicated memory budget: ${key}`)
    seen.add(key)
    const maximum = positiveInteger(value.maximum, 'budget maximum', 1_000_000_000)
    const fallback = positiveInteger(value.default, 'budget default', maximum)
    return { ...normalized, default: fallback, maximum }
  })
}

function validateSemantics(value: MemoryOperationSemantics, phase: 'projection' | 'route' | 'action'): MemoryOperationSemantics {
  const actions = semanticMembers(value.actions, ACTIONS, 'semantic actions')
  const targets = semanticMembers(value.targets, TARGETS, 'semantic targets')
  const representations = semanticMembers(value.representations, MEMORY_REPRESENTATIONS, 'representations')
  if (!Array.isArray(value.effects)) throw new Error('memory effects must be an explicit list (empty for pure reads)')
  const effects = value.effects.map(effect => {
    validateMemorySemanticMember(effect.target, TARGETS, 'effect target')
    validateMemorySemanticMember(effect.mode, ['write', 'delete', 'invalidate'], 'effect mode')
    if (effect.target === 'usage') validateMemorySemanticMember(effect.stage!, ['retrieved', 'injected', 'feedback'], 'usage stage')
    else if (effect.stage !== undefined) throw new Error('only usage effects have an accounting stage')
    if (!targets.includes(effect.target)) throw new Error('memory effect target is not declared by the operation')
    return effect
  })
  if (new Set(effects.map(effect => canonicalMemoryJson(effect))).size !== effects.length) throw new Error('duplicated memory effect')
  if (phase === 'projection' && (effects.length > 0 || !actions.includes('wake') || actions.some(action => !['wake', 'read', 'compress'].includes(action)))) {
    throw new Error('memory projection must wake without persistent effects')
  }
  if (phase === 'route' && (actions.some(action => !['read', 'compress'].includes(action)) || effects.some(effect => effect.target !== 'usage' || effect.stage !== 'retrieved'))) {
    throw new Error('memory Route may only read/compress and explicitly account for retrieval usage')
  }
  if (phase === 'action' && (!actions.some(action => ['record', 'compress', 'forget'].includes(action)) || !representations.includes('receipt'))) {
    throw new Error('memory Action must declare a mutation and receipt representation')
  }
  const overflow = validateMemorySemanticMember(value.overflow, ['truncate', 'omit', 'summarize', 'page', 'unavailable'], 'overflow policy')
  if (overflow === 'truncate' && !representations.includes('excerpt')) throw new Error('truncation requires an explicit excerpt representation')
  return jsonClone({ actions, targets, effects, representations, overflow,
    retry: validateMemorySemanticMember(value.retry, ['safe', 'unsafe', 'idempotency-key'], 'retry policy'),
    ...(value.budgets === undefined ? {} : { budgets: validateMemoryBudgetSupports(value.budgets) }),
  }, 'memory operation semantics')
}

export function requiredText(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const normalized = value.trim()
  if (normalized === '') throw new Error(`${label} is required`)
  if (normalized.length > maximum) throw new Error(`${label} is too long (max ${maximum} characters)`)
  return normalized
}

export function id(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 128)
  if (!ID.test(normalized)) throw new Error(`${label} must match [a-z][a-z0-9-]{0,127}`)
  return normalized
}

export function positiveInteger(value: unknown, label: string, maximum = 1_000_000): number {
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

export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

export function jsonClone<T>(value: T, label: string): T {
  canonicalMemoryJson(value, label)
  return deepFreeze(structuredClone(value))
}

export function uniqueIds(values: readonly string[], label: string): string[] {
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

export function validateProvenance(value: MemoryPackageProvenance, expectedPackage: string): MemoryPackageProvenance {
  const packageName = requiredText(value.packageName, 'memory package name', 214)
  if (!PACKAGE.test(packageName)) throw new Error(`invalid memory package name: ${packageName}`)
  if (packageName !== expectedPackage) throw new Error(`memory package provenance does not match manifest: ${packageName} != ${expectedPackage}`)
  const entryId = requiredText(value.entryId, 'memory Entry id', 300)
  const artifactDigest = value.artifactDigest === undefined ? undefined : requiredText(value.artifactDigest, 'memory artifact digest', 500)
  return deepFreeze({ packageName, entryId, ...(artifactDigest === undefined ? {} : { artifactDigest }) })
}

export function validateCapabilities(values: readonly string[], label: string): MemorySourceManifest['capabilities'] {
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
    ...(route.semantics === undefined ? {} : { semantics: validateSemantics(route.semantics, 'route') }),
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
    ...(action.semantics === undefined ? {} : { semantics: validateSemantics(action.semantics, 'action') }),
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
    ...(manifest.projection === undefined ? {} : { projection: validateSemantics(manifest.projection, 'projection') }),
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
