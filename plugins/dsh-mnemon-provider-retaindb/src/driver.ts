import { descriptor } from './descriptor.ts'
import type { JsonValue } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import type { MemorySpaceAuthority } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import type { Insight, MemoryBody as MemorySpace, MemoryListRequest, RememberRequest, SearchRequest } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { HttpMemoryProvider, firstArray, jsonNumber, jsonObject, jsonString, type HttpProviderOptions } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { type MemoryProviderAdapter, type ProviderBodyStatus as ProviderSpaceStatus, type ProviderMemorySpace, type ProviderSearchResult } from 'dsh-mnemon-source-memory-spaces/provider-sdk'

function insight(value: unknown): Insight | undefined {
  const row = jsonObject(value)
  // Server search wraps the memory; Local and list responses return it directly.
  const item = jsonObject(row?.memory) ?? row
  const id = jsonString(item?.id) ?? jsonString(item?.memory_id)
  const content = jsonString(item?.content) ?? jsonString(item?.memory) ?? jsonString(item?.text)
  if (id === undefined || content === undefined) return undefined
  const score = jsonNumber(row?.score) ?? jsonNumber(row?.similarity) ?? jsonNumber(item?.score) ?? jsonNumber(item?.similarity)
  const createdAt = jsonString(item?.created_at) ?? jsonString(item?.createdAt) ?? jsonString(item?.updated_at)
  return {
    id,
    content,
    category: categoryOf(item),
    source: 'external',
    ...(score === undefined ? {} : { score }),
    ...(createdAt === undefined ? {} : { createdAt }),
  }
}

/**
 * Whether a request failed because this deployment does not serve the endpoint.
 *
 * RetainDB exposes a current and a legacy surface, and only a missing endpoint
 * may fall through to the legacy one. Everything else - a 5xx, a timeout, or a
 * caller abort - must reach the caller untouched: the timeout in particular is
 * ambiguous, so retrying `remember`'s POST on it can store the memory twice.
 */
function isEndpointMissing(error: unknown): boolean {
  return error instanceof Error && /HTTP 404\b/u.test(error.message)
}

/**
 * The importance sent for the Source's default 3: the middle of the 0.5..0.9 band
 * RetainDB's own writers use. Its SDK's extraction keeps importance within 0.5..1,
 * falling back to 0.7, and RetainDB Local writes 0.55 to 0.92.
 */
const IMPORTANCE_AT_DEFAULT = 0.7

/** How far one step of the Source's 1..5 importance moves the importance sent. */
const IMPORTANCE_PER_STEP = 0.1

/** The 1..5 importance a request carries, if any, read as the Holographic Provider reads it. */
function importanceLevel(value: unknown): number | undefined {
  const level = Number(value)
  return value === undefined || value === null || !Number.isFinite(level) ? undefined : Math.min(5, Math.max(1, Math.round(level)))
}

/**
 * The importance sent to RetainDB, which takes 0..1. RetainDB Server refuses a
 * value above 1 with HTTP 400 and defaults to 0.5; RetainDB Local defaults to 0.62.
 * The Source's integer 1..5 (3 when the writer gives none) maps onto 0.5..0.9:
 * 3 is sent as 0.7, and each step above or below moves it by 0.1. A request
 * without a usable importance is sent as 0.7. The 1..5 value used to be sent as is.
 */
function retainDbImportance(importance: unknown): number {
  const level = importanceLevel(importance)
  const steps = level === undefined ? 0 : level - 3
  // Two decimals, so 1 is sent as 0.5 rather than 0.49999999999999994.
  return Math.round((IMPORTANCE_AT_DEFAULT + steps * IMPORTANCE_PER_STEP) * 100) / 100
}

/** The Memory Spaces categories RetainDB Server's POST /v1/memory takes under the same name. */
const SHARED_MEMORY_TYPES: ReadonlySet<string> = new Set(['preference', 'decision'])

/**
 * RetainDB's memory type for a Memory Spaces category. RetainDB Server answers a
 * type outside its list with HTTP 400. POST /v1/memory takes `preference` and
 * `decision`, but neither `fact`, `insight`, `context` nor `general`; those are sent
 * as `factual`, the type RetainDB itself falls back to. The legacy POST /v1/memories
 * takes only factual, episodic, semantic and procedural, so it gets `factual` for
 * every category. RetainDB Local takes any type and infers its own from the text;
 * where it finds none, it already fell back to `factual` for those four.
 */
function memoryType(category: string | undefined, endpoint: '/v1/memory' | '/v1/memories'): string {
  return endpoint === '/v1/memory' && category !== undefined && SHARED_MEMORY_TYPES.has(category) ? category : 'factual'
}

/**
 * The Memory Spaces category of a memory RetainDB returns. Its type comes as
 * `memory_type`, or as `type` in RetainDB Local's search results; `preference`
 * and `decision` map back to those categories, and any other type reads as general.
 */
function categoryOf(item: ReturnType<typeof jsonObject>): string {
  const type = jsonString(item?.memory_type) ?? jsonString(item?.type) ?? jsonString(item?.category)
  return type !== undefined && SHARED_MEMORY_TYPES.has(type) ? type : 'general'
}

export class RetainDbProvider extends HttpMemoryProvider implements MemoryProviderAdapter {
  readonly id = 'retaindb' as const
  readonly scoreSemantics = Object.freeze({ kind: 'provider-native' as const })

  constructor(memorySpaces: MemorySpaceAuthority, options: HttpProviderOptions = {}) {
    super(memorySpaces, { label: descriptor.label, ...options })
  }

  async discover(connection: Record<string, string | number | boolean>, signal?: AbortSignal): Promise<ProviderMemorySpace[]> {
    const payload = await this.requestConnection(connection, '/v1/projects', { headers: this.headers(connection, '/v1/projects'), signal })
    return firstArray(payload, 'projects', 'items').flatMap(value => {
      const item = jsonObject(value)
      const project = jsonString(item?.slug) ?? jsonString(item?.name) ?? jsonString(item?.id)
      if (project === undefined) return []
      return [{
        externalId: jsonString(item?.id) ?? project,
        name: jsonString(item?.name) ?? project,
        description: jsonString(item?.description) ?? `RetainDB project ${project}`,
        connection: { project, userId: '*' },
      }]
    })
  }

  async status(body: MemorySpace, signal?: AbortSignal): Promise<ProviderSpaceStatus> {
    try {
      await this.list(body, { limit: 1 }, signal)
      return { healthy: true }
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async search(body: MemorySpace, request: SearchRequest, signal?: AbortSignal): Promise<ProviderSearchResult> {
    const connection = this.connection(body)
    const payload = await this.request(body, '/v1/memory/search', {
      headers: this.headers(connection, '/v1/memory/search'),
      json: {
        project: String(connection.project),
        query: request.query,
        ...(String(connection.userId) === '*' ? {} : { user_id: String(connection.userId) }),
        session_id: `dsh-${body.id}`,
        top_k: request.limit ?? 10,
        include_pending: true,
      },
      signal,
    })
    return { results: firstArray(payload, 'results', 'memories').map(insight).filter((item): item is Insight => item !== undefined) }
  }

  async list(body: MemorySpace, request: MemoryListRequest, signal?: AbortSignal): Promise<Insight[]> {
    const connection = this.connection(body)
    const params = new URLSearchParams({ project: String(connection.project), include_pending: 'true' })
    let payload: unknown
    if (String(connection.userId) === '*') {
      params.set('limit', String(Math.min(Math.max(request.limit ?? 200, 1), 200)))
      payload = await this.request(body, `/v1/memories?${params}`, { headers: this.headers(connection, '/v1/memories'), signal })
    } else {
      try {
        payload = await this.request(body, `/v1/memory/profile/${encodeURIComponent(String(connection.userId))}?${params}`, {
          headers: this.headers(connection, '/v1/memory/profile'),
          signal,
        })
      } catch (error) {
        if (!isEndpointMissing(error)) throw error
        params.set('user_id', String(connection.userId))
        params.set('limit', String(Math.min(Math.max(request.limit ?? 200, 1), 200)))
        payload = await this.request(body, `/v1/memories?${params}`, { headers: this.headers(connection, '/v1/memories'), signal })
      }
    }
    return firstArray(payload, 'memories', 'results').map(insight).filter((item): item is Insight => item !== undefined)
      .filter(item => request.category === undefined || item.category === request.category)
      .slice(0, Math.min(Math.max(request.limit ?? 200, 1), 200))
  }

  async remember(body: MemorySpace, request: RememberRequest, signal?: AbortSignal): Promise<JsonValue> {
    const connection = this.connection(body)
    const json = {
      project: String(connection.project),
      content: request.content,
      memory_type: memoryType(request.category, '/v1/memory'),
      user_id: String(connection.userId) === '*' ? 'dsh-user' : String(connection.userId),
      session_id: `dsh-${body.id}`,
      importance: retainDbImportance(request.importance),
      write_mode: 'sync',
    } as const
    let payload: unknown
    try {
      payload = await this.request(body, '/v1/memory', { headers: this.headers(connection, '/v1/memory'), json, signal })
    } catch (error) {
      if (!isEndpointMissing(error)) throw error
      const { write_mode: _writeMode, ...current } = json
      // The legacy endpoint queues a write unless `async` is false; ask it to store before it answers.
      const legacy = { ...current, memory_type: memoryType(request.category, '/v1/memories'), async: false }
      payload = await this.request(body, '/v1/memories', { headers: this.headers(connection, '/v1/memories'), json: legacy, signal })
    }
    const result = jsonObject(payload) ?? {}
    const status = String(result.status).toLowerCase()
    if (result.success === false || ['error', 'failed'].includes(status)) {
      throw new Error('RetainDB did not confirm a stored memory; check the server before retrying.')
    }
    // A server that queued the write anyway answers with a job, not a memory: report it as queued, not stored.
    const jobId = jsonString(result.jobId) ?? jsonString(result.job_id)
    if (jsonString(result.mode) === 'async' || ['queued', 'pending', 'processing'].includes(status) || jobId !== undefined) {
      return { action: 'queued', provider: this.id, summary: 'RetainDB queued the memory; it is not stored yet.', ...(jobId === undefined ? {} : { jobId }) }
    }
    // RetainDB Local answers with `id`; RetainDB Server with `memory_id`, or only the stored `memory`.
    const id = jsonString(result.id) ?? jsonString(result.memory_id) ?? jsonString(jsonObject(result.memory)?.id)
    if (id === undefined) {
      throw new Error('RetainDB did not confirm a stored memory; the write outcome is unknown. Check the server before retrying.')
    }
    return {
      action: 'stored',
      provider: this.id,
      summary: 'RetainDB stored the memory synchronously.',
      id,
    }
  }

  async forget(body: MemorySpace, id: string, signal?: AbortSignal): Promise<JsonValue> {
    const connection = this.connection(body)
    try {
      await this.request(body, `/v1/memory/${encodeURIComponent(id)}`, { method: 'DELETE', headers: this.headers(connection, '/v1/memory'), signal })
    } catch (error) {
      if (!isEndpointMissing(error)) throw error
      await this.request(body, `/v1/memories/${encodeURIComponent(id)}`, { method: 'DELETE', headers: this.headers(connection, '/v1/memories'), signal })
    }
    return { action: 'deleted', provider: this.id, id }
  }

  private headers(connection: Record<string, string | number | boolean>, path: string): HeadersInit {
    const token = String(connection.apiKey ?? '').replace(/^Bearer\s+/iu, '')
    return {
      Authorization: `Bearer ${token}`,
      'x-sdk-runtime': 'dsh-mnemon',
      ...(path.startsWith('/v1/memory') || path.startsWith('/v1/context') ? { 'X-API-Key': token } : {}),
    }
  }
}
