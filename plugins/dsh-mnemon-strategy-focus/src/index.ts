import type { Context } from '@deepseek-ai/cordis'
import { defineMemoryPlugin, defineMemoryStrategyConfiguration, installMemory } from 'dsh-mnemon/extension-sdk'
import { defineWorkspacePolicy, validateMemoryContextSelection } from 'dsh-mnemon-strategy-workspace/extension-sdk'

export const name = 'dsh-mnemon-strategy-focus'
export const inject = ['mnemonMemory']
export interface Config { sourceKeys?: string[]; writableSourceKeys?: string[]; maxProjectionCharacters?: number }
export const memoryPlugin = defineMemoryPlugin({
  packageName: name, label: { en: 'Focused context', 'zh-CN': '专注上下文' },
  description: { en: 'Limit context to selected sources and control write access.', 'zh-CN': '聚焦选定的信息来源，控制上下文长度与写入范围。' },
  roles: ['strategy-extension'], provides: [{ id: 'strategy.workspace.focus', exclusive: true }], requires: ['strategy.workspace'],
})
export function createFocusExtension(config: Config = {}) {
  if (config.maxProjectionCharacters !== undefined && config.maxProjectionCharacters > 65536) throw new Error('Focus context character budget must not exceed 65536')
  const captured = structuredClone(config)
  const selection = captured.sourceKeys === undefined ? undefined : validateMemoryContextSelection( {
    sourceKeys: captured.sourceKeys, ...(captured.writableSourceKeys === undefined ? {} : { writableSourceKeys: captured.writableSourceKeys }), maxProjectionCharacters: captured.maxProjectionCharacters ?? 8192,
  })
  // Validate both the budget and an independent writable selection at installation.
  validateMemoryContextSelection( { sourceKeys: captured.writableSourceKeys ?? [], maxProjectionCharacters: captured.maxProjectionCharacters ?? 8192 })
  return defineWorkspacePolicy({ typeId: 'focus', packageName: name, slot: 'focus', contribute: (_request, sources) => ({ decisions: [], selection: selection ?? {
    sourceKeys: sources.map(source => source.sourceInstanceKey).sort(),
    ...(captured.writableSourceKeys === undefined ? {} : { writableSourceKeys: captured.writableSourceKeys }),
    maxProjectionCharacters: captured.maxProjectionCharacters ?? 8192,
  } }) })
}
export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({
  kind: 'strategy-extension', typeId: 'focus', label: memoryPlugin.label, description: memoryPlugin.description,
  fields: [
    { key: 'sourceKeys', input: 'source-list', label: { en: 'Sources in priority order', 'zh-CN': '参与来源（按优先顺序）' }, description: { en: 'Unset selects all installed Sources. An explicit empty list selects none.', 'zh-CN': '默认使用已安装的来源；手动选择后留空则不使用任何来源。' } },
    { key: 'writableSourceKeys', input: 'source-list', label: { en: 'Writable Sources', 'zh-CN': '允许写入的来源' }, description: { en: 'Unset preserves permissions. An empty list makes the View read-only.', 'zh-CN': '默认保留原有权限；手动选择后留空则仅允许读取。' } },
    { key: 'maxProjectionCharacters', input: 'number', label: { en: 'Context character budget', 'zh-CN': '上下文字符预算' }, defaultValue: 8192, minimum: 1, maximum: 65536 },
  ], create: config => ({ plugin: memoryPlugin, strategyExtensions: [createFocusExtension(config as Config)] }),
})
export function apply(ctx: Context, config: Config = {}): void { installMemory(ctx, { plugin: memoryPlugin, strategyExtensions: [createFocusExtension(config)] }) }
