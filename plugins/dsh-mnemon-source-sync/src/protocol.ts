import type { MemoryTransferSnapshot } from 'dsh-mnemon/contracts'
export interface Binding { slot: string; sourceKey: string; track: string }
export interface CapturedTrack { binding: Binding; revision: string; snapshot: MemoryTransferSnapshot }
export interface Bundle { format: 'mnemon-sync/v1'; identity: string; scope: 'project' | 'global'; tracks: Record<string, MemoryTransferSnapshot> }
export interface Conflict { key: string; slot: string; id: string; base: unknown; local: unknown; remote: unknown; choice?: 'local' | 'remote' | 'both' }
export interface SyncPlan {
  id: string; targetId: string; configDigest: string; createdAt: string; status: 'conflicts' | 'ready' | 'applying' | 'complete' | 'cancelled'
  head: string; remoteHead: string; commonHead: string; branch: string; remote: string
  local: CapturedTrack[]; merged: Bundle; conflicts: Conflict[]
  receipts: Record<string, { revision: string; snapshot: MemoryTransferSnapshot; at: string }>
  commit?: string
}
export function canonical(value: unknown): string {
  const sort = (input: unknown): unknown => Array.isArray(input) ? input.map(sort) : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, sort(value)])) : input
  return JSON.stringify(sort(value))
}
