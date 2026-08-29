import type { JsonValue } from '../contracts.ts'
import type {
  EdgeType,
  Insight,
  MemoryBody,
  MemoryBodyStats,
  MemoryGraphSnapshot,
  MemoryListRequest,
  MemoryProviderConnection,
  RememberRequest,
  SearchRequest,
} from '../shared/contracts.ts'

export interface ProviderBodyStatus {
  healthy: boolean
  error?: string
  stats?: MemoryBodyStats
}

export interface ProviderSearchResult {
  results: Insight[]
  hint?: string
}

export interface ProviderScoreSemantics {
  /** Provider promises a finite relevance score in 0..1 where larger is better. */
  kind: 'normalized-relevance'
}

export type MemoryProviderScoreSemantics = 'normalized-relevance' | 'provider-native' | 'none'

export const NORMALIZED_RELEVANCE_SCORE: ProviderScoreSemantics = Object.freeze({ kind: 'normalized-relevance' })

/** One provider-owned namespace projected into DSH as a Memory Space. */
export interface ProviderMemorySpace {
  /** Stable identifier owned by the provider, never a DSH-generated title. */
  externalId: string
  name: string
  description: string
  connection: MemoryProviderConnection
}

/**
 * Third-layer memory data plane. DSH owns routing and lifecycle; adapters own
 * only one body's persistence and retrieval semantics.
 */
export interface MemoryProviderAdapter {
  readonly id: MemoryBody['provider']['id']
  readonly scoreSemantics?: ProviderScoreSemantics
  /** Enumerate the complete set of namespaces visible to this service connection. */
  discover?(connection: MemoryProviderConnection, signal?: AbortSignal): Promise<ProviderMemorySpace[]>
  /** Drop a short-lived health result before an explicit user reconnect. */
  invalidateStatus?(memoryBodyId?: string): void
  status(body: MemoryBody, signal?: AbortSignal): Promise<ProviderBodyStatus>
  search(body: MemoryBody, request: SearchRequest, signal?: AbortSignal): Promise<ProviderSearchResult>
  graph(body: MemoryBody, signal?: AbortSignal): Promise<MemoryGraphSnapshot>
  list(body: MemoryBody, request: MemoryListRequest, signal?: AbortSignal): Promise<Insight[]>
  remember(body: MemoryBody, request: RememberRequest, signal?: AbortSignal): Promise<JsonValue>
  /** Persist an ordered host-authorized batch and return one receipt per request. */
  rememberMany?(body: MemoryBody, requests: readonly RememberRequest[], signal?: AbortSignal): Promise<JsonValue[]>
  related?(body: MemoryBody, id: string, depth: number, edge?: EdgeType, signal?: AbortSignal): Promise<Insight[]>
  link?(body: MemoryBody, sourceId: string, targetId: string, type: EdgeType, weight: number, reason?: string, signal?: AbortSignal): Promise<JsonValue>
  forget?(body: MemoryBody, id: string, signal?: AbortSignal): Promise<JsonValue>
  /** Release generation-owned clients, timers, pools, or subprocess handles. */
  dispose?(): void | Promise<void>
}
