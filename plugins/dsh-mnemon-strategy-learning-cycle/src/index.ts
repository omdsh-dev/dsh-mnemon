import type { Context } from '@deepseek-ai/cordis'
import type { MemoryJsonValue, MemoryAvailableSource, MemoryContextPolicy } from 'dsh-mnemon/contracts'
import { defineMemoryPlugin, defineMemoryStrategyConfiguration, installMemory, memoryContextHints, memoryInputInteger, memoryInputText } from 'dsh-mnemon/extension-sdk'
import { defineWorkspacePolicy } from 'dsh-mnemon-strategy-workspace/extension-sdk'
export const name = 'dsh-mnemon-strategy-learning-cycle'
export const inject = ['mnemonMemory']
const instruction = 'A learning review is due after independent human turns. Read review-input from the offered learning Source, inspect its exact token, independent evidence and existing proposals, and complete-review before ending this turn. Submit at most two stable memory proposals and one reusable procedure; an empty proposal list is valid when nothing durable was learned. Never store credentials, transient task state, or methods as factual memory. Keep stable preference proposals inactive until two independent human signals exist. Treat read counts, model-reported use and explicit human helpfulness as separate facts. Follow up on negative feedback through a reviewed revision, never silently overwrite or delete adopted learning. If review cannot finish, report the reason and leave the cycle outstanding.'
export const memoryPlugin = defineMemoryPlugin({ packageName: name, label: { en: 'Learning cycle', 'zh-CN': '经验整理周期' }, description: { en: 'Periodically review human evidence and close the learning feedback loop.', 'zh-CN': '按真实用户轮次整理证据，并跟进经验的使用反馈。' }, roles: ['strategy-extension'], provides: [{ id: 'strategy-extension' }], requires: ['strategy.workspace', 'source.learning-context'] })
function evaluate(config: Record<string, MemoryJsonValue>, sources: readonly MemoryAvailableSource[]): Omit<MemoryContextPolicy, 'format'> {
  const guidance = memoryInputText(config.instruction ?? instruction, 'instruction', 4000)!
  const interval = memoryInputInteger(config.interval, 5, 1, 1000)
  const outcomeInterval = memoryInputInteger(config.outcomeInterval, 0, 0, 1000)
  return { decisions: sources.filter(source => source.role === 'learning-context' && source.routeIds.includes('review-input') && source.actionIds.includes('complete-review')).map(source => {
    const hints = memoryContextHints(source)
    const turns = Number(hints.newHumanTurns ?? 0), feedback = Number(hints.newFeedback ?? 0), outcomes = Number(hints.newOutcomes ?? 0)
    const ready = turns >= interval || config.feedbackReview !== false && feedback > 0 || outcomeInterval > 0 && outcomes >= outcomeInterval
    return { id: 'review-evidence', sourceInstanceKey: source.sourceInstanceKey, ready,
      reason: { en: `${turns} new human turns, ${feedback} explicit feedback items and ${outcomes} outcomes.`, 'zh-CN': `新增 ${turns} 个用户轮次、${feedback} 条人工反馈、${outcomes} 条结果。` },
      requires: { routeIds: ['review-input'], actionIds: ['complete-review'] }, context: { mode: 'eager', weight: 4 },
      instruction: guidance }
  }) }
}
export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({ kind: 'strategy-extension', typeId: 'learning-cycle', label: memoryPlugin.label, description: memoryPlugin.description,
  fields: [{ key: 'interval', label: { en: 'Human turns between reviews', 'zh-CN': '整理间隔（用户轮次）' }, input: 'number', defaultValue: 5, minimum: 1, maximum: 1000 }, { key: 'feedbackReview', label: { en: 'Review new explicit feedback', 'zh-CN': '及时审核新增人工反馈' }, input: 'boolean', defaultValue: true }, { key: 'outcomeInterval', label: { en: 'Outcomes between reviews (0: human-turn schedule)', 'zh-CN': '结果回流整理间隔（0：随用户轮次整理）' }, input: 'number', defaultValue: 0, minimum: 0, maximum: 1000 }, { key: 'instruction', label: { en: 'Learning guidance', 'zh-CN': '整理规则' }, input: 'textarea', defaultValue: instruction, maximum: 4000 }],
  create: config => ({ plugin: memoryPlugin, strategyExtensions: [defineWorkspacePolicy({ typeId: 'learning-cycle', packageName: name, slot: 'learning', contribute: (_request, sources) => evaluate(config, sources) })] }),
})
export function apply(ctx: Context, config: Record<string, MemoryJsonValue> = {}): void { installMemory(ctx, memoryStrategyConfiguration.create(config)) }
