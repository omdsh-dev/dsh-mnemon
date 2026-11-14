import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemorySpaceProviderFixture, mountMemorySpaceProvider } from 'dsh-mnemon-source-memory-spaces/testing'
import type { MemoryProviderConnection, MemoryProviderId, MemorySpaceAuthority } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import module, { HindsightProvider, descriptor, definition } from '../src/index.ts'

const temporaryDirectories: string[] = []
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

async function providerBody(providerId: MemoryProviderId, connection: MemoryProviderConnection) {
  if (providerId !== descriptor.id) throw new Error('Wrong Provider fixture')
  const dataDir = mkdtempSync(join(tmpdir(), 'mnemon-hindsight-driver-'))
  temporaryDirectories.push(dataDir)
  const { authority: registry, body } = createMemorySpaceProviderFixture(descriptor, connection, { dataDir, instanceId: 'work-account' })
  return { registry, body }
}

function response(payload: unknown, status = 200): Response {
  return new Response(payload === undefined ? null : JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('standalone hindsight data plane', () => {
  it('discovers its native namespaces independently', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => response({ banks: [{ bank_id: 'bank-1', name: 'Product bank', mission: 'Hindsight source metadata.' }] }))
    const hindsight = await providerBody('hindsight', { endpoint: 'https://hindsight.example', bankId: 'old', budget: 'mid' })
    await expect(new HindsightProvider(hindsight.registry, { fetch: fetchMock }).discover({ endpoint: 'https://hindsight.example' })).resolves.toEqual([
      expect.objectContaining({ externalId: 'bank-1', name: 'Product bank', description: 'Hindsight source metadata.' }),
    ])
  })

  it('maps Hindsight recall, graph traversal, asynchronous retain, and soft forget', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({ url: String(url), ...(init === undefined ? {} : { init }) })
      const path = new URL(String(url)).pathname
      if (path === '/health/live') return response({ status: 'alive', version: '0.9.1' })
      if (path.endsWith('/stats')) return response({ total_nodes: 3, total_links: 2, nodes_by_fact_type: { world: 2, observation: 1 }, operations_by_status: { completed: 4 } })
      if (path.endsWith('/entities')) return response({ items: [{ canonical_name: 'Alice', mention_count: 3 }], total: 1 })
      if (path.endsWith('/memories/recall')) return response({ results: [{ id: 'hs-1', text: 'Alice uses TypeScript.', type: 'world', entities: ['Alice'], scores: { final: 0.93 } }] })
      if (path.endsWith('/memories/list')) return response({ items: [{ id: 'hs-1', text: 'Alice uses TypeScript.', type: 'world' }], total: 1 })
      if (path.endsWith('/graph')) return response({
        nodes: [
          { data: { id: 'hs-1', text: 'Alice', entities: 'Alice' } },
          { data: { id: 'hs-2', text: 'TypeScript', color: '#42a5f5' } },
          { data: { id: 'hs-3', text: 'Node.js' } },
        ],
        edges: [
          { data: { source: 'hs-1', target: 'hs-2', linkType: 'entity' } },
          { data: { source: 'hs-2', target: 'hs-3', linkType: 'semantic' } },
        ],
      })
      if (path.endsWith('/memories') && init?.method === 'POST') return response({ operation_id: 'op-1', items_count: 1 })
      if (path.endsWith('/memories/hs-1') && init?.method === 'PATCH') return response({ state: 'invalidated' })
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    const { registry, body } = await providerBody('hindsight', {
      endpoint: 'https://api.hindsight.vectorize.io', apiKey: 'hs-secret', bankId: 'alice/profile', budget: 'high',
    })
    const provider = new HindsightProvider(registry, { fetch: fetchMock })

    expect(definition.manifest.scoreSemantics).toBe('provider-native')
    expect(provider.scoreSemantics).toEqual({ kind: 'provider-native' })

    await expect(provider.search(body, { query: 'language', limit: 3 })).resolves.toEqual({
      results: [expect.objectContaining({ id: 'hs-1', category: 'world', score: 0.93, entities: ['Alice'] })],
    })
    await expect(provider.list(body, { limit: 25 })).resolves.toEqual([expect.objectContaining({ id: 'hs-1' })])
    await expect(provider.related(body, 'hs-1', 2)).resolves.toEqual([
      expect.objectContaining({ id: 'hs-2' }), expect.objectContaining({ id: 'hs-3' }),
    ])
    await expect(provider.status(body)).resolves.toEqual({
      healthy: true,
      stats: expect.objectContaining({ totalInsights: 3, edgeCount: 2, oplogCount: 4, byCategory: { world: 2, observation: 1 }, topEntities: [{ entity: 'Alice', count: 3 }] }),
    })
    await expect(provider.remember(body, { content: 'Alice ships TypeScript.', category: 'decision', tags: ['dsh'], entities: ['Alice'] })).resolves.toMatchObject({ action: 'queued', operationId: 'op-1', itemsCount: 1 })
    await expect(provider.forget(body, 'hs-1')).resolves.toMatchObject({ action: 'invalidated', id: 'hs-1' })

    expect(new URL(requests[0]!.url).pathname).toBe('/v1/default/banks/alice%2Fprofile/memories/recall')
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer hs-secret')
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ query: 'language', budget: 'high', types: ['world', 'experience', 'observation'] })
    expect(JSON.parse(String(requests[6]?.init?.body))).toMatchObject({
      items: [{ content: 'Alice ships TypeScript.', context: 'decision', tags: ['dsh'], entities: [{ text: 'Alice' }] }],
      async: true,
    })
    expect(JSON.parse(String(requests[7]?.init?.body))).toEqual({ state: 'invalidated', reason: 'Forgotten from dsh-mnemon' })
  })
  it('reads entity names without their notes, and a name of many "(" at once', async () => {
    const notes = 'x' + '('.repeat(120_000)
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ results: [
      { id: 'hs-1', text: 'Alice ships TypeScript.', type: 'world', entities: 'Alice (person),  TypeScript (language) , Node.js, (only a note), Atlas ((nested), Beta (a) (b)' },
      { id: 'hs-2', text: 'A name the server garbled.', type: 'world', entities: notes },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const { registry, body } = await providerBody('hindsight', { endpoint: 'https://api.hindsight.vectorize.io', apiKey: 'hs-secret', bankId: 'alice/profile', budget: 'high' })
    const provider = new HindsightProvider(registry, { fetch: fetchMock })
    const found = await provider.search(body, { query: 'language', limit: 3 })
    expect(found.results.map(result => result.entities)).toEqual([
      ['Alice', 'TypeScript', 'Node.js', 'Atlas', 'Beta (a)'],
      [notes],
    ])
  })
})

describe('independent hindsight Provider', () => {
  it('installs complete immutable metadata in one parent-owned child', async () => {
    const mounted = await mountMemorySpaceProvider(module, { instanceId: 'work', config: undefined })
    try {
      expect(mounted.descriptor).toMatchObject({ id: 'work', typeId: 'hindsight', label: descriptor.label })
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
    const adapter = definition.create({ memoryBodies: authority, config: { timeoutMs: 200 }, providerInstanceId: 'hindsight', manifest: definition.manifest })
    expect(adapter).toBeInstanceOf(HindsightProvider)
    expect(adapter.id).toBe('hindsight')
  })
})
