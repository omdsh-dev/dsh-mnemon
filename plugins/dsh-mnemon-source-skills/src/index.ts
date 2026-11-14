import type { Context } from '@deepseek-ai/cordis'
import { defineMemoryPlugin, installMemory, memoryConfigurationDigest } from 'dsh-mnemon/extension-sdk'
import { createSkillsMemorySource, type Config } from './source.ts'

export const name = 'dsh-mnemon-source-skills'
export const inject = ['mnemonMemory']
export type { Config }

export const memoryPlugin = defineMemoryPlugin({
  packageName: name,
  label: { en: 'Skills', 'zh-CN': '技能管理' },
  description: {
    en: 'Manage DSH skills, and let them improve from your conversations.',
    'zh-CN': '管理 DSH 技能，并让它们从对话中持续改进。',
  },
  roles: ['source'],
  provides: [{ id: 'source' }, { id: 'source.procedural' }],
})

export function apply(ctx: Context, config: Config = {}): void {
  installMemory(ctx, { plugin: memoryPlugin, sources: [createSkillsMemorySource(config)] }, { effectiveDigest: memoryConfigurationDigest(config) })
}

export { createSkillsMemorySource, SKILLS_MEMORY_SOURCE, SKILLS_SOURCE_TYPE_ID, SKILLS_SOURCE_ROLE } from './source.ts'
