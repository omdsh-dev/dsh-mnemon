import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemorySpaceAuthority } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import { createMemorySpaceProviderFixture, mountMemorySpaceProvider } from 'dsh-mnemon-source-memory-spaces/testing'
import module, { OpenVikingProvider, descriptor, definition } from '../src/index.ts'

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

    await expect(provider.discover({ endpoint: 'https://memory.example.com', apiKey: 'Bearer private-key', account: 'acme' })).resolves.toEqual([
      { externalId: 'acme:alice', name: 'Alice', description: 'Product lead memory.', connection: { targetUri: 'viking://user/alice/memories', user: 'alice', actorPeerId: 'dsh' } },
      { externalId: 'acme:bob', name: 'Bob', description: 'Engineer', connection: { targetUri: 'viking://user/bob/memories', user: 'bob', actorPeerId: 'dsh' } },
    ])
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer private-key')
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

    expect(definition.manifest.scoreSemantics).toBe('provider-native')
    expect(provider.scoreSemantics).toEqual({ kind: 'provider-native' })

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

describe('OpenViking literal keyword search', () => {
  it.each([
    ['v0.5.1 (rc)+[42]?', String.raw`v0\.5\.1 \(rc\)\+\[42\]\?`],
    [String.raw`C:\work\file.md`, String.raw`C:\\work\\file\.md`],
    ['a.*|b$', String.raw`a\.\*\|b\$`],
    ['编号（42）', '编号（42）'],
  ])('escapes %s as literal text and returns full content without a synthetic score', async (query, pattern) => {
    const uri = 'viking://user/team/memories/entities/example.md'
    const content = `Full text containing ${query}, beyond the matching line.`
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const target = new URL(String(url))
      if (target.pathname === '/api/v1/content/read') {
        expect(target.searchParams.get('uri')).toBe(uri)
        return ok(content)
      }
      expect(target.pathname).toBe('/api/v1/search/grep')
      // Common request fields in the published 0.4.16 and 0.5.1.1 GrepRequest.
      expect(JSON.parse(String(init?.body))).toEqual({ uri: 'viking://user/team/memories', pattern, case_insensitive: true, node_limit: 3 })
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-key')
      return ok({ matches: [{ uri, line: 3, content: 'Only an excerpt', score: 999 }], count: 1 })
    })
    const { body, provider } = await bodyAndRegistry(fetchMock)
    const result = await provider.search(body, { query, mode: 'keyword', limit: 3 })
    expect(result.results).toEqual([{ id: uri, externalUri: uri, content, category: 'fact', source: 'external' }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('deduplicates lines, rejects unsafe or foreign files and caps full-content reads', async () => {
    const root = 'viking://user/team/memories'
    const first = `${root}/entities/first.md`
    const second = `${root}/preferences/second.md`
    const reads: string[] = []
    const fetchMock = vi.fn<typeof fetch>(async url => {
      const target = new URL(String(url))
      if (target.pathname === '/api/v1/content/read') {
        const uri = target.searchParams.get('uri')!
        reads.push(uri)
        return ok(`Full content for ${uri}`)
      }
      return ok({ matches: [
        { uri: 'viking://user/other/memories/entities/foreign.md' },
        { uri: `${root}/entities/.abstract.md` },
        { uri: `${root}/entities/../outside.md` },
        { uri: `${root}/entities/%2e%2e/outside.md` },
        { uri: `${root}-other/entities/foreign.md` },
        { uri: first, line: 1 }, { uri: first, line: 2 },
        { uri: second, line: 3 }, { uri: `${root}/entities/over-budget.md` },
      ] })
    })
    const { body, provider } = await bodyAndRegistry(fetchMock)
    const result = await provider.search(body, { query: 'device', mode: 'keyword', limit: 2 })
    expect(result.results.map(entry => entry.id)).toEqual([first, second])
    expect(reads).toEqual([first, second])
  })

  it('keeps readable matches and reports a file removed before hydration', async () => {
    const root = 'viking://user/team/memories/entities/'
    const fetchMock = vi.fn<typeof fetch>(async url => {
      const target = new URL(String(url))
      if (target.pathname === '/api/v1/content/read') return target.searchParams.get('uri') === root + 'gone.md'
        ? new Response(JSON.stringify({ error: { message: 'file no longer exists' } }), { status: 404 }) : ok('Complete readable memory')
      return ok({ matches: [{ uri: root + 'present.md' }, { uri: root + 'gone.md' }] })
    })
    const { body, provider } = await bodyAndRegistry(fetchMock)
    const result = await provider.search(body, { query: 'device', mode: 'keyword' })
    expect(result.results).toMatchObject([{ content: 'Complete readable memory' }])
    expect(result.hint).toMatch(/^1 OpenViking result could not be read/u)
  })

  it.each([undefined, 0, 500])('bounds the grep node budget for limit %s', async limit => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).node_limit).toBe(limit === undefined ? 10 : limit === 0 ? 1 : 50)
      return ok({ matches: [] })
    })
    const { body, provider } = await bodyAndRegistry(fetchMock)
    expect(await provider.search(body, { query: 'device', mode: 'keyword', ...(limit === undefined ? {} : { limit }) })).toEqual({ results: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not turn blank text into a match-all scan', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const { body, provider } = await bodyAndRegistry(fetchMock)
    expect(await provider.search(body, { query: ' \n ', mode: 'keyword' })).toEqual({ results: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['unsupported', 'malformed'] as const)('reports %s grep responses without falling back to semantic search', async failure => {
    const fetchMock = vi.fn<typeof fetch>(async url => {
      expect(new URL(String(url)).pathname).toBe('/api/v1/search/grep')
      return failure === 'unsupported'
        ? new Response(JSON.stringify({ error: { message: 'grep unavailable' } }), { status: 404 })
        : ok({ memories: [] })
    })
    const { body, provider } = await bodyAndRegistry(fetchMock)
    await expect(provider.search(body, { query: 'device', mode: 'keyword' })).rejects.toThrow(failure === 'unsupported' ? 'grep unavailable' : 'did not return matches')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['cancel', 'timeout'] as const)('honors %s while grep is in flight', async reason => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const fetchMock = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
        const signal = init!.signal!
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }))
      const { body, provider } = await bodyAndRegistry(fetchMock)
      const rejection = expect(provider.search(body, { query: 'device', mode: 'keyword' }, controller.signal))
        .rejects.toThrow(reason === 'cancel' ? 'selection changed' : 'OpenViking request timed out')
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      if (reason === 'cancel') controller.abort(new Error('selection changed'))
      else await vi.advanceTimersByTimeAsync(1000)
      await rejection
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
})

describe('independent openviking Provider', () => {
  it('installs complete immutable metadata in one parent-owned child', async () => {
    const mounted = await mountMemorySpaceProvider(module, { instanceId: 'work', config: undefined })
    try {
      expect(mounted.descriptor).toMatchObject({ id: 'work', typeId: 'openviking', label: descriptor.label })
      expect(Object.isFrozen(mounted.manifest)).toBe(true)
      const authority: MemorySpaceAuthority = { runner: { effectiveDataDir: () => '/unused' }, list: () => [], providerConnection: () => ({}) }
      expect(mounted.createAdapter({ memoryBodies: authority, config: { timeoutMs: 200 } }).id).toBe('work')
      expect(mounted.registered).toBe(true)
      expect(definition.manifest.secrets).toEqual(descriptor.fields.filter(field => field.input === 'secret').map(field => field.key).sort())
    } finally { await mounted.dispose() }
    expect(mounted.registered).toBe(false)
  })

  it('constructs its own driver from a structural authority, without the main repository', () => {
    const authority: MemorySpaceAuthority = { runner: { effectiveDataDir: () => '/unused' }, list: () => [], providerConnection: () => ({}) }
    const adapter = definition.create({ memoryBodies: authority, config: { timeoutMs: 200 }, providerInstanceId: 'openviking', manifest: definition.manifest })
    expect(adapter).toBeInstanceOf(OpenVikingProvider)
    expect(adapter.id).toBe('openviking')
  })
})

describe('OpenViking explicit user-key discovery', () => {
  const service = { endpoint: 'https://memory.example/openviking', account: 'work', discoveryUser: 'alice', apiKey: randomUUID() }
  const root = 'viking://user/alice/memories'
  const userOk = (result: unknown) => new Response(JSON.stringify({ status: 'ok', result }), { status: 200 })
  const denied = () => new Response(JSON.stringify({ status: 'error', error: { message: 'API is currently unavailable due to access restrictions' } }), { status: 403 })
  function provider(fetchMock: typeof fetch) {
    return new OpenVikingProvider({ runner: { effectiveDataDir: () => '/unused' }, list: () => [], providerConnection: () => ({}) }, { fetch: fetchMock, requestTimeoutMs: 30 })
  }

  it('uses the same safe owner pattern in Host and modern HTML form validation', () => {
    const field = descriptor.fields.find(item => item.key === 'discoveryUser')!
    for (const flags of ['u', 'v']) {
      const pattern = new RegExp(field.pattern!, flags)
      expect(pattern.test('alice-team@example.com')).toBe(true)
      for (const user of ['..', '../bob', 'a@b@c']) expect(pattern.test(user)).toBe(false)
    }
  })

  it('discovers the explicit owner through the data plane when every admin route is denied', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.includes('/admin/')) return denied()
      expect(url.pathname).toBe('/openviking/api/v1/fs/ls')
      expect(url.searchParams.get('uri')).toBe(root)
      expect(url.searchParams.get('recursive')).toBe('false')
      expect(url.searchParams.get('output')).toBe('original')
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe(`Bearer ${service.apiKey}`)
      expect(headers.has('X-OpenViking-Account')).toBe(false)
      expect(headers.has('X-OpenViking-User')).toBe(false)
      return userOk([])
    })
    await expect(provider(fetchMock).discover(service)).resolves.toEqual([{
      externalId: 'work:alice', name: 'alice', description: 'OpenViking memory namespace for alice',
      connection: { targetUri: root, user: 'alice', actorPeerId: 'dsh' },
    }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    { account: '' }, { account: 'work:foreign' }, { discoveryUser: '../foreign' },
    { discoveryUser: 'a@b@c' }, { discoveryUser: '.' }, { discoveryUser: '%2e%2e' }, { apiKey: '' },
  ])('rejects incomplete or unsafe explicit configuration before I/O: %j', async change => {
    const fetchMock = vi.fn<typeof fetch>()
    await expect(provider(fetchMock).discover({ ...service, ...change })).rejects.toThrow(/OpenViking/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([{}, null, 'healthy', [{ uri: 'viking://user/other/memories/private.md' }], [{ name: 'missing-uri' }]])('rejects an invalid data-plane response: %j', async result => {
    const fetchMock = vi.fn<typeof fetch>(async () => userOk(result))
    await expect(provider(fetchMock).discover(service)).rejects.toThrow('OpenViking could not validate the selected memory namespace')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a denied namespace denied without an admin or health fallback', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => denied())
    await expect(provider(fetchMock).discover(service)).rejects.toThrow('access restrictions')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/fs/ls?')
  })

  it('honors cancellation and timeout on the explicit probe', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const controller = new AbortController()
    controller.abort(new Error('scope changed'))
    await expect(provider(fetchMock).discover(service, controller.signal)).rejects.toThrow('scope changed')
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(provider(fetchMock).discover(service)).rejects.toThrow('timed out')
  })

  it('retains key-bound headers for browse, search, status, write, readback and exact deletion', async () => {
    let written = ''
    const content = 'Synthetic user-key canary.'
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe(`Bearer ${service.apiKey}`)
      expect(headers.has('X-OpenViking-Account')).toBe(false)
      expect(headers.has('X-OpenViking-User')).toBe(false)
      expect(url.pathname).not.toMatch(/admin|system|health/)
      if (url.pathname.endsWith('/content/write')) {
        const request = JSON.parse(String(init?.body))
        written = request.uri
        return userOk({ uri: written, content_updated: true, written_bytes: Buffer.byteLength(content), mode: 'create', context_type: 'memory', vector_status: 'complete', semantic_status: 'skipped' })
      }
      if (url.pathname.endsWith('/content/read')) return userOk(content)
      if (url.pathname.endsWith('/content/set_tags')) return userOk({ uri: written, tags_updated: true })
      if (url.pathname.endsWith('/search/find')) return userOk({ memories: [{ uri: written, score: 1 }] })
      if (init?.method === 'DELETE') return userOk({ uri: written })
      return userOk(written ? [{ uri: written, isDir: false }] : [])
    })
    const { authority, body } = createMemorySpaceProviderFixture(descriptor, { ...service, user: 'alice', targetUri: root }, { dataDir: '/unused', instanceId: 'cloud' })
    const adapter = new OpenVikingProvider(authority, { fetch: fetchMock })
    expect(await adapter.status(body)).toEqual({ healthy: true })
    // tagsApplied is false if a header check in the mock threw during the tag call.
    expect(await adapter.remember(body, { content })).toMatchObject({ action: 'stored', id: written, tagsApplied: true })
    expect((await adapter.list(body, {}))[0]?.content).toBe(content)
    expect((await adapter.search(body, { query: 'canary', limit: 5 })).results[0]?.content).toBe(content)
    expect(await adapter.forget(body, written)).toMatchObject({ action: 'deleted', id: written })
  })

  it.each([
    { targetUri: 'viking://user/bob/memories', user: 'alice' },
    { targetUri: root, user: 'bob' },
  ])('rejects a memory owner different from the explicit service scope: %j', async memory => {
    const fetchMock = vi.fn<typeof fetch>()
    const { authority, body } = createMemorySpaceProviderFixture(descriptor, { ...service, ...memory }, { dataDir: '/unused', instanceId: 'cloud' })
    const adapter = new OpenVikingProvider(authority, { fetch: fetchMock })
    await expect(adapter.search(body, { query: 'canary', limit: 5 })).rejects.toThrow('configured discovery user')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retains account enumeration and user enumeration when the explicit user is empty', async () => {
    const fetchMock = vi.fn<typeof fetch>(async input => String(input).endsWith('/admin/accounts') ? userOk([{ account_id: 'work' }]) : userOk([{ user_id: 'alice' }, { user_id: 'bob' }]))
    expect(await provider(fetchMock).discover({ endpoint: service.endpoint, discoveryUser: '' })).toHaveLength(2)
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      '/openviking/api/v1/admin/accounts', '/openviking/api/v1/admin/accounts/work/users',
    ])
  })
})
