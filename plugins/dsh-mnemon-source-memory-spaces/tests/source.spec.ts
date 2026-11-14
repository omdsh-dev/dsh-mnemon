import { descriptor, provider, strategy } from './fixture.ts'
import { providerEntries, TestHolographicProvider as HolographicProvider } from './providers.ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_MEMORY_VIEW_BUDGET, MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as spaces from '../src/index.ts'
import { installMemorySpaces } from '../src/index.ts'
import { MemorySpaceRegistry } from '../src/memory-spaces.ts'
import { createRunner } from '../src/runner.ts'
import { resolveMemorySpacesConfig } from '../src/config.ts'
import { defineMemorySpaceProvider, MEMORY_SPACE_PROVIDER_API_VERSION, NORMALIZED_RELEVANCE_SCORE } from '../src/provider-sdk.ts'
import { MemoryProviderCatalog } from '../src/providers/catalog.ts'
import { MEMORY_SPACE_DESCRIPTION_MAX_LENGTH, MEMORY_SPACE_NAME_MAX_LENGTH, type MemorySpaceCatalog } from '../src/contracts.ts'

describe('standalone Memory Spaces Source', () => {
  it('admits only evidence actually returned under the View budget, not all Provider search hits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-bounded-'))
    const runner = new MemoryCompositionRunner()
    const scope = { storage: 'custom' as const }
    const rows = [{ id: 'visible', content: 'needle\u{1F600} evidence one', score: 1, importance: 0.8, createdAt: '2026-08-30T00:00:00.000Z' }, { id: 'hidden', content: 'needle evidence two', score: 0.9 }]
    const related = vi.fn(async () => [...rows])
    const forget = vi.fn(async () => ({ action: 'deleted' }))
    const boundedProvider = defineMemorySpaceProvider<undefined>({ id: 'bounded', apply(ctx, host) {
      host.install(ctx, {
        manifest: { apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION, kind: 'provider', typeId: 'bounded',
          packageName: 'dsh-mnemon-provider-bounded-test', version: '1.0.0', label: 'Bounded fixture', summary: 'Simulated Provider; real Source and Core.',
          origin: 'third-party', locality: 'remote', workspaceBinding: 'provider-global', fields: [], secrets: [], scoreSemantics: 'normalized-relevance',
          capabilities: { ...descriptor.capabilities, related: true, forget: true, deletionMode: 'hard' },
        },
        create: () => ({ id: 'bounded', scoreSemantics: NORMALIZED_RELEVANCE_SCORE,
          discover: async () => [{ externalId: 'notes', name: 'Notes', description: 'Fixture namespace', connection: {} }],
          status: async () => ({ healthy: true }), list: async () => [...rows], search: async () => ({ results: [...rows] }),
          graph: async () => ({ nodes: [], edges: [], generatedAt: new Date().toISOString() }),
          remember: async () => ({ action: 'queued', operationId: 'extraction-job' }), related, forget,
        }),
      })
    } })
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'account', module: boundedProvider, config: undefined }], { config: { dataDir: directory } })
      } }, { instanceId: 'work' })
      const source = (await runner.managementCatalog(scope)).sources[0]!
      await runner.executeManagement({ scope, sourceInstanceKey: source.sourceInstanceKey, mode: 'mutate', confirmed: true,
        expectedRevision: source.revision, operation: 'provider-service-update', input: { providerId: 'account', settings: {}, enabled: true } })
      const turn = await runner.beginTurn({ scope, budget: { ...DEFAULT_MEMORY_VIEW_BUDGET, maxEvidenceCharacters: 5 } })
      const route = (id: string) => turn.view.routes.find(route => route.sourceRouteId === id)!.id
      const remember = turn.view.actionOffers.find(action => action.sourceActionId === 'remember')!
      const accepted = await turn.executeAction(remember.id, { content: 'Queued input.' }, () => true)
      expect(accepted).toMatchObject({ status: 'succeeded', completion: 'accepted', details: { result: { operationId: 'extraction-job' } } })
      expect(accepted.committedAt).toBeUndefined()
      const evidence = await turn.executeRoute(route('recall'), { query: 'needle' })
      expect(evidence.items.map(item => item.id)).toEqual(['visible'])
      expect(evidence.items[0]?.provenance).toMatchObject({ importance: 0.8, createdAt: '2026-08-30T00:00:00.000Z' })
      expect(evidence.items[0]?.text.length).toBeLessThanOrEqual(5)
      expect(evidence.truncated).toBe(true)
      await expect(turn.executeRoute(route('related'), { id: 'hidden' })).rejects.toThrow('already admitted')
      expect(related).not.toHaveBeenCalled()
      await turn.executeRoute(route('related'), { id: 'visible' })
      expect(related).toHaveBeenCalledOnce()
      const action = turn.view.actionOffers.find(action => action.sourceActionId === 'forget')!
      await expect(turn.executeAction(action.id, { id: 'hidden' }, () => true)).rejects.toThrow('already admitted')
      // Naming the space does not make an id usable when its Provider cannot look
      // ids up: that Provider's own forget may reach beyond the space (issue 337).
      const directoryRead = await runner.executeManagement({ scope, sourceInstanceKey: source.sourceInstanceKey, mode: 'read', confirmed: false, operation: 'body-directory', input: null })
      const notes = (directoryRead.value as unknown as { items: Array<{ id: string }> }).items[0]!.id
      await expect(turn.executeAction(action.id, { id: 'hidden', memoryBodyId: notes }, () => true)).rejects.toThrow('already admitted')
      await expect(turn.executeRoute(route('related'), { id: 'hidden', memoryBodyId: notes })).rejects.toThrow('already admitted')
      expect(forget).not.toHaveBeenCalled()
      const receipt = await turn.executeAction(action.id, { id: 'visible' }, () => true)
      expect(receipt.completion).toBe('committed')
      const catalog = await turn.executeRoute(route('inspect'), { section: 'directory' })
      expect(catalog.items).toEqual([]) // Never clip catalog JSON into invalid text.
      expect(catalog.unavailable).toContain('valid catalog JSON')
    } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('acts on a memory named by exact id that this View has not returned (issue 337)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-exact-id-'))
    const runner = new MemoryCompositionRunner()
    const scope = { storage: 'custom' as const }
    // `written` exists only in Notes; `twin` exists in both spaces.
    const stored: Record<string, Array<{ id: string; content: string }>> = {
      notes: [{ id: 'written', content: 'Written a moment ago' }, { id: 'twin', content: 'Twin in Notes' }],
      archive: [{ id: 'twin', content: 'Twin in Archive' }],
    }
    const forget = vi.fn(async () => ({ action: 'deleted' }))
    const related = vi.fn(async () => [])
    const link = vi.fn(async () => ({ action: 'linked' }))
    const exactProvider = defineMemorySpaceProvider<undefined>({ id: 'exact', apply(ctx, host) {
      host.install(ctx, {
        manifest: { apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION, kind: 'provider', typeId: 'exact',
          packageName: 'dsh-mnemon-provider-exact-test', version: '1.0.0', label: 'Exact fixture', summary: 'Looks memories up by id.',
          origin: 'third-party', locality: 'remote', workspaceBinding: 'provider-global', fields: [], secrets: [], scoreSemantics: 'normalized-relevance',
          capabilities: { ...descriptor.capabilities, related: true, link: true, forget: true, deletionMode: 'soft' },
        },
        create: () => ({ id: 'exact', scoreSemantics: NORMALIZED_RELEVANCE_SCORE,
          discover: async () => [
            { externalId: 'notes', name: 'Notes', description: 'Fixture namespace', connection: {} },
            { externalId: 'archive', name: 'Archive', description: 'Fixture namespace', connection: {} },
          ],
          status: async () => ({ healthy: true }), list: async () => [], search: async () => ({ results: [] }),
          graph: async () => ({ nodes: [], edges: [], generatedAt: new Date().toISOString() }),
          remember: async () => ({ action: 'stored' }),
          get: async (body, id) => stored[body.name.toLowerCase()]?.find(item => item.id === id),
          related, link, forget,
        }),
      })
    } })
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'account', module: exactProvider, config: undefined }], { config: { dataDir: directory } })
      } }, { instanceId: 'work' })
      const source = (await runner.managementCatalog(scope)).sources[0]!
      await runner.executeManagement({ scope, sourceInstanceKey: source.sourceInstanceKey, mode: 'mutate', confirmed: true,
        expectedRevision: source.revision, operation: 'provider-service-update', input: { providerId: 'account', settings: {}, enabled: true } })
      const directoryRead = await runner.executeManagement({ scope, sourceInstanceKey: source.sourceInstanceKey, mode: 'read', confirmed: false, operation: 'body-directory', input: null })
      const spaces = (directoryRead.value as unknown as { items: Array<{ id: string; name: string }> }).items
      const notes = spaces.find(space => space.name === 'Notes')!.id
      const archive = spaces.find(space => space.name === 'Archive')!.id
      const turn = await runner.beginTurn({ scope })
      const offer = (id: string) => turn.view.actionOffers.find(action => action.sourceActionId === id)!.id
      const route = turn.view.routes.find(item => item.sourceRouteId === 'related')!.id

      // Nothing was recalled in this View: the Provider finds the id, in one space only.
      await expect(turn.executeAction(offer('forget'), { id: 'written' }, () => true)).resolves.toMatchObject({ completion: 'committed' })
      expect(forget.mock.calls.at(-1)?.slice(0, 2)).toEqual([expect.objectContaining({ id: notes }), 'written'])
      // An id no authorized space holds, or one two spaces hold, is not guessed.
      // With no space switched off, the refusal names none (#390).
      await expect(turn.executeAction(offer('forget'), { id: 'missing' }, () => true)).rejects.toThrow(/already admitted.*when several hold it$/u)
      await expect(turn.executeAction(offer('forget'), { id: 'twin' }, () => true)).rejects.toThrow('already admitted')
      expect(forget).toHaveBeenCalledOnce()
      // Naming the space settles it.
      await turn.executeAction(offer('forget'), { id: 'twin', memoryBodyId: archive }, () => true)
      expect(forget.mock.calls.at(-1)?.slice(0, 2)).toEqual([expect.objectContaining({ id: archive }), 'twin'])
      // The same holds for traversal and links within one space.
      await turn.executeRoute(route, { id: 'twin', memoryBodyId: notes })
      expect(related.mock.calls.at(-1)?.slice(0, 3)).toEqual([expect.objectContaining({ id: notes }), 'twin', 2])
      await turn.executeAction(offer('link'), { sourceId: 'written', targetId: 'twin', memoryBodyId: notes }, () => true)
      expect(link.mock.calls.at(-1)?.slice(0, 3)).toEqual([expect.objectContaining({ id: notes }), 'written', 'twin'])
      await expect(turn.executeAction(offer('link'), { sourceId: 'written', targetId: 'twin', memoryBodyId: archive }, () => true)).rejects.toThrow('link requires two evidence items')
      turn.release()
      // A switched-off space is outside the next View, and a forget there says so rather than looking like a missing memory (#390).
      await runner.executeManagement({ scope, sourceInstanceKey: source.sourceInstanceKey, mode: 'mutate', confirmed: true,
        expectedRevision: (await runner.managementCatalog(scope)).sources[0]!.revision, operation: 'body-update', input: { memoryBodyId: archive, active: false } })
      const later = await runner.beginTurn({ scope })
      const forgetOffer = later.view.actionOffers.find(action => action.sourceActionId === 'forget')!.id
      // Whether a space is on stays the user's choice, and the View is pinned for the turn.
      await expect(later.executeAction(forgetOffer, { id: 'twin', memoryBodyId: archive }, () => true)).rejects.toThrow(`Memory Space ${JSON.stringify(archive)} (Archive) is switched off, so this turn's View does not read it and cannot forget from it. Whether it is on is the user's choice, on the Memory Spaces page; once it is on, a forget there works from the next turn`)
      await expect(later.executeAction(forgetOffer, { id: 'twin', memoryBodyId: 'nowhere' }, () => true)).rejects.toThrow('Memory Space "nowhere" does not exist')
      await expect(later.executeAction(forgetOffer, { id: 'missing' }, () => true)).rejects.toThrow('when several hold it. Switched-off spaces ("Archive") are outside this View; one the user switches on is read from the next turn')
      // Switched on again during the turn, the space is still outside the pinned View until the next one.
      await runner.executeManagement({ scope, sourceInstanceKey: source.sourceInstanceKey, mode: 'mutate', confirmed: true,
        expectedRevision: (await runner.managementCatalog(scope)).sources[0]!.revision, operation: 'body-update', input: { memoryBodyId: archive, active: true } })
      await expect(later.executeAction(forgetOffer, { id: 'twin', memoryBodyId: archive }, () => true))
        .rejects.toThrow(`Memory Space ${JSON.stringify(archive)} (Archive) was switched on after this turn began, so this turn's View does not read it yet; a forget there works from the next turn`)
      expect(forget).toHaveBeenCalledTimes(2)
      later.release()
      const next = await runner.beginTurn({ scope })
      await next.executeAction(next.view.actionOffers.find(action => action.sourceActionId === 'forget')!.id, { id: 'twin', memoryBodyId: archive }, () => true)
      expect(forget).toHaveBeenCalledTimes(3)
      next.release()
    } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('owns two isolated Provider trees, storage roots, management and LLM routes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-source-'))
    const runner = new MemoryCompositionRunner()
    const scope = { storage: 'custom' as const }
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      for (const id of ['work', 'personal']) await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'account', module: provider, config: undefined }], { config: { dataDir: join(directory, id) } })
      } }, { instanceId: id })
      for (const sourceInstanceKey of ['source:work', 'source:personal']) {
        const source = (await runner.managementCatalog(scope)).sources.find(source => source.sourceInstanceKey === sourceInstanceKey)!
        await runner.executeManagement({ scope, sourceInstanceKey, mode: 'mutate', confirmed: true, expectedRevision: source.revision,
          operation: 'provider-service-update', input: { providerId: 'account', settings: {}, enabled: true } })
      }
      const first = await runner.beginTurn({ scope })
      expect(first.view.sourcePresentations?.filter(value => value.visibleItems > 0)).toEqual(expect.arrayContaining([
        expect.objectContaining({ mode: 'routed', visibleItems: 1, totalItems: 1,
          items: [expect.objectContaining({ title: 'Notes', excerpt: 'Provider namespace' })] }),
      ]))
      const action = first.view.actionOffers.find(offer => offer.sourceInstanceKey === 'source:work' && offer.sourceActionId === 'remember')!
      await first.executeAction(action.id, { content: 'Only for work' }, () => true)
      first.release()
      const next = await runner.beginTurn({ scope })
      for (const route of next.view.routes.filter(route => route.sourceRouteId === 'recall')) {
        const evidence = await next.executeRoute(route.id, { query: 'work' })
        expect(evidence.items).toHaveLength(route.sourceInstanceKey === 'source:work' ? 1 : 0)
      }
      expect(runner.context.get('mnemonProvider', false)).toBeUndefined()
      next.release()
    } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('limits a space name and description by one rule wherever a request sets them', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-limits-'))
    const runner = new MemoryCompositionRunner()
    const scope = { storage: 'custom' as const }
    const name = 'n'.repeat(MEMORY_SPACE_NAME_MAX_LENGTH)
    const description = 'd'.repeat(MEMORY_SPACE_DESCRIPTION_MAX_LENGTH)
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'fixture', module: provider, config: undefined }], { config: { dataDir: directory } })
      } }, { instanceId: 'spaces' })
      const client = await runner.managementClient('source:spaces', scope)
      await client.mutate('provider-service-update', { providerId: 'fixture', settings: {}, enabled: true }, { confirmed: true })
      const body = ((await client.read('body-directory')).value as unknown as { items: Array<{ id: string }> }).items[0]!
      // The management operations.
      await expect(client.mutate('body-create', { name: `${name}n`, description: 'Facts' }, { confirmed: true })).rejects.toThrow('name is too long (max 100 characters)')
      await expect(client.mutate('body-create', { name, description: `${description}d` }, { confirmed: true })).rejects.toThrow('description is too long (max 1000 characters)')
      await expect(client.mutate('body-update', { memoryBodyId: body.id, name: `${name}n` }, { confirmed: true })).rejects.toThrow('name is too long (max 100 characters)')
      await expect(client.mutate('body-update', { memoryBodyId: body.id, description: `${description}d` }, { confirmed: true })).rejects.toThrow('description is too long (max 1000 characters)')
      expect((await client.mutate('body-update', { memoryBodyId: body.id, name, description }, { confirmed: true })).value).toMatchObject({ name, description })
      // The model's manage-spaces Action.
      const turn = await runner.beginTurn({ scope })
      const manage = turn.view.actionOffers.find(offer => offer.sourceActionId === 'manage-spaces')!
      await expect(turn.executeAction(manage.id, { operation: 'update', memoryBodyId: body.id, name: `${name}n` }, () => true)).rejects.toThrow('name is too long (max 100 characters)')
      await expect(turn.executeAction(manage.id, { operation: 'update', memoryBodyId: body.id, description: `${description}d` }, () => true)).rejects.toThrow('description is too long (max 1000 characters)')
      turn.release()
    } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('observes durable metadata changed by another generation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-authority-'))
    try {
      const nativeRunner = createRunner(resolveMemorySpacesConfig({ dataDir: directory }))
      const catalog = new MemoryProviderCatalog([descriptor])
      const first = new MemorySpaceRegistry(nativeRunner, true, undefined, catalog)
      first.syncProviderService('fixture', {}, [{ externalId: 'notes', name: 'Notes', description: 'A namespace', connection: {} }])
      const second = new MemorySpaceRegistry(nativeRunner, true, undefined, catalog)
      const id = first.list()[0]!.id
      first.setActive(id, false)
      expect(second.get(id).active).toBe(false)
      second.update(id, { name: 'Updated elsewhere' })
      expect(first.get(id).name).toBe('Updated elsewhere')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('publishes nothing when configuration or a child fails', async () => {
    const runner = new MemoryCompositionRunner()
    try {
      await expect(runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'account', module: provider, config: undefined }], { config: { dataDir: 'relative' } })
      } }, { instanceId: 'invalid' })).rejects.toThrow('absolute')
      let released = false
      const failing = defineMemorySpaceProvider<undefined>({ id: 'failing', apply(ctx) {
        ctx.effect(() => () => { released = true })
        throw new Error('fixture child failed')
      } })
      await expect(runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'account', module: provider, config: undefined }, { instanceId: 'bad', module: failing, config: undefined }])
      } }, { instanceId: 'failed' })).rejects.toThrow('fixture child failed')
      expect(released).toBe(true)
      expect(runner.inspect().evaluation.sourceInstanceKeys).toHaveLength(0)
    } finally { await runner.dispose() }
  })

  it('stays inert under a dshmarket client-only shim Entry, which carries no Providers (#359)', async () => {
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount(spaces, { instanceId: 'include:dsh-market:mkt-client-dsh-mnemon-source-memory-spaces' })
      expect(runner.inspect().evaluation.sourceInstanceKeys).toHaveLength(0)
      await expect(runner.mount(spaces, { instanceId: 'spaces' })).rejects.toThrow('at least one explicit Provider child')
    } finally { await runner.dispose() }
  })
})

describe('Memory Spaces metadata IO through public Cordis plugins', () => {
  it('keeps live shared authority, durable receipts and cancellation without Provider data probes during composition', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-io-'))
    const scope = { storage: 'custom' as const }
    const runners: MemoryCompositionRunner[] = []
    const mount = async () => {
      const runner = new MemoryCompositionRunner()
      runners.push(runner)
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, providerEntries, { config: { dataDir: directory, cliPath: '/fake/mnemon' } })
      } }, { instanceId: 'spaces' })
      return { runner, client: await runner.managementClient('source:spaces', scope) }
    }
    const status = vi.spyOn(HolographicProvider.prototype, 'status')
    const search = vi.spyOn(HolographicProvider.prototype, 'search')
    const list = vi.spyOn(HolographicProvider.prototype, 'list')
    try {
      const first = await mount()
      const store = join(directory, 'facts.json')
      await first.client.mutate('provider-service-update', { providerId: 'holographic', settings: { dataPath: store }, enabled: true }, { confirmed: true })
      const catalog = (await first.client.read('body-directory')).value as unknown as MemorySpaceCatalog
      const body = catalog.items[0]!
      expect(body.provider.id).toBe('holographic')
      status.mockClear(); search.mockClear(); list.mockClear()
      const initialRevision = first.client.revision
      for (let index = 0; index < 4; index++) {
        const turn = await first.runner.beginTurn({ scope })
        expect(turn.view.readGrants[0]!.value).toMatchObject({ memoryBodyIds: [body.id] })
        turn.release()
        expect((await first.client.read('body-directory')).revision).toBe(initialRevision)
      }
      expect(status).not.toHaveBeenCalled()
      expect(search).not.toHaveBeenCalled()
      expect(list).not.toHaveBeenCalled()

      const turn = await first.runner.beginTurn({ scope })
      const offer = turn.view.actionOffers.find(offer => offer.sourceActionId === 'remember')!
      const receipt = await turn.executeAction(offer.id, { content: 'Durable provider checkpoint.', memoryBodyId: body.id, importance: 3 }, () => true)
      expect(receipt).toMatchObject({ status: 'succeeded', completion: 'committed', committedAt: expect.any(String) })
      expect(JSON.parse(readFileSync(store, 'utf8')).facts).toMatchObject([{ content: 'Durable provider checkpoint.' }])
      turn.release()
      const saved = await first.client.read('body-directory')
      expect(saved.revision).not.toBe(initialRevision)

      const second = await mount()
      const updated = await second.client.mutate('body-update', { memoryBodyId: body.id, name: 'Renamed elsewhere', active: false }, { confirmed: true })
      await expect(first.client.mutate('remember', { content: 'Stale write.', memoryBodyId: body.id }, { confirmed: true, expectedRevision: saved.revision })).rejects.toThrow('revision conflict')
      const changed = await first.client.read('body-directory')
      expect(changed.revision).toBe(updated.revision)
      expect(changed.value).toMatchObject({ activeCount: 0, items: [{ name: 'Renamed elsewhere', active: false }] })
      const inactive = await first.runner.beginTurn({ scope })
      expect(inactive.view.readGrants[0]!.value).toMatchObject({ memoryBodyIds: [], knownMemoryBodyIds: [body.id] })
      const grant = inactive.view.readGrants[0]!
      const writeScope = { viewId: inactive.view.id, grant: { ...grant } }
      expect((await first.client.read('body-directory', { writeScope })).value).toMatchObject({
        writeScope: { viewId: inactive.view.id, sourceInstanceKey: 'source:spaces', memoryBodyIds: [body.id] },
      })
      expect((await first.client.read('body-directory', { writeScope: { ...writeScope,
        grant: { ...grant, value: { memoryBodyIds: [body.id], knownMemoryBodyIds: [] } },
      } })).value).toMatchObject({ writeScope: { memoryBodyIds: [] } })
      expect((await first.client.read('body-directory', { writeScope: { ...writeScope,
        grant: { ...grant, value: { memoryBodyIds: [body.id] } },
      } })).value).toMatchObject({ writeScope: { memoryBodyIds: [body.id] } })
      for (const invalid of [{ ...grant, sourceInstanceKey: 'source:foreign' }, { ...grant, schema: 'foreign-schema' }]) {
        await expect(first.client.read('body-directory', { writeScope: { ...writeScope, grant: invalid } }))
          .rejects.toThrow('write scope grant does not belong to this Source')
      }
      await expect(first.client.read('body-directory', { writeScope: { ...writeScope,
        grant: { ...grant, value: { memoryBodyIds: [], knownMemoryBodyIds: [42] } },
      } })).rejects.toThrow('knownMemoryBodyIds')
      inactive.release()

      await second.client.mutate('body-update', { memoryBodyId: body.id, active: true }, { confirmed: true })
      const current = await first.client.read('body-directory')
      const diskBefore = readFileSync(store, 'utf8')
      const controller = new AbortController()
      controller.abort(new Error('cancelled before mutation'))
      await expect(first.runner.executeManagement({ sourceInstanceKey: 'source:spaces', scope, mode: 'mutate', operation: 'remember',
        input: { content: 'Cancelled write.', memoryBodyId: body.id }, confirmed: true, expectedRevision: current.revision, signal: controller.signal,
      })).rejects.toThrow('cancelled before mutation')
      expect(readFileSync(store, 'utf8')).toBe(diskBefore)

      await second.client.mutate('provider-service-update', { providerId: 'holographic', settings: {}, enabled: false }, { confirmed: true })
      expect((await first.client.read('body-directory')).value).toMatchObject({ total: 0, activeCount: 0 })
      expect(first.runner.context.get('mnemonProvider', false)).toBeUndefined()
    } finally {
      status.mockRestore(); search.mockRestore(); list.mockRestore()
      for (const runner of runners.reverse()) await runner.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('passes an inspection on to the Provider and leaves Agent recall a use (issue 338)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-inspect-'))
    const scope = { storage: 'custom' as const }
    const runner = new MemoryCompositionRunner()
    const search = vi.spyOn(HolographicProvider.prototype, 'search')
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, providerEntries, { config: { dataDir: directory, cliPath: '/fake/mnemon' } })
      } }, { instanceId: 'spaces' })
      const client = await runner.managementClient('source:spaces', scope)
      await client.mutate('provider-service-update', { providerId: 'holographic', settings: { dataPath: join(directory, 'facts.json') }, enabled: true }, { confirmed: true })
      const body = ((await client.read('body-directory')).value as unknown as MemorySpaceCatalog).items[0]!
      await client.mutate('remember', { content: 'Release gates need a canary.', memoryBodyId: body.id }, { confirmed: true })
      search.mockClear()

      // The Memory System's own searches look.
      await client.read('search', { query: 'release gates', inspect: true })
      expect(search.mock.calls.at(-1)?.[1]).toMatchObject({ query: 'release gates', inspect: true })
      // Without the flag a read keeps counting as a use, as before.
      await client.read('search', { query: 'release gates' })
      expect(search.mock.calls.at(-1)?.[1]).not.toHaveProperty('inspect')
      // An Agent's recall through its View is a use.
      const turn = await runner.beginTurn({ scope })
      await turn.executeRoute(turn.view.routes.find(route => route.sourceRouteId === 'recall')!.id, { query: 'release gates' })
      expect(search.mock.calls.at(-1)?.[1]).not.toHaveProperty('inspect')
      turn.release()
    } finally {
      search.mockRestore()
      await runner.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('validates remember-many request fields and enforces the 8192-character boundary cleanly', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-remember-many-'))
    const scope = { storage: 'custom' as const }
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'fixture', module: provider, config: undefined }], { config: { dataDir: directory } })
      } }, { instanceId: 'spaces' })
      const client = await runner.managementClient('source:spaces', scope)
      await client.mutate('provider-service-update', { providerId: 'fixture', settings: {}, enabled: true }, { confirmed: true })
      const body = ((await client.read('body-directory')).value as unknown as MemorySpaceCatalog).items[0]!
      await expect(client.mutate('remember-many', { requests: [{ content: 42 as unknown as string, memoryBodyId: body.id }] }, { confirmed: true }))
        .rejects.toThrow(/content/u)
      await expect(client.mutate('remember-many', { requests: [{ content: 'x'.repeat(8193), memoryBodyId: body.id }] }, { confirmed: true }))
        .rejects.toThrow('max 8192 characters')
      await expect(client.mutate('remember', { content: 'x'.repeat(8193), memoryBodyId: body.id }, { confirmed: true }))
        .rejects.toThrow('max 8192 characters')
    } finally {
      await runner.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
