import type { Context } from '@deepseek-ai/cordis'
import { installMemory } from 'dsh-mnemon/extension-sdk'
import { defineThreeTierExtension, validateThreeTierExtension } from 'dsh-mnemon-strategy-default-three-tier/extension-sdk'

export interface Config { sourceKeys?: string[]; writableSourceKeys?: string[] }
export const name = 'dsh-mnemon-strategy-scoped'
export const inject = ['mnemonMemory']
const roles = ['working-context', 'narrative', 'durable-evidence']

export function createScopedExtension(config: Config = {}) {
  const selection = config.sourceKeys === undefined ? undefined : validateThreeTierExtension('selection', {
    sourceKeys: config.sourceKeys, ...(config.writableSourceKeys === undefined ? {} : { writableSourceKeys: config.writableSourceKeys }),
  })
  const writable = config.writableSourceKeys === undefined ? undefined : validateThreeTierExtension('selection', {
    sourceKeys: config.writableSourceKeys, writableSourceKeys: config.writableSourceKeys,
  }).writableSourceKeys
  return defineThreeTierExtension({ typeId: 'scoped', packageName: name, slot: 'selection',
    contribute: (_request, sources) => selection ?? {
      sourceKeys: sources.filter(source => roles.includes(source.role))
        .sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role) || a.sourceInstanceKey.localeCompare(b.sourceInstanceKey))
        .map(source => source.sourceInstanceKey),
      ...(writable === undefined ? {} : { writableSourceKeys: writable }),
    },
  })
}

export function apply(ctx: Context, config: Config = {}): void {
  installMemory(ctx, { strategyExtensions: [createScopedExtension(config)] })
}
