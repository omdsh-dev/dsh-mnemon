import type { Context } from '@deepseek-ai/cordis'
import { provideMemoryRuntime } from './runtime.ts'

export const name = 'dsh-mnemon-core'
export const provide = ['mnemonMemory']
export const inject: string[] = []

export function apply(context: Context): void {
  provideMemoryRuntime(context)
}
