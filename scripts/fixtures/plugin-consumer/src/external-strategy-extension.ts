import type { Context } from '@deepseek-ai/cordis'
import { installMemory, defineMemoryStrategyConfiguration } from 'dsh-mnemon/extension-sdk'
import { defineThreeTierExtension } from 'dsh-mnemon-strategy-default-three-tier/extension-sdk'

export const name = 'dsh-mnemon-strategy-external-budget'
export const inject = ['mnemonMemory']

/** Compiled outside the repository against the owning Strategy's packed SDK. */
export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({
  kind: 'strategy-extension', typeId: 'external-budget', fields: [],
  label: { en: 'External budget', 'zh-CN': '外部预算' },
  description: { en: 'Public artifact editor conformance.', 'zh-CN': '独立发布产物编辑器验证。' },
  create: () => ({ strategyExtensions: [defineThreeTierExtension({
    typeId: 'external-budget', packageName: name, slot: 'projection',
    contribute: request => ({ maxProjectionCharacters: Math.min(request.budget.maxProjectionCharacters, 1_200) }),
  })] }),
})

export function apply(ctx: Context): void {
  installMemory(ctx, memoryStrategyConfiguration.create({}))
}
