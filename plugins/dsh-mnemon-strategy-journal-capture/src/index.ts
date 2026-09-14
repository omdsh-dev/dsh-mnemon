import type { Context } from '@deepseek-ai/cordis'
import type { MemoryJsonValue, MemoryAvailableSource, MemoryContextPolicy } from 'dsh-mnemon/contracts'
import { defineMemoryPlugin, defineMemoryStrategyConfiguration, installMemory, memoryContextHints, memoryInputInteger, memoryInputText } from 'dsh-mnemon/extension-sdk'
import { defineWorkspacePolicy } from 'dsh-mnemon-strategy-workspace/extension-sdk'
export const name = 'dsh-mnemon-strategy-journal-capture'
export const inject = ['mnemonMemory']
const instruction = "Record meaningful completed outcomes and exact user feedback through the journal Source. Preserve attribution and avoid duplicate entries. A journal entry records evidence; it does not by itself establish a lasting preference or reusable procedure."
export const memoryPlugin = defineMemoryPlugin({ packageName: name, label: { en: 'Journal capture', 'zh-CN': '日志记录' }, description: { en: 'Prompt progress updates and preserve exact user feedback.', 'zh-CN': '提示记录工作进展，并保留用户的原始反馈。' }, roles: ['strategy-extension'], provides: [{ id: 'strategy-extension' }], requires: ['strategy.workspace'] })
function evaluate(config: Record<string, MemoryJsonValue>, sources: readonly MemoryAvailableSource[]): Omit<MemoryContextPolicy, 'format'> {
  const guidance = memoryInputText(config.instruction ?? instruction, 'instruction', 4000)!
  const decisions: MemoryContextPolicy['decisions'] = []
  for (const source of sources.filter(source => source.role === 'activity-log')) {
    const action = source.actions.find(action => action.id === 'append' && !action.authority && !action.operation?.requiresReadGrant
      && (!action.operation || action.operation.effects.includes('append')))
    if (!action) continue
    decisions.push({ id: 'capture-outcomes', sourceInstanceKey: source.sourceInstanceKey, ready: true,
      reason: { en: 'The activity journal offers attributed outcome capture.', 'zh-CN': '活动日志支持记录实际结果并保留出处。' },
      requires: { actionIds: [action.id] }, instruction: guidance })
    if (source.role === 'activity-log' && action.id === 'append') decisions.push({ id: 'journal-progress', sourceInstanceKey: source.sourceInstanceKey,
      ready: memoryContextHints(source).journalWriteDue === true,
      reason: { en: 'Progress reminders follow completed human turns and successful journal writes.', 'zh-CN': '进展提醒依据已完成的用户轮次和成功保存的日志。' }, requires: { actionIds: [action.id] },
      instruction: 'Journal progress is due after several completed human turns without a successful entry. Record the actual outcome through an offered journal append action. This reminder remains until a successful journal write; a pending proposal does not satisfy it.' })
  }
  return { decisions }
}
export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({
 kind: 'strategy-extension', typeId: 'journal-capture', label: memoryPlugin.label, description: memoryPlugin.description,
 fields: [{ key: 'instruction', label: { en: 'Guidance', 'zh-CN': '指导说明' }, input: 'textarea', defaultValue: instruction, maximum: 4000 }],
  create: config => ({ plugin: memoryPlugin, strategyExtensions: [defineWorkspacePolicy({ typeId: 'journal-capture', packageName: name, slot: 'capture', contribute: (_request, sources) => evaluate(config, sources) })] }),
})
export function apply(ctx: Context, config: Record<string, MemoryJsonValue> = {}): void { installMemory(ctx, memoryStrategyConfiguration.create(config)) }
