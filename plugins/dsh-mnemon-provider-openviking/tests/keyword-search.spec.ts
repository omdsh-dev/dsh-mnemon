import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemorySpaceProviderFixture } from 'dsh-mnemon-source-memory-spaces/testing'
import { OpenVikingProvider, descriptor } from '../src/index.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const root = 'viking://user/team/memories'
const ok = (result: unknown) => new Response(JSON.stringify({ status: 'ok', result }))
function fixture(fetchMock: typeof fetch) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mnemon-keyword-'))
  directories.push(dataDir)
  const { authority, body } = createMemorySpaceProviderFixture(descriptor, {
    endpoint: 'https://memory.example', targetUri: root,
  }, { dataDir })
  return { body, provider: new OpenVikingProvider(authority, { fetch: fetchMock, requestTimeoutMs: 100 }) }
}

describe('OpenViking literal keyword search (#452)', () => {
  it.each(['29.8.0', 'postgresql-x64-18', 'D:\\Program Files (x86)\\PostgreSQL\\18', '[a-z]+.*', '记忆路径'])('looks up %s literally, reads full text and deduplicates within the selected space', async query => {
    const uri = `${root}/entities/entry.md`
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url))
      if (path.pathname === '/api/v1/search/grep') {
        const body = JSON.parse(String(init?.body))
        expect(body).toMatchObject({ uri: root, case_insensitive: true, node_limit: 256 })
        expect(new RegExp(body.pattern, 'iu').test(query)).toBe(true)
        if (query === '[a-z]+.*') expect(new RegExp(body.pattern, 'iu').test('anything')).toBe(false)
        if (query === '29.8.0') expect(new RegExp(body.pattern, 'iu').test('29x8x0')).toBe(false)
        return ok({ matches: [
          { uri, content: query }, { uri, content: query },
          { uri: 'viking://user/other/memories/entities/private.md', content: query },
          { uri: `${root}/../private.md`, content: query },
          { uri: `${root}/entities/.abstract.md`, content: query },
        ] })
      }
      expect(path.pathname).toBe('/api/v1/content/read')
      expect(path.searchParams.get('uri')).toBe(uri)
      return ok(`Full memory: ${query}`)
    })
    const { body, provider } = fixture(fetchMock)
    expect((await provider.search(body, { query, mode: 'keyword' })).results).toEqual([
      { id: uri, externalUri: uri, content: `Full memory: ${query}`, category: 'fact', source: 'external' },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('bounds reads, filters category and reports truncated grep results', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (new URL(String(url)).pathname === '/api/v1/content/read') return ok('Canary')
      return ok({ matches: Array.from({ length: 256 }, (_, i) => ({ uri: `${root}/${i % 2 ? 'preferences' : 'entities'}/${i}.md`, content: 'Canary' })) })
    })
    const { body, provider } = fixture(fetchMock)
    const result = await provider.search(body, { query: 'Canary', mode: 'keyword', category: 'preference', limit: 3 })
    expect(result.results).toHaveLength(3)
    expect(result.results.every(row => row.category === 'preference')).toBe(true)
    expect(result.hint).toContain('256-line limit')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('treats a missing selected root as empty, and a missing endpoint as unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ status: 'error', error: { details: { resource: root } } }), { status: 404 }))
    const { body, provider } = fixture(fetchMock)
    await expect(provider.search(body, { query: 'Canary', mode: 'keyword' })).resolves.toEqual({ results: [] })
    fetchMock.mockImplementation(async () => new Response('{}', { status: 404 }))
    await expect(provider.search(body, { query: 'Canary', mode: 'keyword' })).rejects.toThrow('does not support keyword search')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('propagates authentication errors and cancellation without semantic fallback', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 403 }))
    const { body, provider } = fixture(fetchMock)
    await expect(provider.search(body, { query: 'Canary', mode: 'keyword' })).rejects.toThrow('403')
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(provider.search(body, { query: 'Canary', mode: 'keyword' }, controller.signal)).rejects.toThrow('cancelled')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
