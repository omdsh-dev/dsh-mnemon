import { randomUUID } from 'node:crypto'
import type { MessageSourceMap } from '@deepseek-ai/dsh-llm'
import type { HostUserMessage } from './dsh.ts'
import type { MemorySnapshotState } from './memory-snapshot-state.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-mnemon': {
      kind: 'dsh-mnemon'
      form: 'recall' | 'instructions' | 'memory-snapshot' | 'memory-snapshot-retired'
      snapshot?: MemorySnapshotState
    }
  }
}

export const MNEMON_PLUGIN_SOURCE = 'dsh-mnemon'

/** Includes the published V3 wrapper and its official V4 migration. */
export function isMnemonMessageSource(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const { kind, plugin } = source as { kind?: unknown; plugin?: unknown }
  return kind === MNEMON_PLUGIN_SOURCE || kind === `plugin:${MNEMON_PLUGIN_SOURCE}`
    || (kind === 'plugin' && plugin === MNEMON_PLUGIN_SOURCE)
}

/** A user-role message this plugin adds to a step, marked with its own source. */
export function createPluginMessage(text: string, form: 'recall' | 'instructions' | 'memory-snapshot', snapshot?: MemorySnapshotState): HostUserMessage {
  return structuredClone({
    id: randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    source: {
      kind: MNEMON_PLUGIN_SOURCE,
      form,
      ...(snapshot === undefined ? {} : { snapshot }),
    } satisfies MessageSourceMap['dsh-mnemon'],
  })
}
