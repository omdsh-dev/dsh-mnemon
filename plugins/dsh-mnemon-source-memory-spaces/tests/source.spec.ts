import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { defineMemoryStrategy, installMemory } from 'dsh-mnemon/extension-sdk'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { installMemorySpaces, MemoryBodyRegistry, createRunner, resolveMemorySpacesConfig } from '../src/index.ts'
import { MEMORY_SPACE_PROVIDER_API_VERSION, defineMemorySpaceProvider, MemoryProviderCatalog, NORMALIZED_RELEVANCE_SCORE, type MemoryProviderDescriptor } from '../src/provider-sdk.ts'

const descriptor: MemoryProviderDescriptor = {
  id: 'fixture', label: 'Fixture', kind: 'remote', origin: 'third-party', workspaceBinding: 'provider-global',
  summary: 'Provider test double; Source and Cordis lifecycle are real.', fields: [],
  capabilities: { search: true, browse: true, graph: false, entities: false, related: false, remember: true,
    link: false, forget: false, writeMode: 'exact', deletionMode: 'unsupported' },
}

const provider = defineMemorySpaceProvider<undefined>({
  id: descriptor.id,
  apply(ctx, host) {
    const rows: Array<{ id: string; content: string; score: number }> = []
    host.install(ctx, {
      manifest: { apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION, kind: 'provider', typeId: 'fixture',
        packageName: 'dsh-mnemon-provider-fixture', version: '1.0.0', label: descriptor.label, summary: descriptor.summary,
        origin: descriptor.origin, locality: descriptor.kind, workspaceBinding: descriptor.workspaceBinding,
        capabilities: descriptor.capabilities, fields: [], secrets: [], scoreSemantics: 'normalized-relevance' },
      create: () => ({ id: 'fixture', scoreSemantics: NORMALIZED_RELEVANCE_SCORE,
        discover: async () => [{ externalId: 'notes', name: 'Notes', description: 'Provider namespace', connection: {} }],
        status: async () => ({ healthy: true }),
        list: async () => [...rows], search: async () => ({ results: [...rows] }),
        graph: async () => ({ nodes: [], edges: [], generatedAt: new Date().toISOString() }),
        remember: async (_body, request) => { rows.push({ id: String(rows.length), content: request.content, score: 1 }); return { action: 'stored' } },
      }),
    })
  },
})

const strategy = {
  inject: ['mnemonMemory'],
  apply(ctx: Context) {
    installMemory(ctx, { strategies: [defineMemoryStrategy({
      manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'test', packageName: 'test-strategy',
        deterministic: true, supportedSourceRoles: ['durable-evidence'], maxSources: 4, maxRoutes: 4, maxActions: 4 },
      compose: (_request, facts) => ({ strategyTypeId: 'test', explanation: 'Explicit test composition.',
        sources: facts.map(source => ({ sourceInstanceKey: source.sourceInstanceKey,
          projection: { mode: 'routed', maxCharacters: 2048 }, routeIds: source.routeIds, actionIds: source.actionIds })) }),
    })] })
  },
}

describe('standalone Memory Spaces Source', () => {
  it('owns two isolated Provider trees, storage roots, management and LLM routes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-source-'))
    const runner = new MemoryCompositionRunner()
    const scope = { storage: 'custom' as const }
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      for (const id of ['work', 'personal']) await runner.mount({ inject: ['mnemonMemory'], async apply(ctx: Context) {
        await installMemorySpaces(ctx, [{ instanceId: 'account', module: provider, config: undefined }], { config: { dataDir: join(directory, id) } })
      } }, { instanceId: id })
      const generation = runner.generations.current()!
      for (const sourceInstanceKey of ['source:work', 'source:personal']) {
        const source = (await generation.managementCatalog(scope)).sources.find(source => source.sourceInstanceKey === sourceInstanceKey)!
        await generation.executeManagement({ scope, sourceInstanceKey, mode: 'mutate', confirmed: true, expectedRevision: source.revision,
          operation: 'provider-service-update', input: { providerId: 'account', settings: {}, enabled: true } })
      }
      const first = await runner.beginTurn({ scope })
      const action = first.view.actionOffers.find(offer => offer.sourceInstanceKey === 'source:work')!
      await first.lease.generation.executeAction(first.view, action.id, { content: 'Only for work' }, () => true)
      first.release()
      const next = await runner.beginTurn({ scope })
      for (const route of next.view.routes) {
        const evidence = await next.lease.generation.executeRoute(next.view, route.id, { query: 'work' })
        expect(evidence.items).toHaveLength(route.sourceInstanceKey === 'source:work' ? 1 : 0)
      }
      expect(runner.context.get('mnemonProvider', false)).toBeUndefined()
      next.release()
    } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('observes durable metadata changed by another generation or the legacy facade', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-spaces-authority-'))
    try {
      const nativeRunner = createRunner(resolveMemorySpacesConfig({ dataDir: directory }))
      const catalog = new MemoryProviderCatalog([descriptor])
      const first = new MemoryBodyRegistry(nativeRunner, true, undefined, catalog)
      first.syncProviderService('fixture', {}, [{ externalId: 'notes', name: 'Notes', description: 'A namespace', connection: {} }])
      const second = new MemoryBodyRegistry(nativeRunner, true, undefined, catalog)
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
      expect(runner.runtime.contributionSnapshot().sources).toHaveLength(0)
    } finally { await runner.dispose() }
  })
})
