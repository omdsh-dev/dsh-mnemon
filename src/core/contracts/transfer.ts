import type { MemoryJsonValue } from './index.ts'

/** Optional human-management protocol, implemented and validated by each Source. */
export const MEMORY_TRANSFER_FORMAT = 'mnemon-source-transfer/v1' as const
export interface MemoryTransferTrack {
  id: string
  scope: 'project' | 'global'
  label: { en: string; 'zh-CN': string }
}
export interface MemoryTransferCatalog {
  format: typeof MEMORY_TRANSFER_FORMAT
  tracks: MemoryTransferTrack[]
}
export interface MemoryTransferEntry {
  /** Stable within this track. Payload semantics remain private to its Source. */
  id: string
  value: MemoryJsonValue
}
export interface MemoryTransferSnapshot {
  format: typeof MEMORY_TRANSFER_FORMAT
  track: string
  entries: MemoryTransferEntry[]
}

/**
 * `transfer-catalog` and `transfer-export` are management reads. `transfer-import`
 * is a confirmed, revision-fenced mutation receiving { snapshot }. No model
 * ActionOffer or access to another Source is implied. Imports must be repeatable,
 * retain local recovery history and reject unknown tracks or invalid payloads.
 */
