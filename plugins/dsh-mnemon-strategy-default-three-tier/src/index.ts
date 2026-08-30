import type { Context } from '@deepseek-ai/cordis'
import { installMemory } from 'dsh-mnemon/extension-sdk'
import { DEFAULT_THREE_TIER_VIEW_STRATEGY } from './strategy.ts'

export const name = 'dsh-mnemon-strategy-default-three-tier'
export const inject = ['mnemonMemory']

export function apply(ctx: Context): void {
  installMemory(ctx, { strategies: [DEFAULT_THREE_TIER_VIEW_STRATEGY] })
}

export { DEFAULT_THREE_TIER_VIEW_STRATEGY }
