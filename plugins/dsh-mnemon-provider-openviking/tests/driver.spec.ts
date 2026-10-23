import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemorySpaceProviderFixture } from 'dsh-mnemon-source-memory-spaces/testing'
import { OpenVikingProvider, descriptor } from '../src/index.ts'

const temporaryDirectories: string[] = []
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

async function bodyAndRegistry(fetchMock: typeof fetch) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mnemon-openviking-driver-'))
  temporaryDirectories.push(dataDir)
  const { authority, body } = createMemorySpaceProviderFixture(descriptor, {
    endpoint: 'https://memory.example.com', targetUri: 'viking://user/team/memories', apiKey: 'private-key',
    account: 'acme', user: 'grivn', actorPeerId: 'dsh-workbench',
  }, { dataDir, instanceId: 'work-account' })
  return { body, provider: new OpenVikingProvider(authority, { fetch: fetchMock, requestTimeoutMs: 1_000 }) }
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
        { user_id: '../foreign', display_name: 'Unsafe namespace' },
        { user_id: '%2e%2e', display_name: 'Encoded unsafe namespace' },
        { user_id: 'a@b@c', display_name: 'Invalid identity' },
      ])
    })
    const { provider } = await bodyAndRegistry(fetchMock)

    await expect(provider.discover({ endpoint: 'https://memory.example.com', apiKey: 'private-key', account: 'acme' })).resolves.toEqual([
      { externalId: 'acme:alice', name: 'Alice', description: 'Product lead memory.', connection: { targetUri: 'viking://user/alice/memories', user: 'alice', actorPeerId: 'dsh' } },
      { externalId: 'acme:bob', name: 'Bob', description: 'Engineer', connection: { targetUri: 'viking://user/bob/memories', user: 'bob', actorPeerId: 'dsh' } },
    ])
  })

  it('scopes semantic retrieval to the configured memory URI and keeps credentials in host headers', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({ url: String(url), ...(init === undefined ? {} : { init }) })
      if (new URL(String(url)).pathname === '/api/v1/content/read') return ok('用户偏好简洁中文回答。')
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
      // A file written before the category was in its name reads back by its folder, as a category.
      category: 'preference',
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
    const fetchMock = vi.fn<typeof fetch>(async url => new URL(String(url)).pathname === '/api/v1/content/read' ? ok('偏好简洁回答。') : ok([
      { uri: 'viking://user/team/memories/preferences/style.md', isDir: false, abstract: '偏好简洁回答。', modTime: '2026-08-16T00:00:00Z' },
      { uri: 'viking://user/team/memories/preferences', isDir: true },
      { uri: 'viking://user/team/memories/preferences/.abstract.md', isDir: false, abstract: 'system summary' },
      { uri: 'viking://user/team/memories/.meta.json', isDir: false },
    ]))
    const { body, provider } = await bodyAndRegistry(fetchMock)

    await expect(provider.list(body, { limit: 10 })).resolves.toEqual([
      expect.objectContaining({ content: '偏好简洁回答。', category: 'preference' }),
    ])
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('recursive=true')
  })

  it('writes the memory through the content API and returns an exact write receipt', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname
      if (path === '/api/v1/content/read') return ok('发布必须先通过灰度验证。')
      const input = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ path, body: input })
      if (path === '/api/v1/content/set_tags') return ok({ uri: input.uri, tags_updated: true })
      if (path === '/api/v1/content/write') {
        return ok({
          uri: input.uri,
          root_uri: 'viking://user/team/memories/experiences',
          context_type: 'memory',
          mode: 'create',
          written_bytes: Buffer.byteLength(String(input.content)),
          content_updated: true,
          semantic_status: 'skipped',
          vector_status: 'complete',
        })
      }
      throw new Error(`unexpected path ${path}`)
    })
    const { body, provider } = await bodyAndRegistry(fetchMock)

    await expect(provider.remember(body, { content: '发布必须先通过灰度验证。', category: 'decision', importance: 4 })).resolves.toMatchObject({
      action: 'stored',
      provider: 'openviking',
      vectorStatus: 'complete',
      writtenBytes: Buffer.byteLength('发布必须先通过灰度验证。'),
      tagsApplied: true,
    })

    // The write carries only what OpenViking's content API accepts; the tags follow in their own call.
    expect(requests.map(request => request.path)).toEqual(['/api/v1/content/write', '/api/v1/content/set_tags'])
    expect(Object.keys(requests[0]!.body).sort()).toEqual(['content', 'mode', 'uri', 'wait'])
    expect(requests[0]?.body).toMatchObject({ mode: 'create', wait: true, content: '发布必须先通过灰度验证。' })
    expect(requests[1]?.body).toEqual({ uri: requests[0]?.body.uri, tags: ['source=mnemon', 'category=decision', 'importance=4'], mode: 'replace' })
    expect(String(requests[0]?.body.uri)).toMatch(/^viking:\/\/user\/team\/memories\/experiences\/.*_decision-[0-9a-f-]{36}\.md$/u)
  })

  it('routes each memory category into its OpenViking memory folder', async () => {
    const uris: string[] = []
    const files = new Map<string, string>()
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/v1/content/read') return ok(files.get(parsed.searchParams.get('uri')!))
      const request = JSON.parse(String(init?.body)) as { uri: string; content: string }
      if (parsed.pathname === '/api/v1/content/set_tags') return ok({ uri: request.uri, tags_updated: true })
      uris.push(request.uri)
      files.set(request.uri, request.content)
      return ok({ uri: request.uri, mode: 'create', context_type: 'memory', content_updated: true,
        written_bytes: Buffer.byteLength(request.content), semantic_status: 'skipped', vector_status: 'complete' })
    })
    const { body, provider } = await bodyAndRegistry(fetchMock)

    await provider.remember(body, { content: '偏好简洁回答。', category: 'preference' })
    await provider.remember(body, { content: '发布必须先通过灰度验证。', category: 'decision' })
    await provider.remember(body, { content: 'ServerKit 使用 Go 后端。', category: 'fact' })
    await provider.remember(body, { content: 'Context', category: 'context' })
    await provider.remember(body, { content: 'Insight', category: 'insight' })
    await provider.remember(body, { content: 'General', category: 'general' })

    expect(uris.map(uri => uri.split('/').at(-2))).toEqual(['preferences', 'experiences', 'entities', 'events', 'experiences', 'entities'])
    // Each folder holds two categories, so the file name says which one.
    expect(uris.map(uri => /_([a-z]+)-[0-9a-f-]{36}\.md$/u.exec(uri)?.[1])).toEqual(['preference', 'decision', 'fact', 'context', 'insight', 'general'])
  })

  it('keeps every file name within the 255 bytes a Linux server allows', async () => {
    const uris: string[] = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const parsed = new URL(String(url))
      const request = JSON.parse(String(init?.body ?? '{}')) as { uri: string; content: string }
      if (parsed.pathname === '/api/v1/content/read') return ok(['𝐀'.repeat(60), '中'.repeat(60), 'a'.repeat(60)][uris.length - 1])
      if (parsed.pathname === '/api/v1/content/set_tags') return ok({ uri: request.uri, tags_updated: true })
      uris.push(request.uri)
      return ok({ uri: request.uri, mode: 'create', context_type: 'memory', content_updated: true,
        written_bytes: Buffer.byteLength(request.content), semantic_status: 'skipped', vector_status: 'complete' })
    })
    const { body, provider } = await bodyAndRegistry(fetchMock)
    for (const content of ['𝐀'.repeat(60), '中'.repeat(60), 'a'.repeat(60)]) await provider.remember(body, { content, category: 'preference' })
    const names = uris.map(uri => uri.split('/').at(-1)!)
    expect(names.map(name => Buffer.byteLength(name) <= 255)).toEqual([true, true, true])
    // Only characters of four bytes cost the slug any of its 48 characters.
    expect(names.map(name => Array.from(name.slice(15, name.lastIndexOf('_'))).length)).toEqual([45, 48, 48])
  })

  it('reads every category back as it was written, and an unknown one as general (#353)', async () => {
    const files = new Map<string, string>()
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/v1/content/read') return ok(files.get(parsed.searchParams.get('uri')!))
      if (parsed.pathname === '/api/v1/fs/ls') return ok([...files.keys()].map(uri => ({ uri, isDir: false })))
      // Whatever category the server reports, here one of Mnemon's own names, the file name decides.
      if (parsed.pathname === '/api/v1/search/find') return ok({ memories: [...files.keys()].map(uri => ({ uri, category: 'general', score: 0.5 })) })
      const request = JSON.parse(String(init?.body)) as { uri: string; content: string }
      if (parsed.pathname === '/api/v1/content/set_tags') return ok({ uri: request.uri, tags_updated: true })
      files.set(request.uri, request.content)
      return ok({ uri: request.uri, mode: 'create', context_type: 'memory', content_updated: true,
        written_bytes: Buffer.byteLength(request.content), semantic_status: 'skipped', vector_status: 'complete' })
    })
    const { body, provider } = await bodyAndRegistry(fetchMock)
    const asked = ['preference', 'decision', 'fact', 'insight', 'context', 'general', 'bogus']
    for (const category of asked) await provider.remember(body, { content: `memory ${category}`, category: category as 'general' })
    const expected = asked.map(category => category === 'bogus' ? 'general' : category)
    const byContent = (items: Array<{ content: string; category?: string }>) => asked.map(category => items.find(item => item.content === `memory ${category}`)?.category)
    expect(byContent(await provider.list(body, { limit: 20 }))).toEqual(expected)
    expect(byContent((await provider.search(body, { query: 'memory', limit: 20 })).results)).toEqual(expected)
    // No folder of its own for a category Mnemon does not know.
    expect(new Set([...files.keys()].map(uri => uri.split('/').at(-2)))).toEqual(new Set(['preferences', 'experiences', 'entities', 'events']))
  })

  it('leaves out a memory the server lists but can no longer read, and says so', async () => {
    // The index still lists a file that is gone, as a write the server refused or a removal elsewhere can leave it.
    const gone = 'viking://user/team/memories/entities/gone.md'
    const kept = 'viking://user/team/memories/entities/kept.md'
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/v1/search/find') return ok({ memories: [{ uri: gone, score: 0.9 }, { uri: kept, score: 0.8 }] })
      if (parsed.pathname === '/api/v1/fs/ls') return ok([{ uri: gone, isDir: false }, { uri: kept, isDir: false }])
      if (parsed.searchParams.get('uri') === gone) return new Response(JSON.stringify({ status: 'error', error: { code: 'NOT_FOUND', message: `File not found: ${gone}` } }), { status: 404 })
      return ok('The memory that is still there.')
    })
    const { body, provider } = await bodyAndRegistry(fetchMock)

    await expect(provider.search(body, { query: 'memory', limit: 5 })).resolves.toEqual({
      results: [expect.objectContaining({ id: kept, content: 'The memory that is still there.' })],
      hint: expect.stringMatching(/^1 OpenViking result could not be read and was left out/u),
    })
    expect((await provider.list(body, { limit: 10 })).map(item => [item.id, item.content])).toEqual([[kept, 'The memory that is still there.']])
    expect((await provider.graph(body)).nodes.map(node => node.id)).toEqual([kept])
  })

  it('reports why when no listed memory can be read, and stops a cancelled read', async () => {
    const uri = 'viking://user/team/memories/entities/only.md'
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const parsed = new URL(String(url))
      if (parsed.pathname === '/api/v1/search/find') return ok({ memories: [{ uri, score: 0.9 }] })
      if (parsed.pathname === '/api/v1/fs/ls') return ok([{ uri, isDir: false }])
      if (init?.signal?.aborted === true) throw init.signal.reason
      return new Response(JSON.stringify({ status: 'error', error: { message: 'Synthetic read failure' } }), { status: 500 })
    })
    const { body, provider } = await bodyAndRegistry(fetchMock)
    // A server that answers no read is not an empty space.
    await expect(provider.search(body, { query: 'memory', limit: 5 })).rejects.toThrow('Synthetic read failure')
    await expect(provider.list(body, { limit: 10 })).rejects.toThrow('Synthetic read failure')
    const controller = new AbortController()
    controller.abort(new Error('turn cancelled'))
    await expect(provider.search(body, { query: 'memory', limit: 5 }, controller.signal)).rejects.toThrow('turn cancelled')
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
