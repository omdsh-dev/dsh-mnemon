import type { Context } from '@deepseek-ai/cordis'
import { installMemory } from 'dsh-mnemon/extension-sdk'
import { defineThreeTierExtension, validateThreeTierExtension } from 'dsh-mnemon-strategy-default-three-tier/extension-sdk'

export interface Config { sourceKeys?: string[]; actionIds?: string[]; instruction?: string }
export const name = 'dsh-mnemon-strategy-auto-capture'
export const inject = ['mnemonMemory']
const instruction = 'During the current conversation, consider recording at most one new durable user-supplied preference, correction, or established project fact that will help a future task. Compare existing memory first; skip duplicates, secrets, transient progress, guesses, assistant-authored claims and facts merely retrieved from memory. Respect a request not to remember. Prefer adding one concise fact to one eligible durable Source; do not copy the same fact into multiple layers. Continue without writing when no candidate qualifies.'

export function createAutoCaptureExtension(config: Config = {}) {
  const capture = validateThreeTierExtension('capture', { instruction: config.instruction ?? instruction,
    actionIds: config.actionIds ?? ['remember'],
    ...(config.sourceKeys === undefined ? {} : { sourceKeys: config.sourceKeys }) })
  return defineThreeTierExtension({ typeId: 'auto-capture', packageName: name, slot: 'capture',
    contribute: (_request, sources) => ({ ...capture, sourceKeys: capture.sourceKeys ?? sources
      .filter(source => source.role === 'durable-evidence').map(source => source.sourceInstanceKey).sort() }),
  })
}

export function apply(ctx: Context, config: Config = {}): void {
  installMemory(ctx, { strategyExtensions: [createAutoCaptureExtension(config)] })
}
