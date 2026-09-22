import { expect, it } from 'vitest'
import { DEFAULT_MEMORY_VIEW_BUDGET, type MemoryAvailableSource } from 'dsh-mnemon/contracts'
import { WORKSPACE_STRATEGY } from 'dsh-mnemon-strategy-workspace'
import { memoryStrategyConfiguration } from '../src/index.ts'
const request = { scope: { storage: 'custom' as const, sessionId: 'session' }, scenario: 'test', budget: DEFAULT_MEMORY_VIEW_BUDGET }
const source = (hints: { newHumanTurns?: number; newFeedback?: number; newOutcomes?: number }): MemoryAvailableSource => ({ sourceInstanceKey: 'source:learning', sourceTypeId: 'learning', role: 'learning-context', availability: 'ready', revision: '1', capabilities: ['project', 'recall', 'write'], routeIds: ['review-input'], actionIds: ['complete-review'], hints, routes: [{ id: 'review-input', capability: 'recall', description: 'Review', inputSchema: {}, maxCalls: 2 }], actions: [{ id: 'complete-review', capability: 'write', description: 'Complete', inputSchema: {} }] })
it('bases timing on Source facts and explicitly configurable feedback policies', () => {
  const extension = memoryStrategyConfiguration.create({ interval: 5, outcomeInterval: 2 }).strategyExtensions![0]!
  const evaluate = (hints: Parameters<typeof source>[0]) => {
    const sources = [source(hints)], contribution = extension.contribute(request, sources)
    return WORKSPACE_STRATEGY.compose(request, sources, [{ instanceKey: 'extension:learning', typeId: 'learning-cycle', slot: 'learning', value: contribution }])
  }
  expect(evaluate({ newHumanTurns: 4 }).decisions?.[0]?.state).toBe('deferred')
  expect(evaluate({ newHumanTurns: 5 }).decisions?.[0]?.state).toBe('applied')
  expect(evaluate({ newFeedback: 1 }).decisions?.[0]?.state).toBe('applied')
  expect(evaluate({ newOutcomes: 2 }).decisions?.[0]?.state).toBe('applied')
  expect(evaluate({ newFeedback: 1 }).sources[0]?.projection?.mode).toBe('eager')
  expect(extension.manifest.strategyTypeId).toBe('workspace')
})
it('does not produce guidance without an installed learning Source or with an invalid interval', () => {
  const extension = memoryStrategyConfiguration.create({}).strategyExtensions![0]!
  expect(WORKSPACE_STRATEGY.compose(request, [], [{ instanceKey: 'extension:learning', typeId: 'learning-cycle', slot: 'learning', value: extension.contribute(request, []) }]).guidance?.system).not.toContain('Learning due Sources')
  expect(() => memoryStrategyConfiguration.create({ interval: 0 }).strategyExtensions![0]!.contribute(request, [])).toThrow()
})
