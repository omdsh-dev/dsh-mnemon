import type { Context } from '@deepseek-ai/cordis'
import { installMemory } from 'dsh-mnemon/extension-sdk'
import { defineThreeTierExtension, validateThreeTierExtension } from 'dsh-mnemon-strategy-default-three-tier/extension-sdk'

export interface Config { maxProjectionCharacters?: number }
export const name = 'dsh-mnemon-strategy-light-context'
export const inject = ['mnemonMemory']

export function createLightContextExtension(config: Config = {}) {
  const projection = validateThreeTierExtension('projection', { maxProjectionCharacters: config.maxProjectionCharacters ?? 4_096 })
  return defineThreeTierExtension({ typeId: 'light-context', packageName: name, slot: 'projection', contribute: () => projection })
}

export function apply(ctx: Context, config: Config = {}): void {
  installMemory(ctx, { strategyExtensions: [createLightContextExtension(config)] })
}
