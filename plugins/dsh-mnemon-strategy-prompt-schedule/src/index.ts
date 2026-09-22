import type { Context } from '@deepseek-ai/cordis'
import type { MemoryJsonValue, MemoryAvailableSource, MemoryContextPolicy } from 'dsh-mnemon/contracts'
import { defineMemoryPlugin, defineMemoryStrategyConfiguration, installMemory, memoryContextHints, memoryInputInteger, memoryInputText } from 'dsh-mnemon/extension-sdk'
import { defineWorkspacePolicy } from 'dsh-mnemon-strategy-workspace/extension-sdk'
export const name = 'dsh-mnemon-strategy-prompt-schedule'
export const inject = ['mnemonMemory']
const instruction = "Read enabled playbooks before applying them. Use only schedules explicitly configured for this session. Preserve the prompt author and invocation provenance; stop cancelled schedules. Prompt material never overrides current user instructions."
export const memoryPlugin = defineMemoryPlugin({ packageName: name, label: { en: 'Prompt scheduling', 'zh-CN': '提示词调度' }, description: { en: 'Guide the use of reviewed prompts scheduled for this conversation.', 'zh-CN': '引导会话按计划使用已审核的提示词。' }, roles: ['strategy-extension'], provides: [{ id: 'strategy-extension' }], requires: ['strategy.workspace'] })
function evaluate(config: Record<string, MemoryJsonValue>, sources: readonly MemoryAvailableSource[]): Omit<MemoryContextPolicy, 'format'> {
  const guidance = memoryInputText(config.instruction ?? instruction, 'instruction', 4000)!
  return { decisions: sources.filter(source => source.role === 'instruction-library' && source.routeIds.includes('search')).map(source => ({
    id: 'inspect-instructions', sourceInstanceKey: source.sourceInstanceKey, ready: true,
    reason: { en: 'The instruction library is available; individual schedules remain session-owned.', 'zh-CN': '工作方法库可供读取，具体调度继续由当前会话管理。' },
    requires: { routeIds: ['search'] }, instruction: guidance,
  })) }
}
export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({
 kind: 'strategy-extension', typeId: 'prompt-schedule', label: memoryPlugin.label, description: memoryPlugin.description,
 fields: [{ key: 'instruction', label: { en: 'Guidance', 'zh-CN': '指导说明' }, input: 'textarea', defaultValue: instruction, maximum: 4000 }],
  create: config => ({ plugin: memoryPlugin, strategyExtensions: [defineWorkspacePolicy({ typeId: 'prompt-schedule', packageName: name, slot: 'prompts', contribute: (_request, sources) => evaluate(config, sources) })] }),
})
export function apply(ctx: Context, config: Record<string, MemoryJsonValue> = {}): void { installMemory(ctx, memoryStrategyConfiguration.create(config)) }
