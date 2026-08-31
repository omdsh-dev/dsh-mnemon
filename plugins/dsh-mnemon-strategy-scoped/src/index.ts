import type { Context } from '@deepseek-ai/cordis'
import { installMemory, defineMemoryStrategyConfiguration } from 'dsh-mnemon/extension-sdk'
import { defineThreeTierExtension, validateThreeTierExtension } from 'dsh-mnemon-strategy-default-three-tier/extension-sdk'

export interface Config { sourceKeys?: string[]; writableSourceKeys?: string[] }
export const name = 'dsh-mnemon-strategy-scoped'
export const inject = ['mnemonMemory']
const roles = ['working-context', 'narrative', 'durable-evidence']

export function createScopedExtension(config: Config = {}) {
  const selection = config.sourceKeys === undefined ? undefined : validateThreeTierExtension('selection', {
    sourceKeys: config.sourceKeys, ...(config.writableSourceKeys === undefined ? {} : { writableSourceKeys: config.writableSourceKeys }),
  })
  const writable = config.writableSourceKeys === undefined ? undefined : validateThreeTierExtension('selection', {
    sourceKeys: config.writableSourceKeys, writableSourceKeys: config.writableSourceKeys,
  }).writableSourceKeys
  return defineThreeTierExtension({ typeId: 'scoped', packageName: name, slot: 'selection',
    contribute: (_request, sources) => selection ?? {
      sourceKeys: sources.filter(source => roles.includes(source.role))
        .sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role) || a.sourceInstanceKey.localeCompare(b.sourceInstanceKey))
        .map(source => source.sourceInstanceKey),
      ...(writable === undefined ? {} : { writableSourceKeys: writable }),
    },
  })
}

export function apply(ctx: Context, config: Config = {}): void {
  installMemory(ctx, { strategyExtensions: [createScopedExtension(config)] })
}

export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({
  kind: 'strategy-extension', typeId: 'scoped',
  label: { en: 'Scoped composition', 'zh-CN': '范围组合' },
  description: { en: 'Select and order existing Source instances; optionally narrow writes.', 'zh-CN': '选择并排序已有 Source 实例，可进一步收窄写入范围。' },
  fields: [
    { key: 'sourceKeys', input: 'source-list', label: { en: 'Sources, in priority order', 'zh-CN': '参与 Source（按优先顺序）' }, description: { en: 'Unset uses all eligible instances. An explicit empty list selects none.', 'zh-CN': '未设置时使用全部适用实例；明确留空则不选择任何实例。' } },
    { key: 'writableSourceKeys', input: 'source-list', label: { en: 'Writable Sources', 'zh-CN': '允许写入的 Source' }, description: { en: 'Unset preserves existing permissions. An empty list makes this View read-only.', 'zh-CN': '未设置时保留已有权限；明确留空使此 View 只读。' } },
  ],
  create: config => ({ strategyExtensions: [createScopedExtension(config as Config)] }),
})
