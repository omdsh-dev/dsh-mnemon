import type { Context } from '@deepseek-ai/cordis'
import { installMemory } from '../../packages/extension-sdk/src/index.ts'
import { DEFAULT_THREE_TIER_VIEW_STRATEGY } from '../../packages/strategy-default-three-tier/src/index.ts'

export const name = 'dsh-mnemon-strategy-default-three-tier'
export const inject = ['mnemonMemory']

export function apply(ctx: Context): void {
  installMemory(ctx, { strategies: [DEFAULT_THREE_TIER_VIEW_STRATEGY] })
}

export { DEFAULT_THREE_TIER_VIEW_STRATEGY }
