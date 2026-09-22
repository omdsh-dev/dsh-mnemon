import { expect, it } from 'vitest'
import { DEFAULT_MEMORY_VIEW_BUDGET, type MemoryAvailableSource } from 'dsh-mnemon/contracts'
import { WORKSPACE_STRATEGY } from 'dsh-mnemon-strategy-workspace'
import { memoryStrategyConfiguration } from '../src/index.ts'
const request = { scope: { storage: 'custom' as const, sessionId: 'session' }, scenario: 'test', budget: DEFAULT_MEMORY_VIEW_BUDGET }
const source = (signals: number[], feedback = 0): MemoryAvailableSource => ({ sourceInstanceKey: 'source:playbooks', sourceTypeId: 'playbooks', role: 'instruction-library', availability: 'ready', revision: '1', capabilities: ['project', 'recall', 'write'], routeIds: ['skill-context'], actionIds: ['propose-skill'], hints: { skillOpportunitySignals: signals, skillFeedbackCount: feedback }, routes: [{ id: 'skill-context', capability: 'recall', description: 'Inspect', inputSchema: {}, maxCalls: 4 }], actions: [{ id: 'propose-skill', capability: 'write', description: 'Propose', inputSchema: {} }] })
it('only prompts refinement for sufficient evidence or enabled feedback policy', () => {
  const evaluate = (signals: number[], feedback: number, config = {}) => { const extension = memoryStrategyConfiguration.create(config).strategyExtensions![0]!, sources = [source(signals, feedback)]; return WORKSPACE_STRATEGY.compose(request, sources, [{ instanceKey: 'extension:skills', typeId: 'skill-refinement', slot: 'skills', value: extension.contribute(request, sources) }]).decisions?.[0]?.state }
  expect(evaluate([1], 0)).toBe('deferred')
  expect(evaluate([2], 0)).toBe('applied')
  expect(evaluate([], 1)).toBe('applied')
  expect(evaluate([], 1, { reviewFeedback: false })).toBe('deferred')
  expect(JSON.stringify(memoryStrategyConfiguration.create({}).strategyExtensions![0]!.contribute(request, [source([2])]))).toContain('Do not execute candidate scripts')
  expect(() => memoryStrategyConfiguration.create({ minimumSignals: 0 }).strategyExtensions![0]!.contribute(request, [])).toThrow()
})

it('declares the slot accepted by the selected Workspace strategy', () => {
  const extension = memoryStrategyConfiguration.create({}).strategyExtensions![0]!
  expect(WORKSPACE_STRATEGY.manifest.acceptedContributionFormats).toContain(extension.manifest.contributionFormat)
  expect(extension.manifest.strategyTypeId).toBe(WORKSPACE_STRATEGY.manifest.typeId)
})
