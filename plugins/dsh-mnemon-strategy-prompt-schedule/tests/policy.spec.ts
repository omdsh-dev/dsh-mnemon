import { expect, it } from 'vitest'
import { DEFAULT_MEMORY_VIEW_BUDGET } from 'dsh-mnemon/contracts'
import { memoryStrategyConfiguration } from '../src/index.ts'
it('targets its owning Strategy and rejects an empty instruction', () => {
 const extension = memoryStrategyConfiguration.create({}).strategyExtensions![0]!
 expect(extension.manifest.strategyTypeId).toBe('workspace')
 expect(extension.manifest.slot).toBe('prompts')
 expect(() => memoryStrategyConfiguration.create({ instruction: '' }).strategyExtensions![0]!.contribute({ scope: { storage: 'custom' }, scenario: 'test', budget: DEFAULT_MEMORY_VIEW_BUDGET }, [])).toThrow()
})
