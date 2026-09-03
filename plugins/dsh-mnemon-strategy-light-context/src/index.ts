import type { Context } from '@deepseek-ai/cordis'
import { defineMemoryPlugin, installMemory, defineMemoryStrategyConfiguration } from 'dsh-mnemon/extension-sdk'
import { defineThreeTierExtension, validateThreeTierExtension } from 'dsh-mnemon-strategy-default-three-tier/extension-sdk'

export interface Config { maxProjectionCharacters?: number }
export const name = 'dsh-mnemon-strategy-light-context'
export const inject = ['mnemonMemory']
export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'Light context', 'zh-CN': '轻量上下文' },
  description: { en: 'Narrow resident context while keeping on-demand reads.', 'zh-CN': '收窄常驻内容预算，保留按需读取。' },
  roles: ['strategy-extension'],
  provides: [{ id: 'strategy.default-three-tier.projection', exclusive: true }],
  requires: ['strategy.default-three-tier'],
})

export function createLightContextExtension(config: Config = {}) {
  const projection = validateThreeTierExtension('projection', { maxProjectionCharacters: config.maxProjectionCharacters ?? 4_096 })
  return defineThreeTierExtension({ typeId: 'light-context', packageName: name, slot: 'projection', contribute: () => projection })
}

export function apply(ctx: Context, config: Config = {}): void {
  installMemory(ctx, { plugin: memoryPlugin, strategyExtensions: [createLightContextExtension(config)] })
}

export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({
  kind: 'strategy-extension', typeId: 'light-context',
  label: { en: 'Light context', 'zh-CN': '轻量上下文' },
  description: { en: 'Narrow resident context while keeping on-demand reads.', 'zh-CN': '收窄常驻内容预算，保留按需读取。' },
  fields: [{ key: 'maxProjectionCharacters', input: 'number', defaultValue: 4096, minimum: 1, maximum: 10_000_000,
    label: { en: 'Resident character ceiling', 'zh-CN': '常驻内容上限（字符）' },
    description: { en: 'Capped by the Host, not a whole-request token budget. Runtime has no on-demand expansion route.', 'zh-CN': '不能超过 Host 上限，不是整个请求的 token 预算。运行时没有按需展开入口。' } }],
  create: config => ({ plugin: memoryPlugin, strategyExtensions: [createLightContextExtension(config as Config)] }),
})
