import { randomUUID } from 'node:crypto'
import type { JsonValue } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import type { MemorySpaceAuthority } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import type {
  Insight,
  MemoryBody,
  MemoryGraphSnapshot,
  MemoryListRequest,
  MemoryProviderConnection,
  OpenVikingBodyConnection,
  RememberRequest,
  SearchRequest,
} from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { NORMALIZED_RELEVANCE_SCORE, type MemoryProviderAdapter, type ProviderBodyStatus, type ProviderMemorySpace, type ProviderSearchResult } from 'dsh-mnemon-source-memory-spaces/provider-sdk'

interface OpenVikingEnvelope {
  status?: string
  result?: unknown
  error?: { code?: string; message?: string; trace_id?: string }
  trace_id?: string
}

interface OpenVikingRequestOptions {
  timeoutMs?: number
  signal?: AbortSignal | undefined
}

interface OpenVikingProviderOptions {
  fetch?: typeof fetch
  requestTimeoutMs?: number
  settlementTimeoutMs?: number
  pollIntervalMs?: number
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason ?? new Error('OpenViking request aborted'))
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('OpenViking request aborted')) }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }, ms)
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

function categoryFromUri(uri: string): string {
  const marker = '/memories/'
  const suffix = uri.includes(marker) ? uri.slice(uri.indexOf(marker) + marker.length) : ''
  return suffix.split('/')[0]?.replace(/\.md$/u, '') || 'general'
}

export class OpenVikingProvider implements MemoryProviderAdapter {
  readonly id = 'openviking' as const
  readonly scoreSemantics = NORMALIZED_RELEVANCE_SCORE
  private readonly requestFetch: typeof fetch
  private readonly requestTimeoutMs: number
  private readonly settlementTimeoutMs: number
  private readonly pollIntervalMs: number

  constructor(private readonly memoryBodies: MemorySpaceAuthority, options: OpenVikingProviderOptions = {}) {
    this.requestFetch = options.fetch ?? globalThis.fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000
    this.settlementTimeoutMs = options.settlementTimeoutMs ?? 120_000
    this.pollIntervalMs = options.pollIntervalMs ?? 750
  }

  async discover(connection: MemoryProviderConnection, signal?: AbortSignal): Promise<ProviderMemorySpace[]> {
    let account = String(connection.account ?? '').trim()
    if (account === '') {
      const accounts = await this.requestConnection(connection, '/api/v1/admin/accounts', {}, { signal })
      const items = Array.isArray(accounts) ? accounts : []
      const ids = items.flatMap(value => {
        const id = string(object(value)?.account_id) ?? string(object(value)?.id)
        return id === undefined ? [] : [id]
      })
      if (ids.length > 1) throw new Error('OpenViking exposes multiple accounts; configure the account to select one discovery scope')
      account = ids[0] ?? 'default'
    }
    const users = await this.requestConnection({ ...connection, account }, `/api/v1/admin/accounts/${encodeURIComponent(account)}/users?limit=100`, {}, { signal })
    const items = Array.isArray(users) ? users : []
    return items.flatMap(value => {
      const item = object(value)
      const user = string(item?.user_id) ?? string(item?.id) ?? string(item?.name)
      if (user === undefined) return []
      return [{
        externalId: `${account}:${user}`,
        name: string(item?.display_name) ?? string(item?.name) ?? user,
        description: string(item?.description) ?? string(item?.role) ?? `OpenViking memory namespace for ${user}`,
        connection: { targetUri: 'viking://user/memories', user, actorPeerId: 'dsh' },
      }]
    })
  }

  async status(body: MemoryBody, signal?: AbortSignal): Promise<ProviderBodyStatus> {
    try {
      await this.request(body, '/health', {}, { signal, timeoutMs: 5_000 })
      return { healthy: true }
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async search(body: MemoryBody, request: SearchRequest, signal?: AbortSignal): Promise<ProviderSearchResult> {
    const connection = this.connection(body)
    const result = await this.request(body, '/api/v1/search/find', {
      method: 'POST',
      body: JSON.stringify({
        query: request.query,
        target_uri: connection.targetUri,
        context_type: ['memory'],
        limit: request.limit,
      }),
    }, { signal })
    const root = object(result)
    const entries = Array.isArray(root?.memories) ? root.memories : []
    return {
      results: entries.flatMap((value): Insight[] => {
        const item = object(value)
        const uri = string(item?.uri)
        if (uri === undefined) return []
        const score = number(item?.score)
        return [{
          id: uri,
          externalUri: uri,
          content: string(item?.overview) ?? string(item?.abstract) ?? uri,
          category: string(item?.category) ?? categoryFromUri(uri),
          source: 'external',
          ...(score === undefined ? {} : { score }),
        }]
      }),
    }
  }

  async graph(body: MemoryBody, signal?: AbortSignal): Promise<MemoryGraphSnapshot> {
    // Remote providers are projected as a bounded, disconnected browse view;
    // they do not pretend to expose Mnemon's typed graph relationships.
    const items = await this.list(body, { limit: 200 }, signal)
    return {
      nodes: items.map(item => ({ ...item, color: '#5568d9' })),
      edges: [],
      generatedAt: new Date().toISOString(),
    }
  }

  async list(body: MemoryBody, request: MemoryListRequest, signal?: AbortSignal): Promise<Insight[]> {
    const connection = this.connection(body)
    const query = new URLSearchParams({ uri: connection.targetUri, recursive: 'true', output: 'original' })
    const result = await this.request(body, `/api/v1/fs/ls?${query}`, {}, { signal })
    const entries = Array.isArray(result) ? result : []
    const limit = Math.min(Math.max(request.limit ?? 200, 1), 1000)
    const files = entries.flatMap((value): Array<{ item: Record<string, unknown>; uri: string }> => {
      const item = object(value)
      const uri = string(item?.uri)
      const filename = uri?.slice(uri.lastIndexOf('/') + 1)
      return item === undefined || uri === undefined || item.isDir === true || filename?.startsWith('.') === true || !uri.endsWith('.md') ? [] : [{ item, uri }]
    }).slice(0, limit)
    return Promise.all(files.map(async ({ item, uri }): Promise<Insight> => {
      let content = string(item.abstract) ?? string(item.overview) ?? ''
      if (content === '') {
        try {
          const read = await this.request(body, `/api/v1/content/abstract?uri=${encodeURIComponent(uri)}`, {}, { signal })
          content = string(read) ?? string(object(read)?.content) ?? string(object(read)?.abstract) ?? uri
        } catch { content = uri }
      }
      const createdAt = string(item.modTime)
      return {
        id: uri,
        externalUri: uri,
        content,
        category: categoryFromUri(uri),
        source: 'external',
        ...(createdAt === undefined ? {} : { createdAt }),
      }
    }))
  }

  async remember(body: MemoryBody, request: RememberRequest, signal?: AbortSignal): Promise<JsonValue> {
    const sessionId = `dsh-mnemon-${Date.now()}-${randomUUID()}`
    await this.request(body, '/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId }),
    }, { signal })
    await this.request(body, `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ role: 'user', content: request.content }),
    }, { signal })
    const committed = object(await this.request(body, `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`, {
      method: 'POST',
      body: JSON.stringify({ keep_recent_count: 0 }),
    }, { signal, timeoutMs: 30_000 }))
    const taskId = string(committed?.task_id)
    const archiveUri = string(committed?.archive_uri)
    if (taskId === undefined) {
      return {
        action: 'skipped',
        provider: 'openviking',
        summary: string(committed?.reason) ?? 'OpenViking did not archive a memory candidate.',
        sessionId,
      }
    }

    const task = await this.settleTask(body, taskId, signal)
    if (task === undefined) {
      return {
        action: 'queued',
        provider: 'openviking',
        summary: 'OpenViking accepted the session and is extracting durable memories asynchronously.',
        status: 'pending',
        taskId,
        sessionId,
        ...(archiveUri === undefined ? {} : { archiveUri }),
      }
    }
    const taskResult = object(task.result)
    const extracted = object(taskResult?.memories_extracted) ?? {}
    const total = Object.values(extracted).reduce<number>((sum, value) => sum + (number(value) ?? 0), 0)
    return {
      action: total > 0 ? 'stored' : 'skipped',
      provider: 'openviking',
      summary: total > 0 ? `OpenViking extracted ${total} durable ${total === 1 ? 'memory' : 'memories'}.` : 'OpenViking completed extraction without a durable memory change.',
      taskId,
      sessionId,
      ...(archiveUri === undefined ? {} : { archiveUri }),
      extracted: extracted as JsonValue,
    }
  }

  async forget(body: MemoryBody, id: string, signal?: AbortSignal): Promise<JsonValue> {
    const connection = this.connection(body)
    const uri = id.trim()
    const root = connection.targetUri.replace(/\/+$/u, '')
    const filename = uri.slice(uri.lastIndexOf('/') + 1)
    if (!uri.startsWith(`${root}/`) || !uri.endsWith('.md') || filename.startsWith('.')) {
      throw new Error('OpenViking forget requires an exact non-generated .md memory URI inside this Memory Space')
    }
    const query = new URLSearchParams({ uri, recursive: 'false' })
    const result = object(await this.request(body, `/api/v1/fs?${query}`, { method: 'DELETE' }, { signal })) ?? {}
    return {
      action: 'deleted',
      provider: this.id,
      uri: string(result.uri) ?? uri,
      ...(number(result.estimated_deleted_count) === undefined ? {} : { estimatedDeletedCount: number(result.estimated_deleted_count)! }),
    }
  }

  private connection(body: MemoryBody): OpenVikingBodyConnection {
    if ((body.provider.typeId ?? body.provider.id) !== this.id) throw new Error(`OpenViking cannot serve provider ${body.provider.id}`)
    const connection = this.memoryBodies.providerConnection(body.id, body.provider.id)
    return { endpoint: String(connection.endpoint ?? ''), targetUri: String(connection.targetUri ?? ''), apiKey: String(connection.apiKey ?? ''), account: String(connection.account ?? ''), user: String(connection.user ?? ''), actorPeerId: String(connection.actorPeerId ?? '') }
  }

  private async settleTask(body: MemoryBody, taskId: string, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
    const deadline = Date.now() + this.settlementTimeoutMs
    while (Date.now() < deadline) {
      const task = object(await this.request(body, `/api/v1/tasks/${encodeURIComponent(taskId)}`, {}, { signal, timeoutMs: 10_000 })) ?? {}
      const status = string(task.status)
      if (status === 'completed') return task
      if (status === 'failed' || status === 'cancelled') throw new Error(`OpenViking memory extraction ${status}: ${string(task.error) ?? taskId}`)
      await delay(this.pollIntervalMs, signal)
    }
    return undefined
  }

  private async request(body: MemoryBody, path: string, init: RequestInit = {}, options: OpenVikingRequestOptions = {}): Promise<unknown> {
    const connection = this.connection(body)
    return this.requestConnection(connection, path, init, options)
  }

  private async requestConnection(connection: MemoryProviderConnection | OpenVikingBodyConnection, path: string, init: RequestInit = {}, options: OpenVikingRequestOptions = {}): Promise<unknown> {
    options.signal?.throwIfAborted()
    const controller = new AbortController()
    const relay = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', relay, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('OpenViking request timed out')), options.timeoutMs ?? this.requestTimeoutMs)
    try {
      const response = await this.requestFetch(`${connection.endpoint}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(connection.apiKey === undefined || connection.apiKey === '' ? {} : { Authorization: `Bearer ${connection.apiKey}` }),
          ...(connection.account === undefined || connection.account === '' ? {} : { 'X-OpenViking-Account': String(connection.account) }),
          ...(connection.user === undefined || connection.user === '' ? {} : { 'X-OpenViking-User': String(connection.user) }),
          ...(connection.actorPeerId === undefined || connection.actorPeerId === '' ? {} : { 'X-OpenViking-Actor-Peer': String(connection.actorPeerId) }),
          ...init.headers,
        },
        signal: controller.signal,
      })
      const envelope = await response.json().catch(() => ({})) as OpenVikingEnvelope
      if (!response.ok || envelope.status === 'error') {
        const trace = envelope.error?.trace_id ?? envelope.trace_id
        throw new Error(`${envelope.error?.message ?? `OpenViking HTTP ${response.status}`}${trace === undefined ? '' : ` (trace ${trace})`}`)
      }
      return envelope.result ?? envelope
    } catch (error) {
      if (controller.signal.aborted && options.signal?.aborted !== true) throw new Error(`OpenViking request timed out after ${options.timeoutMs ?? this.requestTimeoutMs}ms`)
      throw error
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', relay)
    }
  }
}
