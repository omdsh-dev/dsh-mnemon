import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as spaces from 'dsh-mnemon-source-memory-spaces'
import * as layered from 'dsh-mnemon-strategy-default-three-tier'
import * as scoped from 'dsh-mnemon-strategy-scoped'
import type { MemorySpaceCatalog } from 'dsh-mnemon-source-memory-spaces/contracts'
import { createMemorySpaceProviderFixture } from 'dsh-mnemon-source-memory-spaces/testing'
import { HindsightProvider, descriptor } from 'dsh-mnemon-provider-hindsight'

it('keeps legacy Hindsight banks readable while only the restricted DSH Source can write (#434)', async () => {
  // Synthetic credential labels; no live Hindsight service or account is used.
  const mutations: string[] = []
  const denied: string[] = []
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the real adapter's body. */ }
    const token = request.headers.authorization
    const banks = token === 'Bearer fixture-legacy' ? ['legacy-a', 'legacy-b'] : token === 'Bearer fixture-dsh-only' ? ['dsh'] : []
    const path = new URL(request.url!, 'http://localhost').pathname
    response.setHeader('content-type', 'application/json')
    const send = (value: unknown) => response.end(JSON.stringify(value))
    if (path === '/health/live') return send({ status: 'ok' })
    if (path === '/v1/default/banks') return send({ banks: banks.map(bank_id => ({ bank_id, name: bank_id })) })
    const bank = decodeURIComponent(path.split('/')[4] ?? '')
    if (!banks.includes(bank)) { denied.push(path); response.statusCode = 403; return send({ error: 'bank forbidden' }) }
    if (path.endsWith('/memories/recall')) return send({ results: [{ id: bank + '-fact', text: 'Original ' + bank + ' evidence', score: 1 }] })
    if (path.endsWith('/graph')) return send({
      nodes: [{ id: bank + '-fact', text: 'Original evidence' }, { id: bank + '-related', text: 'Related evidence' }],
      edges: [{ source: bank + '-fact', target: bank + '-related', type: 'semantic' }],
    })
    if (request.method === 'POST' || request.method === 'PATCH') {
      mutations.push(bank)
      return send({ operation_id: 'fixture-retain', items_count: 1 })
    }
    return send({ items: [], total_nodes: 1 })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const directory = await mkdtemp(join(tmpdir(), 'mnemon-bank-isolation-'))
  let runner = new MemoryCompositionRunner()
  const scope = { storage: 'custom' as const }
  const mount = async (id: string, writeEnabled: boolean) => runner.mount(spaces, { instanceId: id,
    config: { dataDir: join(directory, id), writeEnabled, providers: [{ use: 'dsh-mnemon-provider-hindsight', instanceId: 'hindsight' }] },
  })
  const manage = async (id: string, operation: string, input: Record<string, string | boolean | object>) => {
    const source = (await runner.managementCatalog(scope)).sources.find(source => source.sourceInstanceKey === `source:${id}`)!
    return runner.executeManagement({ scope, sourceInstanceKey: source.sourceInstanceKey, mode: 'mutate', confirmed: true,
      expectedRevision: source.revision, operation, input: input as never })
  }
  const catalog = async (id: string) => (await runner.executeManagement({ scope, sourceInstanceKey: `source:${id}`,
    mode: 'read', confirmed: false, operation: 'body-directory', input: null })).value as unknown as MemorySpaceCatalog
  try {
    // Offline preparation only configures/discovers namespaces; it mutates no bank.
    await runner.mount(layered, { instanceId: 'layered' })
    await runner.mount(scoped, { instanceId: 'selection' })
    for (const id of ['legacy', 'dsh']) {
      await mount(id, true)
      await manage(id, 'provider-service-update', { providerId: 'hindsight', enabled: true,
        settings: { endpoint, apiKey: id === 'legacy' ? 'fixture-legacy' : 'fixture-dsh-only' } })
    }
    expect(mutations).toEqual([])
    await runner.dispose()
    // Restart with the immutable Source write policy before accepting conversations.
    runner = new MemoryCompositionRunner()
    await mount('legacy', false)
    await mount('dsh', true)
    await runner.mount(layered, { instanceId: 'layered' })
    await runner.mount(scoped, { instanceId: 'selection', config: {
      sourceKeys: ['source:dsh', 'source:legacy'], writableSourceKeys: ['source:dsh'],
    } })
    const turn = await runner.beginTurn({ scope })
    const legacy = await catalog('legacy')
    const writable = await catalog('dsh')
    expect(legacy.items.map(item => item.name).sort()).toEqual(['legacy-a', 'legacy-b'])
    expect(writable.items.map(item => item.name)).toEqual(['dsh'])
    const route = turn.view.routes.find(route => route.sourceInstanceKey === 'source:legacy' && route.sourceRouteId === 'recall')!
    const evidence = await turn.executeRoute(route.id, { query: 'Original evidence' })
    expect(evidence.items.map(item => item.id).sort()).toEqual(['legacy-a-fact', 'legacy-b-fact'])
    const related = turn.view.routes.find(route => route.sourceInstanceKey === 'source:legacy' && route.sourceRouteId === 'related')!
    expect((await turn.executeRoute(related.id, { id: 'legacy-a-fact', depth: 1,
      memoryBodyId: legacy.items.find(item => item.name === 'legacy-a')!.id })).items.map(item => item.id)).toContain('legacy-a-related')
    expect(turn.view.actionOffers.every(action => action.sourceInstanceKey === 'source:dsh')).toBe(true)
    const remember = turn.view.actionOffers.find(action => action.sourceActionId === 'remember')!
    await expect(turn.executeAction(remember.id, { content: 'Must not reach a legacy bank', memoryBodyId: legacy.items[0]!.id }, () => true)).rejects.toThrow()
    for (const [operation, input] of [
      ['remember', { content: 'Blocked', memoryBodyId: legacy.items[0]!.id }],
      ['forget', { id: 'legacy-a-fact', memoryBodyId: legacy.items[0]!.id }],
      ['provider-service-update', { providerId: 'hindsight', enabled: true, settings: { endpoint, apiKey: 'fixture-dsh-only' } }],
    ] as const) await expect(manage('legacy', operation, input)).rejects.toThrow(/read-only/u)
    expect(mutations).toEqual([])
    const receipt = await turn.executeAction(remember.id, { content: 'New DSH decision' }, () => true)
    expect(receipt).toMatchObject({ status: 'succeeded', completion: 'accepted' })
    expect(receipt.committedAt).toBeUndefined()
    expect(mutations).toEqual(['dsh'])
    // Changing a local connection's bank name is not a substitute for backend authority.
    // The restricted credential still cannot write either legacy bank directly.
    for (const bank of ['legacy-a', 'legacy-b']) {
      const alias = createMemorySpaceProviderFixture(descriptor, { endpoint, apiKey: 'fixture-dsh-only', bankId: bank, budget: 'mid' },
        { dataDir: join(directory, 'alias-' + bank), instanceId: 'same-provider-alias' })
      const provider = new HindsightProvider(alias.authority)
      await expect(provider.remember(alias.body, { content: 'Blocked alias write' })).rejects.toThrow(/403/u)
      await expect(provider.forget(alias.body, bank + '-fact')).rejects.toThrow(/403/u)
    }
    expect(denied).toHaveLength(4)
    expect(mutations).toEqual(['dsh'])
    turn.release()
    await manage('dsh', 'provider-service-update', { providerId: 'hindsight', enabled: false })
    const empty = await runner.beginTurn({ scope })
    expect(empty.view.actionOffers).toEqual([])
    expect(empty.view.routes.some(route => route.sourceInstanceKey === 'source:legacy' && route.sourceRouteId === 'recall')).toBe(true)
    empty.release()
  } finally {
    await runner.dispose()
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    await rm(directory, { recursive: true, force: true })
  }
})
