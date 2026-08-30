import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemorySpaceProviderFixture } from 'dsh-mnemon-source-memory-spaces/testing'
import { OpenVikingProvider, descriptor } from '../src/index.ts'

const temporaryDirectories: string[] = []
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

async function bodyAndRegistry(fetchMock: typeof fetch, options: { settlementTimeoutMs?: number; pollIntervalMs?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mnemon-openviking-driver-'))
  temporaryDirectories.push(dataDir)
  const { authority, body } = createMemorySpaceProviderFixture(descriptor, {
    endpoint: 'https://memory.example.com', targetUri: 'viking://user/team/memories', apiKey: 'private-key',
    account: 'acme', user: 'grivn', actorPeerId: 'dsh-workbench',
  }, { dataDir, instanceId: 'work-account' })
  return { body, provider: new OpenVikingProvider(authority, { fetch: fetchMock, requestTimeoutMs: 1_000, settlementTimeoutMs: options.settlementTimeoutMs ?? 1_000, pollIntervalMs: options.pollIntervalMs ?? 1 }) }
}

function ok(result: unknown): Response { return new Response(JSON.stringify({ status: 'ok', result }), { status: 200, headers: { 'Content-Type': 'application/json' } }) }

describe('standalone OpenViking data plane', () => {
  it('does not start discovery after cancellation', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const controller = new AbortController()
    controller.abort(new Error('workspace changed'))
    const { provider } = await bodyAndRegistry(fetchMock)

    await expect(provider.discover({ endpoint: 'https://memory.example.com', apiKey: 'private-key', account: 'acme' }, controller.signal)).rejects.toThrow('workspace changed')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('discovers every registered user namespace in the configured account', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      expect(new URL(String(url)).pathname).toBe('/api/v1/admin/accounts/acme/users')
      return ok([
        { user_id: 'alice', display_name: 'Alice', description: 'Product lead memory.' },
        { user_id: 'bob', name: 'Bob', role: 'Engineer' },
      ])
    })
    const { provider } = await bodyAndRegistry(fetchMock)

    await expect(provider.discover({ endpoint: 'https://memory.example.com', apiKey: 'private-key', account: 'acme' })).resolves.toEqual([
      { externalId: 'acme:alice', name: 'Alice', description: 'Product lead memory.', connection: { targetUri: 'viking://user/memories', user: 'alice', actorPeerId: 'dsh' } },
      { externalId: 'acme:bob', name: 'Bob', description: 'Engineer', connection: { targetUri: 'viking://user/memories', user: 'bob', actorPeerId: 'dsh' } },
    ])
  })

  it('scopes semantic retrieval to the configured memory URI and keeps credentials in host headers', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({ url: String(url), ...(init === undefined ? {} : { init }) })
      return ok({
        memories: [{
          uri: 'viking://user/team/memories/preferences/style.md',
          abstract: '用户偏好简洁中文回答。',
          score: 0.86,
        }],
      })
    })
    const { body, provider } = await bodyAndRegistry(fetchMock)

    const result = await provider.search(body, { query: '回答风格', limit: 8 })

    expect(result.results).toEqual([expect.objectContaining({
      id: 'viking://user/team/memories/preferences/style.md',
      externalUri: 'viking://user/team/memories/preferences/style.md',
      content: '用户偏好简洁中文回答。',
      category: 'preferences',
      source: 'external',
      score: 0.86,
    })])
    expect(requests[0]?.url).toBe('https://memory.example.com/api/v1/search/find')
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      query: '回答风格',
      target_uri: 'viking://user/team/memories',
      context_type: ['memory'],
      limit: 8,
    })
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer private-key')
    expect(new Headers(requests[0]?.init?.headers).get('X-OpenViking-Account')).toBe('acme')
    expect(new Headers(requests[0]?.init?.headers).get('X-OpenViking-Actor-Peer')).toBe('dsh-workbench')
  })

  it('browses remote memory markdown without exposing OpenViking system files', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ok([
      { uri: 'viking://user/team/memories/preferences/style.md', isDir: false, abstract: '偏好简洁回答。', modTime: '2026-08-16T00:00:00Z' },
      { uri: 'viking://user/team/memories/preferences', isDir: true },
      { uri: 'viking://user/team/memories/preferences/.abstract.md', isDir: false, abstract: 'system summary' },
      { uri: 'viking://user/team/memories/.meta.json', isDir: false },
    ]))
    const { body, provider } = await bodyAndRegistry(fetchMock)

    await expect(provider.list(body, { limit: 10 })).resolves.toEqual([
      expect.objectContaining({ content: '偏好简洁回答。', category: 'preferences' }),
    ])
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('recursive=true')
  })

  it('settles asynchronous extraction and returns a truthful write receipt', async () => {
    const paths: string[] = []
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname
      paths.push(path)
      if (path === '/api/v1/sessions') return ok({ session_id: 'created' })
      if (path.endsWith('/messages')) return ok({ message_id: 'message-1' })
      if (path.endsWith('/commit')) return ok({ status: 'accepted', task_id: 'task-1', archive_uri: 'viking://user/team/sessions/session/history/archive_001' })
      if (path === '/api/v1/tasks/task-1') return ok({ status: 'completed', result: { memories_extracted: { preferences: 1, events: 1 } } })
      throw new Error(`unexpected path ${path}`)
    })
    const { body, provider } = await bodyAndRegistry(fetchMock)

    await expect(provider.remember(body, { content: '发布必须先通过灰度验证。', category: 'decision' })).resolves.toMatchObject({
      action: 'stored',
      provider: 'openviking',
      taskId: 'task-1',
      archiveUri: 'viking://user/team/sessions/session/history/archive_001',
      extracted: { preferences: 1, events: 1 },
    })
    expect(paths).toEqual([
      '/api/v1/sessions',
      expect.stringMatching(/^\/api\/v1\/sessions\/dsh-mnemon-.*\/messages$/),
      expect.stringMatching(/^\/api\/v1\/sessions\/dsh-mnemon-.*\/commit$/),
      '/api/v1/tasks/task-1',
    ])
  })

  it('returns a queued receipt when accepted extraction outlives the wait window', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname
      if (path === '/api/v1/sessions') return ok({ session_id: 'created' })
      if (path.endsWith('/messages')) return ok({ message_id: 'message-1' })
      if (path.endsWith('/commit')) return ok({ status: 'accepted', task_id: 'task-slow', archive_uri: 'viking://user/team/sessions/session/history/archive_slow' })
      if (path === '/api/v1/tasks/task-slow') return ok({ status: 'running' })
      throw new Error(`unexpected path ${path}`)
    })
    const { body, provider } = await bodyAndRegistry(fetchMock, { settlementTimeoutMs: 5 })

    await expect(provider.remember(body, { content: '异步提取不应被误报为失败。', category: 'decision' })).resolves.toMatchObject({
      action: 'queued',
      provider: 'openviking',
      status: 'pending',
      taskId: 'task-slow',
      archiveUri: 'viking://user/team/sessions/session/history/archive_slow',
    })
  })

  it('forgets only an exact non-generated memory file inside the configured root', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ok({ uri: 'viking://user/team/memories/preferences/style.md', estimated_deleted_count: 1 }))
    const { body, provider } = await bodyAndRegistry(fetchMock)

    await expect(provider.forget(body, 'viking://user/team/memories/preferences/style.md')).resolves.toMatchObject({
      action: 'deleted',
      provider: 'openviking',
      estimatedDeletedCount: 1,
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/v1/fs?')
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('DELETE')
    await expect(provider.forget(body, 'viking://user/team/memories/.overview.md')).rejects.toThrow(/exact non-generated/u)
    await expect(provider.forget(body, 'viking://user/other/memories/fact.md')).rejects.toThrow(/inside this Memory Space/u)
  })
})
