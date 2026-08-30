import { descriptor, provider, strategy } from './fixture.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { installMemorySpaces } from '../src/index.ts'
import { MemoryBodyRegistry } from '../src/memory-bodies.ts'
import { createRunner } from '../src/runner.ts'
import { resolveMemorySpacesConfig } from '../src/config.ts'
import { defineMemorySpaceProvider, MemoryProviderCatalog } from '../src/provider-sdk.ts'

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
      const action = first.view.actionOffers.find(offer => offer.sourceInstanceKey === 'source:work' && offer.sourceActionId === 'remember')!
      await first.lease.generation.executeAction(first.view, action.id, { content: 'Only for work' }, () => true)
      first.release()
      const next = await runner.beginTurn({ scope })
      for (const route of next.view.routes.filter(route => route.sourceRouteId === 'recall')) {
        const evidence = await next.lease.generation.executeRoute(next.view, route.id, { query: 'work' })
        expect(evidence.items).toHaveLength(route.sourceInstanceKey === 'source:work' ? 1 : 0)
      }
      expect(runner.context.get('mnemonProvider', false)).toBeUndefined()
      next.release()
    } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('observes durable metadata changed by another generation', () => {
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
