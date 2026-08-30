/**
 * Public narrow waist for Composable View Memory plugins.
 *
 * Definitions contain executable factories and remain inside the Host realm.
 * Every manifest, fact, spec, View, Evidence, and Receipt crossing that
 * boundary is JSON-safe and can therefore be validated, digested, and replayed.
 */
import type {
  MemoryCapability,
  MemoryJsonValue,
  MemoryOperationScope,
  MemoryReceiptStatus,
  MemorySourceMode,
  MemoryOperationSemantics,
  MemoryOperationSelection,
  MemoryResolvedBudget,
  MemoryBudgetUsage,
  MemoryResultSemantics,
  MemoryMutationCompletion,
} from './index.ts'

export const COMPOSABLE_MEMORY_API_VERSION = 'dsh-mnemon/v1' as const

export type MemoryContributionKind = 'source' | 'strategy'
export type MemorySourceAvailability = 'ready' | 'degraded' | 'unavailable'
export type MemoryViewConsistencyMode = 'exact-snapshot' | 'namespace-pinned-live-read'

export interface MemoryPackageProvenance {
  /** npm package name or another stable artifact namespace. */
  packageName: string
  /** Stable Loader Entry id (or an explicit id for direct ctx.plugin mounts). */
  entryId: string
  /** Optional immutable package artifact digest supplied by an installer. */
  artifactDigest?: string
}

export interface MemoryManagementField {
  key: string
  label: string
  description?: string
  input: 'text' | 'number' | 'boolean' | 'url' | 'secret' | 'select'
  required: boolean
  secret?: boolean
  options?: Array<{ value: string; label: string }>
}

/** JSON-safe presentation metadata. It never contains a React component. */
export interface MemoryManagementDescriptor {
  label: string
  description: string
  fields?: MemoryManagementField[]
  diagnostics?: string[]
}

export type MemorySourceManagementMode = 'read' | 'mutate'

/**
 * Authenticated human-management request delivered to one Serving Source.
 * It is deliberately separate from model Routes and ActionOffers: no View
 * grant crosses into the browser management plane.
 */
export interface MemorySourceManagementRequest {
  scope: MemoryOperationScope
  sourceInstanceKey: string
  mode: MemorySourceManagementMode
  operation: string
  input: MemoryJsonValue
  /** Mutations are revision-fenced by the caller and rechecked by the Source. */
  expectedRevision?: string
  /** The Host only forwards mutations after an explicit confirmation. */
  confirmed: boolean
  signal?: AbortSignal
}

/** JSON-safe management projection or mutation result from one Source. */
export interface MemorySourceManagementResult {
  revision: string
  value: MemoryJsonValue
}

/** Sanitized Source instance descriptor returned to authenticated clients. */
export interface MemorySourceManagementInstance {
  sourceInstanceKey: string
  sourceTypeId: string
  packageName: string
  role: string
  availability: MemorySourceAvailability
  revision: string
  capabilities: MemoryCapability[]
  management: MemoryManagementDescriptor
  hints?: MemoryJsonValue
}

export interface MemorySourceManagementCatalog {
  generationId: string
  sources: MemorySourceManagementInstance[]
  diagnostics?: MemoryCompositionDiagnostic[]
}

export interface MemorySourceRouteManifest {
  /** Stable within one Source type. Runtime prefixes it with the instance key. */
  id: string
  description: string
  capability: MemoryCapability
  inputSchema: MemoryJsonValue
  maxCalls: number
  maxResults?: number
  maxCharacters?: number
  /** Omission means unspecified semantics, not inferred support. */
  semantics?: MemoryOperationSemantics
}

export interface MemorySourceActionManifest {
  /** Stable within one Source type. Runtime prefixes it with the instance key. */
  id: string
  description: string
  capability: MemoryCapability
  inputSchema: MemoryJsonValue
  /** High-risk non-memory actions must name an external authority. */
  authority?: string
  semantics?: MemoryOperationSemantics
}

export interface MemorySourceManifest {
  apiVersion: typeof COMPOSABLE_MEMORY_API_VERSION
  kind: 'source'
  typeId: string
  packageName: string
  role: string
  capabilities: MemoryCapability[]
  consistency: MemoryViewConsistencyMode
  projection?: MemoryOperationSemantics
  routes?: MemorySourceRouteManifest[]
  actions?: MemorySourceActionManifest[]
  management?: MemoryManagementDescriptor
}

export interface MemoryStrategyManifest {
  apiVersion: typeof COMPOSABLE_MEMORY_API_VERSION
  kind: 'strategy'
  typeId: string
  packageName: string
  deterministic: true
  supportedSourceRoles: string[]
  maxSources: number
  maxRoutes: number
  maxActions: number
}

export interface MemorySourceFacts {
  sourceInstanceKey: string
  sourceTypeId: string
  role: string
  availability: MemorySourceAvailability
  revision: string
  capabilities: MemoryCapability[]
  routeIds: string[]
  actionIds: string[]
  /** Coarse, non-sensitive hints only; never raw Authority data or credentials. */
  hints?: MemoryJsonValue
}

/** Core derives this from Manifest + live Facts + Host permissions. Sources do not author it twice. */
export interface MemoryAvailableSource extends MemorySourceFacts {
  projection?: MemoryOperationSemantics
  routes: MemorySourceRouteManifest[]
  actions: MemorySourceActionManifest[]
}

export interface MemoryViewBudget {
  maxProjectionCharacters: number
  maxRoutes: number
  maxActions: number
  maxEvidenceResults: number
  maxEvidenceCharacters: number
}

export const DEFAULT_MEMORY_VIEW_BUDGET: Readonly<MemoryViewBudget> = Object.freeze({
  maxProjectionCharacters: 64 * 1024,
  maxRoutes: 16,
  maxActions: 16,
  maxEvidenceResults: 16,
  maxEvidenceCharacters: 16 * 1024,
})

export interface MemoryViewRequest {
  scope: MemoryOperationScope
  scenario: string
  budget: MemoryViewBudget
}

export interface MemoryViewSourceSpec {
  sourceInstanceKey: string
  /** Defaults to true. An explicitly optional Source may be omitted on read failure. */
  required?: boolean
  projection?: MemoryOperationSelection & {
    mode: MemorySourceMode
    maxCharacters?: number
  }
  /** Source-local route ids declared by its manifest/facts. */
  routeIds?: string[]
  /** Source-local action ids declared by its manifest/facts. */
  actionIds?: string[]
  /** Options may only narrow operations selected above. Keys are Source-local ids. */
  routeOptions?: Record<string, MemoryOperationSelection>
  actionOptions?: Record<string, MemoryOperationSelection>
}

/** Pure Strategy output. Runtime treats it as a proposal, never as authority. */
export interface MemoryViewSpec {
  strategyTypeId: string
  sources: MemoryViewSourceSpec[]
  explanation: string
}

export interface MemoryProjectionRequest {
  scope: MemoryOperationScope
  sourceInstanceKey: string
  /** Facts revision selected by the Strategy; the Source owns its snapshot consistency. */
  expectedRevision: string
  includeProjection: boolean
  mode: MemorySourceMode
  maxCharacters: number
  representation?: MemoryResultSemantics['representation']
  budgets?: MemoryResolvedBudget[]
}

export interface MemoryViewFragment {
  id: string
  sourceInstanceKey: string
  mode: MemorySourceMode
  text: string
  revision: string
  provenance?: MemoryJsonValue
  result?: MemoryResultSemantics
}

export interface MemoryReadGrant {
  id: string
  sourceInstanceKey: string
  schema: string
  value: MemoryJsonValue
  revision: string
  consistency: MemoryViewConsistencyMode
}

export interface MemoryViewContribution {
  fragments: MemoryViewFragment[]
  readGrant?: MemoryReadGrant
  usage?: MemoryBudgetUsage[]
}

export interface MemoryViewRoute {
  id: string
  sourceInstanceKey: string
  sourceRouteId: string
  description: string
  capability: MemoryCapability
  inputSchema: MemoryJsonValue
  readGrantId: string
  maxCalls: number
  maxResults?: number
  maxCharacters?: number
  semantics?: MemoryOperationSemantics
  representation?: MemoryResultSemantics['representation']
  budgets?: MemoryResolvedBudget[]
}

export interface MemoryActionOffer {
  id: string
  sourceInstanceKey: string
  sourceActionId: string
  description: string
  capability: MemoryCapability
  inputSchema: MemoryJsonValue
  authority?: string
  semantics?: MemoryOperationSemantics
  representation?: MemoryResultSemantics['representation']
  budgets?: MemoryResolvedBudget[]
}

export interface MemoryViewConsistency {
  mode: 'mixed' | MemoryViewConsistencyMode
  sourceRevisions: Record<string, string>
}

/** Complete Host-side safety envelope. Read grants are never model-rendered. */
export interface ComposableMemoryView {
  id: string
  digest: string
  runtimeGeneration: string
  strategyInstanceKey: string
  strategyTypeId: string
  createdAt: string
  scope: MemoryOperationScope
  projection: MemoryViewFragment[]
  projectionUsage?: Record<string, MemoryBudgetUsage[]>
  routes: MemoryViewRoute[]
  readGrants: MemoryReadGrant[]
  actionOffers: MemoryActionOffer[]
  consistency: MemoryViewConsistency
  explanation: string
  /** Sanitized, turn-local availability failures; never raw provider errors. */
  diagnostics?: MemoryCompositionDiagnostic[]
}

export interface MemoryEvidenceItem {
  id: string
  text: string
  provenance: MemoryJsonValue
  score?: number
  revision?: string
  result?: MemoryResultSemantics
}

export interface MemoryEvidence {
  id: string
  viewId: string
  routeId: string
  sourceInstanceKey: string
  observedAt: string
  items: MemoryEvidenceItem[]
  truncated: boolean
  unavailable?: string
  usage?: MemoryBudgetUsage[]
}

export interface MemoryMutationReceipt {
  id: string
  viewId: string
  offerId: string
  sourceInstanceKey: string
  status: MemoryReceiptStatus
  completion: MemoryMutationCompletion
  /** Only present for an explicitly confirmed full commit; Core never supplies it. */
  committedAt?: string
  revision?: string
  details?: MemoryJsonValue
  usage?: MemoryBudgetUsage[]
}

export interface MemorySourceRuntimeContext {
  sourceInstanceKey: string
  provenance: MemoryPackageProvenance
  /** Immutable, JSON-only Host/scope defaults; never business objects or clients. */
  configuration?: Readonly<Record<string, MemoryJsonValue>>
}

/** Operation identity only; never the complete View or another Source's data. */
export interface MemorySourceViewContext {
  id: string
  scope: MemoryOperationScope
}

export interface MemorySourceRuntime {
  /** Lightweight metadata. Honor cancellation; do not perform writes here. */
  facts(request: MemoryViewRequest, signal?: AbortSignal): MemorySourceFacts | Promise<MemorySourceFacts>
  project(request: MemoryProjectionRequest, signal?: AbortSignal): MemoryViewContribution | Promise<MemoryViewContribution>
  manage?(request: MemorySourceManagementRequest): MemorySourceManagementResult | Promise<MemorySourceManagementResult>
  query?(request: {
    view: MemorySourceViewContext
    route: MemoryViewRoute
    grant: MemoryReadGrant
    input: MemoryJsonValue
    signal?: AbortSignal
  }): MemoryEvidence | Promise<MemoryEvidence>
  mutate?(request: {
    view: MemorySourceViewContext
    offer: MemoryActionOffer
    /** This Source's own pinned read scope, when it contributed one. Not write authorization. */
    grant?: MemoryReadGrant
    input: MemoryJsonValue
    signal?: AbortSignal
  }): MemoryMutationReceipt | Promise<MemoryMutationReceipt>
  dispose?(): void | Promise<void>
}

export interface MemorySourceDefinition {
  manifest: MemorySourceManifest
  create(context: MemorySourceRuntimeContext): MemorySourceRuntime
}

export interface MemoryStrategyDefinition {
  manifest: MemoryStrategyManifest
  compose(request: MemoryViewRequest, sources: readonly MemoryAvailableSource[]): MemoryViewSpec
}

export interface MemoryCompositionDiagnostic {
  code: string
  message: string
  contributionInstanceKey?: string
}

export interface MemoryCompositionEvaluationReport {
  state: 'ready' | 'incomplete' | 'rejected'
  contributionRevision: number
  generationId?: string
  strategyInstanceKey?: string
  sourceInstanceKeys: string[]
  diagnostics: MemoryCompositionDiagnostic[]
}
