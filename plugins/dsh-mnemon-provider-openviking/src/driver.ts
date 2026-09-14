import { randomUUID } from 'node:crypto'
import type { JsonValue } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import type { MemorySpaceAuthority } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import type {
  Insight,
  MemoryBody as MemorySpace,
  MemoryGraphSnapshot,
  MemoryListRequest,
  MemoryProviderConnection,
  OpenVikingBodyConnection as OpenVikingSpaceConnection,
  RememberRequest,
  SearchRequest,
} from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { NORMALIZED_RELEVANCE_SCORE, type MemoryProviderAdapter, type ProviderBodyStatus as ProviderSpaceStatus, type ProviderMemorySpace, type ProviderSearchResult } from 'dsh-mnemon-source-memory-spaces/provider-sdk'

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

/**
 * OpenViking keeps long-term memory as markdown files under the memory
 * namespace, and its extraction pipeline only derives durable memories from a
 * conversation: a session whose single turn carries the memorized text is
 * committed with an empty diff, so remember() used to report success while
 * nothing was stored. Writing the file through the content API keeps the write
 * deterministic and makes it retrievable as soon as it returns.
 */
const MEMORY_FOLDERS: Record<string, string> = {
  preference: 'preferences',
  insight: 'experiences',
  decision: 'experiences',
  context: 'events',
  fact: 'entities',
  general: 'entities',
}

function memoryUri(root: string, category: string, content: string): string {
  const folder = MEMORY_FOLDERS[category] ?? 'entities'
  const firstLine = content.split('\n').find(line => line.trim().length > 0) ?? 'memory'
  const slug = firstLine.replace(/^#+\s*/u, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48).toLowerCase() || 'memory'
  const stamp = new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14)
  return `${root}/${folder}/${stamp}-${slug}-${randomUUID().slice(0, 8)}.md`
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

  constructor(private readonly memorySpaces: MemorySpaceAuthority, options: OpenVikingProviderOptions = {}) {
    this.requestFetch = options.fetch ?? globalThis.fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000
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

  async status(body: MemorySpace, signal?: AbortSignal): Promise<ProviderSpaceStatus> {
    try {
      await this.request(body, '/health', {}, { signal, timeoutMs: 5_000 })
      return { healthy: true }
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async search(body: MemorySpace, request: SearchRequest, signal?: AbortSignal): Promise<ProviderSearchResult> {
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

  async graph(body: MemorySpace, signal?: AbortSignal): Promise<MemoryGraphSnapshot> {
    // Remote providers are projected as a bounded, disconnected browse view;
    // they do not pretend to expose Mnemon's typed graph relationships.
    const items = await this.list(body, { limit: 200 }, signal)
    return {
      nodes: items.map(item => ({ ...item, color: '#5568d9' })),
      edges: [],
      generatedAt: new Date().toISOString(),
    }
  }

  async list(body: MemorySpace, request: MemoryListRequest, signal?: AbortSignal): Promise<Insight[]> {
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

  async remember(body: MemorySpace, request: RememberRequest, signal?: AbortSignal): Promise<JsonValue> {
    const connection = this.connection(body)
    const root = connection.targetUri.replace(/\/+$/u, '')
    if (root === '') throw new Error('OpenViking memory space requires a memory URI')
    const category = string(request.category) ?? 'general'
    const uri = memoryUri(root, category, request.content)
    const tags = ['source=mnemon', `category=${category}`]
    const importance = number(request.importance)
    if (importance !== undefined) tags.push(`importance=${importance}`)
    const written = object(await this.request(body, '/api/v1/content/write', {
      method: 'POST',
      body: JSON.stringify({ uri, content: request.content, mode: 'replace', wait: true, tags }),
    }, { signal, timeoutMs: Math.max(this.requestTimeoutMs, 60_000) })) ?? {}
    const rootUri = string(written.root_uri)
    const writtenBytes = number(written.written_bytes)
    return {
      action: 'stored',
      provider: 'openviking',
      uri,
      externalUri: uri,
      summary: `OpenViking stored the memory at ${uri} (category ${category}).`,
      ...(rootUri === undefined ? {} : { rootUri }),
      ...(writtenBytes === undefined ? {} : { writtenBytes }),
      vectorStatus: string(written.vector_status) ?? 'unknown',
    }
  }

  async forget(body: MemorySpace, id: string, signal?: AbortSignal): Promise<JsonValue> {
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

  private connection(body: MemorySpace): OpenVikingSpaceConnection {
    if ((body.provider.typeId ?? body.provider.id) !== this.id) throw new Error(`OpenViking cannot serve provider ${body.provider.id}`)
    const connection = this.memorySpaces.providerConnection(body.id, body.provider.id)
    return { endpoint: String(connection.endpoint ?? ''), targetUri: String(connection.targetUri ?? ''), apiKey: String(connection.apiKey ?? ''), account: String(connection.account ?? ''), user: String(connection.user ?? ''), actorPeerId: String(connection.actorPeerId ?? '') }
  }

  private async request(body: MemorySpace, path: string, init: RequestInit = {}, options: OpenVikingRequestOptions = {}): Promise<unknown> {
    const connection = this.connection(body)
    return this.requestConnection(connection, path, init, options)
  }

  private async requestConnection(connection: MemoryProviderConnection | OpenVikingSpaceConnection, path: string, init: RequestInit = {}, options: OpenVikingRequestOptions = {}): Promise<unknown> {
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
