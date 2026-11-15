import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { defineMemorySource, defineMemoryStrategy, installMemory, createMemoryMutationReceipt, memoryViewExtensionValues } from 'dsh-mnemon/extension-sdk'
import { ANY_MEMORY_SOURCE_ROLE, COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as base from 'dsh-mnemon-strategy-default-three-tier'
import * as plugin from '../src/index.ts'

async function fixture(role = 'working-context', write = vi.fn()) {
  const runner = new MemoryCompositionRunner()
  const source = { inject: ['mnemonMemory'], apply(ctx: Context) {
    installMemory(ctx, { sources: [defineMemorySource({
      manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'notes',
        packageName: 'external-test-notes', role, capabilities: ['project', 'write'], consistency: 'exact-snapshot',
        actions: [{ id: 'append', description: 'Append one note.', capability: 'write', inputSchema: { type: 'object' } }] },
      create: context => ({
        facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'notes', role, availability: 'ready',
          revision: 'r1', capabilities: ['project', 'write'], routeIds: [], actionIds: ['append'] }),
        project: request => ({ fragments: request.includeProjection ? [{ id: 'note', sourceInstanceKey: context.sourceInstanceKey,
          mode: request.mode, revision: 'r1', text: 'A'.repeat(Math.min(100, request.maxCharacters)) }] : [] }),
        mutate: async request => { write(request.input); return createMemoryMutationReceipt(request.view.id, request.offer.id, context.sourceInstanceKey, 'r2', request.input, 'committed') },
      }),
    })] })
  } }
  await runner.mount(source, { instanceId: 'notes' })
  await runner.mount(base, { instanceId: 'base' })
  return { runner, source, write }
}

describe('independent scoped Strategy extension', () => {
  it('selects multiple instances automatically without replacing the base Strategy', async () => {
    const { runner, source } = await fixture()
    try {
      await runner.mount(source, { instanceId: 'other' })
      await expect(runner.beginTurn()).rejects.toThrow('ambiguous')
      await runner.mount(plugin, { instanceId: 'scoped' })
      const turn = await runner.beginTurn()
      expect(turn.view.strategyTypeId).toBe('default-three-tier')
      expect(turn.view.projection.map(item => item.sourceInstanceKey)).toEqual(['source:notes', 'source:other'])
      expect(turn.view.strategyExtensions?.map(item => item.slot)).toEqual(['selection'])
      turn.release()
    } finally { await runner.dispose() }
  })

  it('respects explicit order and narrows writes independently of reading', async () => {
    const { runner, source } = await fixture()
    try {
      await runner.mount(source, { instanceId: 'other' })
      await runner.mount(plugin, { instanceId: 'scoped', config: { sourceKeys: ['source:other', 'source:notes'], writableSourceKeys: ['source:notes'] } })
      const turn = await runner.beginTurn()
      expect(turn.view.projection.map(item => item.sourceInstanceKey)).toEqual(['source:other', 'source:notes'])
      expect(turn.view.actionOffers.map(item => item.sourceInstanceKey)).toEqual(['source:notes'])
      turn.release()
    } finally { await runner.dispose() }
  })

  it('rejects invalid configuration instead of widening the selection', () => {
    expect(() => plugin.createScopedExtension({ sourceKeys: ['notes'] })).toThrow('exact Source')
    expect(() => plugin.createScopedExtension({ sourceKeys: ['source:notes', 'source:notes'] })).toThrow('duplicate')
    expect(() => plugin.createScopedExtension({ sourceKeys: ['source:notes'], writableSourceKeys: ['source:other'] })).toThrow('within selected')
  })

  it('preserves procedural Sources after three-tier roles for general Strategies and skips them with diagnostics in default-three-tier', async () => {
    const makeSource = (typeId: string, role: string) => ({
      inject: ['mnemonMemory'],
      apply(ctx: Context) {
        installMemory(ctx, { sources: [defineMemorySource({
          manifest: {
            apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId,
            packageName: `external-test-${typeId}`, role, capabilities: ['project', 'write'], consistency: 'exact-snapshot',
            actions: [{ id: 'save', description: 'Save.', capability: 'write', inputSchema: { type: 'object' } }],
          },
          create: context => ({
            facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: typeId, role, availability: 'ready',
              revision: 'r1', capabilities: ['project', 'write'], routeIds: [], actionIds: ['save'] }),
            project: request => ({ fragments: request.includeProjection ? [{ id: typeId, sourceInstanceKey: context.sourceInstanceKey,
              mode: request.mode, revision: 'r1', text: typeId }] : [] }),
            mutate: async request => createMemoryMutationReceipt(request.view.id, request.offer.id, context.sourceInstanceKey, 'r2', request.input, 'committed'),
          }),
        })] })
      },
    })

    const threeTierRunner = new MemoryCompositionRunner()
    try {
      await threeTierRunner.mount(makeSource('skills', 'procedural'), { instanceId: 'skills' })
      await threeTierRunner.mount(makeSource('notes', 'working-context'), { instanceId: 'notes' })
      await threeTierRunner.mount(base, { instanceId: 'base' })
      await threeTierRunner.mount(plugin, { instanceId: 'scoped', config: { writableSourceKeys: [] } })
      const turn = await threeTierRunner.beginTurn()
      expect(turn.view.projection.map(item => item.sourceInstanceKey)).toEqual(['source:notes'])
      expect(turn.view.actionOffers).toEqual([])
      expect(turn.view.diagnostics).toEqual([
        expect.objectContaining({ code: 'unsupported-source-role', message: expect.stringContaining('source:skills') }),
      ])
      turn.release()
    } finally {
      await threeTierRunner.dispose()
    }

    const generalRunner = new MemoryCompositionRunner()
    const roleAgnostic = {
      inject: ['mnemonMemory'],
      apply(ctx: Context) {
        installMemory(ctx, { strategies: [defineMemoryStrategy({
          manifest: {
            apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'role-agnostic',
            packageName: 'external-test-general', deterministic: true,
            supportedSourceRoles: [ANY_MEMORY_SOURCE_ROLE], maxSources: 32, maxRoutes: 32, maxActions: 32,
            extensionSlots: ['selection'],
          },
          compose(_request, sources, contributions = []) {
            const selection = memoryViewExtensionValues(contributions).selection
            const keys = selection?.sourceKeys ?? sources.map(source => source.sourceInstanceKey)
            return {
              strategyTypeId: 'role-agnostic',
              explanation: 'Compose selected sources in order.',
              sources: keys.flatMap(key => {
                const source = sources.find(item => item.sourceInstanceKey === key)
                return source === undefined ? [] : [{
                  sourceInstanceKey: source.sourceInstanceKey,
                  required: false,
                  projection: { mode: 'eager' as const, maxCharacters: 200 },
                  routeIds: [],
                  actionIds: selection?.writableSourceKeys === undefined || selection.writableSourceKeys.includes(key)
                    ? [...source.actionIds]
                    : [],
                }]
              }),
            }
          },
        })] })
      },
    }
    try {
      await generalRunner.mount(makeSource('skills', 'procedural'), { instanceId: 'skills' })
      await generalRunner.mount(makeSource('notes', 'working-context'), { instanceId: 'notes' })
      await generalRunner.mount(roleAgnostic, { instanceId: 'general' })
      await generalRunner.mount(plugin, { instanceId: 'scoped', config: { writableSourceKeys: [] } })
      const turn = await generalRunner.beginTurn()
      expect(turn.view.projection.map(item => item.sourceInstanceKey)).toEqual(['source:notes', 'source:skills'])
      expect(turn.view.actionOffers).toEqual([])
      turn.release()
    } finally {
      await generalRunner.dispose()
    }
  })
})
