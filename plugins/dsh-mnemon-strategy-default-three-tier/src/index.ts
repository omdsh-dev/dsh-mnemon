import type { Context } from '@deepseek-ai/cordis'
import { installMemory, defineMemoryStrategyConfiguration } from 'dsh-mnemon/extension-sdk'
import { DEFAULT_THREE_TIER_VIEW_STRATEGY } from './strategy.ts'

export const name = 'dsh-mnemon-strategy-default-three-tier'
export const inject = ['mnemonMemory']

export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({
  kind: 'strategy', typeId: 'default-three-tier',
  label: { en: 'Default three-tier', 'zh-CN': '默认三层' },
  description: { en: 'Compose runtime context, documents and durable memory.', 'zh-CN': '组合运行时、档案与长期记忆。' },
  fields: [], create: () => ({ strategies: [DEFAULT_THREE_TIER_VIEW_STRATEGY] }),
})

export function apply(ctx: Context): void {
  installMemory(ctx, memoryStrategyConfiguration.create({}))
}

export { DEFAULT_THREE_TIER_VIEW_STRATEGY }
