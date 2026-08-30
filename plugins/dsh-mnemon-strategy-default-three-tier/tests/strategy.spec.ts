import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { defineMemorySource, installMemory, type MemoryAvailableSource } from 'dsh-mnemon/extension-sdk'
import { COMPOSABLE_MEMORY_API_VERSION, type MemoryOperationSemantics } from 'dsh-mnemon/contracts'
import { MemoryCompositionRunner, DEFAULT_MEMORY_VIEW_BUDGET } from 'dsh-mnemon/testing'
import * as plugin from '../src/index.ts'

const PROJECTION: MemoryOperationSemantics = { actions: ['wake'], targets: ['records'], effects: [], representations: ['raw'], overflow: 'unavailable', retry: 'safe' }

function fact(role: string, key = role): MemoryAvailableSource {
  return {
    sourceInstanceKey: `source:${key}`, sourceTypeId: key, role,
    availability: 'ready', revision: 'r1', capabilities: ['project'], routeIds: [], actionIds: [], routes: [], actions: [],
    projection: PROJECTION,
  }
}

describe('standalone default three-tier Strategy', () => {
  it('is deterministic and depends only on facts, not Source implementations', () => {
    const request = { scope: { storage: 'custom' as const }, scenario: 'test', budget: { ...DEFAULT_MEMORY_VIEW_BUDGET } }
    const facts = [fact('working-context'), fact('narrative'), fact('durable-evidence')]
    const first = plugin.DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, facts)
    expect(first).toEqual(plugin.DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [...facts].reverse()))
    expect(first.sources.map(source => source.sourceInstanceKey)).toEqual(facts.map(source => source.sourceInstanceKey))
    expect(first.sources.reduce((sum, source) => sum + (source.projection?.maxCharacters ?? 0), 0)).toBeLessThanOrEqual(request.budget.maxProjectionCharacters)
  })

  it('rejects ambiguous roles instead of selecting by mount order', () => {
    expect(() => plugin.DEFAULT_THREE_TIER_VIEW_STRATEGY.compose({
      scope: { storage: 'custom' }, scenario: 'test', budget: { ...DEFAULT_MEMORY_VIEW_BUDGET },
    }, [fact('working-context', 'first'), fact('working-context', 'second')])).toThrow('ambiguous')
  })

  it('selects described operations with arbitrary names, without requiring a standard Source method set', () => {
    const source = fact('narrative')
    source.routes = [
      { id: 'open-optmem-node', description: 'Read a native node', capability: 'read', maxCalls: 2, inputSchema: { type: 'object' },
        semantics: { actions: ['read'], targets: ['representations'], effects: [], representations: ['summary'], overflow: 'unavailable', retry: 'safe' } },
      { id: 'unknown-legacy-operation', description: 'Unspecified', capability: 'read', maxCalls: 1, inputSchema: { type: 'object' } },
    ]
    source.routeIds = source.routes.map(route => route.id)
    source.actions = [{ id: 'condense-private-branch', description: 'Native compaction', capability: 'write', inputSchema: { type: 'object' },
      semantics: { actions: ['compress'], targets: ['representations'], effects: [{ target: 'representations', mode: 'write' }], representations: ['receipt'], overflow: 'unavailable', retry: 'unsafe' } }]
    source.actionIds = source.actions.map(action => action.id)
    const request = { scope: { storage: 'custom' as const }, scenario: 'test', budget: { ...DEFAULT_MEMORY_VIEW_BUDGET, maxRoutes: 1, maxActions: 1 } }
    const spec = plugin.DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [source])
    expect(spec.sources[0]).toMatchObject({ routeIds: ['open-optmem-node'], actionIds: ['condense-private-branch'] })
    // No descriptor means unknown: even a familiar role/capability does not invent a wake operation.
    delete source.projection
    expect(plugin.DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [source]).sources[0]?.projection).toBeUndefined()
  })

  it('mounts and composes through real Cordis and the public test runner', async () => {
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(plugin, { instanceId: 'strategy' })
      expect(runner.inspect().evaluation.state).toBe('incomplete')
      const source = defineMemorySource({
        manifest: {
          apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'fixture',
          packageName: 'test-source-fixture', role: 'working-context', capabilities: ['project'], consistency: 'exact-snapshot',
          projection: PROJECTION,
        },
        create: ctx => ({
          facts: () => ({ ...fact('working-context', 'fixture'), sourceInstanceKey: ctx.sourceInstanceKey }),
          project: request => ({ fragments: [{
            id: 'fixture', sourceInstanceKey: ctx.sourceInstanceKey, mode: request.mode,
            revision: 'r1', text: 'independent fixture',
            result: { representation: 'raw', coverage: 'complete' },
          }] }),
        }),
      })
      const unmount = await runner.mount({
        inject: ['mnemonMemory'], apply(ctx: Context) { installMemory(ctx, { sources: [source] }) },
      }, { instanceId: 'source' })
      const turn = await runner.beginTurn()
      expect(turn.view.projection[0]?.text).toBe('independent fixture')
      await unmount()
      await expect(runner.beginTurn()).rejects.toThrow('no Serving')
      expect(runner.inspect().drainingGenerationIds).toContain(turn.view.runtimeGeneration)
      turn.release()
    } finally { await runner.dispose() }
  })
})
