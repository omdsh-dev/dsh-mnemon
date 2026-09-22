import type { Context } from '@deepseek-ai/cordis'
import type { MemoryJsonValue, MemoryAvailableSource, MemoryContextPolicy } from 'dsh-mnemon/contracts'
import { defineMemoryPlugin, defineMemoryStrategyConfiguration, installMemory, memoryContextHints, memoryInputInteger, memoryInputText } from 'dsh-mnemon/extension-sdk'
import { defineWorkspacePolicy } from 'dsh-mnemon-strategy-workspace/extension-sdk'
export const name = 'dsh-mnemon-strategy-team-coordination'
export const inject = ['mnemonMemory']
const instruction = "Before editing shared project files, inspect and declare file reservations. Use directed messages and explicit team membership. Report job receipts and current presence; wake idle sessions only as part of an authorized task. Attribute reviewer and teammate messages to their actual sender."
export const memoryPlugin = defineMemoryPlugin({ packageName: name, label: { en: 'Team coordination', 'zh-CN': '团队协作' }, description: { en: 'Guide shared-file coordination and messages between team members.', 'zh-CN': '提示协调共享文件和会话消息，保留成员身份。' }, roles: ['strategy-extension'], provides: [{ id: 'strategy-extension' }], requires: ['strategy.workspace'] })
function evaluate(config: Record<string, MemoryJsonValue>, sources: readonly MemoryAvailableSource[]): Omit<MemoryContextPolicy, 'format'> {
  const guidance = memoryInputText(config.instruction ?? instruction, 'instruction', 4000)!
  return { decisions: sources.filter(source => source.role === 'collaboration' && source.routeIds.includes('search')).map(source => ({
    id: 'inspect-coordination', sourceInstanceKey: source.sourceInstanceKey, ready: true,
    reason: { en: 'Shared-resource coordination can be inspected in this scope.', 'zh-CN': '当前范围内可检查共享资源与协作状态。' },
    requires: { routeIds: ['search'] }, instruction: guidance,
  })) }
}
export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({
 kind: 'strategy-extension', typeId: 'team-coordination', label: memoryPlugin.label, description: memoryPlugin.description,
 fields: [{ key: 'instruction', label: { en: 'Guidance', 'zh-CN': '指导说明' }, input: 'textarea', defaultValue: instruction, maximum: 4000 }],
  create: config => ({ plugin: memoryPlugin, strategyExtensions: [defineWorkspacePolicy({ typeId: 'team-coordination', packageName: name, slot: 'collaboration', contribute: (_request, sources) => evaluate(config, sources) })] }),
})
export function apply(ctx: Context, config: Record<string, MemoryJsonValue> = {}): void { installMemory(ctx, memoryStrategyConfiguration.create(config)) }
