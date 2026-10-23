import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemorySpaceProviderFixture } from 'dsh-mnemon-source-memory-spaces/testing'
import type { Category, MemoryProviderConnection, MemoryProviderId } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { RetainDbProvider, descriptor } from '../src/index.ts'

const temporaryDirectories: string[] = []
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

async function providerBody(providerId: MemoryProviderId, connection: MemoryProviderConnection) {
  if (providerId !== descriptor.id) throw new Error('Wrong Provider fixture')
  const dataDir = mkdtempSync(join(tmpdir(), 'mnemon-retaindb-driver-'))
  temporaryDirectories.push(dataDir)
  const { authority: registry, body } = createMemorySpaceProviderFixture(descriptor, connection, { dataDir, instanceId: 'work-account' })
  return { registry, body }
}

function response(payload: unknown, status = 200): Response {
  return new Response(payload === undefined ? null : JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('standalone retaindb data plane', () => {
  it('discovers its native namespaces independently', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response({ projects: [{ id: 'project-1', name: 'Launch', slug: 'launch', description: 'RetainDB source metadata.' }] }))
    const retain = await providerBody('retaindb', { endpoint: 'https://retain.example', apiKey: 'key', project: 'old', userId: 'user' })
    await expect(new RetainDbProvider(retain.registry, { fetch: fetchMock }).discover({ endpoint: 'https://retain.example', apiKey: 'key' })).resolves.toEqual([
      expect.objectContaining({ externalId: 'project-1', name: 'Launch', description: 'RetainDB source metadata.', connection: { project: 'launch', userId: '*' } }),
    ])
  })

  it('only falls back to the legacy surface when the endpoint is missing', async () => {
    const requests: string[] = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      requests.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`)
      return response({ message: 'upstream exploded' }, 500)
    })
    const { registry, body } = await providerBody('retaindb', {
      endpoint: 'https://api.retaindb.com', apiKey: 'retain-secret', project: 'launch', userId: 'alice',
    })
    const provider = new RetainDbProvider(registry, { fetch: fetchMock })

    // A 5xx must reach the caller. Retrying remember's POST after an ambiguous
    // failure would store the memory twice on the legacy surface.
    await expect(provider.remember(body, { content: 'Canary before production.' })).rejects.toThrow(/HTTP 500/u)
    await expect(provider.forget(body, 'ret-1')).rejects.toThrow(/HTTP 500/u)

    expect(requests).toEqual(['POST /v1/memory', 'DELETE /v1/memory/ret-1'])
  })

  it('lists a project-wide scope on the collection endpoint without probing the profile endpoint', async () => {
    const requests: string[] = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname
      requests.push(`${init?.method ?? 'GET'} ${path}`)
      if (path === '/v1/memories') return response({ memories: [{ id: 'ret-9', content: 'Project wide.' }] })
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    const { registry, body } = await providerBody('retaindb', {
      endpoint: 'https://api.retaindb.com', apiKey: 'retain-secret', project: 'launch', userId: '*',
    })
    const provider = new RetainDbProvider(registry, { fetch: fetchMock })

    await expect(provider.list(body, {})).resolves.toEqual([
      expect.objectContaining({ id: 'ret-9', content: 'Project wide.' }),
    ])
    expect(requests).toEqual(['GET /v1/memories'])
  })

  it('falls back from the profile endpoint to the collection endpoint on 404', async () => {
    const requests: string[] = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname
      requests.push(`${init?.method ?? 'GET'} ${path}`)
      if (path.startsWith('/v1/memory/profile/')) return response({ message: 'missing' }, 404)
      if (path === '/v1/memories') return response({ memories: [{ id: 'ret-3', content: 'Fallback.' }] })
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    const { registry, body } = await providerBody('retaindb', {
      endpoint: 'https://api.retaindb.com', apiKey: 'retain-secret', project: 'launch', userId: 'alice',
    })
    const provider = new RetainDbProvider(registry, { fetch: fetchMock })

    await expect(provider.list(body, {})).resolves.toEqual([
      expect.objectContaining({ id: 'ret-3', content: 'Fallback.' }),
    ])
    expect(requests).toEqual(['GET /v1/memory/profile/alice', 'GET /v1/memories'])
  })

  it('preserves RetainDB project/user/session scope and current-to-legacy fallbacks', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({ url: String(url), ...(init === undefined ? {} : { init }) })
      const path = new URL(String(url)).pathname
      if (path === '/v1/memory/search') return response({ memories: [{ id: 'ret-1', content: 'Use staged rollout.', score: 0.8, memory_type: 'decision' }] })
      if (path === '/v1/memory') return response({ message: 'missing' }, 404)
      if (path === '/v1/memories' && init?.method === 'POST') return response({ id: 'ret-2' })
      if (path === '/v1/memory/ret-1') return response({ message: 'missing' }, 404)
      if (path === '/v1/memories/ret-1') return response({ deleted: true })
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    const { registry, body } = await providerBody('retaindb', {
      endpoint: 'https://api.retaindb.com', apiKey: 'retain-secret', project: 'launch', userId: 'alice',
    })
    const provider = new RetainDbProvider(registry, { fetch: fetchMock })

    await expect(provider.search(body, { query: 'rollout', limit: 4 })).resolves.toEqual({
      results: [expect.objectContaining({ id: 'ret-1', category: 'decision', score: 0.8 })],
    })
    await expect(provider.remember(body, { content: 'Canary before production.', category: 'decision' })).resolves.toMatchObject({ id: 'ret-2' })
    await expect(provider.forget(body, 'ret-1')).resolves.toMatchObject({ action: 'deleted' })

    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ project: 'launch', user_id: 'alice', top_k: 4 })
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer retain-secret')
    expect(new Headers(requests[0]?.init?.headers).get('X-API-Key')).toBe('retain-secret')
    expect(requests.map(request => new URL(request.url).pathname)).toContain('/v1/memories/ret-1')
  })

  describe('importance on RetainDB\'s 0..1 scale', () => {
    // The Memory Spaces Source sends every Provider an integer importance from 1 to 5, and 3 when the
    // writer gives none. RetainDB takes 0..1: Server refuses more than 1 and defaults to 0.5, Local
    // defaults to 0.62. The Provider maps 1..5 onto 0.5..0.9, the band RetainDB's own writers use.
    async function remember(importance: number | undefined, { currentMissing = false } = {}) {
      const sent: Array<{ path: string; json: Record<string, unknown> }> = []
      const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
        const path = new URL(String(url)).pathname
        sent.push({ path, json: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return currentMissing && path === '/v1/memory' ? response({ message: 'missing' }, 404) : response({ id: 'ret-7' })
      })
      const { registry, body } = await providerBody('retaindb', {
        endpoint: 'https://api.retaindb.com', apiKey: 'retain-secret', project: 'launch', userId: 'alice',
      })
      await new RetainDbProvider(registry, { fetch: fetchMock })
        .remember(body, { content: 'Canary before production.', category: 'decision', ...(importance === undefined ? {} : { importance }) })
      return { sent, sessionId: `dsh-${body.id}` }
    }

    it.each([[1, 0.5], [2, 0.6], [3, 0.7], [4, 0.8], [5, 0.9]])('sends importance %i as %s', async (importance, expected) => {
      const { sent, sessionId } = await remember(importance)
      expect(sent).toEqual([{ path: '/v1/memory', json: {
        project: 'launch', content: 'Canary before production.', memory_type: 'decision', user_id: 'alice',
        session_id: sessionId, importance: expected, write_mode: 'sync',
      } }])
    })

    it('sends 0.7, the middle of the band, when the request carries no importance', async () => {
      const { sent } = await remember(undefined)
      expect(sent.map(request => request.json.importance)).toEqual([0.7])
    })

    it('rounds the importance to a whole step and clamps it to 1..5, as the Holographic Provider does', async () => {
      const sentFor = async (importance: number) => (await remember(importance)).sent.map(request => request.json.importance)
      expect([await sentFor(9), await sentFor(-9), await sentFor(2.4), await sentFor(3.6)]).toEqual([[0.9], [0.5], [0.6], [0.8]])
    })

    it('treats an importance that is not a finite number as none', async () => {
      const sentFor = async (importance: number) => (await remember(importance)).sent.map(request => request.json.importance)
      expect([await sentFor(Number.NaN), await sentFor(Number.POSITIVE_INFINITY), await sentFor(Number.NEGATIVE_INFINITY)]).toEqual([[0.7], [0.7], [0.7]])
    })

    it('sends the same importance to the legacy endpoint', async () => {
      const { sent } = await remember(5, { currentMissing: true })
      expect(sent.map(request => [request.path, request.json.importance])).toEqual([['/v1/memory', 0.9], ['/v1/memories', 0.9]])
    })
  })

  describe('memory types RetainDB Server accepts', () => {
    // RetainDB Server answers a memory_type outside its list with HTTP 400. POST /v1/memory takes preference and
    // decision but not fact, insight, context or general; the legacy POST /v1/memories takes only factual, episodic,
    // semantic and procedural. The Source always sends a category, general by default.
    async function sentTypes(category: Category | undefined) {
      const sent: Array<[string, unknown]> = []
      const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
        const path = new URL(String(url)).pathname
        sent.push([path, (JSON.parse(String(init?.body)) as Record<string, unknown>).memory_type])
        return path === '/v1/memory' ? response({ message: 'missing' }, 404) : response({ id: 'ret-8' })
      })
      const { registry, body } = await providerBody('retaindb', {
        endpoint: 'https://api.retaindb.com', apiKey: 'retain-secret', project: 'launch', userId: 'alice',
      })
      await new RetainDbProvider(registry, { fetch: fetchMock })
        .remember(body, { content: 'Canary before production.', importance: 3, ...(category === undefined ? {} : { category }) })
      return sent
    }

    it.each([
      ['preference', 'preference'],
      ['decision', 'decision'],
      ['fact', 'factual'],
      ['insight', 'factual'],
      ['context', 'factual'],
      ['general', 'factual'],
    ] as const)('sends category %s as %s, and as factual to the legacy endpoint', async (category, type) => {
      expect(await sentTypes(category)).toEqual([['/v1/memory', type], ['/v1/memories', 'factual']])
    })

    it('sends factual on both endpoints when the request carries no category', async () => {
      expect(await sentTypes(undefined)).toEqual([['/v1/memory', 'factual'], ['/v1/memories', 'factual']])
    })
  })

  describe('receipts for what RetainDB stored', () => {
    // RetainDB Server's legacy POST /v1/memories queues a write and answers 202 with a job unless `async` is false.
    // Its POST /v1/memory answers a synchronous write with `memory_id`, the legacy endpoint with the stored `memory`.
    async function rememberWith(replies: { current?: unknown; legacy?: unknown }) {
      const sent: Array<{ path: string; json: Record<string, unknown> }> = []
      const reply = (payload: unknown) => payload === undefined ? response({ message: 'missing' }, 404)
        : response(payload, (payload as { mode?: string }).mode === 'async' ? 202 : 201)
      const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
        const path = new URL(String(url)).pathname
        sent.push({ path, json: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return reply(path === '/v1/memory' ? replies.current : replies.legacy)
      })
      const { registry, body } = await providerBody('retaindb', {
        endpoint: 'https://api.retaindb.com', apiKey: 'retain-secret', project: 'launch', userId: 'alice',
      })
      const receipt = await new RetainDbProvider(registry, { fetch: fetchMock }).remember(body, { content: 'Canary before production.', importance: 3 })
      return { receipt, sent, sessionId: `dsh-${body.id}` }
    }

    it('asks the legacy endpoint to store the memory before it answers', async () => {
      const { sent, sessionId } = await rememberWith({ legacy: { mode: 'sync', memory: { id: 'mem-9' }, write_outcome: 'created' } })
      expect(sent[1]).toEqual({ path: '/v1/memories', json: {
        project: 'launch', content: 'Canary before production.', memory_type: 'factual', user_id: 'alice',
        session_id: sessionId, importance: 0.7, async: false,
      } })
    })

    it('reports a write the server queued anyway as queued, not stored', async () => {
      const legacy = await rememberWith({ legacy: { success: true, mode: 'async', jobId: 'job-1', status: 'PROCESSING', statusUrl: '/v1/jobs/job-1' } })
      expect(legacy.receipt).toEqual({ action: 'queued', provider: 'retaindb', summary: 'RetainDB queued the memory; it is not stored yet.', jobId: 'job-1' })
      const current = await rememberWith({ current: { success: true, mode: 'async', job_id: 'job-2', status_url: '/v1/memory/jobs/job-2' } })
      expect(current.receipt).toMatchObject({ action: 'queued', jobId: 'job-2' })
    })

    it('names the memory RetainDB Server stored, whichever endpoint answered', async () => {
      const current = await rememberWith({ current: { mode: 'sync', memory_id: 'mem-8', memory: { id: 'mem-8' } } })
      expect(current.receipt).toMatchObject({ action: 'stored', id: 'mem-8' })
      const legacy = await rememberWith({ legacy: { mode: 'sync', memory: { id: 'mem-9' }, write_outcome: 'created' } })
      expect(legacy.receipt).toMatchObject({ action: 'stored', id: 'mem-9' })
    })
  })

  it('reads preference and decision back from either type key, and any other type as general', async () => {
    // RetainDB Local's search result carries the type as `type` beside the stored `memory`; its lists use `memory_type`.
    const local = (id: string, type: string) => ({
      id, score: 11.08, content: `Memory ${id}`, memory: { id, content: `Memory ${id}`, memory_type: type, importance: 0.86 },
      metadata: { quality: 0.27 }, source: 'local-memory', document: 'dsh-space', type, retrieval_source: 'local_rrf', scores: { bm25: 1.1 },
    })
    const fetchMock = vi.fn<typeof fetch>(async url => new URL(String(url)).pathname === '/v1/memory/search'
      ? response({ results: [local('mem-1', 'preference'), local('mem-2', 'workflow'), local('mem-3', 'decision')], count: 3 })
      : response({ memories: [{ id: 'mem-4', content: 'Memory mem-4', memory_type: 'decision' }, { id: 'mem-5', content: 'Memory mem-5', memory_type: 'factual' }] }))
    const { registry, body } = await providerBody('retaindb', {
      endpoint: 'http://127.0.0.1:18990', apiKey: 'local-lab', project: 'launch', userId: 'alice',
    })
    const provider = new RetainDbProvider(registry, { fetch: fetchMock })
    expect((await provider.search(body, { query: 'memory' })).results.map(row => row.category)).toEqual(['preference', 'general', 'decision'])
    expect((await provider.list(body, {})).map(row => row.category)).toEqual(['decision', 'general'])
  })
})
