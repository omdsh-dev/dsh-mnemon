import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import { defineMemoryPlugin, installMemory, memoryConfigurationDigest } from 'dsh-mnemon/extension-sdk'
import { createRecordSource, type RecordSourceConfig } from 'dsh-mnemon/source-sdk'
import { sourceOptions } from './source.ts'
export const name = 'dsh-mnemon-source-project-context'
export const inject = ['mnemonMemory']
export type Config = RecordSourceConfig
export const Config = z.object({ dataDir: z.string() }) as z<Config>
export const memoryPlugin = defineMemoryPlugin({
 packageName: name, label: { en: 'Project notes', 'zh-CN': '项目笔记' },
 description: { en: 'Branch-aware project facts, decisions and working notes.', 'zh-CN': '按分支组织项目事实、决策和工作笔记。' }, roles: ['source'], provides: [{ id: 'source' }, { id: 'source.project-context' }],
})
export function apply(ctx: Context, config: Config = {}): void {
 installMemory(ctx, { plugin: memoryPlugin, sources: [createRecordSource(sourceOptions, config)] }, { effectiveDigest: memoryConfigurationDigest(config) })
}
export { sourceOptions }
