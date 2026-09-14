import type { Context } from '@deepseek-ai/cordis'
import type { MemoryJsonValue, MemoryAvailableSource, MemoryContextPolicy } from 'dsh-mnemon/contracts'
import { defineMemoryPlugin, defineMemoryStrategyConfiguration, installMemory, memoryContextHints, memoryInputInteger, memoryInputText } from 'dsh-mnemon/extension-sdk'
import { defineWorkspacePolicy } from 'dsh-mnemon-strategy-workspace/extension-sdk'

export const name = 'dsh-mnemon-strategy-skill-refinement'
export const inject = ['mnemonMemory']
const instruction = 'Reusable skill evidence or unresolved skill feedback is available. Inspect skill-context from the offered Source, including existing native names and pending candidates. Handle at most one opportunity in this turn. Prefer improving a matching enabled published skill over creating a duplicate: read every listed resource using skill-read, then submit propose-skill with its baseId. For a matching editable native skill outside the managed versions, read all its resources with nativeName and then propose-skill with nativeName. Cite the exact basisId supplied by skill-context. Include a complete SKILL.md and any scripts, references and meaningful runnable tests needed for reliable reuse; preserve useful existing files. Instructions-only skills do not need artificial scripts. A negative execution or feedback is evidence of a problem, never proof of success. All candidates remain inactive until the operator reviews, validates and publishes them. Do not execute candidate scripts, install dependencies, publish changes or bypass native tool approval during automatic refinement. If the evidence is transient, duplicated or insufficient, use defer-skill with a specific reason; do not claim the concern was resolved. Distinguish native loading, actual execution, model-reported use and human helpfulness. Do not generate a new candidate when one already awaits review.'
export const memoryPlugin = defineMemoryPlugin({ packageName: name, label: { en: 'Skill refinement', 'zh-CN': '技能改进' }, description: { en: 'Turn reusable evidence and observed failures into reviewed native skill candidates.', 'zh-CN': '将可复用经验和使用反馈整理为待审核的原生技能版本。' }, roles: ['strategy-extension'], provides: [{ id: 'strategy-extension' }], requires: ['strategy.workspace', 'source.skill-lifecycle'] })
function evaluate(config: Record<string, MemoryJsonValue>, sources: readonly MemoryAvailableSource[]): Omit<MemoryContextPolicy, 'format'> {
  const guidance = memoryInputText(config.instruction ?? instruction, 'instruction', 4000)!
  const minimum = memoryInputInteger(config.minimumSignals, 2, 1, 20)
  return { decisions: sources.filter(source => source.role === 'instruction-library' && source.routeIds.includes('skill-context') && source.actionIds.includes('propose-skill')).map(source => {
    const hints = memoryContextHints(source), feedback = Number(hints.skillFeedbackCount ?? 0)
    const opportunities = Array.isArray(hints.skillOpportunitySignals) ? hints.skillOpportunitySignals.filter(count => typeof count === 'number' && count >= minimum).length : 0
    return { id: 'refine-resource', sourceInstanceKey: source.sourceInstanceKey, ready: opportunities > 0 || config.reviewFeedback !== false && feedback > 0,
      reason: { en: `${opportunities} opportunities meet the evidence threshold; ${feedback} feedback items await follow-up.`, 'zh-CN': `${opportunities} 个机会达到证据门槛，${feedback} 条使用反馈待跟进。` },
      requires: { routeIds: ['skill-context'], actionIds: ['propose-skill'] }, context: { mode: 'eager', weight: 4 },
      instruction: guidance }
  }) }
}
export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({ kind: 'strategy-extension', typeId: 'skill-refinement', label: memoryPlugin.label, description: memoryPlugin.description,
  fields: [
    { key: 'minimumSignals', label: { en: 'Independent signals for a new skill', 'zh-CN': '新技能所需独立证据数' }, input: 'number', defaultValue: 2, minimum: 1, maximum: 20 },
    { key: 'reviewFeedback', label: { en: 'Follow up on skill feedback', 'zh-CN': '跟进技能使用反馈' }, input: 'boolean', defaultValue: true },
    { key: 'instruction', label: { en: 'Skill refinement guidance', 'zh-CN': '技能改进规则' }, input: 'textarea', defaultValue: instruction, maximum: 4000 },
  ],
  create: config => ({ plugin: memoryPlugin, strategyExtensions: [defineWorkspacePolicy({ typeId: 'skill-refinement', packageName: name, slot: 'skills', contribute: (_request, sources) => evaluate(config, sources) })] }),
})
export function apply(ctx: Context, config: Record<string, MemoryJsonValue> = {}): void { installMemory(ctx, memoryStrategyConfiguration.create(config)) }
