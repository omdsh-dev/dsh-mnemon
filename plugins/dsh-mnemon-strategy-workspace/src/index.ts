import type { Context } from '@deepseek-ai/cordis'
import { defineMemoryPlugin, defineMemoryStrategyConfiguration, installMemory } from 'dsh-mnemon/extension-sdk'
import { WORKSPACE_STRATEGY } from './strategy.ts'
export const name = 'dsh-mnemon-strategy-workspace'
export const inject = ['mnemonMemory']
export const memoryPlugin = defineMemoryPlugin({ packageName: name, label: { en: 'Workspace context', 'zh-CN': '工作区上下文' }, description: { en: 'Combine project knowledge, tasks, and conversations into useful context.', 'zh-CN': '汇总项目资料、任务与会话，提供当前工作所需的上下文。' }, roles: ['strategy'], provides: [{ id: 'strategy' }, { id: 'strategy.workspace' }], requires: ['source'] })
export const memoryStrategyConfiguration = defineMemoryStrategyConfiguration({ kind: 'strategy', typeId: 'workspace', label: memoryPlugin.label, description: memoryPlugin.description, fields: [], create: () => ({ plugin: memoryPlugin, strategies: [WORKSPACE_STRATEGY] }) })
export function apply(ctx: Context): void { installMemory(ctx, memoryStrategyConfiguration.create({})) }
export { WORKSPACE_STRATEGY }
