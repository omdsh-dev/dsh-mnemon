import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { MemoryProviderCatalog } from '../src/providers/catalog.ts'
import { MemoryProviderAdapterRegistry } from '../src/providers/registry.ts'
import { MemorySpaceRegistry } from '../src/memory-spaces.ts'
import { MemorySpacesService } from '../src/service.ts'
import {
  HttpMemoryProvider,
  MEMORY_SPACE_PROVIDER_API_VERSION,
  NORMALIZED_RELEVANCE_SCORE,
  defineMemorySpaceProvider,
  defineMemorySpaceProviderDefinition,
  firstArray,
  jsonNumber,
  jsonObject,
  jsonString,
  type EdgeType,
  type Insight,
  type JsonValue,
  type MemoryGraphEdge,
  type MemoryGraphNode,
  type MemoryGraphSnapshot,
  type MemoryListRequest,
  type MemoryProviderAdapter,
  type MemoryProviderCapabilities,
  type MemoryProviderDescriptor,
  type MemorySpace,
  type MemorySpaceNativeRunner,
  type MemorySpaceProviderDefinition,
  type MemorySpaceProviderManifest,
  type MemorySpaceProviderScoreSemantics,
  type MemorySpaceStats,
  type ProviderMemorySpace,
  type ProviderSearchResult,
  type ProviderSpaceStatus,
  type RememberRequest,
  type SearchRequest,
} from '../src/provider-sdk.ts'

const DATA_URL_STUB = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"/>').toString('base64')}`

function manifestFromDescriptor(
  descriptor: MemoryProviderDescriptor,
  scoreSemantics: MemorySpaceProviderScoreSemantics = 'normalized-relevance',
): MemorySpaceProviderManifest {
  return {
    apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION,
    kind: 'provider',
    typeId: descriptor.id,
    packageName: `dsh-mnemon-provider-${descriptor.id}`,
    version: '0.5.0',
    label: descriptor.label,
    ...(descriptor.icon === undefined ? {} : { icon: descriptor.icon }),
    summary: descriptor.summary,
    ...(descriptor.summaryI18nKey === undefined ? {} : { summaryI18nKey: descriptor.summaryI18nKey }),
    origin: descriptor.origin,
    locality: descriptor.kind,
    workspaceBinding: descriptor.workspaceBinding,
    capabilities: descriptor.capabilities,
    fields: descriptor.fields,
    secrets: descriptor.fields.filter(field => field.input === 'secret').map(field => field.key).sort(),
    scoreSemantics,
  }
}

function makeProviderModule(
  descriptor: MemoryProviderDescriptor,
  create: MemorySpaceProviderDefinition['create'],
  scoreSemantics: MemorySpaceProviderScoreSemantics = 'normalized-relevance',
) {
  const definition = defineMemorySpaceProviderDefinition({
    manifest: manifestFromDescriptor(descriptor, scoreSemantics),
    create,
  })
  const plugin = defineMemorySpaceProvider<undefined>({
    id: descriptor.id,
    apply(ctx, host) {
      host.install(ctx, definition)
    },
  })
  return { descriptor, definition, default: plugin }
}

const JS_STRING = '"(?:\\\\.|[^"\\\\])*"'
const VIZ_NODE_PATTERN = new RegExp(`\\{id:(${JS_STRING}),label:(${JS_STRING}),title:(${JS_STRING}),color:(${JS_STRING}),font:\\{color:"white"\\}\\}`, 'g')
const VIZ_EDGE_PATTERN = new RegExp(`\\{from:(${JS_STRING}),to:(${JS_STRING}),label:(${JS_STRING}),color:\\{color:(${JS_STRING})\\},arrows:"to"`, 'g')
const EDGE_COLORS: Record<string, EdgeType> = {
  '#aaaaaa': 'temporal',
  '#3498db': 'semantic',
  '#e74c3c': 'causal',
  '#2ecc71': 'entity',
}

function parseTestNativeGraph(html: string): MemoryGraphSnapshot {
  const nodes: MemoryGraphNode[] = []
  const edges: MemoryGraphEdge[] = []
  for (const match of html.matchAll(VIZ_NODE_PATTERN)) {
    const id = JSON.parse(match[1]!) as string
    const label = JSON.parse(match[2]!) as string
    const content = (JSON.parse(match[3]!) as string).replaceAll('\\n', '\n')
    const color = JSON.parse(match[4]!) as string
    const category = /\[([a-z_]+)\]/i.exec(label)?.[1] ?? 'general'
    nodes.push({ id, content, category, color })
  }
  for (const match of html.matchAll(VIZ_EDGE_PATTERN)) {
    const color = JSON.parse(match[4]!) as string
    const type = EDGE_COLORS[color.toLowerCase()]
    edges.push({
      sourceId: JSON.parse(match[1]!) as string,
      targetId: JSON.parse(match[2]!) as string,
      label: JSON.parse(match[3]!) as string,
      color,
      ...(type === undefined ? {} : { type }),
    })
  }
  if (!html.includes('var nodes = new vis.DataSet([')) throw new Error('Mnemon viz returned an unexpected HTML payload')
  return { nodes, edges, generatedAt: new Date().toISOString() }
}

function normalizeNativeInsight(value: unknown): Insight | undefined {
  const item = jsonObject(value)
  if (item === undefined) return undefined
  const core = jsonObject(item.insight) ?? item
  const id = jsonString(core.id)
  const content = jsonString(core.content)
  if (id === undefined || content === undefined) return undefined
  const insight: Insight = { id, content }
  const optionalText = {
    category: jsonString(core.category),
    source: jsonString(core.source),
    confidence: jsonString(item.confidence),
    intent: jsonString(item.intent),
    matchedVia: jsonString(item.matched_via ?? item.via ?? item.via_edge_type),
    createdAt: jsonString(core.created_at),
    edgeType: jsonString(item.via_edge_type),
  }
  for (const [key, val] of Object.entries(optionalText)) if (val !== undefined) Object.assign(insight, { [key]: val })
  const optionalNumbers = {
    importance: jsonNumber(core.importance),
    score: jsonNumber(item.score),
    depth: jsonNumber(item.depth),
  }
  for (const [key, val] of Object.entries(optionalNumbers)) if (val !== undefined) Object.assign(insight, { [key]: val })
  if (Array.isArray(core.tags)) insight.tags = core.tags.filter((entry): entry is string => typeof entry === 'string')
  if (Array.isArray(core.entities)) insight.entities = core.entities.filter((entry): entry is string => typeof entry === 'string')
  return insight
}

function commaList(values: string[] | undefined, label: string, limit: number): string | undefined {
  if (values === undefined) return undefined
  const normalized = values.map(value => value.trim()).filter(value => value !== '')
  if (normalized.length > limit) throw new Error(`${label} accepts at most ${limit} values`)
  if (normalized.some(value => value.includes(','))) throw new Error(`${label} values cannot contain commas`)
  return normalized.length === 0 ? undefined : normalized.join(',')
}

const STORE_DUMP_MAX_OUTPUT_BYTES = 128 * 1024 * 1024

export class TestNativeProvider implements MemoryProviderAdapter {
  readonly id = 'mnemon-native'
  readonly scoreSemantics = NORMALIZED_RELEVANCE_SCORE

  constructor(
    private readonly runner: MemorySpaceNativeRunner,
    private readonly config: { defaultRecallLimit: number } = { defaultRecallLimit: 10 },
  ) {}

  list(body: MemorySpace, _request: MemoryListRequest, signal?: AbortSignal): Promise<Insight[]> {
    return this.allInsights(body, signal, true)
  }

  async status(body: MemorySpace, signal?: AbortSignal): Promise<ProviderSpaceStatus> {
    try {
      const raw = await this.runner.runJson(['status'], { ...(signal === undefined ? {} : { signal }), store: body.id })
      const status = jsonObject(raw)
      if (status === undefined) throw new Error('mnemon status returned an unexpected payload')
      const byCategoryRecord = jsonObject(status.by_category) ?? {}
      const byCategory: Record<string, number> = {}
      for (const [category, count] of Object.entries(byCategoryRecord)) if (typeof count === 'number') byCategory[category] = count
      const topEntities = Array.isArray(status.top_entities)
        ? status.top_entities.flatMap(entry => {
            const entity = jsonObject(entry)
            const name = jsonString(entity?.entity)
            const count = jsonNumber(entity?.count)
            return name === undefined || count === undefined ? [] : [{ entity: name, count }]
          })
        : []
      const stats: MemorySpaceStats = {
        totalInsights: jsonNumber(status.total_insights) ?? 0,
        deletedInsights: jsonNumber(status.deleted_insights) ?? 0,
        edgeCount: jsonNumber(status.edge_count) ?? 0,
        oplogCount: jsonNumber(status.oplog_count) ?? 0,
        dbSizeBytes: jsonNumber(status.db_size_bytes) ?? 0,
        byCategory,
        topEntities,
      }
      return { healthy: true, stats }
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async graph(body: MemorySpace, signal?: AbortSignal): Promise<MemoryGraphSnapshot> {
    const [html, insights] = await Promise.all([
      this.runner.runText(['viz', '--format', 'html', '--output', '-'], {
        ...(signal === undefined ? {} : { signal }), store: body.id, maxOutputBytes: STORE_DUMP_MAX_OUTPUT_BYTES,
      }),
      this.allInsights(body, signal, true),
    ])
    const snapshot = parseTestNativeGraph(html)
    const metadata = new Map(insights.map(insight => [insight.id, insight]))
    return {
      ...snapshot,
      nodes: snapshot.nodes.map(node => {
        const insight = metadata.get(node.id)
        return insight === undefined ? node : { ...node, ...insight, id: node.id, content: node.content, color: node.color }
      }),
    }
  }

  private async allInsights(body: MemorySpace, signal?: AbortSignal, readonly = false): Promise<Insight[]> {
    const payload = await this.runner.runJson([
      ...(readonly ? ['--readonly'] : []),
      'recall', '', '--basic', '--limit', '100000',
    ], { ...(signal === undefined ? {} : { signal }), store: body.id, maxOutputBytes: STORE_DUMP_MAX_OUTPUT_BYTES })
    return firstArray(payload, 'results').map(normalizeNativeInsight).filter((entry): entry is Insight => entry !== undefined)
  }

  async metadataSample(body: MemorySpace, limit: number, signal?: AbortSignal): Promise<Insight[]> {
    const payload = await this.runner.runJson([
      '--readonly', 'recall', '', '--basic', '--limit', String(limit),
    ], { ...(signal === undefined ? {} : { signal }), store: body.id })
    return firstArray(payload, 'results').map(normalizeNativeInsight).filter((entry): entry is Insight => entry !== undefined)
  }

  async search(body: MemorySpace, request: SearchRequest, signal?: AbortSignal): Promise<ProviderSearchResult> {
    const mode = request.mode ?? 'smart'
    const semantic = mode === 'smart'
    const limit = request.limit ?? this.config.defaultRecallLimit
    const candidateLimit = semantic ? Math.max(limit, Math.min(50, Math.max(20, limit * 4))) : limit
    const readonly = request.inspect === true ? ['--readonly'] : []
    const args = mode === 'keyword'
      ? [...readonly, 'search', request.query, '--limit', String(candidateLimit)]
      : [...readonly, 'recall', request.query, '--limit', String(candidateLimit)]
    if (semantic) args.push('--verbose')
    if (mode === 'basic') args.push('--basic')
    if (mode !== 'keyword') {
      if (request.category !== undefined) args.push('--cat', request.category)
      if (request.source !== undefined) args.push('--source', request.source)
      if (request.intent !== undefined) args.push('--intent', request.intent)
    }
    const options = { ...(signal === undefined ? {} : { signal }), store: body.id }
    let payload: JsonValue
    try {
      payload = await this.runner.runJson(args, options)
    } catch (error) {
      if (!semantic || signal?.aborted || !(error instanceof Error)) throw error
      const prefix = `mnemon ${args.join(' ')} exited `
      const detail = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message
      if (!/^(?:[1-9]\d*:\s*)?(?:Error:\s*)?unknown flag: --verbose[ \t]*(?:\r?\n|$)/u.test(detail)) throw error
      const legacyArgs = [...args]
      legacyArgs.splice(readonly.length + 4, 1)
      payload = await this.runner.runJson(legacyArgs, options)
    }
    const wrapper = jsonObject(payload)
    const values = firstArray(payload, 'results')
    const candidates = values.flatMap(value => {
      const insight = normalizeNativeInsight(value)
      if (insight === undefined) return []
      const item = jsonObject(value)
      const similarity = jsonNumber(jsonObject(item?.signals)?.similarity)
      return [{ insight, similarity, superseded: item?.superseded === true }]
    })
    if (semantic && candidates.some(candidate => candidate.similarity !== undefined && candidate.similarity > 0)) {
      for (const candidate of candidates) {
        const { insight, similarity } = candidate
        delete insight.confidence
        if (similarity === undefined) {
          if (!candidate.superseded) delete insight.score
        } else {
          const relevance = Math.min(1, Math.max(0, similarity))
          insight.score = candidate.superseded ? Math.min(relevance, insight.score ?? 0) : relevance
        }
      }
      candidates.sort((left, right) => (right.insight.score ?? -1) - (left.insight.score ?? -1))
    }
    const hint = jsonString(wrapper?.hint) ?? jsonString(jsonObject(wrapper?.meta)?.hint)
    return {
      results: candidates.slice(0, limit).map(candidate => candidate.insight),
      ...(hint === undefined ? {} : { hint }),
    }
  }

  async remember(body: MemorySpace, request: RememberRequest, signal?: AbortSignal): Promise<JsonValue> {
    const args = ['remember', request.content, '--cat', request.category ?? 'general', '--imp', String(request.importance ?? 3), '--source', request.source ?? 'user']
    const tags = commaList(request.tags, 'tags', 20)
    const entities = commaList(request.entities, 'entities', 50)
    if (tags !== undefined) args.push('--tags', tags)
    if (entities !== undefined) args.push('--entities', entities)
    return this.runner.runJson(args, { ...(signal === undefined ? {} : { signal }), store: body.id })
  }

  async rememberMany(body: MemorySpace, requests: readonly RememberRequest[], signal?: AbortSignal): Promise<JsonValue[]> {
    if (requests.length === 0) return []
    const existing = new Map((await this.allInsights(body, signal, true)).map(entry => [entry.content, entry]))
    const ordered = new Array<JsonValue>(requests.length)
    const reused = new Set<number>()
    let pending = new Map<string, { request: RememberRequest; indexes: number[] }>()
    const queue = (index: number) => {
      const request = requests[index]!
      const group = pending.get(request.content)
      if (group === undefined) pending.set(request.content, { request, indexes: [index] })
      else group.indexes.push(index)
    }
    for (const [index, request] of requests.entries()) {
      const exact = existing.get(request.content)
      if (exact === undefined) queue(index)
      else {
        ordered[index] = { action: 'skipped', id: exact.id, content: exact.content }
        reused.add(index)
      }
    }
    while (pending.size > 0) {
      const pruned = await this.importExact(body, [...pending.values()], ordered, signal)
      pending = new Map()
      for (const index of reused) {
        const id = jsonObject(ordered[index])?.id
        if (typeof id === 'string' && pruned.has(id)) {
          reused.delete(index)
          queue(index)
        }
      }
    }
    return ordered
  }

  private async importExact(body: MemorySpace, batch: ReadonlyArray<{ request: RememberRequest; indexes: number[] }>, ordered: JsonValue[], signal?: AbortSignal): Promise<Set<string>> {
    const temporary = mkdtempSync(join(tmpdir(), 'dsh-mnemon-runtime-archive-'))
    const draftPath = join(temporary, 'memory-draft.json')
    try {
      writeFileSync(draftPath, JSON.stringify({
        schema_version: '1',
        source: 'dsh-mnemon-runtime-archive',
        insights: batch.map(({ request }) => ({
          content: request.content,
          category: request.category,
          importance: request.importance ?? 3,
          source: request.source,
          ...(request.tags === undefined ? {} : { tags: request.tags }),
          ...(request.entities === undefined ? {} : { entities: request.entities }),
        })),
      }), { encoding: 'utf8', mode: 0o600 })
      const payload = await this.runner.runJson(['import', draftPath, '--no-diff'], { ...(signal === undefined ? {} : { signal }), store: body.id })
      const summary = jsonObject(payload)
      const rows = Array.isArray(summary?.results) ? summary.results : undefined
      const errors = jsonNumber(summary?.errors)
      const imported = jsonNumber(summary?.imported)
      const updated = jsonNumber(summary?.updated)
      const skipped = jsonNumber(summary?.skipped)
      const invalid = () => new Error(`Mnemon runtime archive import returned an invalid or partial result for Memory Space ${body.id}`)
      if (errors !== 0 || imported === undefined || updated === undefined || skipped === undefined || rows === undefined
        || ![imported, updated, skipped].every(value => Number.isInteger(value) && value >= 0)
        || imported !== batch.length || updated !== 0 || skipped !== 0 || rows.length !== batch.length) {
        throw invalid()
      }
      const seen = new Set<number>()
      for (const candidate of rows) {
        const row = jsonObject(candidate) as Record<string, JsonValue> | undefined
        const index = jsonNumber(row?.index)
        const action = jsonString(row?.action)?.trim().toLocaleLowerCase()
        if (row === undefined || index === undefined || !Number.isInteger(index) || index < 0 || index >= batch.length || seen.has(index)) {
          throw invalid()
        }
        if (row.content !== batch[index]!.request.content || action !== 'added') {
          throw invalid()
        }
        seen.add(index)
        for (const [offset, originalIndex] of batch[index]!.indexes.entries()) {
          ordered[originalIndex] = offset === 0 ? row : { ...row, action: 'skipped' }
        }
      }
      const autoPruned = Array.isArray(summary?.auto_pruned_ids)
        ? summary.auto_pruned_ids.filter((item): item is string => typeof item === 'string')
        : []
      return new Set(autoPruned)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }

  async get(body: MemorySpace, id: string, signal?: AbortSignal): Promise<Insight | undefined> {
    try {
      return normalizeNativeInsight(await this.runner.runJson(['--readonly', 'show', id], { ...(signal === undefined ? {} : { signal }), store: body.id }))
    } catch (error) {
      if (error instanceof Error && /no rows in result set/u.test(error.message)) return undefined
      throw error
    }
  }

  async related(body: MemorySpace, id: string, depth: number, edge?: EdgeType, signal?: AbortSignal): Promise<Insight[]> {
    const args = ['related', id, '--depth', String(depth)]
    if (edge !== undefined) args.push('--edge', edge)
    const payload = await this.runner.runJson(args, { ...(signal === undefined ? {} : { signal }), store: body.id })
    return Array.isArray(payload) ? payload.map(normalizeNativeInsight).filter((entry): entry is Insight => entry !== undefined) : []
  }

  async link(body: MemorySpace, sourceId: string, targetId: string, type: EdgeType, weight: number, reason?: string, signal?: AbortSignal): Promise<JsonValue> {
    const args = ['link', sourceId, targetId, '--type', type, '--weight', String(weight)]
    if (reason !== undefined) args.push('--meta', JSON.stringify({ reason }))
    return this.runner.runJson(args, { ...(signal === undefined ? {} : { signal }), store: body.id })
  }

  forget(body: MemorySpace, id: string, signal?: AbortSignal): Promise<JsonValue> {
    return this.runner.runJson(['forget', id], { ...(signal === undefined ? {} : { signal }), store: body.id })
  }
}

interface TestHolographicFact {
  id: string
  content: string
  category: string
  trustScore: number
  entities: string[]
  tags: string[]
  source: string
  createdAt: string
}

export class TestHolographicProvider implements MemoryProviderAdapter {
  readonly id = 'holographic'
  readonly scoreSemantics = NORMALIZED_RELEVANCE_SCORE

  constructor(
    private readonly memorySpaces: { providerConnection(id: string, providerId: string): Record<string, unknown> },
    private readonly defaultPath: string,
  ) {}

  private storePath(body: MemorySpace): string {
    const connection = this.memorySpaces.providerConnection(body.id, this.id)
    const configured = typeof connection.dataPath === 'string' ? connection.dataPath.trim() : ''
    return configured || this.defaultPath
  }

  private load(path: string): { version: 1; facts: TestHolographicFact[] } {
    if (!existsSync(path)) return { version: 1, facts: [] }
    const parsed = jsonObject(JSON.parse(readFileSync(path, 'utf8')))
    return {
      version: 1,
      facts: Array.isArray(parsed?.facts) ? parsed.facts as TestHolographicFact[] : [],
    }
  }

  private save(path: string, store: { version: 1; facts: TestHolographicFact[] }): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  async discover(connection: Record<string, unknown>): Promise<ProviderMemorySpace[]> {
    const path = (typeof connection.dataPath === 'string' ? connection.dataPath.trim() : '') || this.defaultPath
    return [{
      externalId: path,
      name: 'Holographic Fact Store',
      description: 'Structured facts and trust scores stored locally.',
      connection: { defaultTrust: 0.5, minTrust: 0.3 },
    }]
  }

  async status(body: MemorySpace): Promise<ProviderSpaceStatus> {
    const path = this.storePath(body)
    const store = this.load(path)
    return {
      healthy: true,
      stats: {
        totalInsights: store.facts.length,
        deletedInsights: 0,
        edgeCount: 0,
        oplogCount: store.facts.length,
        dbSizeBytes: 0,
        byCategory: {},
        topEntities: [],
      },
    }
  }

  async list(body: MemorySpace, request: MemoryListRequest): Promise<Insight[]> {
    const connection = this.memorySpaces.providerConnection(body.id, this.id)
    const minTrust = Number(connection.minTrust ?? 0.3)
    const limit = Math.min(Math.max(request.limit ?? 50, 1), 200)
    return this.load(this.storePath(body)).facts
      .filter(fact => fact.trustScore >= minTrust)
      .slice(0, limit)
      .map(fact => ({
        id: fact.id,
        content: fact.content,
        category: fact.category,
        importance: Math.max(1, Math.min(5, Math.round(fact.trustScore * 5))),
        score: fact.trustScore,
        entities: fact.entities,
        tags: fact.tags,
        source: fact.source,
        createdAt: fact.createdAt,
      }))
  }

  async search(body: MemorySpace, request: SearchRequest): Promise<ProviderSearchResult> {
    const items = await this.list(body, { limit: request.limit ?? 20 })
    const needle = request.query.trim().toLocaleLowerCase()
    const tokens = needle.split(/\s+/u).filter(Boolean)
    return {
      results: items
        .filter(item => tokens.length === 0 || tokens.some(token => item.content.toLocaleLowerCase().includes(token)))
        .map(item => ({ ...item, score: item.score ?? 0.8 })),
    }
  }

  async graph(body: MemorySpace): Promise<MemoryGraphSnapshot> {
    const items = await this.list(body, { limit: 200 })
    return {
      nodes: items.map(item => ({ ...item, color: '#6574d9' })),
      edges: [],
      generatedAt: new Date().toISOString(),
    }
  }

  async remember(body: MemorySpace, request: RememberRequest, signal?: AbortSignal): Promise<JsonValue> {
    signal?.throwIfAborted()
    const path = this.storePath(body)
    const connection = this.memorySpaces.providerConnection(body.id, this.id)
    const defaultTrust = Math.min(1, Math.max(0, Number(connection.defaultTrust ?? 0.5)))
    const trustScore = request.importance === undefined ? defaultTrust : Math.min(1, Math.max(0.2, request.importance / 5))
    const store = this.load(path)
    const id = `holo_${randomUUID()}`
    store.facts.push({
      id,
      content: request.content,
      category: request.category ?? 'fact',
      trustScore,
      entities: request.entities ?? [],
      tags: request.tags ?? [],
      source: request.source ?? 'user',
      createdAt: new Date().toISOString(),
    })
    this.save(path, store)
    return { id, action: 'stored', trustScore }
  }

  async forget(body: MemorySpace, id: string, signal?: AbortSignal): Promise<JsonValue> {
    signal?.throwIfAborted()
    const path = this.storePath(body)
    const store = this.load(path)
    store.facts = store.facts.filter(fact => fact.id !== id)
    this.save(path, store)
    return { id, action: 'deleted' }
  }

  async related(): Promise<Insight[]> {
    return []
  }
}

class TestOpenVikingProvider extends HttpMemoryProvider implements MemoryProviderAdapter {
  readonly id = 'openviking'
  readonly scoreSemantics = { kind: 'provider-native' as const }

  async status(): Promise<ProviderSpaceStatus> {
    return { healthy: true }
  }

  async list(): Promise<Insight[]> {
    return []
  }

  async search(body: MemorySpace, request: SearchRequest, signal?: AbortSignal): Promise<ProviderSearchResult> {
    const connection = this.connection(body)
    const payload = await this.requestConnection(connection, '/api/v1/search/find', {
      method: 'POST',
      json: { query: request.query, target_uri: String(connection.targetUri ?? 'viking://user/memories'), limit: request.limit ?? 10 },
      signal,
    })
    const result = jsonObject(jsonObject(payload)?.result)
    const memories = Array.isArray(result?.memories) ? result.memories : []
    const items: Insight[] = await Promise.all(memories.map(async entry => {
      const row = jsonObject(entry) ?? {}
      const uri = jsonString(row.uri) ?? 'viking://unknown'
      const readPayload = await this.requestConnection(connection, `/api/v1/content/read?uri=${encodeURIComponent(uri)}`, { method: 'GET', signal })
      const content = jsonString(jsonObject(readPayload)?.result) ?? jsonString(row.overview) ?? uri
      const score = jsonNumber(row.score)
      return {
        id: uri,
        content,
        ...(score === undefined ? {} : { score }),
      }
    }))
    return { results: items }
  }

  async remember(_body: MemorySpace, request: RememberRequest): Promise<JsonValue> {
    return { action: 'stored', content: request.content }
  }

  async forget(_body: MemorySpace, id: string): Promise<JsonValue> {
    return { id, action: 'deleted' }
  }
}

class TestHindsightProvider extends HttpMemoryProvider implements MemoryProviderAdapter {
  readonly id = 'hindsight'
  readonly scoreSemantics = { kind: 'provider-native' as const }

  async status(): Promise<ProviderSpaceStatus> {
    return { healthy: true }
  }

  async list(): Promise<Insight[]> {
    return []
  }

  async search(body: MemorySpace, request: SearchRequest, signal?: AbortSignal): Promise<ProviderSearchResult> {
    const connection = this.connection(body)
    const bankId = encodeURIComponent(String(connection.bankId ?? 'dsh'))
    const payload = await this.requestConnection(connection, `/v1/default/banks/${bankId}/memories/recall`, {
      method: 'POST',
      json: { query: request.query, max_tokens: 4096 },
      signal,
    })
    const results = firstArray(payload, 'results').flatMap((entry): Insight[] => {
      const row = jsonObject(entry)
      const id = jsonString(row?.id)
      const content = jsonString(row?.text ?? row?.content)
      if (id === undefined || content === undefined) return []
      const scores = jsonObject(row?.scores)
      const score = jsonNumber(scores?.final ?? row?.score)
      return [{ id, content, ...(score === undefined ? {} : { score }) }]
    })
    return { results }
  }

  async remember(_body: MemorySpace, request: RememberRequest): Promise<JsonValue> {
    return { action: 'stored', content: request.content }
  }

  async forget(_body: MemorySpace, id: string): Promise<JsonValue> {
    return { id, action: 'deleted' }
  }

  async related(): Promise<Insight[]> {
    return []
  }
}

function stubAdapter(id: string, scoreSemantics: MemoryProviderAdapter['scoreSemantics'] = NORMALIZED_RELEVANCE_SCORE): MemoryProviderAdapter {
  return {
    id,
    scoreSemantics,
    discover: async () => [],
    status: async () => ({ healthy: true }),
    search: async () => ({ results: [] }),
    graph: async () => ({ nodes: [], edges: [], generatedAt: '2026-08-30T00:00:00.000Z' }),
    list: async () => [],
    remember: async (_body, request) => ({ action: 'stored', content: request.content }),
    forget: async (_body, idValue) => ({ id: idValue, action: 'deleted' }),
  }
}

export const nativeDescriptor: MemoryProviderDescriptor = {
  id: 'mnemon-native',
  label: 'Mnemon Native',
  icon: { kind: 'brand', value: 'mnemon' },
  kind: 'local',
  workspaceBinding: 'automatic',
  summary: 'Official local-first memory with exact writes, typed graph relations, and soft deletion.',
  summaryI18nKey: 'overview.providerSummary.mnemon-native',
  origin: 'native',
  capabilities: {
    search: true, browse: true, graph: true, entities: true, related: true,
    remember: true, link: true, forget: true, writeMode: 'exact', deletionMode: 'soft',
  },
  fields: [],
}

export const openvikingDescriptor: MemoryProviderDescriptor = {
  id: 'openviking',
  label: 'OpenViking',
  icon: { kind: 'data-url', value: DATA_URL_STUB },
  kind: 'remote',
  workspaceBinding: 'provider-global',
  summary: 'Filesystem-shaped shared memory with verified exact writes and semantic retrieval.',
  summaryI18nKey: 'overview.providerSummary.openviking',
  origin: 'third-party',
  capabilities: {
    search: true, browse: true, graph: false, entities: false, related: false,
    remember: true, link: false, forget: true, writeMode: 'exact', deletionMode: 'hard',
  },
  fields: [
    { key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'http://127.0.0.1:1933', placeholder: 'http://127.0.0.1:1933', i18nKey: 'overview.providerEndpoint' },
    {
      key: 'targetUri', label: 'Memory URI', scope: 'memory', input: 'text', required: true, defaultValue: 'viking://user/memories', placeholder: 'viking://user/memories',
      pattern: '^viking://user(?:/(?!\\.{1,2}/)[a-zA-Z0-9_.@-]+)?/memories$', normalize: 'trim-trailing-slash',
      validationMessage: 'OpenViking memory URI must be a viking://user/.../memories root', i18nKey: 'overview.providerTargetUri',
    },
    { key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: false, i18nKey: 'overview.providerApiKey' },
    { key: 'account', label: 'Account', scope: 'service', input: 'text', required: false, i18nKey: 'overview.providerAccount' },
    {
      key: 'discoveryUser', label: 'User key owner (skip admin)', scope: 'service', input: 'text', required: false, maxLength: 200,
      pattern: '^(?!\\.{1,2}$)(?!.*@.*@)[a-zA-Z0-9_.@\\-]+$', validationMessage: 'OpenViking discovery user must be a safe user ID', i18nKey: 'overview.providerDiscoveryUser',
    },
    { key: 'user', label: 'User', scope: 'memory', input: 'text', required: false, i18nKey: 'overview.providerUser' },
    { key: 'actorPeerId', label: 'Agent peer', scope: 'memory', input: 'text', required: false, defaultValue: 'dsh', i18nKey: 'overview.providerActorPeer' },
  ],
}

const honchoDescriptor: MemoryProviderDescriptor = {
  id: 'honcho',
  label: 'Honcho',
  icon: { kind: 'data-url', value: DATA_URL_STUB },
  kind: 'remote',
  workspaceBinding: 'provider-global',
  summary: 'Cross-session user modelling, peer profiles, dialectic reasoning, and persistent conclusions.',
  summaryI18nKey: 'overview.providerSummary.honcho',
  origin: 'third-party',
  capabilities: {
    search: true, browse: true, graph: false, entities: false, related: false,
    remember: true, link: false, forget: true, writeMode: 'exact', deletionMode: 'hard',
  } satisfies MemoryProviderCapabilities,
  fields: [
    { key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'https://api.honcho.dev', i18nKey: 'overview.providerEndpoint' },
    { key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: false, i18nKey: 'overview.providerApiKey' },
    { key: 'workspace', label: 'Workspace', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh', i18nKey: 'overview.providerField.workspace' },
    { key: 'userId', label: 'User peer', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh-user', i18nKey: 'overview.providerField.userId' },
    { key: 'agentId', label: 'Agent peer', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh', i18nKey: 'overview.providerField.agentId' },
  ],
}

const mem0Descriptor: MemoryProviderDescriptor = {
  id: 'mem0',
  label: 'Mem0',
  icon: { kind: 'data-url', value: DATA_URL_STUB },
  kind: 'remote',
  workspaceBinding: 'provider-global',
  summary: 'Automatic fact extraction, semantic retrieval, reranking, and deduplication.',
  summaryI18nKey: 'overview.providerSummary.mem0',
  origin: 'third-party',
  capabilities: {
    search: true, browse: true, graph: false, entities: false, related: false,
    remember: true, link: false, forget: true, writeMode: 'async-extracting', deletionMode: 'hard',
  },
  fields: [
    { key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'https://api.mem0.ai', i18nKey: 'overview.providerEndpoint' },
    { key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: false, i18nKey: 'overview.providerApiKey' },
    {
      key: 'mode', label: 'Mode', scope: 'service', input: 'select', required: true, defaultValue: 'platform',
      options: [
        { value: 'platform', label: 'Mem0 Platform', i18nKey: 'overview.providerOption.platform' },
        { value: 'self-hosted', label: 'Self-hosted server', i18nKey: 'overview.providerOption.self-hosted' },
      ],
      i18nKey: 'overview.providerField.mode',
    },
    { key: 'userId', label: 'User ID', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh-user', i18nKey: 'overview.providerField.userId' },
    { key: 'agentId', label: 'Agent ID', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh', i18nKey: 'overview.providerField.agentId' },
    { key: 'rerank', label: 'Rerank search results', scope: 'memory', input: 'boolean', required: false, defaultValue: false, i18nKey: 'overview.providerField.rerank' },
  ],
}

const hindsightDescriptor: MemoryProviderDescriptor = {
  id: 'hindsight',
  label: 'Hindsight',
  icon: { kind: 'data-url', value: DATA_URL_STUB },
  kind: 'remote',
  workspaceBinding: 'provider-global',
  summary: 'Knowledge-graph memory with entity resolution, observations, multi-strategy recall, and reflection.',
  summaryI18nKey: 'overview.providerSummary.hindsight',
  origin: 'third-party',
  capabilities: {
    search: true, browse: true, graph: true, entities: true, related: true,
    remember: true, link: false, forget: true, writeMode: 'async-extracting', deletionMode: 'soft',
  },
  fields: [
    { key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'https://api.hindsight.vectorize.io', i18nKey: 'overview.providerEndpoint' },
    { key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: false, i18nKey: 'overview.providerApiKey' },
    { key: 'bankId', label: 'Memory bank', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh', i18nKey: 'overview.providerField.bankId' },
    {
      key: 'budget', label: 'Recall budget', scope: 'memory', input: 'select', required: true, defaultValue: 'mid',
      options: [
        { value: 'low', label: 'Low', i18nKey: 'overview.providerOption.low' },
        { value: 'mid', label: 'Medium', i18nKey: 'overview.providerOption.mid' },
        { value: 'high', label: 'High', i18nKey: 'overview.providerOption.high' },
      ],
      i18nKey: 'overview.providerField.budget',
    },
  ],
}

const holographicDescriptor: MemoryProviderDescriptor = {
  id: 'holographic',
  label: 'Holographic',
  icon: { kind: 'data-url', value: DATA_URL_STUB },
  kind: 'local',
  workspaceBinding: 'optional-override',
  summary: 'Local structured fact memory with trust scoring, entity resolution, and compositional retrieval.',
  summaryI18nKey: 'overview.providerSummary.holographic',
  origin: 'third-party',
  capabilities: {
    search: true, browse: true, graph: true, entities: true, related: true,
    remember: true, link: false, forget: true, writeMode: 'exact', deletionMode: 'hard',
  },
  fields: [
    { key: 'dataPath', label: 'Fact store path', scope: 'service', role: 'global-location', input: 'path', required: false, i18nKey: 'overview.providerField.dataPath' },
    { key: 'defaultTrust', label: 'Default trust', scope: 'memory', input: 'number', required: true, defaultValue: 0.5, min: 0, max: 1, i18nKey: 'overview.providerField.defaultTrust' },
    { key: 'minTrust', label: 'Minimum recall trust', scope: 'memory', input: 'number', required: true, defaultValue: 0.3, min: 0, max: 1, i18nKey: 'overview.providerField.minTrust' },
  ],
}

const retaindbDescriptor: MemoryProviderDescriptor = {
  id: 'retaindb',
  label: 'RetainDB',
  icon: { kind: 'data-url', value: DATA_URL_STUB },
  kind: 'remote',
  workspaceBinding: 'provider-global',
  summary: 'Cloud memory with hybrid vector/BM25 retrieval, profiles, and typed durable facts.',
  summaryI18nKey: 'overview.providerSummary.retaindb',
  origin: 'third-party',
  capabilities: {
    search: true, browse: true, graph: false, entities: false, related: false,
    remember: true, link: false, forget: true, writeMode: 'exact', deletionMode: 'hard',
  },
  fields: [
    { key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'https://api.retaindb.com', i18nKey: 'overview.providerEndpoint' },
    { key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: true, i18nKey: 'overview.providerApiKey' },
    { key: 'project', label: 'Project', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh', i18nKey: 'overview.providerField.project' },
    { key: 'userId', label: 'User ID', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh-user', i18nKey: 'overview.providerField.userId' },
  ],
}

const byteroverDescriptor: MemoryProviderDescriptor = {
  id: 'byterover',
  label: 'ByteRover',
  icon: { kind: 'data-url', value: DATA_URL_STUB },
  kind: 'local',
  workspaceBinding: 'optional-override',
  summary: 'Local-first hierarchical knowledge tree accessed through the brv CLI.',
  summaryI18nKey: 'overview.providerSummary.byterover',
  origin: 'third-party',
  capabilities: {
    search: true, browse: false, graph: false, entities: false, related: false,
    remember: true, link: false, forget: false, writeMode: 'async-extracting', deletionMode: 'unsupported',
  },
  fields: [
    { key: 'cliPath', label: 'brv executable', scope: 'service', input: 'path', required: false, defaultValue: 'brv', i18nKey: 'overview.providerField.cliPath' },
    { key: 'defaultDirectory', label: 'Default knowledge directory', scope: 'service', role: 'global-location', input: 'path', required: false, discoveryDefaultFrom: 'workingDirectory', i18nKey: 'overview.providerField.defaultDirectory' },
    { key: 'workingDirectory', label: 'Knowledge directory', scope: 'memory', input: 'path', required: false, i18nKey: 'overview.providerField.workingDirectory' },
    { key: 'apiKey', label: 'Cloud API key', scope: 'service', input: 'secret', required: false, i18nKey: 'overview.providerApiKey' },
  ],
}

const supermemoryDescriptor: MemoryProviderDescriptor = {
  id: 'supermemory',
  label: 'Supermemory',
  icon: { kind: 'data-url', value: DATA_URL_STUB },
  kind: 'remote',
  workspaceBinding: 'provider-global',
  summary: 'Semantic memory, persistent profiles, conversation ingest, and multi-container recall.',
  summaryI18nKey: 'overview.providerSummary.supermemory',
  origin: 'third-party',
  capabilities: {
    search: true, browse: true, graph: false, entities: false, related: false,
    remember: true, link: false, forget: true, writeMode: 'async-extracting', deletionMode: 'soft',
  },
  fields: [
    { key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'https://api.supermemory.ai', i18nKey: 'overview.providerEndpoint' },
    { key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: true, i18nKey: 'overview.providerApiKey' },
    {
      key: 'containerTag', label: 'Container tag', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh',
      maxLength: 100, pattern: '^[a-zA-Z0-9_:-]+$', i18nKey: 'overview.providerField.containerTag',
    },
    {
      key: 'searchMode', label: 'Search mode', scope: 'memory', input: 'select', required: true, defaultValue: 'hybrid',
      options: [
        { value: 'hybrid', label: 'Hybrid', i18nKey: 'overview.providerOption.hybrid' },
        { value: 'memories', label: 'Memories', i18nKey: 'overview.providerOption.memories' },
        { value: 'documents', label: 'Documents', i18nKey: 'overview.providerOption.documents' },
      ],
      i18nKey: 'overview.providerField.searchMode',
    },
  ],
}

const p0 = makeProviderModule(nativeDescriptor, context => {
  if (context.nativeRunner === undefined) throw new Error('Mnemon Native requires nativeRunner')
  return new TestNativeProvider(context.nativeRunner, { defaultRecallLimit: context.config.defaultRecallLimit ?? 10 })
})
const p1 = makeProviderModule(
  openvikingDescriptor,
  context => new TestOpenVikingProvider(context.memorySpaces ?? context.memoryBodies, { label: 'OpenViking', requestTimeoutMs: context.config.timeoutMs }),
  'provider-native',
)
const p2 = makeProviderModule(honchoDescriptor, () => stubAdapter('honcho', { kind: 'provider-native' }), 'provider-native')
const p3 = makeProviderModule(mem0Descriptor, () => stubAdapter('mem0'))
const p4 = makeProviderModule(
  hindsightDescriptor,
  context => new TestHindsightProvider(context.memorySpaces ?? context.memoryBodies, { label: 'Hindsight', requestTimeoutMs: context.config.timeoutMs }),
  'provider-native',
)
const p5 = makeProviderModule(holographicDescriptor, context => {
  const authority = context.memorySpaces ?? context.memoryBodies
  return new TestHolographicProvider(authority, join(authority.runner.effectiveDataDir(), 'state', 'holographic', 'store.json'))
})
const p6 = makeProviderModule(retaindbDescriptor, () => stubAdapter('retaindb'))
const p7 = makeProviderModule(byteroverDescriptor, () => stubAdapter('byterover', { kind: 'provider-native' }), 'provider-native')
const p8 = makeProviderModule(supermemoryDescriptor, () => stubAdapter('supermemory'))

export const nativeDefinition = p0.definition
export const nativeProviderModule = p0.default

/** Synthetic local test assembly; zero dependency on external dsh-mnemon-provider-* packages. */
export const modules = [p0, p1, p2, p3, p4, p5, p6, p7, p8]
export const descriptors = modules.map(module => module.descriptor)
export const providerEntries = modules.map(module => ({ instanceId: module.descriptor.id, module: module.default, config: undefined }))
export const catalog = new MemoryProviderCatalog(descriptors)
export function adapterRegistry() {
  return new MemoryProviderAdapterRegistry(modules.map(({ definition }) => ({
    id: definition.manifest.typeId,
    scoreSemantics: definition.manifest.scoreSemantics === 'normalized-relevance' ? NORMALIZED_RELEVANCE_SCORE : { kind: 'provider-native' as const },
    create: context => definition.create({ ...context, providerInstanceId: definition.manifest.typeId, manifest: definition.manifest }),
  })))
}
export function createRegistry(
  runner: ConstructorParameters<typeof MemorySpaceRegistry>[0],
  enabled = true,
  now?: ConstructorParameters<typeof MemorySpaceRegistry>[2],
  providers = catalog,
) { return new MemorySpaceRegistry(runner, enabled, now, providers) }
export function createService(
  runner: ConstructorParameters<typeof MemorySpacesService>[0],
  config: ConstructorParameters<typeof MemorySpacesService>[1],
  bodies?: MemorySpaceRegistry,
  quality?: ConstructorParameters<typeof MemorySpacesService>[3],
  adapters = adapterRegistry(),
  providers = catalog,
) { return new MemorySpacesService(runner, config, bodies ?? createRegistry(runner), quality, adapters, providers) }

/** An executable stub so the runner sees an installed Mnemon CLI; tests fake the process it would start. */
export function installedCliStub(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'mnemon-cli-stub-')), process.platform === 'win32' ? 'mnemon.exe' : 'mnemon')
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return path
}
