/** JSON values are the only values allowed to cross a Mnemon plugin boundary. */
export type MemoryJsonPrimitive = string | number | boolean | null
export type MemoryJsonValue = MemoryJsonPrimitive | MemoryJsonValue[] | { [key: string]: MemoryJsonValue }

export const BUILTIN_MEMORY_LAYER_IDS = ['runtime', 'documents', 'memory-spaces'] as const
export type BuiltinMemoryLayerId = typeof BUILTIN_MEMORY_LAYER_IDS[number]
export type MemoryLayerId = string

export const MEMORY_CAPABILITIES = [
  'status',
  'project',
  'recall',
  'search',
  'read',
  'browse',
  'write',
  'archive',
  'graph',
  'related',
  'link',
  'forget',
  'maintain',
  'export',
  'import',
] as const
export type MemoryCapability = typeof MEMORY_CAPABILITIES[number]

export const MEMORY_STRATEGY_HOOKS = [
  'admission',
  'placement',
  'retrieval-planning',
  'quality-fusion',
  'projection',
  'promotion-demotion',
  'retention',
  'maintenance',
] as const
export type MemoryStrategyHook = typeof MEMORY_STRATEGY_HOOKS[number]

export type MemoryParticipationMode = 'off' | 'manual' | 'automatic'
export type MemoryParticipationChannel = 'recall' | 'write' | 'projection' | 'maintenance'

export interface MemoryLayerParticipation {
  recall: MemoryParticipationMode
  write: MemoryParticipationMode
  projection: MemoryParticipationMode
  maintenance: MemoryParticipationMode
}

export interface MemoryLayerDescriptor {
  id: MemoryLayerId
  label: string
  description: string
  /** Stable semantic role. Several implementations may eventually satisfy one role. */
  role: string
  order: number
  capabilities: MemoryCapability[]
}

export type MemoryAdapterLocality = 'local' | 'remote' | 'hybrid'
export type MemoryAdapterScope = 'global' | 'workspace' | 'custom' | 'provider-owned'

export interface MemoryAdapterDescriptor {
  id: string
  label: string
  description: string
  locality: MemoryAdapterLocality
  scopes: MemoryAdapterScope[]
  capabilities: MemoryCapability[]
  configNamespace?: string
}

export interface MemoryStrategyDescriptor {
  id: string
  version: string
  label: string
  description: string
  hooks: MemoryStrategyHook[]
  deterministic: boolean
}

export interface MemoryCatalogSnapshot {
  generation: number
  layers: MemoryLayerDescriptor[]
  adapters: MemoryAdapterDescriptor[]
  strategies: MemoryStrategyDescriptor[]
}

export interface MemoryTopologyLayer {
  id: MemoryLayerId
  enabled: boolean
  participation: MemoryLayerParticipation
  adapterIds: string[]
}

export interface MemoryTopologyDefinition {
  id: string
  strategyId: string
  layers: MemoryTopologyLayer[]
}

export interface MemoryTopologySnapshot extends MemoryTopologyDefinition {
  generation: number
  catalogGeneration: number
  createdAt: string
}

export type MemoryOperationTrigger = 'manual' | 'automatic' | 'system'

export interface MemoryOperationScope {
  storage: 'global' | 'workspace' | 'custom'
  workspaceId?: string
  sessionId?: string
  agentId?: string
}

export interface MemoryOperationBudget {
  maxSteps?: number
  maxResults?: number
  maxTokens?: number
  timeoutMs?: number
}

export interface MemoryPlanRequest {
  operation: string
  capability: MemoryCapability
  trigger: MemoryOperationTrigger
  scope: MemoryOperationScope
  candidateLayerIds?: MemoryLayerId[]
  adapterIds?: string[]
  budget?: MemoryOperationBudget
  input?: MemoryJsonValue
}

export interface MemoryPlanStepProposal {
  layerId: MemoryLayerId
  capability: MemoryCapability
  adapterId?: string
  input?: MemoryJsonValue
}

export interface MemoryPlanProposal {
  strategyId: string
  strategyVersion: string
  reason: string
  steps: MemoryPlanStepProposal[]
}

export interface MemoryPlanStep extends MemoryPlanStepProposal {
  id: string
  participation: MemoryParticipationChannel
}

export interface MemoryPlan {
  id: string
  topologyId: string
  topologyGeneration: number
  catalogGeneration: number
  guardGeneration: number
  strategyId: string
  strategyVersion: string
  operation: string
  capability: MemoryCapability
  trigger: MemoryOperationTrigger
  scope: MemoryOperationScope
  /** Canonical JSON request approved by Guards and proposed against by the Strategy. */
  request: MemoryPlanRequest
  /** SHA-256 of the canonical request, used to bind execution to that exact request. */
  requestDigest: string
  reason: string
  createdAt: string
  budget: MemoryOperationBudget
  steps: MemoryPlanStep[]
}

export type MemoryGuardDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }

export type MemoryReceiptStatus = 'succeeded' | 'partial' | 'failed' | 'cancelled'
export type MemoryReceiptStepStatus = 'succeeded' | 'failed' | 'cancelled'

export interface MemoryReceiptStep {
  stepId: string
  layerId: MemoryLayerId
  adapterId?: string
  status: MemoryReceiptStepStatus
  startedAt: string
  finishedAt: string
  output?: MemoryJsonValue
  error?: string
}

export interface MemoryReceipt {
  id: string
  planId: string
  topologyId: string
  topologyGeneration: number
  catalogGeneration: number
  guardGeneration: number
  strategyId: string
  strategyVersion: string
  operation: string
  capability: MemoryCapability
  status: MemoryReceiptStatus
  startedAt: string
  finishedAt: string
  steps: MemoryReceiptStep[]
}

export interface MemoryMigrationLineageEndpoint {
  layerId: MemoryLayerId
  reference: string
  digest: string
}

/** Auditable proof that one exact source item reached one committed destination. */
export interface MemoryMigrationLineage {
  source: MemoryMigrationLineageEndpoint
  destination: MemoryMigrationLineageEndpoint
}

export interface MemorySystemDescriptor {
  catalog: MemoryCatalogSnapshot
  topology: MemoryTopologySnapshot
}

export const MEMORY_SOURCE_MODES = ['eager', 'routed'] as const
export type MemorySourceMode = typeof MEMORY_SOURCE_MODES[number]

export interface MemoryTurnViewSource {
  layerId: MemoryLayerId
  revision: string
  mode: MemorySourceMode
  digest: string
  /** Exact eager content or one compact routed cover; never a child catalog. */
  wake: string
}

/** Immutable Source-generation snapshot pinned by one or more user turns. */
export interface MemoryTurnView {
  id: string
  createdAt: string
  topologyId: string
  catalogGeneration: number
  topologyGeneration: number
  guardGeneration: number
  sources: MemoryTurnViewSource[]
  digest: string
}

/** Compatibility name for the v0.3 pre-release API. */
export type MemoryView = MemoryTurnView

/** Compatibility name for the v0.3 pre-release API. */
export type MemoryViewSource = MemoryTurnViewSource

export interface MemoryWakeSection {
  layerId: MemoryLayerId
  mode: MemorySourceMode
  text: string
}

export interface MemoryWake {
  viewId: string
  viewDigest: string
  text: string
  sections: MemoryWakeSection[]
}

export interface MemoryTurnContext {
  turnId: string
  viewId: string
  viewDigest: string
  scope: MemoryOperationScope
  startedAt: string
}

export * from './composable.ts'
