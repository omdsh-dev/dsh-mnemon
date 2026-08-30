import { createHash } from 'node:crypto'
import { setMaxListeners } from 'node:events'
import type {
  ComposableMemoryView,
  MemoryActionOffer,
  MemoryAvailableSource,
  MemoryCapability,
  MemoryCompositionDiagnostic,
  MemoryCompositionEvaluationReport,
  MemoryEvidence,
  MemoryEvidenceItem,
  MemoryJsonValue,
  MemoryMutationReceipt,
  MemoryOperationSelection,
  MemoryResultSemantics,
  MemoryReadGrant,
  MemorySourceFacts,
  MemorySourceManagementCatalog,
  MemorySourceManagementRequest,
  MemorySourceManagementResult,
  MemorySourceRuntime,
  MemoryViewBudget,
  MemoryViewContribution,
  MemoryViewFragment,
  MemoryViewRequest,
  MemoryViewRoute,
  MemoryViewSourceSpec,
  MemoryViewSpec,
} from "./contracts/index.ts"
import { DEFAULT_MEMORY_VIEW_BUDGET } from './contracts/index.ts'
import type { InstalledMemorySource, InstalledMemoryStrategy, MemoryContributionSnapshot } from './contributions.ts'
import { canonicalMemoryJson, deepFreeze, defineMemorySource, defineMemoryStrategy, id, jsonClone, positiveInteger, requiredText, uniqueIds, validateCapabilities, validateProvenance } from './definitions.ts'
import { readSource, SourceReadFailure } from './source-calls.ts'
import { boundedText, budgetLimit, normalizeUsage, operationCapabilities, outputCeilings, resolveSelection, validateResult, type ResolvedSelection } from './semantics.ts'

const INSTANCE_KEY = /^(?:source|strategy):[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,299}$/u

function instanceKey(value: unknown, kind: 'source' | 'strategy'): string {
  const normalized = requiredText(value, `${kind} instanceKey`, 300)
  if (!INSTANCE_KEY.test(normalized) || !normalized.startsWith(`${kind}:`)) {
    throw new Error(`${kind} instanceKey must start with ${kind}: and contain only stable identifier characters`)
  }
  return normalized
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalMemoryJson(value)).digest('hex')
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
  /** Host authorization ceiling; Strategies can only narrow it. Management remains separately authorized. */
  sourceCapabilities?: (source: InstalledMemorySource) => readonly MemoryCapability[]
  strategyInstanceKey?: string
  strategyTypeId?: string
  /** Host adapter supplies scope defaults; each result is captured and digested. */
  sourceConfiguration?: (source: InstalledMemorySource) => Readonly<Record<string, MemoryJsonValue>>
  /** Per-Source facts/project deadline. Does not turn timed-out writes into failed receipts. */
  sourceTimeoutMs?: number
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
    sourceInstanceKey: source.instanceKey,
    sourceTypeId: manifest.typeId,
    role: manifest.role,
    availability: facts.availability,
    revision: requiredText(facts.revision, `memory Source facts revision for ${source.instanceKey}`, 500),
    capabilities,
    routeIds,
    actionIds,
    ...(facts.hints === undefined ? {} : { hints: facts.hints }),
  }, `memory Source facts for ${source.instanceKey}`)
}

interface CompiledSourceSpec extends Omit<MemoryViewSourceSpec, 'projection' | 'routeOptions' | 'actionOptions'> {
  projection?: ResolvedSelection & { mode: 'eager' | 'routed'; maxCharacters: number }
  routeOptions: Record<string, ResolvedSelection>
  actionOptions: Record<string, ResolvedSelection>
}

interface CompiledViewSpec extends Omit<MemoryViewSpec, 'sources'> { sources: CompiledSourceSpec[] }

function normalizeViewSpec(value: MemoryViewSpec, strategy: InstalledMemoryStrategy, facts: ReadonlyMap<string, MemoryAvailableSource>, budget: MemoryViewBudget): CompiledViewSpec {
  if (value.strategyTypeId !== strategy.definition.manifest.typeId) throw new Error('memory ViewSpec strategyTypeId does not match the selected Strategy')
  const maxSources = Math.min(strategy.definition.manifest.maxSources, facts.size)
  if (!Array.isArray(value.sources) || value.sources.length > maxSources) throw new Error(`memory Strategy selected too many Sources (max ${maxSources})`)
  const seen = new Set<string>()
  let routes = 0
  let actions = 0
  const normalizedSources: CompiledSourceSpec[] = value.sources.flatMap(source => {
    const key = instanceKey(source.sourceInstanceKey, 'source')
    if (seen.has(key)) throw new Error(`memory Strategy selected Source twice: ${key}`)
    seen.add(key)
    const sourceFacts = facts.get(key)
    if (sourceFacts === undefined) throw new Error(`memory Strategy selected unavailable Source: ${key}`)
    if (!strategy.definition.manifest.supportedSourceRoles.includes(sourceFacts.role)) throw new Error(`memory Strategy selected an unsupported Source role: ${sourceFacts.role}`)
    if (source.required !== undefined && typeof source.required !== 'boolean') throw new Error(`memory Source requirement must be boolean: ${key}`)
    if (sourceFacts.availability === 'unavailable') {
      if (source.required === false) return []
      throw new Error(`memory Strategy selected unavailable required Source runtime: ${key}`)
    }
    const routeIds = uniqueIds(source.routeIds ?? [], `memory ViewSpec route id for ${key}`)
    const availableRoutes = new Set(sourceFacts.routeIds)
    for (const routeId of routeIds) if (!availableRoutes.has(routeId)) throw new Error(`memory Strategy selected unavailable route: ${key}/${routeId}`)
    const actionIds = uniqueIds(source.actionIds ?? [], `memory ViewSpec action id for ${key}`)
    const availableActions = new Set(sourceFacts.actionIds)
    for (const actionId of actionIds) if (!availableActions.has(actionId)) throw new Error(`memory Strategy selected unavailable action: ${key}/${actionId}`)
    routes += routeIds.length
    actions += actionIds.length
    if (source.projection !== undefined && !sourceFacts.capabilities.includes('project')) throw new Error(`memory Strategy selected unavailable projection: ${key}`)
    const maxCharacters = Math.min(positiveInteger(source.projection?.maxCharacters ?? budget.maxProjectionCharacters, `memory projection budget for ${key}`, 10_000_000), budget.maxProjectionCharacters)
    const resolved = source.projection === undefined ? undefined : resolveSelection(source.projection, sourceFacts.projection, outputCeilings(maxCharacters))
    const projection = resolved === undefined ? undefined : {
      ...resolved, mode: source.projection!.mode,
      maxCharacters: budgetLimit(resolved.budgets, 'output', 'characters', maxCharacters),
    }
    if (projection !== undefined && projection.mode !== 'eager' && projection.mode !== 'routed') throw new Error(`unsupported memory projection mode: ${String(projection.mode)}`)
    const options = (values: Record<string, MemoryOperationSelection> | undefined, ids: string[], kind: 'route' | 'action'): Record<string, ResolvedSelection> => {
      for (const option of Object.keys(values ?? {})) if (!ids.includes(option)) throw new Error(`memory Strategy supplied options for an unselected ${kind}: ${key}/${option}`)
      return Object.fromEntries(ids.map(id => {
        if (kind === 'action') return [id, resolveSelection(values?.[id], sourceFacts.actions.find(action => action.id === id)!.semantics, [])]
        const route = sourceFacts.routes.find(route => route.id === id)!
        return [id, resolveSelection(values?.[id], route.semantics, outputCeilings(
          Math.min(route.maxCharacters ?? budget.maxEvidenceCharacters, budget.maxEvidenceCharacters),
          Math.min(route.maxResults ?? budget.maxEvidenceResults, budget.maxEvidenceResults), route.maxCalls,
        ))]
      }))
    }
    return [deepFreeze({ sourceInstanceKey: key, required: source.required !== false, ...(projection === undefined ? {} : { projection }), routeIds, actionIds,
      routeOptions: options(source.routeOptions, routeIds, 'route'), actionOptions: options(source.actionOptions, actionIds, 'action'),
    })]
  })
  if (routes > Math.min(strategy.definition.manifest.maxRoutes, budget.maxRoutes)) throw new Error('memory Strategy selected too many Routes')
  if (actions > Math.min(strategy.definition.manifest.maxActions, budget.maxActions)) throw new Error('memory Strategy selected too many ActionOffers')
  return deepFreeze({ strategyTypeId: value.strategyTypeId, sources: normalizedSources, explanation: requiredText(value.explanation, 'memory ViewSpec explanation', 4_000) })
}

function bindExpansion(result: MemoryResultSemantics | undefined, key: string, routes: ReadonlyArray<{ id: string; inputSchema: MemoryJsonValue }>): MemoryResultSemantics | undefined {
  if (result?.expansion === undefined || 'unavailable' in result.expansion) return result
  const localId = result.expansion.routeId.startsWith(`${key}/`) ? result.expansion.routeId.slice(key.length + 1) : id(result.expansion.routeId, 'expansion Source-local route id')
  const route = routes.find(route => route.id === localId || route.id === `${key}/${localId}`)
  if (route === undefined) return { ...result, expansion: { unavailable: 'This View does not offer that expansion route.' } }
  assertInputSchema(route.inputSchema, result.expansion.input, 'memory expansion input')
  return { ...result, expansion: { routeId: `${key}/${localId}`, input: result.expansion.input } }
}

function normalizeContribution(source: RuntimeSource, spec: CompiledSourceSpec, facts: MemorySourceFacts, value: MemoryViewContribution): MemoryViewContribution {
  const fragments = value.fragments.map((fragment, index) => {
    if (fragment.sourceInstanceKey !== source.installed.instanceKey) throw new Error(`memory View fragment Source mismatch: ${fragment.sourceInstanceKey}`)
    if (spec.projection === undefined) throw new Error(`memory Source returned projection without a Strategy request: ${source.installed.instanceKey}`)
    if (fragment.mode !== spec.projection.mode) throw new Error(`memory View fragment mode mismatch: ${source.installed.instanceKey}`)
    const text = typeof fragment.text === 'string' ? fragment.text : ''
    if (text.length > spec.projection.maxCharacters) throw new Error(`memory View fragment exceeds Source projection budget: ${source.installed.instanceKey}`)
    const result = bindExpansion(validateResult(fragment.result, source.installed.definition.manifest.projection, spec.projection.representation), source.installed.instanceKey,
      (source.installed.definition.manifest.routes ?? []).filter(route => spec.routeIds?.includes(route.id)))
    return jsonClone({
      ...fragment,
      id: requiredText(fragment.id, `memory View fragment id ${index}`, 300),
      text,
      revision: requiredText(fragment.revision, 'memory View fragment revision', 500),
      ...(result === undefined ? {} : { result }),
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
  const usage = normalizeUsage(value.usage, spec.projection?.budgets ?? [], fragments.map(fragment => fragment.text))
  return deepFreeze({ fragments, ...(readGrant === undefined ? {} : { readGrant }), ...(usage.length === 0 ? {} : { usage }) })
}

function routeFor(source: RuntimeSource, routeId: string, grant: MemoryReadGrant, selection: ResolvedSelection): MemoryViewRoute {
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
    ...selection,
    ...(manifest.semantics === undefined ? {} : { semantics: manifest.semantics }),
    maxCalls: budgetLimit(selection.budgets, 'cost', 'calls', manifest.maxCalls),
    maxResults: budgetLimit(selection.budgets, 'output', 'items', Infinity),
    maxCharacters: budgetLimit(selection.budgets, 'output', 'characters', Infinity),
  })
}

function actionFor(source: RuntimeSource, actionId: string, selection: ResolvedSelection): MemoryActionOffer {
  const manifest = source.installed.definition.manifest.actions?.find(action => action.id === actionId)
  if (manifest === undefined) throw new Error(`memory Source Action manifest disappeared: ${source.installed.instanceKey}/${actionId}`)
  return deepFreeze({
    id: `${source.installed.instanceKey}/${actionId}`,
    sourceInstanceKey: source.installed.instanceKey,
    sourceActionId: actionId,
    description: manifest.description,
    capability: manifest.capability,
    inputSchema: manifest.inputSchema,
    ...selection,
    ...(manifest.semantics === undefined ? {} : { semantics: manifest.semantics }),
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
  const byteLimit = budgetLimit(route.budgets ?? [], 'output', 'bytes', Infinity)
  const items: MemoryEvidenceItem[] = []
  let characters = 0
  let bytes = 0
  let truncated = value.truncated
  let unavailable = value.unavailable
  for (const item of value.items) {
    if (typeof item.text !== 'string') throw new Error('memory Evidence item text must be a string')
    if (item.score !== undefined && !Number.isFinite(item.score)) throw new Error('memory Evidence score must be finite')
    let result = bindExpansion(validateResult(item.result, route.semantics, route.representation), route.sourceInstanceKey,
      view.routes.filter(candidate => candidate.sourceInstanceKey === route.sourceInstanceKey))
    if (item.score !== undefined && result !== undefined && result.score === undefined) {
      result = { ...result, score: { basis: route.sourceInstanceKey, meaning: 'Source-relative score; not calibrated confidence or a cross-Source ranking.' } }
    }
    let text = item.text
    const fits = items.length < resultLimit && characters + text.length <= characterLimit && bytes + Buffer.byteLength(text, 'utf8') <= byteLimit
    if (!fits) {
      truncated = true
      const policy = route.semantics?.overflow ?? 'unavailable'
      if (policy === 'omit') continue
      if (policy !== 'truncate' || (route.representation !== undefined && route.representation !== 'excerpt') || ['structured', 'catalog', 'receipt'].includes(result?.representation ?? '')) {
        unavailable = 'The requested representation is unavailable within this View budget; no semantic summary or complete result was fabricated.'
        items.length = 0
        break
      }
      if (items.length >= resultLimit) break
      text = boundedText(text, Math.max(0, characterLimit - characters), Math.max(0, byteLimit - bytes))
      if (text === '') break
      result = { ...result!, representation: 'excerpt', sourceRepresentation: result!.sourceRepresentation ?? result!.representation,
        coverage: 'partial', omitted: 'Mechanically clipped to the View output budget; not a semantic summary.' }
    }
    items.push(jsonClone({ ...item, id: requiredText(item.id, 'memory Evidence item id', 500), text,
      ...(result === undefined ? {} : { result }),
    }, 'memory Evidence item'))
    characters += text.length
    bytes += Buffer.byteLength(text, 'utf8')
  }
  const usage = normalizeUsage(value.usage, route.budgets ?? [], items.map(item => item.text), 1)
  return jsonClone({
    ...value,
    id: requiredText(value.id, 'memory Evidence id', 500),
    observedAt: typeof value.observedAt === 'string' && value.observedAt.trim() !== '' ? value.observedAt : now().toISOString(),
    items,
    truncated,
    ...(usage.length === 0 ? {} : { usage }),
    ...(unavailable === undefined ? {} : { unavailable: requiredText(unavailable, 'memory Evidence unavailable reason', 2_000) }),
  }, 'memory Evidence')
}

export class MemoryCompositionGeneration {
  readonly id: string
  readonly report: MemoryCompositionEvaluationReport
  readonly strategy: InstalledMemoryStrategy
  private readonly sources: ReadonlyMap<string, RuntimeSource>
  private readonly permissions = new Map<string, readonly MemoryCapability[]>()
  private readonly now: () => Date
  private readonly routeCalls = new Map<string, number>()
  private readonly sourceTimeoutMs: number
  private disposed = false

  constructor(snapshotValue: MemoryContributionSnapshot, options: CompileMemoryGenerationOptions = {}) {
    const snapshot = captureMemoryContributionSnapshot(snapshotValue)
    if (snapshot.sources.length === 0) throw new Error('memory composition requires at least one Source')
    if (snapshot.strategies.length === 0) throw new Error('memory composition requires a Strategy')
    this.strategy = selectStrategy(snapshot.strategies, options)
    this.now = options.now ?? (() => new Date())
    this.sourceTimeoutMs = positiveInteger(options.sourceTimeoutMs ?? 10_000, 'memory Source timeoutMs', 300_000)
    const configurations = new Map<string, Readonly<Record<string, MemoryJsonValue>>>()
    const created = new Map<string, RuntimeSource>()
    try {
      for (const installed of snapshot.sources) {
        const configuration = jsonClone(options.sourceConfiguration?.(installed) ?? {}, 'Source configuration')
        configurations.set(installed.instanceKey, configuration)
        const capabilities = options.sourceCapabilities?.(installed)
        if (capabilities !== undefined) this.permissions.set(installed.instanceKey, Object.freeze([...capabilities]))
        const runtime = installed.definition.create({
          sourceInstanceKey: installed.instanceKey,
          provenance: installed.provenance,
          configuration,
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
      sourceTimeoutMs: this.sourceTimeoutMs,
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
        configuration: configurations.get(source.instanceKey),
        permissions: this.permissions.get(source.instanceKey) ?? null,
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

  async compose(requestValue: MemoryViewRequest, signal?: AbortSignal): Promise<ComposableMemoryView> {
    signal?.throwIfAborted()
    const controller = new AbortController()
    // One owned cancellation signal may serve more than ten independent Sources.
    setMaxListeners(0, controller.signal)
    const abort = () => controller.abort(signal!.reason)
    signal?.addEventListener('abort', abort, { once: true })
    try { return await this.composeView(requestValue, controller.signal) }
    finally {
      controller.abort()
      signal?.removeEventListener('abort', abort)
    }
  }

  private async sourceFacts(source: RuntimeSource, request: MemoryViewRequest, diagnostics: MemoryCompositionDiagnostic[], signal?: AbortSignal): Promise<MemorySourceFacts> {
    let value: MemorySourceFacts
    try {
      value = await readSource(source.installed.instanceKey, 'facts', this.sourceTimeoutMs,
        abort => source.runtime.facts(request, abort), signal)
    } catch (error) {
      if (!(error instanceof SourceReadFailure)) throw error
      diagnostics.push(error.diagnostic)
      return {
        sourceInstanceKey: source.installed.instanceKey,
        sourceTypeId: source.installed.definition.manifest.typeId,
        role: source.installed.definition.manifest.role,
        availability: 'unavailable', revision: 'unavailable', capabilities: [], routeIds: [], actionIds: [],
      }
    }
    // Invalid protocol/authority claims remain fatal, not ordinary remote outages.
    return normalizeFacts(source.installed, value)
  }

  private async composeView(requestValue: MemoryViewRequest, signal: AbortSignal): Promise<ComposableMemoryView> {
    this.assertOpen()
    const request = jsonClone({ ...requestValue, scenario: requiredText(requestValue.scenario, 'memory View scenario', 300), budget: normalizeBudget(requestValue.budget) }, 'memory View request')
    const diagnostics: MemoryCompositionDiagnostic[] = []
    const entries = await Promise.all([...this.sources.values()].map(async source => {
      const value = structuredClone(await this.sourceFacts(source, request, diagnostics, signal))
      const permissions = this.permissions.get(source.installed.instanceKey)
      if (permissions !== undefined) {
        value.capabilities = value.capabilities.filter(capability => permissions.includes(capability))
        if (value.capabilities.length === 0) value.availability = 'unavailable'
      }
      const manifest = source.installed.definition.manifest
      const available = (operation: { capability: MemoryCapability; semantics?: MemoryAvailableSource['projection'] }) =>
        value.availability !== 'unavailable' && operationCapabilities(operation.capability, operation.semantics).every(capability => value.capabilities.includes(capability))
      const routes = (manifest.routes ?? []).filter(route => value.routeIds.includes(route.id) && available(route))
      const actions = (manifest.actions ?? []).filter(action => value.actionIds.includes(action.id) && available(action))
      const descriptor: MemoryAvailableSource = { ...value, routeIds: routes.map(route => route.id), actionIds: actions.map(action => action.id), routes, actions,
        ...(value.capabilities.includes('project') && manifest.projection !== undefined ? { projection: manifest.projection } : {}),
      }
      return [source.installed.instanceKey, descriptor] as const
    }))
    signal.throwIfAborted()
    const facts = new Map(entries)
    const factsList = deepFreeze([...facts.values()].map(value => jsonClone(value, 'memory Source facts')))
    const proposed = this.strategy.definition.compose(request, factsList)
    const replayed = this.strategy.definition.compose(request, factsList)
    if (canonicalMemoryJson(proposed, 'memory ViewSpec') !== canonicalMemoryJson(replayed, 'replayed memory ViewSpec')) {
      throw new Error(`memory Strategy is not deterministic: ${this.strategy.instanceKey}`)
    }
    let spec: CompiledViewSpec
    try { spec = normalizeViewSpec(proposed, this.strategy, facts, request.budget) }
    catch (error) {
      if (diagnostics.length === 0) throw error
      throw new Error(`${error instanceof Error ? error.message : 'Memory View rejected'}; ${diagnostics.map(item => item.message).sort().join('; ')}`)
    }
    const projection: MemoryViewFragment[] = []
    const grants: MemoryReadGrant[] = []
    const routes: MemoryViewRoute[] = []
    const actions: MemoryActionOffer[] = []
    const projectionUsage: Record<string, NonNullable<MemoryViewContribution['usage']>> = {}
    let projectionCharacters = 0
    const projected = await Promise.all(spec.sources.map(async sourceSpec => {
      const source = this.sources.get(sourceSpec.sourceInstanceKey)!
      const sourceFacts = facts.get(sourceSpec.sourceInstanceKey)!
      let value: MemoryViewContribution
      try {
        value = await readSource(source.installed.instanceKey, 'project', this.sourceTimeoutMs, abort => source.runtime.project({
          scope: request.scope,
          sourceInstanceKey: source.installed.instanceKey,
          expectedRevision: sourceFacts.revision,
          includeProjection: sourceSpec.projection !== undefined,
          mode: sourceSpec.projection?.mode ?? 'routed',
          maxCharacters: sourceSpec.projection?.maxCharacters ?? 1,
          ...(sourceSpec.projection === undefined ? {} : {
            budgets: sourceSpec.projection.budgets,
            ...(sourceSpec.projection.representation === undefined ? {} : { representation: sourceSpec.projection.representation }),
          }),
        }, abort), signal)
      } catch (error) {
        if (!(error instanceof SourceReadFailure) || sourceSpec.required !== false) throw error
        diagnostics.push(error.diagnostic)
        return null
      }
      return { source, sourceSpec, contribution: normalizeContribution(source, sourceSpec, sourceFacts, value) }
    }))
    signal.throwIfAborted()
    const successful = projected.filter(value => value !== null)
    for (const { source, sourceSpec, contribution } of successful) {
      if (contribution.usage !== undefined) projectionUsage[source.installed.instanceKey] = contribution.usage
      for (const fragment of contribution.fragments) {
        projectionCharacters += fragment.text.length
        if (projectionCharacters > request.budget.maxProjectionCharacters) throw new Error('memory View projection exceeds the root-turn budget')
        projection.push(fragment)
      }
      if (contribution.readGrant !== undefined) {
        if (grants.some(grant => grant.id === contribution.readGrant!.id)) throw new Error(`memory ReadGrant id is duplicated: ${contribution.readGrant.id}`)
        grants.push(contribution.readGrant)
        for (const routeId of sourceSpec.routeIds ?? []) routes.push(routeFor(source, routeId, contribution.readGrant, sourceSpec.routeOptions[routeId]!))
      }
      for (const actionId of sourceSpec.actionIds ?? []) actions.push(actionFor(source, actionId, sourceSpec.actionOptions[actionId]!))
    }
    const sourceRevisions = Object.fromEntries([...facts].map(([key, value]) => [key, value.revision]))
    const modes = new Set(successful.map(({ source }) => source.installed.definition.manifest.consistency))
    const consistency = { mode: modes.size === 1 ? [...modes][0]! : 'mixed' as const, sourceRevisions }
    const body = {
      runtimeGeneration: this.id,
      strategyInstanceKey: this.strategy.instanceKey,
      strategyTypeId: this.strategy.definition.manifest.typeId,
      scope: request.scope,
      projection,
      projectionUsage,
      routes,
      readGrants: grants,
      actionOffers: actions,
      consistency,
      explanation: spec.explanation,
      ...(diagnostics.length === 0 ? {} : { diagnostics: diagnostics.sort((a, b) =>
        (a.contributionInstanceKey ?? '').localeCompare(b.contributionInstanceKey ?? '') || a.code.localeCompare(b.code)) }),
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
    const diagnostics: MemoryCompositionDiagnostic[] = []
    const sources = await Promise.all([...this.sources.values()].map(async source => {
      const descriptor = source.installed.definition.manifest.management
      if (descriptor === undefined) return null
      const facts = await this.sourceFacts(source, request, diagnostics)
      return {
        sourceInstanceKey: source.installed.instanceKey,
        sourceTypeId: source.installed.definition.manifest.typeId,
        packageName: source.installed.definition.manifest.packageName,
        role: source.installed.definition.manifest.role,
        availability: facts.availability,
        revision: facts.revision,
        capabilities: facts.capabilities,
        management: descriptor,
        ...(facts.hints === undefined ? {} : { hints: facts.hints }),
      }
    }))
    return jsonClone({ generationId: this.id, sources: sources.filter(source => source !== null),
      ...(diagnostics.length === 0 ? {} : { diagnostics: diagnostics.sort((a, b) => (a.contributionInstanceKey ?? '').localeCompare(b.contributionInstanceKey ?? '')) }),
    }, 'memory Source management catalog')
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
    const diagnostics: MemoryCompositionDiagnostic[] = []
    const facts = await this.sourceFacts(source, jsonClone({
      scope: requestValue.scope,
      scenario: `management.${requestValue.mode}`,
      budget: DEFAULT_MEMORY_VIEW_BUDGET,
    }, 'memory Source management facts request'), diagnostics, requestValue.signal)
    if (facts.availability === 'unavailable') throw new Error(`memory Source is unavailable in the requested management scope: ${sourceInstanceKey}${diagnostics.length === 0 ? '' : '; ' + diagnostics[0]!.message}`)
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
    const executionBudget = normalizeBudget(budget)
    const maxCharacters = Math.min(route.maxCharacters ?? executionBudget.maxEvidenceCharacters, executionBudget.maxEvidenceCharacters)
    const maxResults = Math.min(route.maxResults ?? executionBudget.maxEvidenceResults, executionBudget.maxEvidenceResults)
    const boundedRoute = deepFreeze({ ...route, maxCharacters, maxResults,
      ...(route.budgets === undefined ? {} : { budgets: route.budgets.map(value => value.resource === 'output' && value.measurement === 'exact'
        ? { ...value, max: Math.min(value.max, value.unit === 'characters' ? maxCharacters : value.unit === 'items' ? maxResults : value.max) }
        : value) }),
    })
    signal?.throwIfAborted()
    const counter = `${view.id}\u0000${route.id}`
    const calls = this.routeCalls.get(counter) ?? 0
    if (calls >= route.maxCalls) throw new Error(`memory View Route call budget is exhausted: ${route.id}`)
    const source = this.sources.get(route.sourceInstanceKey)
    if (source?.runtime.query === undefined) throw new Error(`memory Source cannot execute Route: ${route.sourceInstanceKey}`)
    ledger.set(counter, calls + 1)
    // A dispatched failure still consumed a call and may have performed declared usage bookkeeping.
    return normalizeEvidence(await source.runtime.query({
      view: deepFreeze({ id: view.id, scope: view.scope }), route: boundedRoute, grant,
      input: jsonClone(input, 'memory Route input'), ...(signal === undefined ? {} : { signal }),
    }), view, boundedRoute, executionBudget, this.now)
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
    signal?.throwIfAborted()
    const grant = view.readGrants.find(candidate => candidate.sourceInstanceKey === offer.sourceInstanceKey)
    const receipt = await source.runtime.mutate({
      view: deepFreeze({ id: view.id, scope: view.scope }), offer,
      ...(grant === undefined ? {} : { grant }),
      input: jsonClone(input, 'memory Action input'), ...(signal === undefined ? {} : { signal }),
    })
    if (receipt.viewId !== view.id || receipt.offerId !== offer.id || receipt.sourceInstanceKey !== offer.sourceInstanceKey) {
      throw new Error('memory mutation Receipt is not bound to the requested ActionOffer')
    }
    if (!['succeeded', 'partial', 'failed', 'cancelled'].includes(receipt.status)) throw new Error('memory mutation Receipt has an invalid status')
    if (!['accepted', 'candidate', 'committed', 'partial', 'failed', 'unknown'].includes(receipt.completion)) throw new Error('memory mutation Receipt has an invalid completion')
    if (receipt.completion === 'committed') {
      if (receipt.status !== 'succeeded' || typeof receipt.committedAt !== 'string' || !Number.isFinite(Date.parse(receipt.committedAt))) throw new Error('committed memory Receipt requires successful status and an explicit commit timestamp')
    } else if (receipt.committedAt !== undefined) throw new Error('uncommitted memory Receipt cannot claim a commit timestamp')
    if (receipt.completion === 'failed' && receipt.status === 'succeeded') throw new Error('failed memory completion cannot have successful status')
    const usage = normalizeUsage(receipt.usage, offer.budgets ?? [], [])
    return jsonClone({
      ...receipt,
      id: requiredText(receipt.id, 'memory mutation Receipt id', 500),
      ...(usage.length === 0 ? {} : { usage }),
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
