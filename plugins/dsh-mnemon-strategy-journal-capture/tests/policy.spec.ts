import { expect, it } from 'vitest'
import { DEFAULT_MEMORY_VIEW_BUDGET, type MemoryAvailableSource, type MemoryContextPolicy } from 'dsh-mnemon/contracts'
import { memoryStrategyConfiguration } from '../src/index.ts'
it('targets its owning Strategy and rejects an empty instruction', () => {
 const extension = memoryStrategyConfiguration.create({}).strategyExtensions![0]!
 expect(extension.manifest.strategyTypeId).toBe('workspace')
 expect(extension.manifest.slot).toBe('capture')
 expect(() => memoryStrategyConfiguration.create({ instruction: '' }).strategyExtensions![0]!.contribute({ scope: { storage: 'custom' }, scenario: 'test', budget: DEFAULT_MEMORY_VIEW_BUDGET }, [])).toThrow()
})
it('keeps journal capture with its domain instead of applying it to every append operation', () => {
 const source = (role: string): MemoryAvailableSource => ({ sourceInstanceKey: 'source:' + role, sourceTypeId: role, role, availability: 'ready', revision: '1', capabilities: ['project', 'write'], routeIds: [], actionIds: ['append'], routes: [], actions: [{ id: 'append', capability: 'write', description: 'Append', inputSchema: {}, operation: { effects: ['append'], execution: 'immediate' } }] })
 const extension = memoryStrategyConfiguration.create({}).strategyExtensions![0]!
 const result = extension.contribute({ scope: { storage: 'custom' }, scenario: 'test', budget: DEFAULT_MEMORY_VIEW_BUDGET }, [source('activity-log'), source('agent-jobs'), source('notifications')]) as unknown as MemoryContextPolicy
 expect(result.decisions).toHaveLength(2)
 expect(result.decisions.every(decision => decision.sourceInstanceKey === 'source:activity-log')).toBe(true)
 expect(result.decisions[1]?.ready).toBe(false)
})
