import { describe, expect, it } from 'vitest'
import { DEFAULT_MEMORY_VIEW_BUDGET, MEMORY_CONTEXT_POLICY_FORMAT, type MemoryAvailableSource, type MemoryContextPolicy, type MemoryJsonValue } from 'dsh-mnemon/contracts'
import { validateMemoryContextSelection } from 'dsh-mnemon/extension-sdk'
import { WORKSPACE_STRATEGY } from '../src/strategy.ts'

const source = (role: string, index: number): MemoryAvailableSource => ({ sourceInstanceKey: 'source:item-' + index, sourceTypeId: role, role, availability: 'ready', revision: 'r1', capabilities: ['project', 'recall', 'write'], routeIds: ['search'], actionIds: ['propose'],
  routes: [{ id: 'search', description: 'Search', capability: 'recall', inputSchema: {}, maxCalls: 2, access: { kinds: ['search'], result: 'records' } }],
  actions: [{ id: 'propose', description: 'Propose', capability: 'write', inputSchema: {}, operation: { effects: ['propose'], execution: 'immediate' } }] })
const request = { scope: { storage: 'custom' as const }, scenario: 'test', budget: DEFAULT_MEMORY_VIEW_BUDGET }
const contribution = (value: Omit<MemoryContextPolicy, 'format'>, key = 'policy') => ({ instanceKey: 'strategy-extension:' + key, typeId: key, slot: key, value: { format: MEMORY_CONTEXT_POLICY_FORMAT, ...value } as unknown as MemoryJsonValue })
const decision = (item: MemoryAvailableSource) => ({ id: 'follow-up', sourceInstanceKey: item.sourceInstanceKey, ready: true, reason: { en: 'Evidence is ready.', 'zh-CN': '证据已就绪。' }, requires: { routeIds: ['search'], actionIds: ['propose'] }, instruction: 'Inspect the evidence and propose a reviewed update.' })

describe('capability-based workspace composition', () => {
  it('accepts unfamiliar roles and multiple independent instances deterministically', () => {
    const sources = Array.from({ length: 16 }, (_, index) => source(index % 2 ? 'external-directory' : 'external-records', index))
    const view = WORKSPACE_STRATEGY.compose(request, sources)
    expect(view).toEqual(WORKSPACE_STRATEGY.compose(request, sources.slice().reverse()))
    expect(view.sources).toHaveLength(16)
    expect(view.sources.reduce((sum, item) => sum + (item.projection?.maxCharacters ?? 0), 0)).toBeLessThanOrEqual(request.budget.maxProjectionCharacters)
  })
  it('keeps decisions behind write restrictions and operation budgets', () => {
    const item = source('external-records', 1), policy = contribution({ decisions: [decision(item)] })
    const compose = (extra: ReturnType<typeof contribution>[] = [], budget = request.budget) => WORKSPACE_STRATEGY.compose({ ...request, budget }, [item], [policy, ...extra])
    expect(compose().decisions?.[0]?.state).toBe('applied')
    // Instructions are bound by Core after Source projection succeeds.
    expect(compose().guidance?.system).not.toContain('Inspect the evidence')
    const readOnly = compose([contribution({ decisions: [], selection: { sourceKeys: [item.sourceInstanceKey], writableSourceKeys: [] } }, 'focus')])
    expect(readOnly.decisions?.[0]?.state).toBe('excluded')
    expect(readOnly.guidance?.system).not.toContain('Inspect the evidence')
    const bounded = compose([], { ...request.budget, maxActions: 0 })
    expect(bounded.decisions?.[0]?.state).toBe('budget')
    expect(bounded.guidance?.system).not.toContain('Inspect the evidence')
  })
  it('records unmet conditions without applying their context demand', () => {
    const item = source('external-records', 1)
    const result = WORKSPACE_STRATEGY.compose(request, [item], [contribution({ decisions: [{ ...decision(item), ready: false, context: { mode: 'eager', weight: 20 } }] })])
    expect(result.decisions?.[0]?.state).toBe('deferred')
    expect(result.sources[0]?.projection?.mode).toBe('routed')
    expect(result.guidance?.system).not.toContain('Inspect the evidence')
  })
  it('honors explicit order and intersects independent restrictions', () => {
    const sources = [source('records', 1), source('records', 2), source('resources', 3)]
    const ordered = WORKSPACE_STRATEGY.compose(request, sources, [contribution({ decisions: [], selection: { sourceKeys: ['source:item-2', 'source:item-1'], writableSourceKeys: ['source:item-1'], maxProjectionCharacters: 512 } })])
    expect(ordered.sources.map(source => source.sourceInstanceKey)).toEqual(['source:item-2', 'source:item-1'])
    expect(ordered.sources[0]?.actionIds).toEqual([])
    const restricted = WORKSPACE_STRATEGY.compose(request, sources, [contribution({ decisions: [], selection: { sourceKeys: ['source:item-1'] } }), contribution({ decisions: [], selection: { sourceKeys: ['source:item-1', 'source:item-3'], maxProjectionCharacters: 100 } }, 'second')])
    expect(restricted.sources.map(source => source.sourceInstanceKey)).toEqual(['source:item-1'])
    expect(restricted.sources[0]?.projection?.maxCharacters).toBe(100)
    expect(() => validateMemoryContextSelection({ sourceKeys: ['source:one'], writableSourceKeys: ['source:two'] })).toThrow(/subset/)
  })
  it('rejects invented operations', () => {
    const item = source('records', 1)
    expect(() => WORKSPACE_STRATEGY.compose(request, [item], [contribution({ decisions: [{ ...decision(item), requires: { actionIds: ['hidden-write'] } }] })])).toThrow(/unavailable operation/)
  })
  it('shares capacity fairly while prioritizing prerequisites', () => {
    const sources = [source('records', 1), source('resources', 2), source('events', 3)]
    sources[0]!.routes.push({ ...sources[0]!.routes[0]!, id: 'needed' }); sources[0]!.routeIds.push('needed')
    const result = WORKSPACE_STRATEGY.compose({ ...request, budget: { ...request.budget, maxRoutes: 3, maxActions: 1 } }, sources, [contribution({ decisions: [{ ...decision(sources[0]!), requires: { routeIds: ['needed'] } }] })])
    expect(result.sources.every(source => source.routeIds?.length === 1)).toBe(true)
    expect(result.sources[0]?.routeIds).toEqual(['needed'])
    expect(result.sources.flatMap(source => source.actionIds ?? [])).toHaveLength(1)
  })
  it('supports larger budgets and deliberately empty selections', () => {
    const sources = Array.from({ length: 16 }, (_, index) => source('external-' + index, index))
    for (const item of sources) {
      item.routes = Array.from({ length: 4 }, (_, index) => ({ ...item.routes[0]!, id: 'read-' + index }))
      item.actions = Array.from({ length: 4 }, (_, index) => ({ ...item.actions[0]!, id: 'write-' + index }))
      item.routeIds = item.routes.map(route => route.id); item.actionIds = item.actions.map(action => action.id)
    }
    const result = WORKSPACE_STRATEGY.compose({ ...request, budget: { ...request.budget, maxRoutes: 96, maxActions: 96 } }, sources)
    expect(result.sources.flatMap(source => source.routeIds ?? [])).toHaveLength(64)
    expect(result.sources.flatMap(source => source.actionIds ?? [])).toHaveLength(64)
    expect(WORKSPACE_STRATEGY.compose(request, sources, [contribution({ decisions: [], selection: { sourceKeys: [] } })]).sources).toEqual([])
  })
})
