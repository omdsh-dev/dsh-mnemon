import type { Context } from '@deepseek-ai/cordis'
import type { MemoryJsonValue, MemoryAvailableSource, MemoryContextPolicy } from 'dsh-mnemon/contracts'
import { defineMemoryPlugin, defineMemoryStrategyConfiguration, installMemory, memoryContextHints, memoryInputInteger, memoryInputText } from 'dsh-mnemon/extension-sdk'
import { defineWorkspacePolicy } from 'dsh-mnemon-strategy-workspace/extension-sdk'
export const name = 'dsh-mnemon-strategy-review-cycle'
export const inject = ['mnemonMemory']
const instruction = "Inspect the independent conversation reviewer when a reminder is due. Read completed findings, explain unresolved concerns and review proposed improvements. Its own session settings control when independent reviews run. If no completed result exists, report the pending review and leave it due. Never claim a review is complete without its persisted result. Experience extraction is scheduled separately by the learning enhancement. Do not automatically activate, delete or overwrite records."
export const memoryPlugin = defineMemoryPlugin({ packageName: name, label: { en: 'Periodic review', 'zh-CN': '定期审查' }, description: { en: 'Prompt periodic conversation reviews and follow up on improvements.', 'zh-CN': '定期提醒检查对话，跟进问题与改进建议。' }, roles: ['strategy-extension'], provides: [{ id: 'strategy-extension' }], requires: ['strategy.workspace', 'source.conversation-review'] })
function evaluate(config: Record<string, MemoryJsonValue>, sources: readonly MemoryAvailableSource[]): Omit<MemoryContextPolicy, 'format'> {
  const guidance = memoryInputText(config.instruction ?? instruction, 'instruction', 4000)!
  const interval = memoryInputInteger(config.interval, 5, 1, 1000)
  return { decisions: sources.filter(source => source.role === 'conversation-review' && source.routeIds.includes('search')).map(source => {
    const hints = memoryContextHints(source), turns = Number(hints.unreviewedHumanTurns ?? 0)
    return { id: 'inspect-review', sourceInstanceKey: source.sourceInstanceKey, ready: hints.reviewDue === true || turns >= interval,
      reason: { en: `${turns} human turns await review; the reviewer owns the completed result.`, 'zh-CN': `${turns} 个用户轮次待审阅；完成状态以审阅器保存的结果为准。` },
      requires: { routeIds: ['search'] }, context: { mode: 'eager', weight: 2 },
      instruction: guidance }
  }) }
}
export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({
 kind: 'strategy-extension', typeId: 'review-cycle', label: memoryPlugin.label, description: memoryPlugin.description,
 fields: [{ key: 'instruction', label: { en: 'Guidance', 'zh-CN': '指导说明' }, input: 'textarea', defaultValue: instruction, maximum: 4000 }, { key: 'interval', label: { en: 'Reminder interval (human turns)', 'zh-CN': '提醒间隔（用户轮次）' }, description: { en: 'Only controls reminders in the main conversation. Configure the independent reviewer schedule on its own page.', 'zh-CN': '只控制主对话中的提醒。独立审核器的执行周期在其页面单独设置。' }, input: 'number' as const, defaultValue: 5, minimum: 1, maximum: 1000 }],
  create: config => ({ plugin: memoryPlugin, strategyExtensions: [defineWorkspacePolicy({ typeId: 'review-cycle', packageName: name, slot: 'review', contribute: (_request, sources) => evaluate(config, sources) })] }),
})
export function apply(ctx: Context, config: Record<string, MemoryJsonValue> = {}): void { installMemory(ctx, memoryStrategyConfiguration.create(config)) }
