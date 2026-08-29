import type { Context } from '@deepseek-ai/cordis'
import { installMemory } from '../../packages/extension-sdk/src/index.ts'
import { MEMORY_SPACES_SOURCE } from '../composable/source-memory-spaces.ts'

export const name = 'dsh-mnemon-source-memory-spaces'
export const inject = ['mnemonMemory']

export function apply(ctx: Context): void {
  installMemory(ctx, { sources: [MEMORY_SPACES_SOURCE] })
}

export { MEMORY_SPACES_SOURCE }
