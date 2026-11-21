import type { JsonValue } from '../contracts.ts'
import type {
  EdgeType,
  Insight,
  MemorySpace,
  MemorySpaceStats,
  MemoryGraphSnapshot,
  MemoryListRequest,
  MemoryProviderConnection,
  RememberRequest,
  SearchRequest,
} from '../contracts.ts'

export interface MemorySpaceAuthority {
  readonly runner: { effectiveDataDir(): string }
  list(): MemorySpace[]
  providerConnection(id: string, expectedProviderId?: string): MemoryProviderConnection
}

export interface MemorySpaceNativeRunOptions {
  signal?: AbortSignal
  store?: string
  maxOutputBytes?: number
}

export interface MemorySpaceNativeRunner {
  runJson(args: readonly string[], options?: MemorySpaceNativeRunOptions): Promise<JsonValue>
  runText(args: readonly string[], options?: MemorySpaceNativeRunOptions): Promise<string>
}

export interface MemoryProviderAdapterFactoryContext {
  memorySpaces?: MemorySpaceAuthority
  /** @deprecated Use memorySpaces when present; retained for existing Provider factories. */
  memoryBodies: MemorySpaceAuthority
  config: { timeoutMs: number; defaultRecallLimit?: number }
  nativeRunner?: MemorySpaceNativeRunner
}

export interface ProviderSpaceStatus {
  healthy: boolean
  error?: string
  stats?: MemorySpaceStats
}

export interface ProviderSearchResult {
  results: Insight[]
  hint?: string
}

export interface ProviderScoreSemantics {
  kind: 'normalized-relevance' | 'provider-native'
}

export type MemoryProviderScoreSemantics = 'normalized-relevance' | 'provider-native' | 'none'

export const NORMALIZED_RELEVANCE_SCORE: ProviderScoreSemantics = Object.freeze({ kind: 'normalized-relevance' })

export interface ProviderEntityIndex {
  memories: Insight[]
  complete: boolean
}

export interface ProviderMemorySpace {
  externalId: string
  name: string
  description: string
  connection: MemoryProviderConnection
}

export interface MemoryProviderAdapter {
  readonly id: MemorySpace['provider']['id']
  readonly scoreSemantics?: ProviderScoreSemantics
  discover?(connection: MemoryProviderConnection, signal?: AbortSignal): Promise<ProviderMemorySpace[]>
  invalidateStatus?(memoryBodyId?: string): void
  status(body: MemorySpace, signal?: AbortSignal): Promise<ProviderSpaceStatus>
  search(body: MemorySpace, request: SearchRequest, signal?: AbortSignal): Promise<ProviderSearchResult>
  graph(body: MemorySpace, signal?: AbortSignal): Promise<MemoryGraphSnapshot>
  list(body: MemorySpace, request: MemoryListRequest, signal?: AbortSignal): Promise<Insight[]>
  remember(body: MemorySpace, request: RememberRequest, signal?: AbortSignal): Promise<JsonValue>
  metadataSample?(body: MemorySpace, limit: number, signal?: AbortSignal): Promise<Insight[]>
  entityIndex?(body: MemorySpace, signal?: AbortSignal): Promise<ProviderEntityIndex>
  rememberMany?(body: MemorySpace, requests: readonly RememberRequest[], signal?: AbortSignal): Promise<JsonValue[]>
  get?(body: MemorySpace, id: string, signal?: AbortSignal): Promise<Insight | undefined>
  related?(body: MemorySpace, id: string, depth: number, edge?: EdgeType, signal?: AbortSignal): Promise<Insight[]>
  link?(body: MemorySpace, sourceId: string, targetId: string, type: EdgeType, weight: number, reason?: string, signal?: AbortSignal): Promise<JsonValue>
  forget?(body: MemorySpace, id: string, signal?: AbortSignal): Promise<JsonValue>
  dispose?(): void | Promise<void>
}

/** @deprecated Use ProviderSpaceStatus. */
export type ProviderBodyStatus = ProviderSpaceStatus
