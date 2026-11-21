import type {
  MemoryCapability,
  MemoryJsonValue,
  MemoryOperationScope,
  MemoryReceiptStatus,
  MemorySourceMode,
} from './index.ts'

export const COMPOSABLE_MEMORY_API_VERSION = 'dsh-mnemon/v1' as const

export type MemoryMutationCompletion = 'accepted' | 'candidate' | 'committed' | 'partial' | 'failed' | 'unknown'

export type MemoryContributionKind = 'source' | 'strategy' | 'strategy-extension'
export type MemorySourceAvailability = 'ready' | 'degraded' | 'unavailable'
export type MemoryViewConsistencyMode = 'exact-snapshot' | 'namespace-pinned-live-read'

export interface MemoryPackageProvenance {
  packageName: string
  entryId: string
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

export interface MemoryManagementDescriptor {
  label: string
  description: string
  fields?: MemoryManagementField[]
  diagnostics?: string[]
}

export type MemorySourceManagementMode = 'read' | 'mutate'

export interface MemorySourceManagementRequest {
  scope: MemoryOperationScope
  sourceInstanceKey: string
  mode: MemorySourceManagementMode
  operation: string
  input: MemoryJsonValue
  expectedRevision?: string
  confirmed: boolean
  signal?: AbortSignal
}

export interface MemorySourceManagementResult {
  revision: string
  value: MemoryJsonValue
}

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
  id: string
  description: string
  capability: MemoryCapability
  inputSchema: MemoryJsonValue
  maxCalls: number
  maxResults?: number
  maxCharacters?: number
}

export interface MemorySourceActionManifest {
  id: string
  description: string
  capability: MemoryCapability
  inputSchema: MemoryJsonValue
  authority?: string
}

export interface MemorySourceManifest {
  apiVersion: typeof COMPOSABLE_MEMORY_API_VERSION
  kind: 'source'
  typeId: string
  packageName: string
  role: string
  capabilities: MemoryCapability[]
  consistency: MemoryViewConsistencyMode
  routes?: MemorySourceRouteManifest[]
  actions?: MemorySourceActionManifest[]
  management?: MemoryManagementDescriptor
}

export const MEMORY_STRATEGY_WORKFLOWS = ['idle-review', 'runtime-capacity'] as const
export type MemoryStrategyWorkflow = typeof MEMORY_STRATEGY_WORKFLOWS[number]

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
  extensionSlots?: string[]
  workflows?: MemoryStrategyWorkflow[]
}

export const ANY_MEMORY_STRATEGY = '*' as const

export const ANY_MEMORY_SOURCE_ROLE = '*' as const

export const MEMORY_VIEW_EXTENSION_SLOTS = ['selection', 'projection', 'capture'] as const
export type MemoryViewExtensionSlot = typeof MEMORY_VIEW_EXTENSION_SLOTS[number]

export interface MemoryViewExtensionValues {
  selection: { sourceKeys: string[]; writableSourceKeys?: string[] }
  projection: { maxProjectionCharacters: number }
  capture: { instruction: string; actionIds: string[]; sourceKeys?: string[] }
}

export interface MemoryStrategyExtensionManifest {
  apiVersion: typeof COMPOSABLE_MEMORY_API_VERSION
  kind: 'strategy-extension'
  typeId: string
  packageName: string
  strategyTypeId: string
  slot: string
  deterministic: true
}

export interface MemoryStrategyExtensionDefinition {
  manifest: MemoryStrategyExtensionManifest
  contribute(request: MemoryViewRequest, sources: readonly MemoryAvailableSource[]): MemoryJsonValue
}

export interface MemoryStrategyContribution {
  instanceKey: string
  typeId: string
  slot: string
  value: MemoryJsonValue
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
  hints?: MemoryJsonValue
}

export interface MemoryViewBudget {
  maxProjectionCharacters: number
  maxRoutes: number
  maxActions: number
  maxEvidenceResults: number
  maxEvidenceCharacters: number
}

export interface MemoryAvailableSource extends MemorySourceFacts {
  routes: MemorySourceRouteManifest[]
  actions: MemorySourceActionManifest[]
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
  required?: boolean
  projection?: {
    mode: MemorySourceMode
    maxCharacters: number
  }
  routeIds?: string[]
  actionIds?: string[]
}

export interface MemoryViewSpec {
  strategyTypeId: string
  sources: MemoryViewSourceSpec[]
  explanation: string
  guidance?: MemoryViewGuidance
  diagnostics?: MemoryCompositionDiagnostic[]
}

export interface MemoryViewGuidance {
  system?: string
  routing?: string
  reminders?: { read?: string; write?: string; both?: string }
}

export interface MemoryProjectionRequest {
  scope: MemoryOperationScope
  sourceInstanceKey: string
  expectedRevision: string
  includeProjection: boolean
  mode: MemorySourceMode
  maxCharacters: number
}

export interface MemoryViewFragment {
  id: string
  sourceInstanceKey: string
  mode: MemorySourceMode
  text: string
  revision: string
  provenance?: MemoryJsonValue
}

export interface MemorySourcePresentationItem {
  id: string
  title: string
  excerpt?: string
}

export interface MemorySourcePresentation {
  visibleItems: number
  totalItems?: number
  items?: MemorySourcePresentationItem[]
}

export interface MemoryViewSourcePresentation extends MemorySourcePresentation {
  sourceInstanceKey: string
  mode: MemorySourceMode
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
  presentation?: MemorySourcePresentation
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
}

export interface MemoryActionOffer {
  id: string
  sourceInstanceKey: string
  sourceActionId: string
  description: string
  capability: MemoryCapability
  inputSchema: MemoryJsonValue
  authority?: string
}

export interface MemoryViewConsistency {
  mode: 'mixed' | MemoryViewConsistencyMode
  sourceRevisions: Record<string, string>
}

export interface ComposableMemoryView {
  id: string
  digest: string
  runtimeGeneration: string
  strategyInstanceKey: string
  strategyTypeId: string
  strategyExtensions?: Array<{ instanceKey: string; typeId: string; slot: string; digest: string }>
  createdAt: string
  scope: MemoryOperationScope
  projection: MemoryViewFragment[]
  sourcePresentations?: MemoryViewSourcePresentation[]
  routes: MemoryViewRoute[]
  readGrants: MemoryReadGrant[]
  actionOffers: MemoryActionOffer[]
  consistency: MemoryViewConsistency
  explanation: string
  guidance?: MemoryViewGuidance
  diagnostics?: MemoryCompositionDiagnostic[]
}

export interface MemoryEvidenceItem {
  id: string
  text: string
  provenance: MemoryJsonValue
  score?: number
  revision?: string
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
  metadata?: MemoryJsonValue
  output?: MemoryJsonValue
}

export interface MemoryMutationReceipt {
  id: string
  viewId: string
  offerId: string
  sourceInstanceKey: string
  status: MemoryReceiptStatus
  completion: MemoryMutationCompletion
  committedAt?: string
  revision?: string
  details?: MemoryJsonValue
}

export interface MemorySourceRuntimeContext {
  sourceInstanceKey: string
  provenance: MemoryPackageProvenance
  configuration?: Readonly<Record<string, MemoryJsonValue>>
}

export interface MemorySourceViewContext {
  id: string
  scope: MemoryOperationScope
}

export interface MemorySourceRuntime {
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
  compose(request: MemoryViewRequest, sources: readonly MemoryAvailableSource[], contributions?: readonly MemoryStrategyContribution[]): MemoryViewSpec
  createTurn?(view: ComposableMemoryView): MemoryStrategyTurn
}

export interface MemoryStrategyReadRequest {
  route: MemoryViewRoute
  input: MemoryJsonValue
  signal?: AbortSignal
}

export interface MemoryStrategyTurn {
  query(request: MemoryStrategyReadRequest, read: MemoryStrategyRead): Promise<MemoryEvidence>
}

export type MemoryStrategyRead = (input: MemoryJsonValue, limits?: Partial<Pick<MemoryViewRoute, 'maxResults' | 'maxCharacters'>>) => Promise<MemoryEvidence>

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
  strategyExtensionInstanceKeys?: string[]
  sourceInstanceKeys: string[]
  diagnostics: MemoryCompositionDiagnostic[]
}
