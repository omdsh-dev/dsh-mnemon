import { randomUUID } from 'node:crypto'
import type { MessageSourceMap } from '@deepseek-ai/dsh-llm'
import type { HostUserMessage } from './dsh.ts'
import type { MemorySnapshotState, RuntimeSnapshotRange } from './memory-snapshot-state.ts'
import type { Bm25RecallState } from './bm25-recall.ts'

type MnemonUserMessageForm = 'recall' | 'instructions' | 'memory-snapshot' | 'bm25-recall' | 'bm25-invalidation'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-mnemon': {
      kind: 'dsh-mnemon'
      form: MnemonUserMessageForm | 'memory-snapshot-retired'
      snapshot?: MemorySnapshotState
      bm25?: Bm25RecallState
      runtimeRanges?: RuntimeSnapshotRange[]
    }
  }
}

export const MNEMON_PLUGIN_SOURCE = 'dsh-mnemon'

export function isMnemonMessageSource(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const { kind, plugin } = source as { kind?: unknown; plugin?: unknown }
  return kind === MNEMON_PLUGIN_SOURCE || kind === `plugin:${MNEMON_PLUGIN_SOURCE}`
    || (kind === 'plugin' && plugin === MNEMON_PLUGIN_SOURCE)
}

export function isBm25RecallSource(source: unknown): boolean {
  if (!isMnemonMessageSource(source)) return false
  const { form } = source as { form?: unknown }
  return form === 'bm25-recall' || form === 'bm25-invalidation'
}

export function createPluginMessage(text: string, form: MnemonUserMessageForm, metadata?: { snapshot?: MemorySnapshotState; bm25?: Bm25RecallState; runtimeRanges?: RuntimeSnapshotRange[] }): HostUserMessage {
  return structuredClone({
    id: randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    source: {
      kind: MNEMON_PLUGIN_SOURCE,
      form,
      ...metadata,
    } satisfies MessageSourceMap['dsh-mnemon'],
  })
}
