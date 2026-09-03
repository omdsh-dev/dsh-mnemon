import type { Context } from '@deepseek-ai/cordis'
import { defineMemoryPlugin, installMemory, memoryConfigurationDigest } from 'dsh-mnemon/extension-sdk'
import { Config } from './config.ts'
import { createDocumentsMemorySource } from './source.ts'

export const name = 'dsh-mnemon-source-documents'
export const inject = ['mnemonMemory']
export { Config }

export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'Documents', 'zh-CN': '档案' },
  description: { en: 'Searchable project records and narrative memory.', 'zh-CN': '可检索的项目档案与叙事记忆。' },
  roles: ['source'],
  provides: [{ id: 'source' }, { id: 'source.narrative' }],
})

export function apply(ctx: Context, config: Config = {}): void {
  installMemory(ctx, { plugin: memoryPlugin, sources: [createDocumentsMemorySource(config)] }, { effectiveDigest: memoryConfigurationDigest(config) })
}

export { createDocumentsMemorySource, DOCUMENTS_MEMORY_SOURCE } from './source.ts'
export type * from './contracts.ts'
