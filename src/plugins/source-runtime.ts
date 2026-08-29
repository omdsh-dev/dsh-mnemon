import type { Context } from '@deepseek-ai/cordis'
import { installMemory } from '../../packages/extension-sdk/src/index.ts'
import { RUNTIME_MEMORY_SOURCE } from '../composable/source-runtime.ts'

export const name = 'dsh-mnemon-source-runtime'
export const inject = ['mnemonMemory']

export function apply(ctx: Context): void {
  installMemory(ctx, { sources: [RUNTIME_MEMORY_SOURCE] })
}

export { RUNTIME_MEMORY_SOURCE }
