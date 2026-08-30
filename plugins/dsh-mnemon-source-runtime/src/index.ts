import type { Context } from '@deepseek-ai/cordis'
import { installMemory, memoryConfigurationDigest } from 'dsh-mnemon/extension-sdk'
import { Config } from './config.ts'
import { createRuntimeMemorySource } from './source.ts'

export const name = 'dsh-mnemon-source-runtime'
export const inject = ['mnemonMemory']
export { Config }

export function apply(ctx: Context, config: Config = {}): void {
  installMemory(ctx, { sources: [createRuntimeMemorySource(config)] }, { effectiveDigest: memoryConfigurationDigest(config) })
}

export { createRuntimeMemorySource, RUNTIME_MEMORY_SOURCE } from './source.ts'
export * from './controller.ts'
export type * from './contracts.ts'
