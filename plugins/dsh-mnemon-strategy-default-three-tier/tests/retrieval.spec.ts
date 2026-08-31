import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { defineMemorySource, installMemory, truncateMemoryText, type MemorySourceRuntime } from 'dsh-mnemon/extension-sdk'
import { COMPOSABLE_MEMORY_API_VERSION, type MemoryJsonValue } from 'dsh-mnemon/contracts'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import * as plugin from '../src/index.ts'

/** An external Source repository can implement this protocol without a sibling import. */
async function fixture(kind: 'documents' | 'memory-spaces') {
  const runner = new MemoryCompositionRunner()
  const query = vi.fn<NonNullable<MemorySourceRuntime['query']>>(request => {
    const input = request.input as { query?: string; id?: string }
    let remaining = request.route.maxCharacters ?? 16_000
    const items = Array.from({ length: 6 }, (_, index) => {
      const content = `${input.query ?? input.id} evidence ${index} ` + 'x'.repeat(1_900)
      const text = truncateMemoryText(content, Math.min(2_600, remaining))
      remaining -= text.length
      return { id: `${input.query ?? input.id}:${index}`, text,
        provenance: kind === 'documents'
          ? { kind: 'match', title: 'Record', description: 'Saved record', status: 'active', relativePath: 'records/a.md', sourcePaths: [] }
          : { memoryBodyId: 'project', relevanceTier: 'high' },
      }
    }).filter(item => item.text !== '')
    return { id: 'evidence:' + (input.query ?? input.id), viewId: request.view.id, routeId: request.route.id,
      sourceInstanceKey: request.route.sourceInstanceKey, observedAt: '2026-08-31T00:00:00.000Z',
      items: items as never, truncated: items.length < 6, metadata: { total: 6 },
    }
  })
  await runner.mount(plugin, { instanceId: 'strategy' })
  await runner.mount({ inject: ['mnemonMemory'], apply(ctx: Context) {
    const operations = kind === 'documents' ? ['search'] : ['recall', 'related']
    installMemory(ctx, { sources: [defineMemorySource({
      manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: kind,
        packageName: 'external-test-source', role: kind === 'documents' ? 'narrative' : 'durable-evidence',
        capabilities: ['project', 'read'], consistency: 'exact-snapshot',
        routes: operations.map(id => ({ id, description: id, capability: 'read',
          inputSchema: { type: 'object' }, maxCalls: 4, maxCharacters: 16_000, maxResults: 20 })),
      },
      create: context => ({
        facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: kind,
          role: kind === 'documents' ? 'narrative' : 'durable-evidence', availability: 'ready', revision: 'r1',
          capabilities: ['project', 'read'], routeIds: operations, actionIds: [] }),
        project: () => ({ fragments: [], readGrant: { id: kind, sourceInstanceKey: context.sourceInstanceKey,
          schema: `dsh-mnemon.${kind}/v1`, value: { memoryBodyIds: ['project', 'other'] }, revision: 'r1', consistency: 'exact-snapshot' } }),
        query,
      }),
    })] })
  } }, { instanceId: 'source' })
  return { runner, query }
}
const output = (value: { output?: MemoryJsonValue }) => value.output as { results: Array<{ id: string; content: string }>; notRun?: boolean; hint: string }

describe('independent three-tier execution policy', () => {
  it('shares the Documents slot across concurrent calls and resets it for an identical new View', async () => {
    const { runner, query } = await fixture('documents')
    try {
      const first = await runner.beginTurn()
      const route = first.view.routes[0]!.id
      const [a, b] = await Promise.all([first.executeRoute(route, { query: 'first', limit: 20 }), first.executeRoute(route, { query: 'second' })])
      expect(query).toHaveBeenCalledOnce()
      expect(query.mock.calls[0]![0]).toMatchObject({ route: { maxResults: 4, maxCharacters: 6_000 }, input: { limit: 4 } })
      expect(output(a).results.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(6_000)
      expect(output(b).notRun).toBe(true)
      const child = await runner.beginTurn()
      expect(child.view.id).toBe(first.view.id)
      expect(output(await child.executeRoute(route, { query: 'child' })).notRun).toBeUndefined()
      expect(query).toHaveBeenCalledTimes(2)
    } finally { await runner.dispose() }
  })

  it('preserves old Recall ceilings, filters, duplicate replay and refinement across generic calls', async () => {
    const { runner, query } = await fixture('memory-spaces')
    try {
      const turn = await runner.beginTurn()
      const route = turn.view.routes.find(route => route.sourceRouteId === 'recall')!.id
      const first = await turn.executeRoute(route, { query: 'ALPHA!', category: 'wrong', intent: 'wrong', limit: 99 })
      expect(query.mock.calls[0]![0].input).toEqual({ query: 'ALPHA!', limit: 6, memoryBodyIds: ['project', 'other'] })
      expect(output(first).results).toHaveLength(3)
      expect(output(first).results.every(item => item.content.length <= 1_200)).toBe(true)
      expect(output(await turn.executeRoute(route, { query: 'alpha' })).results).toEqual(output(first).results)
      expect(query).toHaveBeenCalledOnce()
      const refined = await turn.executeRoute(route, { query: 'beta' })
      expect(output(refined).results).toHaveLength(1)
      expect([...output(first).results, ...output(refined).results].reduce((sum, item) => sum + item.content.length, 0)).toBe(4_800)
      expect(output(await turn.executeRoute(route, { query: 'third' })).hint).toContain('budget is exhausted')
      expect(query).toHaveBeenCalledTimes(2)
      await expect(turn.executeRoute(route, { query: 'alpha', memoryBodyIds: ['ungranted'] })).rejects.toThrow('outside pinned Source')
      expect(query).toHaveBeenCalledTimes(2)
    } finally { await runner.dispose() }
  })

  it('admits Related only from final Recall evidence and preserves Source identity on replay', async () => {
    const { runner, query } = await fixture('memory-spaces')
    try {
      const turn = await runner.beginTurn()
      const recall = turn.view.routes.find(route => route.sourceRouteId === 'recall')!.id
      const related = turn.view.routes.find(route => route.sourceRouteId === 'related')!.id
      const denied = await turn.executeRoute(related, { id: 'not-admitted', memoryBodyId: 'project' })
      expect(output(denied).results).toEqual([])
      expect(query).not.toHaveBeenCalled()
      const first = await turn.executeRoute(recall, { query: 'alpha' })
      const admitted = output(first).results[0]!.id
      const graph = await turn.executeRoute(related, { id: admitted, memoryBodyId: 'project' })
      const replay = await turn.executeRoute(related, { id: admitted, memoryBodyId: 'project' })
      expect(replay.id).toBe(graph.id)
      expect(replay.routeId).toBe(related)
      expect(query).toHaveBeenCalledTimes(2)
      expect(output(replay).results).toEqual(output(graph).results)
    } finally { await runner.dispose() }
  })
})
