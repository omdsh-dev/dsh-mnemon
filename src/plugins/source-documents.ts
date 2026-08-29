import type { Context } from '@deepseek-ai/cordis'
import { installMemory } from '../../packages/extension-sdk/src/index.ts'
import { DOCUMENTS_MEMORY_SOURCE } from '../composable/source-documents.ts'

export const name = 'dsh-mnemon-source-documents'
export const inject = ['mnemonMemory']

export function apply(ctx: Context): void {
  installMemory(ctx, { sources: [DOCUMENTS_MEMORY_SOURCE] })
}

export { DOCUMENTS_MEMORY_SOURCE }
