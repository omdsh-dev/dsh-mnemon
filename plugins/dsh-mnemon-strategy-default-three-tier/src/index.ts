import type { Context } from '@deepseek-ai/cordis'
import { defineMemoryPlugin, installMemory, defineMemoryStrategyConfiguration } from 'dsh-mnemon/extension-sdk'
import { DEFAULT_THREE_TIER_VIEW_STRATEGY } from './strategy.ts'

export const name = 'dsh-mnemon-strategy-default-three-tier'
export const inject = ['mnemonMemory']

export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'Default three-tier', 'zh-CN': '默认三层' },
  description: { en: 'Compile available runtime, document and durable Sources into one View.', 'zh-CN': '将可用的运行时、档案与长期 Source 编译为一个 View。' },
  roles: ['strategy'],
  provides: [{ id: 'strategy' }, { id: 'strategy.default-three-tier' }],
  requires: ['source'],
})

export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({
  kind: 'strategy', typeId: 'default-three-tier',
  label: { en: 'Default three-tier', 'zh-CN': '默认三层' },
  description: { en: 'Compose runtime context, documents and durable memory.', 'zh-CN': '组合运行时、档案与长期记忆。' },
  fields: [], create: () => ({ plugin: memoryPlugin, strategies: [DEFAULT_THREE_TIER_VIEW_STRATEGY] }),
})

export function apply(ctx: Context): void {
  installMemory(ctx, memoryStrategyConfiguration.create({}))
}

export { DEFAULT_THREE_TIER_VIEW_STRATEGY }
