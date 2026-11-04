import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { defineMemorySource, installMemory } from 'dsh-mnemon/extension-sdk'
import { COMPOSABLE_MEMORY_API_VERSION, DEFAULT_MEMORY_VIEW_BUDGET, type MemoryAvailableSource, type MemoryStrategyContribution, type MemoryViewRequest } from 'dsh-mnemon/contracts'
import { DEFAULT_THREE_TIER_VIEW_STRATEGY } from 'dsh-mnemon-strategy-default-three-tier'
import { inspectMemoryView, modelMemoryWake } from '../src/host/view-presentation.ts'
import { compositionFixture } from './fixtures/composition.ts'

const fixtures: Awaited<ReturnType<typeof compositionFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose() })
async function fixture() { const f = await compositionFixture(); fixtures.push(f); return f }

const request: MemoryViewRequest = { scope: { storage: 'custom' }, scenario: 'diagnostics', budget: { ...DEFAULT_MEMORY_VIEW_BUDGET } }

function facts(role: string, key = role, availability: MemoryAvailableSource['availability'] = 'ready'): MemoryAvailableSource {
  return { sourceInstanceKey: `source:${key}`, sourceTypeId: key, role, availability, revision: 'r1',
    capabilities: ['project'], routeIds: [], actionIds: [], routes: [], actions: [] }
}

const THREE_TIER = [facts('working-context', 'runtime'), facts('narrative', 'documents'), facts('durable-evidence', 'memory-spaces')]
const CUSTOM_ROLE = facts('todo', 'todo')

function contribution(value: MemoryStrategyContribution['value']): MemoryStrategyContribution {
  return { instanceKey: 'strategy-extension:selection', typeId: 'selection', slot: 'selection', value }
}

/** A read-only Source with its own role, like the one #504 measured. */
function customRoleSource() {
  return defineMemorySource({
    manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'source', typeId: 'todo', packageName: 'dsh-mnemon-source-todo',
      role: 'todo', capabilities: ['project', 'read', 'search'], consistency: 'exact-snapshot',
      routes: [
        { id: 'open-items', description: 'List open items.', capability: 'read', maxCalls: 1, inputSchema: { type: 'object' } },
        { id: 'search', description: 'Search items.', capability: 'search', maxCalls: 1, inputSchema: { type: 'object', required: ['query'] } },
      ] },
    create: context => ({
      facts: () => ({ sourceInstanceKey: context.sourceInstanceKey, sourceTypeId: 'todo', role: 'todo', availability: 'ready', revision: 'todo-1',
        capabilities: ['project', 'read', 'search'], routeIds: ['open-items', 'search'], actionIds: [] }),
      project: projection => ({ fragments: [{ id: 'cover', sourceInstanceKey: context.sourceInstanceKey, mode: projection.mode, revision: 'todo-1', text: 'Open todos cover' }],
        readGrant: { id: 'todo-grant', sourceInstanceKey: context.sourceInstanceKey, schema: 'todo/v1', value: {}, revision: 'todo-1', consistency: 'exact-snapshot' } }),
      query: query => ({ id: 'todo-evidence', viewId: query.view.id, routeId: query.route.id, sourceInstanceKey: context.sourceInstanceKey,
        observedAt: new Date().toISOString(), items: [], truncated: false }),
    }),
  })
}

/** What a View offers, without the per-fixture text and ids that legitimately differ. */
function shape(view: { projection: Array<{ sourceInstanceKey: string; mode: string }>; routes: Array<{ sourceInstanceKey: string; sourceRouteId: string }> }) {
  return {
    projection: view.projection.map(fragment => `${fragment.sourceInstanceKey}:${fragment.mode}`).sort(),
    routes: view.routes.map(route => `${route.sourceInstanceKey}/${route.sourceRouteId}`).sort(),
  }
}

describe('default three-tier diagnostics for a Source role it does not admit (#504)', () => {
  it('adds nothing to the default three-Source View', async () => {
    const f = await fixture()
    await f.memorySpace()
    const turn = await f.graph.composableTurns.beginTurn('diagnostics:default', { storage: 'custom', workspaceId: f.workspace, agentId: 'default' })
    expect(turn.view.diagnostics).toBeUndefined()
    // The pure Strategy output carries no diagnostics key at all, so a default
    // profile composes exactly the ViewSpec it composed before #504.
    expect(DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, THREE_TIER)).not.toHaveProperty('diagnostics')
  })

  it('explains an installed read-only Source with a custom role instead of dropping it silently', async () => {
    const baseline = await fixture()
    await baseline.memorySpace()
    const before = await baseline.graph.composableTurns.beginTurn('diagnostics:baseline', { storage: 'custom', workspaceId: baseline.workspace, agentId: 'baseline' })
    const f = await fixture()
    await f.memorySpace()
    await f.mount({ inject: ['mnemonMemory'], apply(ctx: Context) { installMemory(ctx, { sources: [customRoleSource()] }) } }, { instanceId: 'todo' })
    const turn = await f.graph.composableTurns.beginTurn('diagnostics:custom', { storage: 'custom', workspaceId: f.workspace, agentId: 'custom' })
    // It was read: the diagnostic explains a deliberate absence, not a failure.
    expect(turn.view.consistency.sourceRevisions).toHaveProperty('source:todo')
    expect(turn.view.diagnostics).toHaveLength(1)
    expect(turn.view.diagnostics![0]).toMatchObject({ code: 'unsupported-source-role' })
    expect(turn.view.diagnostics![0]!.message).toContain('source:todo')
    expect(turn.view.diagnostics![0]!.message).toContain('"todo"')
    expect(turn.view.diagnostics![0]!.message).toContain('general Strategy')
    expect(turn.view.diagnostics![0]!.message).not.toContain('explicit selection')
    // Explanation only: no projection, Route or ActionOffer is granted, and the
    // three standard Sources offer exactly what they offer without it.
    expect(turn.view.projection.some(fragment => fragment.sourceInstanceKey === 'source:todo')).toBe(false)
    expect(turn.view.routes.some(route => route.sourceInstanceKey === 'source:todo')).toBe(false)
    expect(turn.view.actionOffers.some(offer => offer.sourceInstanceKey === 'source:todo')).toBe(false)
    expect(shape(turn.view)).toEqual(shape(before.view))
    // The same diagnostic reaches the turn's wake text and the browser-safe inspection payload.
    const wake = modelMemoryWake(f.graph, turn).text
    expect(wake).toContain('MNEMON VIEW AVAILABILITY')
    expect(wake).toContain('unsupported-source-role')
    const generation = f.graph.memoryComposition.generation(turn.view.runtimeGeneration)!
    expect(inspectMemoryView(generation, turn.view, 'active').diagnostics).toEqual([turn.view.diagnostics![0]!.message])
  })

  it('leaves the three-tier composition itself unchanged when such a Source is installed', () => {
    const without = DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, THREE_TIER)
    const withCustom = DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [CUSTOM_ROLE, ...THREE_TIER])
    expect(withCustom.sources).toEqual(without.sources)
    expect(withCustom.guidance).toEqual(without.guidance)
    expect(withCustom.explanation).toBe(without.explanation)
    expect(withCustom.diagnostics).toHaveLength(1)
    // Two custom roles are listed by instance key, so repeated composition is identical.
    const second = facts('notes', 'notes')
    const reversed = DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [second, CUSTOM_ROLE, ...THREE_TIER].reverse())
    expect(reversed.diagnostics!.map(diagnostic => diagnostic.message.match(/source:\S+/u)![0])).toEqual(['source:notes', 'source:todo'])
  })

  it('stays quiet about a custom role whose Source is unavailable', () => {
    // An unavailable Source already has the Host's own diagnostic; a second one would misreport it.
    expect(DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [facts('todo', 'todo', 'unavailable'), ...THREE_TIER])).not.toHaveProperty('diagnostics')
  })

  it('still rejects a selection that names a custom role, naming the Source and the way out', () => {
    const selection = contribution({ sourceKeys: ['source:todo'] })
    expect(() => DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [CUSTOM_ROLE, ...THREE_TIER], [selection]))
      .toThrow('unsupported scoped three-tier Source role: todo (source:todo); default-three-tier admits working-context, narrative, durable-evidence only, so remove it from the selection or select the general Strategy')
    // Admission rules are untouched: a selection of standard roles still composes,
    // and the installed custom-role Source is still explained.
    const allowed = DEFAULT_THREE_TIER_VIEW_STRATEGY.compose(request, [CUSTOM_ROLE, ...THREE_TIER], [contribution({ sourceKeys: ['source:runtime'] })])
    expect(allowed.sources.map(source => source.sourceInstanceKey)).toEqual(['source:runtime'])
    expect(allowed.diagnostics).toHaveLength(1)
  })
})
