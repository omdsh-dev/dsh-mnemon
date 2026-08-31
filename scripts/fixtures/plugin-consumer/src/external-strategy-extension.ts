import type { Context } from '@deepseek-ai/cordis'
import { installMemory } from 'dsh-mnemon/extension-sdk'
import { defineThreeTierExtension } from 'dsh-mnemon-strategy-default-three-tier/extension-sdk'

export const name = 'dsh-mnemon-strategy-external-budget'
export const inject = ['mnemonMemory']

/** Compiled outside the repository against the owning Strategy's packed SDK. */
export function apply(ctx: Context): void {
  installMemory(ctx, { strategyExtensions: [defineThreeTierExtension({
    typeId: 'external-budget', packageName: name, slot: 'projection',
    contribute: request => ({ maxProjectionCharacters: Math.min(request.budget.maxProjectionCharacters, 1_200) }),
  })] })
}
