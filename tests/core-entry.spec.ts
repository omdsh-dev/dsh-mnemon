import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as core from '../src/core.ts'
import { COMPOSABLE_MEMORY_API_VERSION } from '../packages/contracts/src/index.ts'
import { defineMemorySource, defineMemoryStrategy, installMemory } from '../packages/extension-sdk/src/index.ts'

describe('Source-neutral Core entry', () => {
  it('mounts on plain Cordis without a DSH default service or built-in contribution', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(core)
    await fiber.await()
    const runtime = ctx.mnemonMemory
    expect(core.inject).toEqual([])
    expect(runtime.contributionSnapshot()).toMatchObject({ sources: [], strategies: [] })
    expect(runtime.descriptors()).toEqual([])
    const attachment = runtime.attachGeneration()
    expect(attachment.host.inspect().evaluation.state).toBe('incomplete')
    await fiber.dispose()
    expect(() => runtime.attachGeneration()).toThrow('disposed')
    expect(() => attachment.host.acquire()).toThrow('disposed')
    await runtime.dispose()
  })

  it('supports third-party Source/Strategy turns without the default bundle and owns shutdown', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(core)
    await fiber.await()
    const runtime = ctx.mnemonMemory
    const disposed = vi.fn()
    const source = defineMemorySource({
      manifest: {
        apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'external-notes',
        packageName: 'dsh-mnemon-external-notes', role: 'notes', capabilities: ['project'], consistency: 'exact-snapshot',
      },
      create: context => ({
        facts: () => ({
          sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'external-notes', role: 'notes',
          availability: 'ready', revision: 'r1', capabilities: ['project'], routeIds: [], actionIds: [],
        }),
        project: request => ({ fragments: [{
          id: 'note', sourceInstanceKey: context.sourceInstanceKey, mode: request.mode,
          text: 'Only external notes', revision: 'r1',
        }] }),
        dispose: disposed,
      }),
    })
    const strategy = defineMemoryStrategy({
      manifest: {
        apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'notes-view', packageName: 'dsh-mnemon-external-notes-view',
        deterministic: true, supportedSourceRoles: ['notes'], maxSources: 1, maxRoutes: 1, maxActions: 1,
      },
      compose: (_request, facts) => ({ strategyTypeId: 'notes-view', explanation: 'Only selected notes', sources: facts.map(fact => ({
        sourceInstanceKey: fact.sourceInstanceKey, projection: { mode: 'eager', maxCharacters: 1_000 }, routes: [], actions: [],
      })) }),
    })
    const sources = ctx.plugin({ inject: ['mnemonMemory'], apply(child: Context) {
      installMemory(child, { sources: [source] }, { instanceId: 'notes' })
    } })
    const strategies = ctx.plugin({ inject: ['mnemonMemory'], apply(child: Context) {
      installMemory(child, { strategies: [strategy] }, { instanceId: 'view' })
    } })
    await Promise.all([sources.await(), strategies.await()])
    const attachment = runtime.attachGeneration()
    const turns = new core.ComposableMemoryTurnManager(attachment.host)
    const turn = await turns.beginTurn('test:1', { storage: 'custom' })
    expect(turns.memoryWake(turn.view.id).text).toBe('Only external notes')
    turns.dispose()
    await fiber.dispose()
    expect(disposed).toHaveBeenCalledOnce()
    expect(() => runtime.installContributions({ sources: [] })).toThrow('disposed')
    await Promise.all([sources.dispose(), strategies.dispose(), attachment.dispose()])
    expect(disposed).toHaveBeenCalledOnce()
  })
})
