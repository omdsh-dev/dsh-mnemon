import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonValue } from './contracts.ts'
import type { ResolvedConfig } from './config.ts'
import {
  MemoryBodyRegistry,
  type CreateMemoryBodyRequest,
  type MemoryBody,
  type UpdateMemoryBodyRequest,
} from './memory-bodies.ts'
import type { MnemonRunner } from './runner.ts'
import type { AuthorityCommitRecorder } from './memory-receipts.ts'
import { finalizeLlmPlacement, prepareMemoryPlacement, rulesOnlyPlacement, type LlmMemoryPlacementSelection, type PreparedMemoryPlacement } from './provider-placement.ts'
import { BUILTIN_MEMORY_PROVIDER_CATALOG, MemoryProviderCatalog } from './providers/catalog.ts'
import { type MemoryProviderAdapter, type ProviderBodyStatus, type ProviderSearchResult } from './providers/provider.ts'
import { memoryProviderAdapterFactories, type MemoryProviderAdapterRegistry } from './providers/registry.ts'
import { lexicalRequiredMatchCount, lexicalSearchTokens, lexicalTokenMatchCount } from './search-tokens.ts'
import {
  applyRecallQualityPolicy,
  prepareRecallQualityPolicy,
  recallQualityPolicies,
  type EvaluatedRecallQualityCandidate,
  type RecallQualityCandidate,
  type RecallQualityPolicy,
  type RecallQualityPolicyContext,
  type RecallQualityPolicyRegistry,
} from './recall-quality/index.ts'
import {
  CATEGORIES,
  EDGE_TYPES,
  INTENTS,
  SOURCES,
  type Category,
  type EdgeType,
  type EntityView,
  type Insight,
  type Intent,
  type MemoryBodyCatalog,
  type MemoryBodyStats,
  type MemoryBodyMetadataUpdate,
  type MemoryBodyView,
  type MemoryGraphEdge,
  type MemoryGraphNode,
  type MemoryGraphSnapshot,
  type MemoryListRequest,
  type MemoryListView,
  type MnemonEmbeddingStatus,
  type MemoryPlacementDecision,
  type MemoryProviderDescriptor,
  type MemoryReadMode,
  type MemoryReadSource,
  type MemoryReadStatus,
  type RememberRequest,
  type RecallQualityStats,
  type SearchRequest,
  type Source,
  type StatusView,
} from './shared/contracts.ts'

export { CATEGORIES, EDGE_TYPES, INTENTS, SOURCES } from './shared/contracts.ts'
export type {
  Category,
  EdgeType,
  EntityView,
  Insight,
  Intent,
  MemoryBodyCatalog,
  MemoryBodyStats,
  MemoryBodyView,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphSnapshot,
  MemoryListRequest,
  MemoryListView,
  MnemonEmbeddingStatus,
  MemoryReadSource,
  RecallQualityStats,
  RememberRequest,
  SearchRequest,
  Source,
  StatusView,
} from './shared/contracts.ts'

export interface MemoryBodyMetadataSample {
  memoryBodyId: string
  name: string
  description: string
  providerId: MemoryBody['provider']['id']
  providerLabel: string
  method: 'native-basic' | 'browse' | 'search'
  evidence: Array<Pick<Insight, 'content' | 'category' | 'entities'>>
}

interface PreparedRemember {
  body: MemoryBody
  request: RememberRequest
}

/**
 * Providers whose native search is a single bounded request while their browse
 * projection fans out to multiple resources or collections. Prefer search for
 * metadata sampling so AI maintenance never pays for a detailed projection.
 */
const METADATA_SEARCH_FIRST_PROVIDERS = new Set<MemoryBody['provider']['id']>([
  'openviking',
  'supermemory',
  'byterover',
])

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function number(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringArray(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function readSource(
  body: MemoryBody,
  mode: MemoryReadMode,
  status: MemoryReadStatus,
  itemCount: number,
  options: { edgeCount?: number; hint?: string } = {},
): MemoryReadSource {
  return {
    memoryBodyId: body.id,
    memoryBodyName: body.name,
    providerId: body.provider.id,
    providerLabel: body.provider.label,
    mode,
    status,
    itemCount,
    ...options,
  }
}

const MAX_EXACT_SEARCH_ANCHORS = 8
const EXACT_SEARCH_ANCHOR = /(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)|(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+(?![A-Za-z0-9])|(?<!\d)\d+(?:[.,]\d+)?\s*(?:[%％]|percent(?:age)?)(?![A-Za-z])|百分之\s*\d+(?:[.,]\d+)?|(?<!\d)\d{1,2}:\d{2}(?!\d)|(?<![A-Za-z0-9])v?\d+\.\d+(?:\.\d+)*(?![A-Za-z0-9])|(?<![\d.])\d+(?![\d.%％:-])/giu

interface NativeSearchRecoveryPlan {
  kind: 'exact' | 'lexical'
  terms: string[]
  query: string
  requiredMatches: number
}

function normalizedExactText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/百分之\s*(\d+(?:[.,]\d+)?)/gu, '$1%')
    .replace(/(\d+(?:[.,]\d+)?)\s*percent(?:age)?/giu, '$1%')
    .replace(/\s+/gu, '')
}

/**
 * Extract only high-information lexical values that a semantic paraphrase
 * should not be allowed to erase. This is a deterministic fallback inside an
 * already-authorized search, not another Recall trigger or model decision.
 */
function exactSearchAnchorPlan(query: string): NativeSearchRecoveryPlan | undefined {
  const anchors = [...new Set([...query.matchAll(EXACT_SEARCH_ANCHOR)].map(match => normalizedExactText(match[0])))]
    .slice(0, MAX_EXACT_SEARCH_ANCHORS)
  if (anchors.length < 2) return undefined
  return {
    kind: 'exact',
    terms: anchors,
    query: anchors.join(' '),
    requiredMatches: Math.min(4, anchors.length),
  }
}

function lexicalSearchRecoveryPlan(query: string): NativeSearchRecoveryPlan | undefined {
  const tokens = lexicalSearchTokens(query, 32)
  if (tokens.length < 4) return undefined
  return {
    kind: 'lexical',
    terms: tokens,
    query,
    requiredMatches: lexicalRequiredMatchCount(tokens),
  }
}

function recoveryMatchCount(content: string, plan: NativeSearchRecoveryPlan): number {
  if (plan.kind === 'lexical') return lexicalTokenMatchCount(content, plan.terms)
  const normalized = normalizedExactText(content)
  return plan.terms.filter(anchor => normalized.includes(anchor)).length
}

function mergeRecoveryResults(
  original: readonly Insight[],
  recovered: readonly Insight[],
  plan: NativeSearchRecoveryPlan,
  limit: number,
): Insight[] {
  const admitted = recovered
    .map(insight => ({ insight, matches: recoveryMatchCount(insight.content, plan) }))
    .filter(candidate => candidate.matches >= plan.requiredMatches)
    .sort((left, right) => right.matches - left.matches || (right.insight.score ?? 0) - (left.insight.score ?? 0))
    .map(candidate => candidate.insight)
  const seen = new Set<string>()
  return [...admitted, ...original].filter(insight => {
    if (seen.has(insight.id)) return false
    seen.add(insight.id)
    return true
  }).slice(0, limit)
}

/** Put query-covering evidence first before the smaller model envelope runs. */
function prioritizeRecoveryEvidence(
  selected: readonly EvaluatedRecallQualityCandidate[],
  plan: NativeSearchRecoveryPlan,
): EvaluatedRecallQualityCandidate[] {
  return selected
    .map((entry, index) => ({ entry, index, matches: recoveryMatchCount(entry.candidate.insight.content, plan) }))
    .sort((left, right) => {
      const leftAdmitted = left.matches >= plan.requiredMatches
      const rightAdmitted = right.matches >= plan.requiredMatches
      if (leftAdmitted !== rightAdmitted) return rightAdmitted ? 1 : -1
      if (leftAdmitted && left.matches !== right.matches) return right.matches - left.matches
      return left.index - right.index
    })
    .map(candidate => candidate.entry)
}

function insightColor(category: string | undefined): string {
  if (category === 'preference') return '#9b59b6'
  if (category === 'decision') return '#e74c3c'
  if (category === 'fact') return '#3498db'
  if (category === 'insight') return '#2ecc71'
  if (category === 'context') return '#f39c12'
  return '#6574d9'
}

export { parseMemoryGraph } from '../plugins/dsh-mnemon-provider-mnemon-native/src/driver.ts'

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`value must be an integer within ${min}..${max}`)
  return value
}

function required(value: string, label: string, max: number): string {
  const normalized = value.trim()
  if (normalized === '') throw new Error(`${label} is required`)
  if (normalized.length > max) throw new Error(`${label} is too long (max ${max} characters)`)
  return normalized
}

function allowed<T extends string>(value: T | undefined, values: readonly T[], label: string): T | undefined {
  if (value !== undefined && !values.includes(value)) {
    throw new Error(`${label} must be one of: ${values.join(', ')}`)
  }
  return value
}

function commaList(values: string[] | undefined, label: string, limit: number): string | undefined {
  if (values === undefined) return undefined
  const normalized = values.map(value => value.trim()).filter(value => value !== '')
  if (normalized.length > limit) throw new Error(`${label} accepts at most ${limit} values`)
  if (normalized.some(value => value.includes(','))) throw new Error(`${label} values cannot contain commas`)
  return normalized.length === 0 ? undefined : normalized.join(',')
}

const COMMITTED_MUTATION_STATES = new Set([
  'added',
  'committed',
  'completed',
  'created',
  'deleted',
  'forgotten',
  'imported',
  'invalidated',
  'linked',
  'merged',
  'removed',
  'replaced',
  'stored',
  'succeeded',
  'success',
  'updated',
])
const UNCOMMITTED_MUTATION_STATES = new Set([
  'accepted',
  'canceled',
  'cancelled',
  'error',
  'failed',
  'pending',
  'processing',
  'queued',
  'running',
  'skipped',
])
const COMMITTED_MUTATION_COUNTS = ['created', 'deleted', 'edges_inserted', 'imported', 'removed', 'stored', 'updated'] as const

/** A provider mutation is authoritative only after it reports an explicit durable terminal state. */
export function mutationResultCommitted(result: unknown): boolean {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return false
  const value = result as Record<string, unknown>
  const states = [value.action, value.status]
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim().toLocaleLowerCase())
  if (value.success === false || value.ok === false || value.committed === false || value.durable === false) return false
  if (states.some(state => UNCOMMITTED_MUTATION_STATES.has(state))) return false
  if (value.success === true || value.ok === true || value.committed === true || value.durable === true) return true
  if (states.some(state => COMMITTED_MUTATION_STATES.has(state))) return true
  return COMMITTED_MUTATION_COUNTS.some(key => typeof value[key] === 'number' && value[key] > 0)
}

export class MnemonService {
  readonly memoryBodies: MemoryBodyRegistry
  private readonly providers: Map<MemoryBody['provider']['id'], MemoryProviderAdapter>
  private readonly recallQualityPolicy: RecallQualityPolicy
  private bodiesInFlight: Promise<MemoryBodyCatalog> | undefined
  private providersDisposed = false

  private providerTypeId(providerId: string): string {
    // Preserve prototype-based test doubles and subclasses compiled against
    // the pre-catalog constructor while keeping real runtimes explicit.
    const descriptor = (this.providerCatalog ?? BUILTIN_MEMORY_PROVIDER_CATALOG).descriptor(providerId)
    return descriptor.typeId ?? descriptor.id
  }

  private isNativeProvider(providerId: string): boolean {
    return this.providerTypeId(providerId) === 'mnemon-native'
  }

  private isNativeBody(body: MemoryBody): boolean {
    return (body.provider.typeId ?? body.provider.id) === 'mnemon-native'
  }

  constructor(
    readonly runner: MnemonRunner,
    readonly config: ResolvedConfig,
    memoryBodies?: MemoryBodyRegistry,
    private readonly recallQualityPolicyRegistry: RecallQualityPolicyRegistry = recallQualityPolicies,
    providerAdapterRegistry: MemoryProviderAdapterRegistry = memoryProviderAdapterFactories,
    private readonly recordCommit?: AuthorityCommitRecorder,
    private readonly providerCatalog: MemoryProviderCatalog = BUILTIN_MEMORY_PROVIDER_CATALOG,
  ) {
    this.memoryBodies = memoryBodies === undefined
      ? new MemoryBodyRegistry(runner, true, () => new Date(), providerCatalog)
      : providerCatalog === BUILTIN_MEMORY_PROVIDER_CATALOG ? memoryBodies : memoryBodies.withProviderCatalog(providerCatalog)
    this.recallQualityPolicy = recallQualityPolicyRegistry.resolve(config.recallQuality.policy)
    this.providers = providerAdapterRegistry.create({ memoryBodies: this.memoryBodies, config: this.config, nativeRunner: this.runner })
  }

  /**
   * Create a generation-owned data plane over the same Memory Space authority.
   * The Provider registry is supplied by the Memory Spaces parent Fiber and is
   * never published as a Cordis Context service.
   */
  withProviderAdapterRegistry(providerAdapterRegistry: MemoryProviderAdapterRegistry, descriptors?: readonly MemoryProviderDescriptor[]): MnemonService {
    const providerCatalog = descriptors === undefined
      ? this.providerCatalog
      // A Source-private Provider snapshot is the complete explicit child
      // composition for that generation. Never inherit Providers merely
      // because the compatibility Host service happens to know them.
      : new MemoryProviderCatalog(descriptors)
    return new MnemonService(
      this.runner,
      this.config,
      this.memoryBodies,
      this.recallQualityPolicyRegistry,
      providerAdapterRegistry,
      this.recordCommit,
      providerCatalog,
    )
  }

  /** Release clients owned by one composable Memory Spaces generation. */
  async dispose(): Promise<void> {
    if (this.providersDisposed) return
    this.providersDisposed = true
    const failures: unknown[] = []
    for (const provider of [...this.providers.values()].reverse()) {
      try {
        await provider.dispose?.()
      } catch (error) {
        failures.push(error)
      }
    }
    this.providers.clear()
    if (failures.length > 0) throw new AggregateError(failures, 'Memory Space Provider disposal failed')
  }

  async bodies(signal?: AbortSignal): Promise<MemoryBodyCatalog> {
    if (signal !== undefined) return this.collectBodies(signal)
    if (this.bodiesInFlight !== undefined) return this.bodiesInFlight
    const pending = this.collectBodies()
    this.bodiesInFlight = pending
    try {
      return await pending
    } finally {
      if (this.bodiesInFlight === pending) this.bodiesInFlight = undefined
    }
  }

  /** Coalesce simultaneous Status/Memory-page probes without caching mutations. */
  private async collectBodies(signal?: AbortSignal): Promise<MemoryBodyCatalog> {
    const directory = this.bodyDirectory()
    const items: MemoryBodyView[] = await Promise.all(directory.items.map(async body => {
      let status: ProviderBodyStatus
      const providerEnabled = body.providerEnabled !== false
      if (!providerEnabled) status = { healthy: false, error: `${body.provider.label} is disabled in Settings` }
      else try { status = await this.providerFor(body).status(body, signal) } catch (error) {
          status = { healthy: false, error: error instanceof Error ? error.message : String(error) }
      }
      const { statusLoading: _statusLoading, ...metadata } = body
      return { ...metadata, ...status }
    }))
    return {
      ...directory,
      items,
      activeCount: items.filter(body => body.active && body.providerEnabled !== false).length,
      generatedAt: new Date().toISOString(),
    }
  }

  /** Return the control-plane directory without waiting for provider I/O. */
  bodyDirectory(): MemoryBodyCatalog {
    const mnemonDefaultStore = this.runner.persistedStore()
    const items: MemoryBodyView[] = this.memoryBodies.list().map(body => {
      const nativeProvider = this.isNativeBody(body)
      const providerEnabled = nativeProvider || this.memoryBodies.providerServiceEnabled(body.provider.id)
      return { ...body, providerEnabled, mnemonDefault: nativeProvider && body.id === mnemonDefaultStore, healthy: false, statusLoading: true }
    })
    return {
      items,
      providers: this.providerCatalog.providers.map(provider => ({
        ...provider,
        serviceConfigured: (provider.typeId ?? provider.id) === 'mnemon-native' || this.memoryBodies.providerServiceEnabled(provider.id),
      })),
      persistenceStrategy: {
        mode: this.config.persistenceStrategy.mode,
        providerId: this.config.persistenceStrategy.providerId,
        prompt: this.config.persistenceStrategy.prompt,
        rules: { ...this.config.persistenceStrategy.rules },
      },
      total: items.length,
      activeCount: items.filter(body => body.active && body.providerEnabled !== false).length,
      directory: this.memoryBodies.directory,
      generatedAt: new Date().toISOString(),
    }
  }

  /** Stable, secret-free checkpoint for the projected Memory Space authority. */
  memoryRevision(): string {
    const bodies = this.memoryBodies.list()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(body => ({
        id: body.id,
        name: body.name,
        description: body.description,
        active: body.active,
        providerId: body.provider.id,
        updatedAt: body.updatedAt,
        capabilities: body.provider.capabilities,
      }))
    const services = this.memoryBodies.providerServices().items
      .map(service => ({ providerId: service.providerId, enabled: service.enabled, configured: service.configured }))
      .sort((left, right) => left.providerId.localeCompare(right.providerId))
    return createHash('sha256').update(JSON.stringify({ bodies, services })).digest('hex')
  }

  /** Return a usable system snapshot without waiting for any Provider I/O. */
  statusSummary(): StatusView {
    const catalog = this.bodyDirectory()
    const active = catalog.items.filter(body => body.active && body.providerEnabled !== false)
    const dshActiveStores = active.map(body => body.id)
    const providerServices = this.memoryBodies.providerServices().items.map(service => {
      const descriptor = this.providerCatalog.descriptor(service.providerId)
      const bodies = catalog.items.filter(body => body.provider.id === service.providerId)
      const activeBodies = bodies.filter(body => body.active && body.providerEnabled !== false)
      return {
        providerId: service.providerId,
        label: descriptor.label,
        ...(descriptor.icon === undefined ? {} : { icon: descriptor.icon }),
        enabled: service.enabled,
        configured: service.configured,
        status: !service.enabled ? 'disabled' as const : 'idle' as const,
        memoryBodyCount: bodies.length,
        activeMemoryBodyCount: activeBodies.length,
      }
    })
    return {
      // Provider availability is projected below and must never make the
      // dsh-mnemon engine itself appear disconnected.
      healthy: true,
      cliPath: this.runner.command,
      commandFound: this.runner.commandFound,
      dataDir: this.runner.effectiveDataDir(),
      store: dshActiveStores.join(', ') || 'none',
      mnemonDefaultStore: this.runner.persistedStore(),
      dshActiveStores,
      writeEnabled: this.config.writeEnabled,
      timeoutMs: this.config.timeoutMs,
      defaultRecallLimit: this.config.defaultRecallLimit,
      recallQuality: this.config.recallQuality,
      memoryBodyDirectory: catalog.directory,
      memoryBodies: catalog.items,
      providerServices,
    }
  }

  /** Probe the effective Mnemon embedding runtime and its default Store coverage. */
  async embeddingStatus(signal?: AbortSignal): Promise<MnemonEmbeddingStatus> {
    const output = record(await this.runner.runJson(
      ['embed', '--status'],
      signal === undefined ? {} : { signal },
    ))
    // Mnemon ≥ 0.3.x reports `embedding_available`; `ollama_available` is the
    // legacy alias kept for older binaries.
    const available = output?.embedding_available ?? output?.ollama_available
    const model = text(output?.model)?.trim()
    // Mnemon ≥ 0.3.x may report the endpoint protocol it resolved; older binaries
    // omit the field, so a missing or malformed value is dropped instead of
    // failing the whole status probe.
    const protocol = text(output?.protocol)?.trim()
    const totalInsights = number(output?.total_insights)
    const embedded = number(output?.embedded)
    const coverage = text(output?.coverage)?.trim()
    if (typeof available !== 'boolean'
      || model === undefined || model === '' || model.length > 200 || /[\u0000-\u001f\u007f]/u.test(model)
      || !Number.isInteger(totalInsights) || totalInsights! < 0
      || !Number.isInteger(embedded) || embedded! < 0 || embedded! > totalInsights!
      || coverage === undefined || !/^(?:100|\d{1,2})%$/u.test(coverage)) {
      throw new Error('mnemon embed --status returned an invalid response')
    }
    const validProtocol = protocol !== undefined && protocol.length <= 32 && !/[\u0000-\u001f\u007f]/u.test(protocol)
    return { available, model, totalInsights: totalInsights!, embedded: embedded!, coverage, ...(validProtocol ? { protocol } : {}) }
  }

  async status(signal?: AbortSignal): Promise<StatusView> {
    const hasNativeBody = this.memoryBodies.list().some(body => this.isNativeBody(body))
    let versionError: unknown
    const [catalog, rawVersion] = await Promise.all([
      this.bodies(signal),
      hasNativeBody
        ? this.runner.runText(['--version'], signal === undefined ? { globalFlags: false } : { signal, globalFlags: false }).catch(error => {
            versionError = error
            return undefined
          })
        : Promise.resolve(undefined),
    ])
    const active = catalog.items.filter(body => body.active && body.providerEnabled !== false)
    const dshActiveStores = active.map(body => body.id)
    const providerServices = this.memoryBodies.providerServices().items.map(service => {
      const descriptor = this.providerCatalog.descriptor(service.providerId)
      const bodies = catalog.items.filter(body => body.provider.id === service.providerId)
      const activeBodies = bodies.filter(body => body.active && body.providerEnabled !== false)
      const failed = activeBodies.filter(body => !body.healthy)
      const status = !service.enabled
        ? 'disabled' as const
        : activeBodies.length === 0
          ? 'idle' as const
          : failed.length === 0
            ? 'healthy' as const
            : 'unhealthy' as const
      return {
        providerId: service.providerId,
        label: descriptor.label,
        ...(descriptor.icon === undefined ? {} : { icon: descriptor.icon }),
        enabled: service.enabled,
        configured: service.configured,
        status,
        memoryBodyCount: bodies.length,
        activeMemoryBodyCount: activeBodies.length,
        ...(failed.length === 0 ? {} : { error: failed.map(body => `${body.name}: ${body.error ?? 'unavailable'}`).join('; ') }),
      }
    })
    const base = {
      cliPath: this.runner.command,
      commandFound: this.runner.commandFound,
      dataDir: this.runner.effectiveDataDir(),
      store: dshActiveStores.join(', ') || 'none',
      mnemonDefaultStore: this.runner.persistedStore(),
      dshActiveStores,
      writeEnabled: this.config.writeEnabled,
      timeoutMs: this.config.timeoutMs,
      defaultRecallLimit: this.config.defaultRecallLimit,
      recallQuality: this.config.recallQuality,
      memoryBodyDirectory: catalog.directory,
      memoryBodies: catalog.items,
      providerServices,
    }
    try {
      if (versionError !== undefined) throw versionError
      const healthyBodies = active.filter(body => body.healthy && body.stats !== undefined)
      const topEntities = new Map<string, number>()
      const byCategory: Record<string, number> = {}
      for (const body of healthyBodies) {
        for (const [category, count] of Object.entries(body.stats!.byCategory)) byCategory[category] = (byCategory[category] ?? 0) + count
        for (const entity of body.stats!.topEntities) topEntities.set(entity.entity, (topEntities.get(entity.entity) ?? 0) + entity.count)
      }
      const stats: StatusView['stats'] = {
        totalInsights: healthyBodies.reduce((total, body) => total + body.stats!.totalInsights, 0),
        deletedInsights: healthyBodies.reduce((total, body) => total + body.stats!.deletedInsights, 0),
        edgeCount: healthyBodies.reduce((total, body) => total + body.stats!.edgeCount, 0),
        oplogCount: healthyBodies.reduce((total, body) => total + body.stats!.oplogCount, 0),
        dbSizeBytes: healthyBodies.reduce((total, body) => total + body.stats!.dbSizeBytes, 0),
        byCategory,
        topEntities: [...topEntities].map(([entity, count]) => ({ entity, count })).sort((left, right) => right.count - left.count),
        ...(active.length === 1 ? { dbPath: active[0]!.dbPath } : {}),
      }
      const failed = active.filter(body => !body.healthy)
      return {
        healthy: true,
        ...base,
        ...(rawVersion === undefined ? {} : { version: rawVersion.trim().replace(/^mnemon version\s+/i, '') }),
        stats,
        ...(failed.length === 0 ? {} : { error: failed.map(body => `${body.name}: ${body.error ?? 'unavailable'}`).join('; ') }),
      }
    } catch (error) {
      return { healthy: true, ...base, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async reconnectBody(id: string, signal?: AbortSignal): Promise<MemoryBodyView> {
    const body = this.memoryBodies.list().find(candidate => candidate.id === id)
    if (body === undefined) throw new Error(`unknown memory body: ${id}`)
    if (!this.isNativeBody(body)) {
      if (!this.memoryBodies.providerServiceEnabled(body.provider.id)) throw new Error(`${body.provider.label} is disabled in Settings`)
    }
    // Card-level reconnect is deliberately scoped to this projected namespace.
    // Whole-service discovery only runs when its service is enabled or saved.
    const provider = this.providerFor(body)
    provider.invalidateStatus?.(body.id)
    const status = await provider.status(body, signal)
    return {
      ...body,
      providerEnabled: true,
      mnemonDefault: this.isNativeBody(body) && body.id === this.runner.persistedStore(),
      ...status,
    }
  }

  async search(request: SearchRequest, signal?: AbortSignal): Promise<{ query: string; mode: string; results: Insight[]; hint?: string; sources: MemoryReadSource[] }> {
    const query = required(request.query, 'query', 2000)
    const limit = boundedInteger(request.limit, this.config.defaultRecallLimit, 1, 50)
    const qualityContext: RecallQualityPolicyContext = { requestedLimit: limit, config: this.config.recallQuality }
    const preparedPolicy = prepareRecallQualityPolicy(this.recallQualityPolicy, qualityContext)
    const mode = allowed(request.mode, ['smart', 'keyword', 'basic'] as const, 'mode') ?? 'smart'
    const category = allowed(request.category, CATEGORIES, 'category')
    const source = allowed(request.source, SOURCES, 'source')
    const intent = allowed(request.intent, INTENTS, 'intent')
    const bodies = this.readBodies(request.memoryBodyIds)
    const normalizedRequest: SearchRequest = {
      query,
      mode,
      limit: preparedPolicy.candidateLimit,
      ...(category === undefined ? {} : { category }),
      ...(source === undefined ? {} : { source }),
      ...(intent === undefined ? {} : { intent }),
    }
    let batches = await Promise.all(bodies.map(async body => {
      if (!body.provider.capabilities.search) {
        return {
          body,
          result: { results: [], hint: 'search is not supported' } satisfies ProviderSearchResult,
          source: readSource(body, 'unsupported', 'unsupported', 0, { hint: 'This provider does not expose search.' }),
        }
      }
      try {
        const result = await this.providerFor(body).search(body, normalizedRequest, signal)
        return {
          body,
          result,
          source: readSource(body, 'search', result.results.length === 0 ? 'empty' : 'ready', result.results.length, result.hint === undefined ? {} : { hint: result.hint }),
        }
      } catch (error) {
        const hint = error instanceof Error ? error.message : String(error)
        return {
          body,
          result: { results: [], hint: `unavailable: ${hint}` } satisfies ProviderSearchResult,
          source: readSource(body, 'search', 'unavailable', 0, { hint }),
        }
      }
    }))
    const recoveryPlan = mode === 'smart' && category === undefined && source === undefined && intent === undefined
      ? exactSearchAnchorPlan(query) ?? lexicalSearchRecoveryPlan(query)
      : undefined
    const evaluate = (selectedBatches: typeof batches) => {
      const candidates: RecallQualityCandidate[] = []
      const hints: string[] = []
      for (const [bodyOrder, { body, result }] of selectedBatches.entries()) {
        const scoreSemantics = this.providerFor(body).scoreSemantics
        candidates.push(...result.results.map((entry, index) => ({
          insight: this.annotate(entry, body),
          memoryBodyId: body.id,
          providerId: body.provider.id,
          providerRank: index + 1,
          bodyOrder,
          ...(scoreSemantics === undefined ? {} : { scoreSemantics }),
        })))
        if (result.hint !== undefined) hints.push(`${body.name}: ${result.hint}`)
      }
      const heterogeneous = new Set(bodies.map(body => body.provider.id)).size > 1
      if (heterogeneous) for (const candidate of candidates) candidate.insight.federatedScore = 1 / (60 + candidate.providerRank)
      candidates.sort((left, right) => heterogeneous
        ? (right.insight.federatedScore ?? 0) - (left.insight.federatedScore ?? 0) || left.bodyOrder - right.bodyOrder
        : (right.insight.score ?? 0) - (left.insight.score ?? 0))
      return { hints, quality: applyRecallQualityPolicy(preparedPolicy, candidates, qualityContext) }
    }
    let evaluation = evaluate(batches)
    const hasRecoveryEvidence = recoveryPlan !== undefined && evaluation.quality.selected.some(candidate => (
      recoveryMatchCount(candidate.candidate.insight.content, recoveryPlan) >= recoveryPlan.requiredMatches
    ))
    if (recoveryPlan !== undefined && !hasRecoveryEvidence) {
      batches = await Promise.all(batches.map(async batch => {
        if (!this.isNativeBody(batch.body) || batch.source.status === 'unsupported' || batch.source.status === 'unavailable') return batch
        try {
          const provider = this.providerFor(batch.body)
          const recovered = await provider.search(batch.body, {
            query: recoveryPlan.query,
            mode: 'keyword',
            limit: Math.min(limit, preparedPolicy.candidateLimit),
          }, signal)
          const admitted = recovered.results.some(insight => recoveryMatchCount(insight.content, recoveryPlan) >= recoveryPlan.requiredMatches)
          const results = mergeRecoveryResults(batch.result.results, recovered.results, recoveryPlan, preparedPolicy.candidateLimit)
          return {
            ...batch,
            result: {
              results,
              ...(admitted || batch.result.hint === undefined ? {} : { hint: batch.result.hint }),
            },
          }
        } catch {
          // Deterministic Native recovery is an optional local fallback. The original
          // successful result remains authoritative if it is unavailable.
          return batch
        }
      }))
      evaluation = evaluate(batches)
    }
    const { hints, quality } = evaluation
    const selected = recoveryPlan === undefined
      ? quality.selected
      : prioritizeRecoveryEvidence(quality.selected, recoveryPlan)
    const qualityStats = (memoryBodyId: string): RecallQualityStats => {
      const evaluated = quality.evaluated.filter(candidate => candidate.candidate.memoryBodyId === memoryBodyId)
      const selected = quality.selected.filter(candidate => candidate.candidate.memoryBodyId === memoryBodyId)
      return {
        policyId: quality.policyId,
        ...(quality.fallbackFrom === undefined ? {} : { fallbackFrom: quality.fallbackFrom }),
        fetched: evaluated.length,
        retained: evaluated.filter(candidate => candidate.decision.action === 'keep').length,
        selected: selected.length,
        droppedLowScore: evaluated.filter(candidate => candidate.decision.action === 'drop' && candidate.decision.reason === 'low-score').length,
        droppedNonPositiveScore: evaluated.filter(candidate => candidate.decision.action === 'drop' && candidate.decision.reason === 'non-positive-score').length,
        droppedInvalidScore: evaluated.filter(candidate => candidate.decision.action === 'drop' && candidate.decision.reason === 'invalid-score').length,
        unscored: evaluated.filter(candidate => candidate.decision.reason === 'unscored').length,
        unscaled: evaluated.filter(candidate => candidate.decision.reason === 'unscaled-score').length,
      }
    }
    return {
      query,
      mode,
      results: selected.map(({ candidate, decision }) => ({
        ...candidate.insight,
        relevanceTier: decision.tier,
        ...(decision.normalizedScore === undefined ? {} : { normalizedScore: decision.normalizedScore }),
      })),
      sources: batches.map(batch => {
        const stats = qualityStats(batch.body.id)
        if (batch.source.status === 'unavailable' || batch.source.status === 'unsupported') return { ...batch.source, quality: stats }
        return { ...batch.source, status: stats.retained === 0 ? 'empty' : 'ready', itemCount: stats.retained, quality: stats }
      }),
      ...(hints.length === 0 ? {} : { hint: hints.join('\n') }),
    }
  }

  /**
   * Read a deliberately small metadata sample through the cheapest useful path
   * exposed by the owning Provider. This avoids federated ranking, graph
   * expansion, and large browse projections before an LLM metadata pass.
   */
  async metadataSample(memoryBodyId: string, signal?: AbortSignal): Promise<MemoryBodyMetadataSample> {
    const body = this.readBodies([memoryBodyId])[0]!
    const provider = this.providerFor(body)
    const limit = 6
    let method: MemoryBodyMetadataSample['method']
    let items: Insight[]
    if (this.isNativeBody(body)) {
      method = 'native-basic'
      items = provider.metadataSample === undefined
        ? await provider.list(body, { limit }, signal)
        : await provider.metadataSample(body, limit, signal)
    } else if (METADATA_SEARCH_FIRST_PROVIDERS.has(body.provider.typeId ?? body.provider.id) || !body.provider.capabilities.browse) {
      method = 'search'
      const query = (body.description.trim() || body.name.trim()).slice(0, 400)
      items = (await provider.search(body, { query, mode: 'basic', limit }, signal)).results
    } else {
      method = 'browse'
      items = await provider.list(body, { limit }, signal)
    }
    return {
      memoryBodyId: body.id,
      name: body.name,
      description: body.description,
      providerId: body.provider.id,
      providerLabel: body.provider.label,
      method,
      evidence: items.slice(0, limit).map(item => ({
        content: item.content.length > 720 ? `${item.content.slice(0, 719)}…` : item.content,
        ...(item.category === undefined ? {} : { category: item.category }),
        ...(item.entities === undefined ? {} : { entities: item.entities.slice(0, 8) }),
      })),
    }
  }

  async graph(signal?: AbortSignal, memoryBodyIds?: string[]): Promise<MemoryGraphSnapshot> {
    const bodies = this.readBodies(memoryBodyIds)
    const nodes: MemoryGraphNode[] = []
    const edges: MemoryGraphEdge[] = []
    const sources: MemoryReadSource[] = []
    const snapshots = await Promise.all(bodies.map(async body => {
      const mode: MemoryReadMode = body.provider.capabilities.graph
        ? 'graph'
        : body.provider.capabilities.browse
          ? 'projection'
          : body.provider.capabilities.search
            ? 'query-only'
            : 'unsupported'
      if (mode === 'query-only') {
        return { body, source: readSource(body, mode, 'query-required', 0, { edgeCount: 0, hint: 'Use Recall to query this provider.' }) }
      }
      if (mode === 'unsupported') {
        return { body, source: readSource(body, mode, 'unsupported', 0, { edgeCount: 0, hint: 'This provider exposes neither graph nor browse projection.' }) }
      }
      try {
        const snapshot = await this.providerFor(body).graph(body, signal)
        return {
          body,
          snapshot,
          source: readSource(body, mode, snapshot.nodes.length === 0 ? 'empty' : 'ready', snapshot.nodes.length, { edgeCount: snapshot.edges.length }),
        }
      } catch (error) {
        return {
          body,
          source: readSource(body, mode, 'unavailable', 0, { edgeCount: 0, hint: error instanceof Error ? error.message : String(error) }),
        }
      }
    }))
    for (const item of snapshots) {
      sources.push(item.source)
      if (item.snapshot === undefined) continue
      const { body, snapshot } = item
      const graphId = (id: string): string => `${body.id}:${id}`
      nodes.push(...snapshot.nodes.map(node => ({ ...this.annotate(node, body), color: node.color, graphId: graphId(node.id) })))
      edges.push(...snapshot.edges.map(edge => ({ ...edge, sourceId: graphId(edge.sourceId), targetId: graphId(edge.targetId) })))
    }
    return {
      nodes,
      edges,
      generatedAt: new Date().toISOString(),
      memoryBodies: bodies.map(({ id, name, active }) => ({ id, name, active })),
      sources,
    }
  }

  async list(request: MemoryListRequest = {}, signal?: AbortSignal): Promise<MemoryListView> {
    const rawQuery = request.query?.trim() ?? ''
    const query = rawQuery.toLocaleLowerCase()
    if (rawQuery.length > 500) throw new Error('query is too long (max 500 characters)')
    const category = allowed(request.category, CATEGORIES, 'category')
    const limit = boundedInteger(request.limit, 200, 1, 1000)
    const bodies = this.readBodies(request.memoryBodyIds)
    const batches = await Promise.all(bodies.map(async body => {
      const mode: MemoryReadMode = body.provider.capabilities.browse
        ? 'enumerable'
        : body.provider.capabilities.search
          ? 'query-only'
          : 'unsupported'
      if (mode === 'query-only' && rawQuery === '') {
        return { body, items: [] as Insight[], source: readSource(body, mode, 'query-required', 0, { hint: 'Enter a query to inspect this provider.' }) }
      }
      if (mode === 'unsupported') {
        return { body, items: [] as Insight[], source: readSource(body, mode, 'unsupported', 0, { hint: 'This provider does not expose content browsing.' }) }
      }
      try {
        const provider = this.providerFor(body)
        const rawItems = mode === 'query-only'
          ? (await provider.search(body, { query: rawQuery, limit }, signal)).results
          : await provider.list(body, { ...request, limit }, signal)
        const items = rawItems.filter(item =>
          (category === undefined || item.category === category)
          && (query === '' || item.content.toLocaleLowerCase().includes(query) || item.id.toLocaleLowerCase().includes(query)),
        )
        return {
          body,
          items,
          source: readSource(body, mode, items.length === 0 ? 'empty' : 'ready', items.length),
        }
      } catch (error) {
        return {
          body,
          items: [] as Insight[],
          source: readSource(body, mode, 'unavailable', 0, { hint: error instanceof Error ? error.message : String(error) }),
        }
      }
    }))
    const items = batches.flatMap(({ body, items: bodyItems }) => bodyItems.map(item => ({ ...this.annotate(item, body), color: insightColor(item.category) })))
    return {
      items: items.slice(0, limit),
      total: items.length,
      generatedAt: new Date().toISOString(),
      sources: batches.map(batch => batch.source),
    }
  }

  async entities(entity?: string, limit?: number, signal?: AbortSignal): Promise<EntityView> {
    const catalog = await this.bodies(signal)
    const active = catalog.items.filter(body => body.active)
    const capable = active.filter(body => body.provider.capabilities.entities)
    const entityCounts = new Map<string, number>()
    for (const body of capable) {
      for (const item of body.stats?.topEntities ?? []) entityCounts.set(item.entity, (entityCounts.get(item.entity) ?? 0) + item.count)
    }
    const items = [...entityCounts].map(([name, count]) => ({ entity: name, count })).sort((left, right) => right.count - left.count)
    const sources = active.map(body => {
      if (!body.provider.capabilities.entities) return readSource(body, 'unsupported', 'unsupported', 0, { hint: 'This provider does not expose an entity index.' })
      if (!body.healthy) return readSource(body, 'entities', 'unavailable', 0, { hint: body.error ?? 'Provider unavailable.' })
      const count = body.stats?.topEntities.length ?? 0
      return readSource(body, 'entities', count === 0 ? 'empty' : 'ready', count)
    })
    const selected = entity?.trim() ?? ''
    if (selected === '') return { items, insights: [], sources }
    if (selected.length > 200) throw new Error('entity is too long (max 200 characters)')
    const readableIds = capable.filter(body => body.healthy).map(body => body.id)
    const insights = readableIds.length === 0
      ? []
      : (await this.search({ query: selected, intent: 'ENTITY', limit: boundedInteger(limit, 20, 1, 50), memoryBodyIds: readableIds }, signal)).results
    return { items, selected, insights, sources }
  }

  async remember(request: RememberRequest, signal?: AbortSignal): Promise<JsonValue> {
    this.assertWritable()
    const prepared = this.prepareRemember(request)
    const result = await this.providerFor(prepared.body).remember(prepared.body, prepared.request, signal)
    if (this.activateAfterWrite(prepared.body, mutationResultCommitted(result))) this.recordMemoryCommit('memory-space-remember', 'write', [prepared.body.id])
    return this.annotateResult(result, prepared.body)
  }

  /**
   * Persist a host-authorized set of exact memories without involving a model
   * in the data plane. Mnemon Native requests share one import per destination;
   * other Providers retain their adapter-defined write semantics.
   */
  async rememberMany(requests: readonly RememberRequest[], signal?: AbortSignal): Promise<JsonValue[]> {
    this.assertWritable()
    const prepared = requests.map(request => this.prepareRemember(request))
    const results = new Array<JsonValue>(prepared.length)
    const groups = new Map<string, Array<PreparedRemember & { index: number }>>()
    for (const [index, entry] of prepared.entries()) {
      groups.set(entry.body.id, [...(groups.get(entry.body.id) ?? []), { ...entry, index }])
    }

    for (const group of groups.values()) {
      const body = group[0]!.body
      const provider = this.providerFor(body)
      let providerChanged = false
      const batchWriter = provider.rememberMany
      const batch = batchWriter === undefined
        ? []
        : group.filter(entry => !this.isNativeBody(body) || entry.request.content.length <= 8_000)
      if (batchWriter !== undefined && batch.length > 0) {
        const written = await batchWriter.call(provider, body, batch.map(entry => entry.request), signal)
        if (written.length !== batch.length) throw new Error(`batch remember did not return one receipt per request for Memory Space ${body.id}`)
        for (const [offset, result] of written.entries()) {
          const entry = batch[offset]!
          results[entry.index] = this.annotateResult(result, body)
          providerChanged ||= mutationResultCommitted(result)
        }
      }
      for (const entry of group) {
        if (batch.includes(entry)) continue
        const result = await provider.remember(body, entry.request, signal)
        results[entry.index] = this.annotateResult(result, body)
        providerChanged ||= mutationResultCommitted(result)
      }
      if (this.activateAfterWrite(body, providerChanged)) {
        this.recordMemoryCommit('memory-space-remember-batch', this.isNativeBody(body) && batch.length > 0 ? 'import' : 'write', [body.id])
      }
    }

    return results
  }

  async related(id: string, depth = 2, edge?: EdgeType, signal?: AbortSignal, memoryBodyId?: string): Promise<Insight[]> {
    const body = this.readBody(memoryBodyId)
    const selectedEdge = allowed(edge, EDGE_TYPES, 'edge')
    const provider = this.providerFor(body)
    if (provider.related === undefined || !body.provider.capabilities.related) throw new Error(`${body.provider.label} does not support related-memory traversal`)
    const results = await provider.related(body, required(id, 'id', 2000), boundedInteger(depth, 2, 1, 5), selectedEdge, signal)
    return results.map(entry => this.annotate(entry, body))
  }

  async link(sourceId: string, targetId: string, type: EdgeType = 'semantic', weight = 0.5, reason?: string, signal?: AbortSignal, memoryBodyId?: string): Promise<JsonValue> {
    this.assertWritable()
    const body = this.writeBody(memoryBodyId)
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error('weight must be within 0..1')
    const selectedType = allowed(type, EDGE_TYPES, 'type') ?? 'semantic'
    const provider = this.providerFor(body)
    if (provider.link === undefined || !body.provider.capabilities.link) throw new Error(`${body.provider.label} does not support explicit memory links`)
    const result = await provider.link(
      body,
      required(sourceId, 'sourceId', 2000),
      required(targetId, 'targetId', 2000),
      selectedType,
      weight,
      reason === undefined || reason.trim() === '' ? undefined : required(reason, 'reason', 1000),
      signal,
    )
    if (this.activateAfterWrite(body, mutationResultCommitted(result))) this.recordMemoryCommit('memory-space-link', 'link', [body.id])
    return this.annotateResult(result, body)
  }

  async forget(id: string, signal?: AbortSignal, memoryBodyId?: string): Promise<JsonValue> {
    this.assertWritable()
    const body = this.writeBody(memoryBodyId)
    const provider = this.providerFor(body)
    if (provider.forget === undefined || !body.provider.capabilities.forget) throw new Error(`${body.provider.label} does not expose safe forget semantics in this integration`)
    const result = await provider.forget(body, required(id, 'id', 2000), signal)
    if (this.activateAfterWrite(body, mutationResultCommitted(result))) this.recordMemoryCommit('memory-space-forget', 'forget', [body.id])
    return this.annotateResult(result, body)
  }

  prepareBodyPlacement(request: CreateMemoryBodyRequest): PreparedMemoryPlacement {
    if (request.placement === undefined) throw new Error('automatic provider placement request is required')
    if (request.providerId !== undefined) throw new Error('automatic provider placement cannot include a fixed providerId')
    return prepareMemoryPlacement(request.placement, this.memoryBodies.placementCandidates(request))
  }

  async createBody(request: CreateMemoryBodyRequest, signal?: AbortSignal, placement?: MemoryPlacementDecision): Promise<MemoryBody> {
    this.assertWritable()
    const body = await this.memoryBodies.create(request, signal, placement)
    this.recordMemoryCommit('memory-space-create', 'write', [body.id])
    return body
  }

  /**
   * Create a Memory Space from the configured distillation policy. The model
   * may choose only among candidates already filtered by the host; manual mode
   * ignores model preference and always uses the configured fixed provider.
   */
  async createBodyForPersistence(
    body: { name: string; description: string },
    selection: LlmMemoryPlacementSelection | undefined,
    signal?: AbortSignal,
    delegation: { runId: string; provider: string } = { runId: 'memory-write', provider: 'task-agent' },
  ): Promise<MemoryBody> {
    const strategy = this.config.persistenceStrategy
    if (strategy.mode === 'manual') {
      const connection = strategy.providerConnections[strategy.providerId]
      return this.createBody({
        ...body,
        providerId: strategy.providerId,
        ...(this.isNativeProvider(strategy.providerId) || connection === undefined ? {} : { connection }),
      }, signal)
    }

    const request: CreateMemoryBodyRequest = {
      ...body,
      placement: {
        mode: 'automatic',
        ...(strategy.prompt === '' ? {} : { prompt: strategy.prompt }),
        rules: { ...strategy.rules },
      },
      ...(Object.keys(strategy.providerConnections).length === 0 ? {} : { providerConnections: strategy.providerConnections }),
    }
    const prepared = this.prepareBodyPlacement(request)
    const decision = rulesOnlyPlacement(prepared)
      ?? finalizeLlmPlacement(prepared, selection ?? { providerId: '', reason: '', confidence: '' }, delegation)
    return this.createBody(request, signal, decision)
  }

  async updateProviderService(providerId: MemoryBody['provider']['id'], settings: Record<string, string | number | boolean>, clearSecrets: readonly string[] = [], enabled = true, signal?: AbortSignal) {
    this.assertWritable()
    if (this.isNativeProvider(providerId)) throw new Error('Mnemon Native service settings are managed by the native configuration')
    if (!enabled) {
      const service = this.memoryBodies.updateProviderService(providerId, settings, clearSecrets, false)
      this.recordMemoryCommit('memory-provider-service-update', 'maintain')
      return service
    }
    const connection = this.memoryBodies.resolveProviderService(providerId, settings, clearSecrets)
    const provider = this.providers.get(providerId)
    if (provider?.discover === undefined) throw new Error(`${this.providerCatalog.descriptor(providerId).label} does not support Memory Space discovery`)
    const discovered = await provider.discover(connection, signal)
    const service = this.memoryBodies.syncProviderService(providerId, connection, discovered)
    this.recordMemoryCommit('memory-provider-service-update', 'maintain')
    return service
  }

  updateBody(id: string, request: UpdateMemoryBodyRequest): MemoryBody {
    this.assertWritable()
    const body = this.memoryBodies.update(id, request)
    this.recordMemoryCommit('memory-space-update', 'write', [body.id])
    return body
  }

  updateBodyMetadata(updates: readonly MemoryBodyMetadataUpdate[]): MemoryBody[] {
    this.assertWritable()
    const bodies = this.memoryBodies.updateMetadata(updates)
    this.recordMemoryCommit('memory-space-metadata', 'maintain', bodies.map(body => body.id))
    return bodies
  }

  async deleteBody(id: string, signal?: AbortSignal): Promise<MemoryBody> {
    this.assertWritable()
    const body = await this.memoryBodies.remove(id, signal)
    this.recordMemoryCommit('memory-space-delete', 'forget', [body.id])
    return body
  }

  async mergeBodies(targetBodyId: string, sourceBodyIds: string[], deactivateSources = true, signal?: AbortSignal): Promise<JsonValue> {
    this.assertWritable()
    const target = this.memoryBodies.get(targetBodyId)
    if (!this.isNativeBody(target)) throw new Error('memory-body merge currently requires a Mnemon Native target')
    const sourceIds = [...new Set(sourceBodyIds.map(id => id.trim()).filter(id => id !== ''))]
    if (sourceIds.length === 0) throw new Error('sourceMemoryBodyIds requires at least one memory body')
    if (sourceIds.includes(target.id)) throw new Error('target memory body cannot also be a merge source')
    const sources = sourceIds.map(id => this.memoryBodies.get(id))
    if (sources.some(source => !this.isNativeBody(source))) throw new Error('memory-body merge currently supports Mnemon Native sources only')
    const insights: Array<Record<string, JsonValue>> = []
    const edges: Array<Record<string, JsonValue>> = []
    for (const source of sources) {
      const offset = insights.length
      const sourceInsights = await this.providerFor(source).list(source, { limit: 100_000 }, signal)
      const indexById = new Map(sourceInsights.map((insight, index) => [insight.id, offset + index]))
      for (const insight of sourceInsights) {
        insights.push({
          content: insight.content,
          ...(insight.category === undefined ? {} : { category: insight.category }),
          ...(insight.importance === undefined ? {} : { importance: insight.importance }),
          ...(insight.tags === undefined ? {} : { tags: insight.tags }),
          ...(insight.entities === undefined ? {} : { entities: insight.entities }),
          ...(insight.source === undefined ? {} : { source: insight.source }),
          ...(insight.createdAt === undefined ? {} : { created_at: insight.createdAt }),
        })
      }
      const graph = await this.providerFor(source).graph(source, signal)
      for (const edge of graph.edges) {
        const sourceIndex = indexById.get(edge.sourceId)
        const targetIndex = indexById.get(edge.targetId)
        if (sourceIndex === undefined || targetIndex === undefined || edge.type === undefined) continue
        edges.push({ source_index: sourceIndex, target_index: targetIndex, edge_type: edge.type, weight: 0.5, reason: edge.label })
      }
    }
    if (insights.length === 0) {
      let changed = this.activateAfterWrite(target, false)
      if (deactivateSources) {
        for (const source of sources) {
          if (!source.active) continue
          this.memoryBodies.setActive(source.id, false)
          changed = true
        }
      }
      if (changed) this.recordMemoryCommit('memory-space-merge', 'import', [target.id, ...sourceIds])
      return { imported: 0, updated: 0, skipped: 0, edges_inserted: 0, targetMemoryBodyId: target.id }
    }
    const temporary = mkdtempSync(join(tmpdir(), 'dsh-mnemon-merge-'))
    const draftPath = join(temporary, 'memory-draft.json')
    try {
      writeFileSync(draftPath, JSON.stringify({ schema_version: '1', source: 'dsh-mnemon-merge', insights, edges }), { encoding: 'utf8', mode: 0o600 })
      const result = await this.runner.runJson(['import', draftPath], { ...(signal === undefined ? {} : { signal }), store: target.id })
      let changed = this.activateAfterWrite(target, mutationResultCommitted(result))
      if (deactivateSources) {
        for (const source of sources) {
          if (!source.active) continue
          this.memoryBodies.setActive(source.id, false)
          changed = true
        }
      }
      if (changed) this.recordMemoryCommit('memory-space-merge', 'import', [target.id, ...sourceIds])
      return this.annotateResult(result, target)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }

  private providerFor(body: MemoryBody): MemoryProviderAdapter {
    const provider = this.providers.get(body.provider.id)
    if (provider === undefined) throw new Error(`unsupported memory provider: ${body.provider.id}`)
    return provider
  }

  private readBodies(ids?: string[]): MemoryBody[] {
    const active = this.memoryBodies.active()
    if (ids === undefined || ids.length === 0) return active
    const requested = [...new Set(ids.map(id => id.trim()).filter(id => id !== ''))]
    return requested.map(id => {
      const body = this.memoryBodies.get(id)
      if (!body.active) throw new Error(`memory body is not active for reading: ${id}`)
      if (!this.isNativeBody(body) && !this.memoryBodies.providerServiceEnabled(body.provider.id)) throw new Error(`${body.provider.label} is disabled in Settings`)
      return body
    })
  }

  private readBody(id?: string): MemoryBody {
    if (id !== undefined && id.trim() !== '') {
      const body = this.memoryBodies.get(id)
      if (!body.active) throw new Error(`memory body is not active for reading: ${body.id}`)
      if (!this.isNativeBody(body) && !this.memoryBodies.providerServiceEnabled(body.provider.id)) throw new Error(`${body.provider.label} is disabled in Settings`)
      return body
    }
    const active = this.memoryBodies.active()
    if (active.length !== 1) throw new Error('memoryBodyId is required when the number of active memory bodies is not exactly one')
    return active[0]!
  }

  private writeBody(id?: string): MemoryBody {
    if (id !== undefined && id.trim() !== '') {
      const body = this.memoryBodies.get(id)
      if (!this.isNativeBody(body) && !this.memoryBodies.providerServiceEnabled(body.provider.id)) throw new Error(`${body.provider.label} is disabled in Settings`)
      return body
    }
    const active = this.memoryBodies.active()
    if (active.length !== 1) throw new Error('memoryBodyId is required when the number of active memory bodies is not exactly one')
    return active[0]!
  }

  private prepareRemember(request: RememberRequest): PreparedRemember {
    const body = this.writeBody(request.memoryBodyId)
    // Runtime entries are capped at 8 KiB. Keep the service boundary large
    // enough for the Host to archive any valid hot-memory entry byte-for-byte;
    // the UI remains at its existing 8,000-character limit.
    const content = required(request.content, 'content', 8 * 1024)
    const importance = boundedInteger(request.importance, 3, 1, 5)
    const category = allowed(request.category, CATEGORIES, 'category') ?? 'general'
    const source = allowed(request.source, SOURCES, 'source') ?? 'user'
    const tags = commaList(request.tags, 'tags', 20)?.split(',')
    const entities = commaList(request.entities, 'entities', 50)?.split(',')
    return {
      body,
      request: {
        content,
        importance,
        category,
        source,
        memoryBodyId: body.id,
        ...(tags === undefined ? {} : { tags }),
        ...(entities === undefined ? {} : { entities }),
      },
    }
  }

  private annotate<T extends Insight>(insight: T, body: MemoryBody): T {
    return {
      ...insight,
      memoryBodyId: body.id,
      memoryBodyName: body.name,
      memoryProviderId: body.provider.id,
      memoryProviderLabel: body.provider.label,
      memoryCapabilities: body.provider.capabilities,
    }
  }

  private annotateResult(result: JsonValue, body: MemoryBody): JsonValue {
    const value = record(result)
    return value === undefined ? result : {
      ...value,
      memoryBodyId: body.id,
      memoryBodyName: body.name,
      memoryProviderId: body.provider.id,
      memoryProviderLabel: body.provider.label,
    }
  }

  private activateAfterWrite(body: MemoryBody, providerChanged: boolean): boolean {
    if (!providerChanged) return false
    if (!body.active) {
      this.memoryBodies.setActive(body.id, true)
      return true
    }
    this.memoryBodies.touch(body.id)
    return true
  }

  private recordMemoryCommit(operation: string, capability: 'write' | 'link' | 'forget' | 'maintain' | 'import', memoryBodyIds: string[] = []): void {
    this.recordCommit?.({
      layerId: 'memory-spaces',
      capability,
      operation,
      checkpoint: {
        sourceRevision: this.memoryRevision(),
        ...(memoryBodyIds.length === 0 ? {} : { memoryBodyIds }),
      },
    })
  }

  private assertWritable(): void {
    if (!this.config.writeEnabled) throw new Error('dsh-mnemon is configured read-only (writeEnabled: false)')
  }
}
