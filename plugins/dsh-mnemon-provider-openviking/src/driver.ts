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
import { CATEGORIES, type MemoryProviderAdapter, type ProviderBodyStatus as ProviderSpaceStatus, type ProviderMemorySpace, type ProviderSearchResult } from 'dsh-mnemon-source-memory-spaces/provider-sdk'

interface OpenVikingEnvelope {
  status?: string
  result?: unknown
  error?: { code?: string; message?: string; trace_id?: string; details?: { resource?: unknown } }
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

type OpenVikingConnection = OpenVikingSpaceConnection & { discoveryUser?: string }

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The categories Mnemon writes; anything else is stored, and read back, as general. */
const CATEGORY_NAMES = new Set<string>(CATEGORIES)

function categoryOf(value: unknown): string {
  const category = string(value)?.trim().toLowerCase()
  return category !== undefined && CATEGORY_NAMES.has(category) ? category : 'general'
}

// Agent-authored memories use the content API; extraction counters cannot
// prove that a one-turn session stored the caller's text.
const MEMORY_FOLDERS: Record<string, string> = {
  preference: 'preferences',
  insight: 'experiences',
  decision: 'experiences',
  context: 'events',
  fact: 'entities',
  general: 'entities',
}

/**
 * The slug's share of a file name, which Linux caps at 255 bytes: the stamp, the longest
 * category, the UUID and the separators take 66, so 48 characters of four bytes would not fit.
 */
const SLUG_BYTES = 180

function memoryUri(root: string, category: string, content: string): string {
  const folder = Object.hasOwn(MEMORY_FOLDERS, category) ? MEMORY_FOLDERS[category] : 'entities'
  const firstLine = content.split('\n').find(line => line.trim().length > 0) ?? 'memory'
  const characters = Array.from(firstLine.replace(/^#+\s*/u, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/gu, '')).slice(0, 48)
  while (Buffer.byteLength(characters.join('').toLowerCase()) > SLUG_BYTES) characters.pop()
  const slug = characters.join('').toLowerCase() || 'memory'
  const stamp = new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14)
  // Folders hold two categories each, so the category travels in the file name too. The slug
  // never contains '_' and a UUID never does, so `_<category>-<uuid>.md` reads back exactly.
  return `${root}/${folder}/${stamp}-${slug}_${category}-${randomUUID()}.md`
}

function safeUser(user: string): boolean {
  return /^[a-zA-Z0-9_.@-]+$/u.test(user) && user !== '.' && user !== '..' && (user.match(/@/gu)?.length ?? 0) <= 1
}

function discoveryUser(connection: MemoryProviderConnection | OpenVikingConnection): string | undefined {
  const user = String(connection.discoveryUser ?? '').trim()
  if (user === '') return undefined
  if (!safeUser(user) || !safeUser(String(connection.account ?? '').trim())) {
    throw new Error('OpenViking user-key discovery requires an explicit account and a safe discovery user')
  }
  if (String(connection.apiKey ?? '').trim() === '') throw new Error('OpenViking user-key discovery requires a user API key')
  return user
}

function isMemoryFile(uri: string, root: string): boolean {
  if (!uri.startsWith(`${root}/`) || !uri.endsWith('.md') || /[%?#\\\u0000-\u001f\u007f]/u.test(uri)) return false
  return uri.slice(root.length + 1).split('/').every(part => part !== '' && !part.startsWith('.') && part.trim() === part)
}

function queueFailed(value: unknown): boolean {
  return Object.values(object(value) ?? {}).some(entry => {
    const queue = object(entry)
    return (number(queue?.error_count) ?? 0) > 0 || (Array.isArray(queue?.errors) && queue.errors.length > 0)
  })
}

/** What a folder holds, for files written before the category was in the name or by OpenViking itself. */
const FOLDER_CATEGORIES: Record<string, string> = { preferences: 'preference', experiences: 'insight', events: 'context', entities: 'fact' }

/** The category in the file name Mnemon wrote, else one the server reports, else the folder's. */
function categoryFromUri(uri: string, reported?: unknown): string {
  const named = /_([a-z]+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/u.exec(uri)?.[1]
  if (named !== undefined && CATEGORY_NAMES.has(named)) return named
  const stated = string(reported)
  if (stated !== undefined && CATEGORY_NAMES.has(stated)) return stated
  const marker = '/memories/'
  const folder = (uri.includes(marker) ? uri.slice(uri.indexOf(marker) + marker.length) : '').split('/')[0] ?? ''
  return Object.hasOwn(FOLDER_CATEGORIES, folder) ? FOLDER_CATEGORIES[folder]! : 'general'
}

/** Whether the server turned the request down as sent, so it wrote nothing: not a timeout or a server fault. */
function refused(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 409
}

export class OpenVikingProvider implements MemoryProviderAdapter {
  readonly id = 'openviking' as const
  readonly scoreSemantics = Object.freeze({ kind: 'provider-native' as const })
  private readonly requestFetch: typeof fetch
  private readonly requestTimeoutMs: number

  constructor(private readonly memorySpaces: MemorySpaceAuthority, options: OpenVikingProviderOptions = {}) {
    this.requestFetch = options.fetch ?? globalThis.fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000
  }

  async discover(connection: MemoryProviderConnection, signal?: AbortSignal): Promise<ProviderMemorySpace[]> {
    signal?.throwIfAborted()
    let account = String(connection.account ?? '').trim()
    const selectedUser = discoveryUser(connection)
    if (selectedUser !== undefined) {
      const targetUri = await this.validateUserNamespace(connection, selectedUser, signal)
      return [{
        externalId: `${account}:${selectedUser}`,
        name: selectedUser,
        description: `OpenViking memory namespace for ${selectedUser}`,
        connection: { targetUri, user: selectedUser, actorPeerId: 'dsh' },
      }]
    }
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
      if (user === undefined || !safeUser(user)) return []
      return [{
        externalId: `${account}:${user}`,
        name: string(item?.display_name) ?? string(item?.name) ?? user,
        description: string(item?.description) ?? string(item?.role) ?? `OpenViking memory namespace for ${user}`,
        connection: { targetUri: `viking://user/${user}/memories`, user, actorPeerId: 'dsh' },
      }]
    })
  }

  async status(body: MemorySpace, signal?: AbortSignal): Promise<ProviderSpaceStatus> {
    try {
      const connection = this.connection(body)
      const selectedUser = discoveryUser(connection)
      if (selectedUser === undefined) await this.request(body, '/health', {}, { signal, timeoutMs: 5_000 })
      else {
        await this.memoryRoot(body, signal)
        await this.validateUserNamespace(connection, selectedUser, signal)
      }
      return { healthy: true }
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async search(body: MemorySpace, request: SearchRequest, signal?: AbortSignal): Promise<ProviderSearchResult> {
    const memoryRoot = await this.memoryRoot(body, signal)
    if (request.mode === 'keyword') return this.keywordSearch(body, memoryRoot, request, signal)
    const result = await this.request(body, '/api/v1/search/find', {
      method: 'POST',
      body: JSON.stringify({
        query: request.query,
        target_uri: memoryRoot,
        context_type: ['memory'],
        limit: request.limit,
      }),
    }, { signal })
    const root = object(result)
    const entries = Array.isArray(root?.memories) ? root.memories : []
    const matches = entries.flatMap((value): Insight[] => {
        const item = object(value)
        const uri = string(item?.uri)
        if (uri === undefined || !isMemoryFile(uri, memoryRoot)) return []
        const score = number(item?.score)
        return [{
          id: uri,
          externalUri: uri,
          content: string(item?.overview) ?? string(item?.abstract) ?? uri,
          category: categoryFromUri(uri, item?.category),
          source: 'external',
          ...(score === undefined ? {} : { score }),
        }]
      }).slice(0, request.limit)
    const { read, skipped } = await this.readAll(body, matches, signal)
    return {
      results: read,
      ...(skipped === 0 ? {} : { hint: `${skipped} OpenViking ${skipped === 1 ? 'result' : 'results'} could not be read and ${skipped === 1 ? 'was' : 'were'} left out; the server's index can list a file it no longer holds.` }),
    }
  }

  /** Literal, case-insensitive search in the selected namespace (#452). */
  private async keywordSearch(body: MemorySpace, memoryRoot: string, request: SearchRequest, signal?: AbortSignal): Promise<ProviderSearchResult> {
    const query = request.query.trim()
    if (query === '') return { results: [] }
    const nodeLimit = 256
    let result: Record<string, unknown> | undefined
    try {
      result = object(await this.request(body, '/api/v1/search/grep', {
        method: 'POST',
        body: JSON.stringify({ uri: memoryRoot, pattern: query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), case_insensitive: true, node_limit: nodeLimit }),
      }, { signal }))
    } catch (error) {
      const failure = object(error)
      if (failure?.status === 404 && failure.resource === memoryRoot) return { results: [] }
      if (failure?.status === 405 || (failure?.status === 404 && failure.resource === undefined)) {
        throw new Error('This OpenViking server does not support keyword search (search/grep).', { cause: error })
      }
      throw error
    }
    const matches = Array.isArray(result?.matches) ? result.matches : []
    const seen = new Set<string>()
    const candidates = matches.flatMap((value): Insight[] => {
      const uri = string(object(value)?.uri)
      if (uri === undefined || !isMemoryFile(uri, memoryRoot) || seen.has(uri)) return []
      seen.add(uri)
      const category = categoryFromUri(uri)
      if (request.category !== undefined && request.category !== category) return []
      return [{ id: uri, externalUri: uri, content: uri, category, source: 'external' }]
    }).slice(0, Math.min(Math.max(request.limit ?? 10, 1), 50))
    const { read, skipped } = await this.readAll(body, candidates, signal)
    const hints = [
      ...(matches.length >= nodeLimit ? ['OpenViking keyword search reached its 256-line limit; narrow the query to find other matches.'] : []),
      ...(skipped > 0 ? [`${skipped} OpenViking keyword results could not be read and were left out.`] : []),
    ]
    return { results: read, ...(hints.length === 0 ? {} : { hint: hints.join(' ') }) }
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
    const memoryRoot = await this.memoryRoot(body, signal)
    const query = new URLSearchParams({ uri: memoryRoot, recursive: 'true', output: 'original' })
    const result = await this.request(body, `/api/v1/fs/ls?${query}`, {}, { signal })
    const entries = Array.isArray(result) ? result : []
    const limit = Math.min(Math.max(request.limit ?? 200, 1), 1000)
    const files = entries.flatMap((value): Array<{ item: Record<string, unknown>; uri: string }> => {
      const item = object(value)
      const uri = string(item?.uri)
      return item === undefined || uri === undefined || item.isDir === true || !isMemoryFile(uri, memoryRoot) ? [] : [{ item, uri }]
    }).slice(0, limit)
    const { read } = await this.readAll(body, files.map(({ item, uri }) => ({ id: uri, item })), signal)
    return read.map(({ item, id, content }): Insight => {
      const createdAt = string(item.modTime)
      return {
        id,
        externalUri: id,
        content,
        category: categoryFromUri(id),
        source: 'external',
        ...(createdAt === undefined ? {} : { createdAt }),
      }
    })
  }

  /**
   * Each listed memory with its full content, leaving out one the server cannot read: its index
   * can still list a file it no longer holds. When none can be read, the first failure is the
   * answer, so a server that cannot be reached is never shown as an empty space, and a cancelled
   * turn stops at once.
   */
  private async readAll<T extends { id: string }>(body: MemorySpace, items: readonly T[], signal?: AbortSignal): Promise<{ read: Array<T & { content: string }>; skipped: number }> {
    const settled = await Promise.allSettled(items.map(async item => ({ ...item, content: await this.readContent(body, item.id, signal) })))
    signal?.throwIfAborted()
    const read = settled.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : [])
    const failed = settled.find(outcome => outcome.status === 'rejected')
    if (read.length === 0 && failed !== undefined) throw failed.reason
    return { read, skipped: settled.length - read.length }
  }

  async remember(body: MemorySpace, request: RememberRequest, signal?: AbortSignal): Promise<JsonValue> {
    const root = await this.memoryRoot(body, signal)
    const category = categoryOf(request.category)
    const uri = memoryUri(root, category, request.content)
    const tags = ['source=mnemon', `category=${category}`]
    const importance = number(request.importance)
    if (importance !== undefined) tags.push(`importance=${importance}`)
    const writtenBytes = Buffer.byteLength(request.content, 'utf8')
    let written: Record<string, unknown> | undefined
    try {
      written = object(await this.request(body, '/api/v1/content/write', {
        method: 'POST',
        // Every WriteContentRequest from 0.4.16 to 0.5.2 declares these four and refuses any other field with
        // HTTP 400 (#353). 0.5.1 removed `timeout` (#455); the request's own deadline bounds the wait instead.
        body: JSON.stringify({ uri, content: request.content, mode: 'create', wait: true }),
      }, { signal }))
    } catch (error) {
      if (refused(error)) throw new Error(`OpenViking refused the write at ${uri}; nothing was stored. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      throw new Error(`OpenViking write was not verified at ${uri}; remote content may remain. Inspect this URI before retrying. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    try {
      // 0.5.1 counts the reserved MEMORY_FIELDS trailer it appends to a memory file (#455); earlier releases
      // count the text alone. Fewer bytes than the text is a short write; the exact readback below proves the rest.
      if (written?.uri !== uri || written.content_updated !== true || (number(written.written_bytes) ?? -1) < writtenBytes
        || written.mode !== 'create' || written.context_type !== 'memory'
        || written.vector_status !== 'complete' || !['complete', 'skipped'].includes(String(written.semantic_status))
        || queueFailed(written.queue_status)) {
        throw new Error('content API did not confirm this exact memory and completed indexing')
      }
      // The public read projection removes OpenViking's reserved metadata.
      // Reject normalization or a stale read rather than promising exactness.
      if (await this.readContent(body, uri, signal) !== request.content) throw new Error('stored content does not match the requested text')
      signal?.throwIfAborted()
    } catch (error) {
      // A server timeout can happen after the file was written. Do not retry,
      // fall back to extraction, or delete a target whose creation is uncertain.
      throw new Error(`OpenViking write was not verified at ${uri}; remote content may remain. Inspect this URI before retrying. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    return {
      action: 'stored',
      provider: 'openviking',
      id: uri,
      uri,
      externalUri: uri,
      summary: `OpenViking stored the memory at ${uri} (category ${category}).`,
      writtenBytes,
      vectorStatus: 'complete',
      tagsApplied: await this.tag(body, uri, tags, signal),
    }
  }

  /**
   * Label a verified memory. Tags only describe it - its category is in the URI too - so a server
   * without the endpoint, one that refuses or does not confirm the call, or one that is slow to
   * answer leaves an exact memory that is just untagged. The wait is short, as for `/health`:
   * the receipt is already true.
   */
  private async tag(body: MemorySpace, uri: string, tags: string[], signal?: AbortSignal): Promise<boolean> {
    try {
      const result = object(await this.request(body, '/api/v1/content/set_tags', { method: 'POST', body: JSON.stringify({ uri, tags, mode: 'replace' }) }, {
        signal, timeoutMs: Math.min(this.requestTimeoutMs, 5_000),
      }))
      return result?.tags_updated === true
    } catch {
      return false
    }
  }

  async forget(body: MemorySpace, id: string, signal?: AbortSignal): Promise<JsonValue> {
    const root = await this.memoryRoot(body, signal)
    const uri = id.trim()
    if (!isMemoryFile(uri, root)) {
      throw new Error('OpenViking forget requires an exact non-generated .md memory URI inside this Memory Space')
    }
    const query = new URLSearchParams({ uri, recursive: 'false' })
    const result = object(await this.request(body, `/api/v1/fs?${query}`, { method: 'DELETE' }, { signal })) ?? {}
    if (result.uri !== uri) throw new Error('OpenViking did not confirm deletion of the requested memory URI')
    return {
      action: 'deleted',
      provider: this.id,
      id: uri,
      uri,
      ...(number(result.estimated_deleted_count) === undefined ? {} : { estimatedDeletedCount: number(result.estimated_deleted_count)! }),
    }
  }

  private connection(body: MemorySpace): OpenVikingConnection {
    if ((body.provider.typeId ?? body.provider.id) !== this.id) throw new Error(`OpenViking cannot serve provider ${body.provider.id}`)
    const connection = this.memorySpaces.providerConnection(body.id, body.provider.id)
    return { endpoint: String(connection.endpoint ?? ''), targetUri: String(connection.targetUri ?? ''), apiKey: String(connection.apiKey ?? ''), account: String(connection.account ?? ''), user: String(connection.user ?? ''), actorPeerId: String(connection.actorPeerId ?? ''), discoveryUser: String(connection.discoveryUser ?? '') }
  }

  private async validateUserNamespace(connection: MemoryProviderConnection | OpenVikingConnection, user: string, signal?: AbortSignal): Promise<string> {
    const root = `viking://user/${user}/memories`
    // Health is unauthenticated on some deployments. A read-only, scoped data
    // request must succeed before the Host persists or replaces projections.
    const query = new URLSearchParams({ uri: root, recursive: 'false', output: 'original' })
    const result = await this.requestConnection(connection, `/api/v1/fs/ls?${query}`, {}, { signal })
    if (!Array.isArray(result) || result.some(item => !string(object(item)?.uri)?.startsWith(`${root}/`))) {
      throw new Error('OpenViking could not validate the selected memory namespace')
    }
    return root
  }

  private async memoryRoot(body: MemorySpace, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const connection = this.connection(body)
    const root = connection.targetUri.replace(/\/+$/u, '')
    const match = /^viking:\/\/user(?:\/([^/]+))?\/memories$/u.exec(root)
    if (match === null || (match[1] !== undefined && !safeUser(match[1]))) throw new Error('OpenViking memory URI must be a safe viking://user/<user>/memories root')
    const selectedUser = discoveryUser(connection)
    if (selectedUser !== undefined) {
      if ((match[1] !== undefined && match[1] !== selectedUser) || (connection.user?.trim() && connection.user.trim() !== selectedUser)) {
        throw new Error('OpenViking memory owner must match the configured discovery user')
      }
      return `viking://user/${selectedUser}/memories`
    }
    if (match[1] !== undefined) return root
    // Retain old persisted shorthand without sending the ambiguous URI to
    // newer servers. With no configured user, ask the authenticated backend.
    const user = connection.user?.trim() || string(object(await this.request(body, '/api/v1/system/status', {}, { signal }))?.user) || ''
    if (!safeUser(user)) throw new Error('OpenViking could not resolve the memory owner; configure an explicit user memory URI')
    return `viking://user/${user}/memories`
  }

  private async readContent(body: MemorySpace, uri: string, signal?: AbortSignal): Promise<string> {
    const result = await this.request(body, `/api/v1/content/read?${new URLSearchParams({ uri })}`, {}, { signal })
    if (typeof result !== 'string') throw new Error('OpenViking content read did not return text')
    return result
  }

  private async request(body: MemorySpace, path: string, init: RequestInit = {}, options: OpenVikingRequestOptions = {}): Promise<unknown> {
    const connection = this.connection(body)
    return this.requestConnection(connection, path, init, options)
  }

  private async requestConnection(connection: MemoryProviderConnection | OpenVikingConnection, path: string, init: RequestInit = {}, options: OpenVikingRequestOptions = {}): Promise<unknown> {
    options.signal?.throwIfAborted()
    // In api_key mode the backend binds the account/user to the key and
    // rejects trusted identity overrides. Preserve old discovery by default.
    const keyBound = discoveryUser(connection) !== undefined
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
          ...(keyBound || connection.account === undefined || connection.account === '' ? {} : { 'X-OpenViking-Account': String(connection.account) }),
          ...(keyBound || connection.user === undefined || connection.user === '' ? {} : { 'X-OpenViking-User': String(connection.user) }),
          ...(connection.actorPeerId === undefined || connection.actorPeerId === '' ? {} : { 'X-OpenViking-Actor-Peer': String(connection.actorPeerId) }),
          ...init.headers,
        },
        signal: controller.signal,
      })
      const envelope = await response.json().catch(() => ({})) as OpenVikingEnvelope
      if (!response.ok || envelope.status === 'error') {
        const trace = envelope.error?.trace_id ?? envelope.trace_id
        throw Object.assign(new Error(`${envelope.error?.message ?? `OpenViking HTTP ${response.status}`}${trace === undefined ? '' : ` (trace ${trace})`}`), {
          status: response.status, resource: string(envelope.error?.details?.resource),
        })
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
