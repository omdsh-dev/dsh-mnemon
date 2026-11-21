import type { Context } from '@deepseek-ai/cordis'
import { prepareStarterResolution } from './starter-resolution.ts'

export const name = 'dsh-mnemon-starter'
export const provide = ['mnemonStarterReady']

export async function apply(ctx: Context): Promise<void> {
  await prepareStarterResolution(ctx)
  ctx.provide('mnemonStarterReady', true)
}
