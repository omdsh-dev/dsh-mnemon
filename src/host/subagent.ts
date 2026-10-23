import { randomUUID } from 'node:crypto'
import type { HostAgent, HostSubagentResult, HostSubagentRun, HostSubagentsService, ToolDefinition, ToolExecution } from "./dsh.ts"
import type { DocumentMutation, DocumentSearchResult, DocumentSnapshot, DocumentView } from 'dsh-mnemon-source-documents/contracts'
import type { RuntimeMemoryMutation, RuntimeMemoryMutationResult, RuntimeMemorySnapshot } from 'dsh-mnemon-source-runtime/contracts'
import type { EdgeType, Insight, MemorySpaceCatalog, MemorySpaceMetadataSample, PreparedMemoryPlacement, RememberRequest, SearchRequest } from 'dsh-mnemon-source-memory-spaces/contracts'
import { mutationResultCommitted } from './receipts.ts'
import { SourceSession } from './source-session.ts'
import { runtimeCapacityWrite, strategyDrives, viewStrategy } from './strategy-workflows.ts'
import { receipt as mutationReceipt } from '../sdk/input.ts'
import { allowsParticipation, assertParticipation } from './access.ts'
import { namedToolInstance, type CoordinatedDocumentResult, type CoordinatedRuntimeMemoryResult, type DelegatedAnswerResult, type DelegatedWriteResult, type MemorySpaceMetadataMaintenanceResult, type MemorySpaceMetadataUpdate, type MemoryPlacementDecision, type MnemonReconcileOptions, type MnemonReconcileResult, type SubagentCounters } from './protocol.ts'
import { emptyDocumentSnapshot, foreignMachines, parseReconcileResult, pendingOpinions, RECONCILE_PERSONA, RECONCILE_SCHEMA, reconcilePrompt, type MnemonReconcileEvidence } from './reconcile.ts'
import { DEFAULT_MEMORY_VIEW_BUDGET, type ComposableMemoryView, type MemoryEvidence, type MemoryJsonValue, type MemoryMutationReceipt, type MemoryOperationScope, type MemorySourceManagementRequest, type MemorySourceManagementResult } from '../core/contracts/index.ts'
import { agentScope, type MnemonAgentRuntimeSource, type MnemonRuntimeGraph } from './runtime.ts'
import type { ComposableMemoryTurn } from '../core/turns.ts'
import { idleReviewBlockReason, reviewLayerPolicy, startGuardedChild, startGuardedReview, type ReviewToolHost } from './review-tools.ts'
import { reviewCheckpoint } from './review-checkpoint.ts'
import { startWithContinuationTurns } from './continuation-turn.ts'
import { childComposition, startSubagent, type SubagentStartAgents } from './subagent-start.ts'
import type { IdleReviewFailure, MemoryToolName } from './protocol.ts'
import { assertDshOutputSchema, assertDshOutputValue } from './subagent-output-schema.ts'
import { ANSWER_PERSONA, ANSWER_SCHEMA, AUTONOMOUS_WRITE_PERSONA, indentedText, METADATA_MAINTENANCE_PERSONA, METADATA_MAINTENANCE_SCHEMA, metadataSampleText, naturalEvidence, naturalRequest, PROVIDER_PLACEMENT_PERSONA, providerPlacementSchema, REQUEST_LABELS, reviewPersona, SUPERVISED_WRITE_PERSONA, TARGETED_WRITE_LABELS, WRITE_PERSONA, WRITE_SCHEMA } from './subagent-prompts.ts'
import { isTool, object, optionalObject, recoverStructuredResult, reviewReceipt, strings, subagentFailureDetail, type CapturedSubagentResult, type CapturedToolReceipt, type ToolReceiptRecovery } from './subagent-receipts.ts'
import { archivableElsewhere } from './archive-destinations.ts'
import { runtimeArchiveSource, runtimeLocked, type RuntimeModelResult, type RuntimeWriteContext } from './runtime-capacity.ts'
import { archiveDocumentLocked, documentLocked, type DocumentWorkflowHost } from './document-archive.ts'

export type { CoordinatedDocumentResult, CoordinatedRuntimeMemoryResult, DelegatedAnswerResult, DelegatedWriteResult, SubagentCounters } from "./protocol.ts"
export { assertDshOutputSchema } from './subagent-output-schema.ts'

type AgentRuntimeSource = MnemonAgentRuntimeSource

export type RuntimeMaintenanceTaskRunner = (scope: MemoryOperationScope, signal: AbortSignal, operation: (agent: HostAgent) => Promise<RuntimeModelResult>) => Promise<RuntimeModelResult>

type RecallInsight = Insight & { revision?: string }

function evidenceInsights(evidence: MemoryEvidence): RecallInsight[] {
  return evidence.items.map(item => {
    const metadata = optionalObject(item.provenance) ?? {}
    return { ...metadata, id: item.id, content: item.text,
      ...(item.score === undefined ? {} : { score: item.score }),
      ...(item.revision === undefined ? {} : { revision: item.revision }),
    } as RecallInsight
  })
}

/**
 * Every task dsh-mnemon delegates to a child Agent starts with one line of its own, such as
 * `[dsh-mnemon:delegated review]` (#393). DSH records the task as the child's prompt from a
 * person, so a plugin that reads sessions, such as one that collects a workspace's work, can
 * rely on this line, documented as stable, to leave Mnemon's own children out.
 */
export const DELEGATED_TASK_PREFIX = '[dsh-mnemon:delegated '
/** Every kind of task dsh-mnemon delegates, as its line names it. */
export const DELEGATED_OPERATIONS = ['write', 'answer', 'review', 'placement', 'migration', 'compaction', 'document-archive', 'metadata-maintenance', 'reconcile', 'skill'] as const
export type DelegatedOperation = typeof DELEGATED_OPERATIONS[number]
/** The line as the reference documents it for readers of DSH sessions. */
export const DELEGATED_TASK_LINE = /^\[dsh-mnemon:delegated [a-z-]+\]$/u
export function delegatedTaskLine(operation: DelegatedOperation): string {
  return `${DELEGATED_TASK_PREFIX}${operation}]`
}

// Which memory tools each delegated child may call; every name is a row of the tool table.
const READ_TOOLS: MemoryToolName[] = ['mnemon_memory_bodies', 'mnemon_recall', 'mnemon_related']
const WRITE_TOOLS: MemoryToolName[] = [
  ...READ_TOOLS,
  'mnemon_remember',
  'mnemon_link',
  'mnemon_forget',
  'mnemon_memory_body_create',
  'mnemon_memory_body_update',
  'mnemon_memory_body_merge',
]
// Distillation is an autonomous run: the model decides what to keep, so it
// must never be able to delete existing entries (issue #148). Explicit user
// instructions such as /mnemon forget keep a dedicated worker that still owns
// the forget tool.
const AUTONOMOUS_WRITE_TOOLS = WRITE_TOOLS.filter(tool => tool !== 'mnemon_forget')
const EXPLICIT_WRITE_TOOLS = WRITE_TOOLS
const DOCUMENT_READ_TOOLS: MemoryToolName[] = ['mnemon_document_search']
const REVIEW_TOOLS: MemoryToolName[] = [...DOCUMENT_READ_TOOLS, 'mnemon_runtime_memory', 'mnemon_document_create']
const RESULT_TOOL_NAME = 'mnemon_subagent_result'
/** How many finished delegated children stay refused memory tools if DSH resumes one. */
const FINISHED_CHILDREN = 1_000
const FINISHED_CHILD_REFUSAL = 'This Mnemon task has finished, so it no longer reads or changes memory. Reply without memory tools.'
const RESULT_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    requestId: { type: 'string', minLength: 1 },
    result: { type: 'object', additionalProperties: true },
  },
  required: ['requestId', 'result'],
  additionalProperties: false,
} as const
const RESULT_TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { recorded: { type: 'boolean', const: true } },
  required: ['recorded'],
  additionalProperties: false,
} as const
const WRITE_OPERATION_RESULT_TOOL: Readonly<Record<string, MemoryToolName>> = {
  remember: 'mnemon_remember',
  'supervised-writeback': 'mnemon_remember',
  link: 'mnemon_link',
  forget: 'mnemon_forget',
  'create-memory-body': 'mnemon_memory_body_create',
  'update-memory-body': 'mnemon_memory_body_update',
  'merge-memory-bodies': 'mnemon_memory_body_merge',
}

interface HostToolRegistry {
  register(definition: ToolDefinition): unknown
}

interface HostResultToolRuntime extends ReviewToolHost {
  tools: HostToolRegistry
  agents?: SubagentStartAgents
  on(name: string, listener: (...args: never[]) => unknown): unknown
}

export class IdleReviewError extends Error {
  constructor(message: string, readonly review: IdleReviewFailure, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IdleReviewError'
  }
}

interface HostToolResultObservation {
  isError?: boolean
  value?: unknown
}

interface RecallAuthority {
  context: ComposableMemoryTurn
  viewId: string
  memoryBodyIds: string[]
  source: SourceSession
}

export interface RecallResult {
  query: string
  mode: string
  results: RecallInsight[]
  /** The Strategy ran no query for this call, so `results` holds nothing of its own. */
  notRun?: true
  /** It did not run because the turn's budget for this read was spent. */
  budgetExhausted?: true
  /** Core read identity/usage; truncated also includes the Host's final admission limits. */
  memoryEvidence?: Omit<MemoryEvidence, 'items'>
  hint?: string
}

/** What a memory saved without a vector means for recall, and how its vector comes. */
const UNEMBEDDED_HINT = 'Saved without a vector, because embedding did not succeed: semantic matching misses it until its vector is filled in, while keyword, link and recency recall still reach it. Once the embedding service answers, the user fills it in from Test status in the Mnemon Native embedding settings, which runs through the storage root and embedding settings DSH uses; a terminal mnemon command may reach neither.'

/** The memories a write saved without a vector: Mnemon Native says so with `embedded: false` (#388). */
function withoutVector(receipts: readonly CapturedToolReceipt[]): Array<{ memoryBodyId?: string; id?: string }> {
  return receipts.filter(receipt => isTool(receipt.name, 'mnemon_remember')).flatMap(receipt => {
    const value = optionalObject(receipt.value)
    if (value?.embedded !== false) return []
    return [{ ...(typeof value.memoryBodyId === 'string' ? { memoryBodyId: value.memoryBodyId } : {}), ...(typeof value.id === 'string' ? { id: value.id } : {}) }]
  })
}

/** A Memory Space write tool: each switches on the space it goes to. */
const SPACE_WRITE_TOOLS: ReadonlySet<string> = new Set<MemoryToolName>(['mnemon_remember', 'mnemon_link'])

/**
 * Holds a delegated write to the Memory Space its caller named, and keeps a writer
 * from switching a space back on: a write or a link switches on the space it goes to,
 * so a space that was inactive when the run started takes one only when the caller
 * named it (#387). A space the writer creates is not in `inactive` and takes its first
 * write. Saving a memory never merges spaces: a merge switches spaces on and off, and
 * is a request of its own.
 */
export function spaceWriteGuard(target: string | undefined, inactive: ReadonlySet<string>, readOnly: ReadonlySet<string> = new Set()): (execution: ToolExecution) => string | undefined {
  return execution => {
    if (isTool(execution.name, 'mnemon_memory_body_merge')) {
      return 'Saving a memory never merges Memory Spaces; a merge is a request of its own. Write the memory, or finish without writing.'
    }
    const input = optionalObject(execution.arguments) ?? {}
    const space = typeof input.memoryBodyId === 'string' ? input.memoryBodyId.trim() : undefined
    // A read-only space is recalled and takes no writes (#434); the Source refuses them too.
    if (space !== undefined && readOnly.has(space) && execution.name !== undefined && SPACE_WRITE_TOOLS.has(execution.name)) {
      return `Memory Space ${JSON.stringify(space)} is read only: it is recalled and takes no writes. Write to a writable space, or finish without writing and say why none fits.`
    }
    if (target !== undefined) {
      if (execution.name !== undefined && SPACE_WRITE_TOOLS.has(execution.name) && space !== target) {
        return `This write was requested for Memory Space ${JSON.stringify(target)}. Call ${execution.name} with memoryBodyId ${JSON.stringify(target)}, or finish without writing and say why it does not fit.`
      }
      if (isTool(execution.name, 'mnemon_memory_body_create', 'mnemon_memory_body_update')) {
        return `This write was requested for Memory Space ${JSON.stringify(target)}, so it creates or changes no space. Write there, or finish without writing and say why it does not fit.`
      }
      return undefined
    }
    if (space === undefined || !inactive.has(space)) return undefined
    if (execution.name !== undefined && SPACE_WRITE_TOOLS.has(execution.name)) {
      return `Memory Space ${JSON.stringify(space)} is switched off, and a write would switch it on. Write to an active space, or finish without writing and say which space would fit.`
    }
    if (isTool(execution.name, 'mnemon_memory_body_update') && input.active === true) return `Memory Space ${JSON.stringify(space)} is switched off; only the user switches it on.`
    return undefined
  }
}

/**
 * Why a write cannot go to the Memory Space its caller named, before a writer runs (#387):
 * the space is unknown, its Provider is off or takes no writes, or it is switched off and
 * the caller did not ask to switch it on. A model names a space by its description, the
 * judgement that misplaced memories before; switching a space back on is its own request.
 */
function targetProblem(spaces: MemorySpaceCatalog['items'], target: string, activate: boolean): string | undefined {
  const body = spaces.find(candidate => candidate.id === target)
  if (body === undefined) {
    const known = spaces.slice(0, 20).map(candidate => `${JSON.stringify(candidate.id)} (${candidate.name}${candidate.active ? '' : ', switched off'})`).join(', ')
    return `Memory Space ${JSON.stringify(target)} does not exist. Name one by its id${known === '' ? '; there is none yet.' : `: ${known}.`}`
  }
  if (body.providerEnabled === false) return `Memory Space ${JSON.stringify(target)} uses ${body.provider.label}, which is turned off on the dsh-mnemon page under Plugins. Name another space.`
  if (body.writePolicy === 'read-only') return `Memory Space ${JSON.stringify(target)} (${body.name}) is read only: it is recalled and takes no writes. Name a writable space.`
  if (body.provider.capabilities.remember !== true) return `Memory Space ${JSON.stringify(target)} (${body.provider.label}) does not take writes. Name another space.`
  if (!body.active && !activate) {
    return `Memory Space ${JSON.stringify(target)} (${body.name}) is switched off, and a write would switch it back on. If the user wants it back, switch it on first with mnemon_memory_body_update (active: true); otherwise name an active space.`
  }
  return undefined
}

/** Whether a write receipt put the memory in its space, or handed it to a Provider that confirms later. */
function writeLanded(value: Record<string, unknown>): boolean {
  if (mutationResultCommitted(value)) return true
  const state = [value.action, value.status, value.state].find((entry): entry is string => typeof entry === 'string')?.trim().toLocaleLowerCase()
  return state === 'accepted' || state === 'queued' || state === 'pending' || state === 'processing'
}

export function isSubagent(agent: HostAgent | undefined): boolean {
  return agent?.session.header?.origin === 'subagent'
}

/** Delegates memory judgment and execution to a fresh, tool-scoped DSH child. */
export class MnemonSubagentCoordinator {
  private readonly counters: SubagentCounters = { recalls: 0, writes: 0, answers: 0, reviews: 0, placements: 0, migrations: 0, compactions: 0, documentArchives: 0, metadataMaintenances: 0, reconciliations: 0, skills: 0, failures: 0 }
  private runtimeQueue: Promise<unknown> = Promise.resolve()
  private documentQueue: Promise<unknown> = Promise.resolve()
  private readonly observedReads = new WeakMap<ComposableMemoryTurn, Set<string>>()
  private readonly resultRequests = new Map<string, (value: unknown, execution: ToolExecution) => Promise<unknown>>()
  private disposeResultTool: (() => unknown) | undefined
  private disposeResumeGuard: (() => unknown) | undefined
  /** Delegated children whose run has ended, newest last, at most FINISHED_CHILDREN. */
  private readonly finishedChildren = new Set<string>()
  private disposed = false

  constructor(
    private readonly subagents: HostSubagentsService,
    private readonly runtimeSource: AgentRuntimeSource,
    private readonly resultRuntime?: HostResultToolRuntime,
    private readonly taskAgentModelResolver?: () => { provider: string; model: string } | undefined,
    private readonly runtimeMaintenanceMaxTokensResolver?: () => number,
    private readonly runtimeMaintenanceTaskRunner?: RuntimeMaintenanceTaskRunner,
  ) {
    if (resultRuntime === undefined) return
    const registration = resultRuntime.tools.register({
      name: RESULT_TOOL_NAME,
      description: 'Record a Mnemon delegated result. The child must use its current requestId and result schema from its completion instructions.',
      parameters: RESULT_TOOL_INPUT_SCHEMA,
      output: {
        schema: RESULT_TOOL_OUTPUT_SCHEMA,
        render: () => [{ type: 'text', text: 'Mnemon subagent result recorded.' }],
      },
      execute: async (args: never, execution: ToolExecution) => {
        if (!isSubagent(execution.agent)) throw new Error('Mnemon subagent result tools are restricted to delegated children')
        execution.signal.throwIfAborted()
        assertDshOutputValue(RESULT_TOOL_INPUT_SCHEMA, args)
        const request = object(args)
        const submit = this.resultRequests.get(String(request.requestId))
        if (this.disposed || submit === undefined) throw new Error('Mnemon subagent result request is unknown or no longer active')
        return submit(request.result, execution)
      },
    })
    if (typeof registration !== 'function') throw new Error('dsh-mnemon subagent result tool registration did not return a disposer')
    this.disposeResultTool = registration as () => unknown
  }

  dispose(): unknown {
    this.disposed = true
    this.resultRequests.clear()
    const resumeGuard = this.disposeResumeGuard
    this.disposeResumeGuard = undefined
    resumeGuard?.()
    const dispose = this.disposeResultTool
    this.disposeResultTool = undefined
    return dispose?.()
  }

  snapshot(): SubagentCounters {
    return { ...this.counters }
  }

  /**
   * DSH 0.2.1 can resume a finished child from its saved state when another Agent sends it a
   * message: with its persona and tools, but without the guard its run held. A delegated child
   * never reads or changes memory once its run has ended (#387).
   */
  private finished(id: string): void {
    this.finishedChildren.delete(id)
    this.finishedChildren.add(id)
    if (this.finishedChildren.size > FINISHED_CHILDREN) this.finishedChildren.delete(this.finishedChildren.values().next().value!)
    if (this.disposeResumeGuard !== undefined || this.disposed || this.resultRuntime === undefined) return
    const resumed = this.resultRuntime.on('agent/created', (({ agent }: { agent: HostAgent }) => {
      if (!this.finishedChildren.has(agent.id)) return
      try {
        agent.ctx?.tools?.guard?.(execution => execution.name?.startsWith('mnemon_') === true ? FINISHED_CHILD_REFUSAL : undefined)
      } catch { /* Never fail another plugin's publication. */ }
    }) as never)
    if (typeof resumed === 'function') this.disposeResumeGuard = resumed as () => unknown
  }

  documentsSnapshot(parent: HostAgent) {
    return this.sourceFor(parent, 'documents').read<DocumentSnapshot>('snapshot')
  }

  documentGet(parent: HostAgent, id: string) {
    return this.sourceFor(parent, 'documents').read<DocumentView>('document', { id })
  }

  documentSearch(parent: HostAgent, query: string, includeArchived = false, limit?: number) {
    return this.sourceFor(parent, 'documents').read<DocumentSearchResult>('search', { query, includeArchived, ...(limit === undefined ? {} : { limit }) })
  }

  /** Both model aliases and generic Routes execute the selected Strategy, not Host-local quotas. */
  async documentQuery(parent: HostAgent, input: unknown, signal: AbortSignal): Promise<unknown> {
    const evidence = await this.readRoute(parent, 'documents', 'search', input, signal, true)
    return evidence.output ?? evidence
  }

  async recall(parent: HostAgent, request: SearchRequest, signal: AbortSignal, options: { requirePinnedView?: boolean } = {}): Promise<RecallResult> {
    const evidence = await this.readRoute(parent, 'memory-spaces', 'recall', request, signal, options.requirePinnedView === true)
    return (evidence.output ?? { query: request.query, mode: request.mode ?? 'smart', results: evidenceInsights(evidence),
      ...(evidence.unavailable === undefined ? {} : { unavailable: evidence.unavailable }) }) as unknown as RecallResult
  }

  private async readRoute(parent: HostAgent, typeId: string, routeId: string, input: unknown, signal: AbortSignal, required: boolean): Promise<MemoryEvidence> {
    signal.throwIfAborted()
    const graph = this.runtimeSource.forAgent(parent)
    if (required && graph.composableTurns.activeTurn(parent.id) === undefined) throw new Error('Recall requires the View pinned to the current turn')
    const execution = await this.runtimeSource.executions.workflow(parent, routeId, signal)
    try {
      const turn = execution.context
      const evidence = await execution.graph.source(typeId, turn.scope).forTurn(turn).route(routeId, input, execution.signal)
      // A read the Strategy did not run, past its turn budget or from an insight the turn never
      // admitted, is no recall (#389).
      if (typeId === 'memory-spaces' && ['recall', 'related'].includes(routeId) && optionalObject(evidence.output)?.notRun !== true) {
        const observed = this.observedReads.get(turn) ?? new Set<string>()
        if (!observed.has(evidence.id)) { this.recordRecall(); observed.add(evidence.id) }
        this.observedReads.set(turn, observed)
      }
      return evidence
    } catch (error) { this.counters.failures += 1; throw error }
    finally { execution.release() }
  }

  /** Bind a model read to the Source state pinned by its own executing turn. */
  scopeRecallRequest(agent: HostAgent, request: SearchRequest, requirePinnedView = false): SearchRequest {
    const authority = this.recallAuthority(agent, requirePinnedView)
    return this.scopeRecallWithAuthority(request, authority)
  }

  private scopeRecallWithAuthority(request: SearchRequest, authority: RecallAuthority | undefined): SearchRequest {
    if (authority === undefined) return request
    const requested = [...new Set((request.memoryBodyIds ?? []).map(id => id.trim()).filter(Boolean))]
    const outside = requested.filter(id => !authority.memoryBodyIds.includes(id))
    if (outside.length > 0) throw new Error(`Recall requested a Memory Space outside pinned Source ${authority.viewId}: ${outside.join(', ')}`)
    return { ...request, memoryBodyIds: requested.length === 0 ? [...authority.memoryBodyIds] : requested }
  }

  scopeRelatedMemorySpace(agent: HostAgent, memoryBodyId?: string, requirePinnedView = false): string | undefined {
    const authority = this.recallAuthority(agent, requirePinnedView)
    return this.scopeRelatedWithAuthority(memoryBodyId, authority)
  }

  private scopeRelatedWithAuthority(memoryBodyId: string | undefined, authority: RecallAuthority | undefined): string | undefined {
    if (authority === undefined) return memoryBodyId
    const requested = memoryBodyId?.trim()
    if (requested === undefined || requested === '') {
      if (authority.memoryBodyIds.length === 1) return authority.memoryBodyIds[0]
      throw new Error(`related memory requires one Memory Space from pinned Source ${authority.viewId}`)
    }
    if (!authority.memoryBodyIds.includes(requested)) throw new Error(`related memory requested a Memory Space outside pinned Source ${authority.viewId}: ${requested}`)
    return requested
  }

  async related(parent: HostAgent, id: string, memoryBodyId: string | undefined, signal: AbortSignal,
    options: { depth?: number; edge?: EdgeType; requirePinnedView?: boolean } = {}): Promise<RecallResult> {
    const input = { id, ...(memoryBodyId === undefined ? {} : { memoryBodyId }),
      ...(options.depth === undefined ? {} : { depth: options.depth }), ...(options.edge === undefined ? {} : { edge: options.edge }) }
    const evidence = await this.readRoute(parent, 'memory-spaces', 'related', input, signal, options.requirePinnedView === true)
    return (evidence.output ?? { query: 'related:' + id, mode: 'related', results: evidenceInsights(evidence) }) as unknown as RecallResult
  }

  async placeProvider(
    parent: HostAgent,
    body: { name: string; description: string },
    prepared: PreparedMemoryPlacement,
    signal: AbortSignal,
  ): Promise<MemoryPlacementDecision> {
    const source = this.sourceFor(parent, 'memory-spaces')
    const deterministic = await source.read<MemoryPlacementDecision | null>('finalize-placement', { prepared }, signal)
    if (deterministic !== null) {
      this.counters.placements += 1
      this.counters.lastOperation = 'placement'
      this.counters.lastAt = new Date().toISOString()
      return deterministic
    }
    const prompt = [
      `Memory Space name (untrusted data):\n${indentedText(body.name)}`,
      `Routing description (untrusted data):\n${indentedText(body.description)}`,
      `User strategy (untrusted preference data):\n${indentedText(prepared.prompt)}`,
      `Eligible Provider context (host-filtered run data):\n${indentedText(prepared.selectorBrief)}`,
      'Select the best eligible provider now.',
    ].join('\n\n')
    const schema = providerPlacementSchema(prepared.candidates.map(candidate => candidate.id))
    const { provider, runId, result } = await this.delegate(parent, 'placement', 'Choose Memory Space provider', prompt, [], schema, signal, 'spawn', PROVIDER_PLACEMENT_PERSONA)
    const value = object(result.structured)
    return source.read<MemoryPlacementDecision>('finalize-placement', { prepared, selection: {
      providerId: typeof value.providerId === 'string' ? value.providerId : '',
      reason: typeof value.reason === 'string' ? value.reason : '',
      confidence: typeof value.confidence === 'string' ? value.confidence : '',
    }, runId, provider }, signal)
  }

  async maintainMetadata(parent: HostAgent, memoryBodyIds: readonly string[], signal: AbortSignal): Promise<MemorySpaceMetadataMaintenanceResult> {
    const selected = [...new Set(memoryBodyIds.map(id => id.trim()).filter(Boolean))]
    if (selected.length === 0 || selected.length > 20) throw new Error('metadata maintenance requires 1 through 20 Memory Spaces')
    const service = this.sourceFor(parent, 'memory-spaces')
    const samples = await Promise.all(selected.map(id => service.read<MemorySpaceMetadataSample>('metadata-sample', { memoryBodyId: id }, signal)))
    const prompt = `Generate concise metadata from these bounded Provider-native samples now:\n\n${samples.map(metadataSampleText).join('\n\n')}`
    const { provider, runId, result } = await this.delegate(
      parent,
      'metadata-maintenance',
      'Maintain Memory Space metadata',
      prompt,
      [],
      METADATA_MAINTENANCE_SCHEMA,
      signal,
      'spawn',
      METADATA_MAINTENANCE_PERSONA,
    )
    const value = object(result.structured)
    if (!Array.isArray(value.updates)) throw new Error('metadata subagent returned no updates')
    const allowed = new Set(selected)
    const seen = new Set<string>()
    const updates: MemorySpaceMetadataUpdate[] = []
    for (const entry of value.updates) {
      const item = object(entry)
      const memoryBodyId = typeof item.memoryBodyId === 'string' ? item.memoryBodyId.trim() : ''
      const title = typeof item.title === 'string' ? item.title.trim() : ''
      const description = typeof item.description === 'string' ? item.description.trim() : ''
      if (!allowed.has(memoryBodyId) || seen.has(memoryBodyId)) throw new Error('metadata subagent returned an unexpected or duplicate Memory Space')
      seen.add(memoryBodyId)
      if (title.length < 2 || title.length > 48 || description.length < 12 || description.length > 200) continue
      updates.push({ memoryBodyId, title, description })
    }
    return {
      delegated: true,
      runId,
      provider,
      summary: typeof value.summary === 'string' ? value.summary.trim() : '',
      updates,
    }
  }

  /**
   * `activateTarget` lets a write the user sent to a switched-off space switch it back on.
   * A model's mnemon_remember call never does: it switches the space on first (#387).
   */
  remember(parent: HostAgent, request: RememberRequest, signal: AbortSignal, options: { activateTarget?: boolean } = {}): Promise<DelegatedWriteResult> {
    return this.write(parent, 'remember', request, signal, options)
  }

  async runtime(parent: HostAgent, request: RuntimeMemoryMutation, signal: AbortSignal): Promise<CoordinatedRuntimeMemoryResult> {
    const authority = this.turnAuthority(parent, false)
    if (authority !== undefined) {
      const lease = authority.graph.memoryComposition.acquire(authority.context.view.runtimeGeneration)
      const instances = lease.generation.sourceInstances().filter(source => source.sourceTypeId === 'runtime')
      lease.release()
      const offers = authority.context.view.actionOffers.filter(offer => offer.sourceActionId === 'mutate'
        && instances.some(source => source.sourceInstanceKey === offer.sourceInstanceKey))
      if (offers.length === 0) throw new Error('Source Action is not offered by the current View: runtime/mutate')
      // The tool runs the offer of the instance the View binds it to, the Starter instance's when a
      // profile mounts another runtime Source beside it (#397), and otherwise the only runtime
      // Source the View lets it write to, as a Scoped composition can make it. The others keep
      // their exact offers, which the View lists for mnemon_view_action.
      const bound = namedToolInstance(instances, 'runtime')
      const offer = offers.find(item => item.sourceInstanceKey === bound?.sourceInstanceKey) ?? (offers.length === 1 ? offers[0] : undefined)
      if (offer === undefined) {
        throw new Error('Several runtime Sources offer mutate and none is the Starter instance this tool writes to; use mnemon_view_action with one of: '
          + offers.map(item => item.id).join(', '))
      }
      const result = await this.viewAction(parent, authority, offer.id, request as unknown as MemoryJsonValue, signal)
      return { ...result.details as unknown as CoordinatedRuntimeMemoryResult,
        ...(result.revision === undefined ? {} : { revision: result.revision }),
        memoryReceipt: { status: result.status, completion: result.completion, ...(result.committedAt === undefined ? {} : { committedAt: result.committedAt }) } }
    }
    const graph = this.runtimeSource.forAgent(parent)
    const scope = agentScope(parent, graph.config)
    const lease = graph.memoryComposition.acquire()
    try {
      const runtime = graph.source('runtime', scope).forGeneration(lease.generation)
      const context: RuntimeWriteContext = {
        runtime, inspectRuntime: runtime,
        maintain: strategyDrives(lease.generation.strategy.definition.manifest, 'runtime-capacity'),
        commit: () => runtime.mutate('mutate', request, signal),
        memorySpaces: async () => {
          if (!graph.config.writeEnabled || !this.runtimeSource.config.writeEnabled) throw new Error('dsh-mnemon is configured read-only')
          // Memory Spaces switched off, taking no automatic writes or not installed
          // leave the archive to the Runtime Source, as in a turn's View (#336).
          if (!allowsParticipation(graph.config, 'memory-spaces', 'write', 'automatic')
            || !lease.generation.sourceInstances().some(source => source.sourceTypeId === 'memory-spaces')) return undefined
          const source = graph.source('memory-spaces', scope).forGeneration(lease.generation)
          const { sourceInstanceKey } = await source.identity()
          return { source, cleanup: source, elsewhere: await archivableElsewhere(graph, scope, lease.generation, sourceInstanceKey, signal) }
        },
        model: (...args) => this.runtimeModel(scope, parent, signal, ...args),
      }
      return await this.enqueueRuntime(context, request, signal)
    } finally { lease.release() }
  }

  private enqueueRuntime(context: RuntimeWriteContext, request: RuntimeMemoryMutation, signal: AbortSignal): Promise<CoordinatedRuntimeMemoryResult> {
    const operation = this.runtimeQueue.then(() => runtimeLocked(this.counters, context, request, signal))
    this.runtimeQueue = operation.catch(() => undefined)
    return operation
  }

  /** Named tools and generic Actions share one default-product write workflow. */
  action(parent: HostAgent, offerId: string, input: MemoryJsonValue, signal: AbortSignal): Promise<MemoryMutationReceipt> {
    return this.viewAction(parent, this.turnAuthority(parent, true)!, offerId, input, signal)
  }

  private async viewAction(parent: HostAgent, authority: { graph: MnemonRuntimeGraph; context: ComposableMemoryTurn }, offerId: string, input: MemoryJsonValue, signal: AbortSignal): Promise<MemoryMutationReceipt> {
    input = JSON.parse(JSON.stringify(input)) as MemoryJsonValue
    const { graph, context: turn } = authority
    const lease = graph.memoryComposition.acquire(turn.view.runtimeGeneration)
    try {
      const offer = turn.view.actionOffers.find(candidate => candidate.id === offerId)
      const source = lease.generation.sourceInstances().find(candidate => candidate.sourceInstanceKey === offer?.sourceInstanceKey)
      const authorize = () => {
        if (graph.composableTurns.turn(turn.turnId) !== turn) throw new Error('Memory operation belongs to an ended turn')
        return graph.config.writeEnabled && this.runtimeSource.config.writeEnabled && offer?.authority === undefined
      }
      let receipt: MemoryMutationReceipt | undefined
      const commit = async () => {
        receipt = await graph.composableTurns.executeAction(turn.turnId, offerId, input, authorize, signal)
        return receipt.details as unknown as RuntimeMemoryMutationResult
      }
      if (offer === undefined || source === undefined || !runtimeCapacityWrite(viewStrategy(lease.generation, turn.view), source.sourceTypeId, offer.sourceActionId)) {
        await commit()
        return receipt!
      }
      const runtime = graph.source(source.sourceTypeId, turn.scope).forInstance(source.sourceInstanceKey).forTurn(turn).forGeneration(lease.generation)
      const result = await this.enqueueRuntime({
        runtime, inspectRuntime: graph.source('runtime', turn.scope).forInstance(source.sourceInstanceKey).forGeneration(lease.generation), maintain: true, commit,
        assertWritable: () => { if (!authorize()) throw new Error('Runtime capacity maintenance is no longer authorized') },
        memorySpaces: async () => {
          if (!authorize()) throw new Error('Runtime capacity maintenance is no longer authorized')
          return runtimeArchiveSource(this.runtimeSource, graph, turn.scope, turn.view, lease.generation, turn, signal)
        },
        model: (...args) => this.runtimeModel(turn.scope, parent, signal, ...args),
      }, input as unknown as RuntimeMemoryMutation, signal)
      return receipt ?? mutationReceipt(turn.view.id, offer.id, offer.sourceInstanceKey, result.revision, result as unknown as MemoryJsonValue, 'committed')
    } finally { lease.release() }
  }

  /** Browser maintenance carries an explicit scope and revision, never a borrowed conversation. */
  async manageSource(graph: MnemonRuntimeGraph, request: MemorySourceManagementRequest): Promise<MemorySourceManagementResult> {
    request = { ...request, scope: { ...request.scope }, input: JSON.parse(JSON.stringify(request.input)) as MemoryJsonValue }
    const signal = request.signal ?? new AbortController().signal
    const lease = graph.memoryComposition.acquire()
    try {
      const generation = lease.generation
      const source = generation.sourceInstances().find(candidate => candidate.sourceInstanceKey === request.sourceInstanceKey)
      if (request.mode !== 'mutate' || source === undefined || !runtimeCapacityWrite(generation.strategy.definition.manifest, source.sourceTypeId, request.operation)) {
        return await generation.executeManagement(request)
      }
      const runtime = graph.source('runtime', request.scope).forInstance(request.sourceInstanceKey).forGeneration(generation)
      let committed: MemorySourceManagementResult | undefined
      let view: ComposableMemoryView | undefined
      const result = await this.enqueueRuntime({
        runtime, inspectRuntime: runtime, maintain: true, ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
        assertWritable: () => {
          if (!graph.config.writeEnabled || !this.runtimeSource.config.writeEnabled) throw new Error('dsh-mnemon is configured read-only')
          assertParticipation(graph.config, 'runtime', 'write', 'manual')
        },
        commit: async () => {
          if (!graph.config.writeEnabled || !this.runtimeSource.config.writeEnabled) throw new Error('dsh-mnemon is configured read-only')
          assertParticipation(graph.config, 'runtime', 'write', 'manual')
          committed = await generation.executeManagement(request)
          return committed.value as unknown as RuntimeMemoryMutationResult
        },
        memorySpaces: async () => {
          view ??= await generation.compose({ scope: request.scope, scenario: 'management.runtime-capacity', budget: DEFAULT_MEMORY_VIEW_BUDGET }, signal)
          return runtimeArchiveSource(this.runtimeSource, graph, request.scope, view, generation, undefined, signal)
        },
        model: (...args) => this.runtimeModel(request.scope, undefined, signal, ...args),
      }, request.input as unknown as RuntimeMemoryMutation, signal)
      if (committed !== undefined) return committed
      if (result.revision === undefined) throw new Error('Runtime maintenance returned no committed Source revision')
      return { revision: result.revision, value: result as unknown as MemoryJsonValue }
    } finally { lease.release() }
  }

  /**
   * Memory reconciliation. One bounded model run reads the merged local memory and
   * proposes operations; those become a pending review and nothing else. The
   * proposal is never applied here, because the point of the feature is that a
   * human reads it first.
   */
  async reconcile(graph: MnemonRuntimeGraph, scope: MemoryOperationScope, signal: AbortSignal, options: MnemonReconcileOptions = {}): Promise<MnemonReconcileResult> {
    const machine = graph.packs.identity()
    const lease = graph.memoryComposition.acquire()
    let runtime: RuntimeMemorySnapshot
    let documents: DocumentSnapshot
    try {
      runtime = await graph.source('runtime', scope).forGeneration(lease.generation).read<RuntimeMemorySnapshot>('snapshot', null, signal)
      documents = await graph.source('documents', scope).forGeneration(lease.generation).read<DocumentSnapshot>('snapshot', null, signal)
        // A reconciliation that cannot read Documents still has the runtime memory to plan against.
        .catch(() => emptyDocumentSnapshot(graph.directory, new Date().toISOString()))
    } finally { lease.release() }
    const others = foreignMachines(runtime.entries, machine)
    // The branch's side is evidence, not an answer. When it cannot be read - no
    // repository, no git, an unpublished branch, an unreadable payload - the plan is
    // the local plan it has always been, and nothing fails because of it.
    const difference = await graph.sync.readRemoteForEvidence(signal)
    const guidance = options.guidance?.trim() ?? ''
    const opinions = pendingOpinions(graph.reviews.list())
    const evidence: MnemonReconcileEvidence = {
      machine, runtime, documents, foreignMachines: others,
      ...(difference === undefined ? {} : {
        remote: {
          entries: difference.remoteOnly,
          conflicts: difference.conflicts,
          truncated: difference.truncated,
          tombstones: difference.remoteTombstones,
          branch: difference.branch,
          ...(difference.remote.machine === undefined ? {} : { machine: difference.remote.machine }),
        },
      }),
      ...(guidance === '' ? {} : { guidance }),
      ...(opinions.length === 0 ? {} : { opinions }),
    }
    const read = {
      ...(difference === undefined ? {} : { remoteEntries: difference.remoteOnly.length }),
      ...(guidance === '' ? {} : { guided: true }),
    }
    if (runtime.entries.length === 0) {
      return { title: '', summary: '', action: 'none', operations: 0, foreignMachines: others, ...read, provider: 'host', runId: '' }
    }
    const delegated = await this.runtimeModel(scope, undefined, signal, 'reconcile', 'Reconcile merged local memory', reconcilePrompt(evidence), RECONCILE_SCHEMA as unknown as Record<string, unknown>, RECONCILE_PERSONA)
    const proposal = parseReconcileResult(delegated.result.structured, evidence)
    const result = { title: proposal.title, summary: proposal.summary, action: proposal.action, foreignMachines: others, ...read, provider: delegated.provider, runId: delegated.runId }
    if (proposal.action === 'failed') throw new Error('memory reconciliation could not plan against the merged evidence: ' + proposal.summary)
    if (proposal.operations.length === 0) return { ...result, action: 'none', operations: 0 }
    const entry = graph.reviews.create({ title: proposal.title, summary: proposal.summary, machine: { id: machine.id, label: machine.label }, foreignMachines: others, operations: proposal.operations })
    return { ...result, action: 'planned', operations: proposal.operations.length, entry }
  }

  private runtimeModel(scope: MemoryOperationScope, parent: HostAgent | undefined, signal: AbortSignal, operation: 'migration' | 'compaction' | 'reconcile', label: string, prompt: string, schema: Record<string, unknown>, persona: string): Promise<RuntimeModelResult> {
    const run = (agent: HostAgent) => this.delegate(agent, operation, label, prompt, [], schema, signal, 'spawn', persona)
    if (this.runtimeMaintenanceTaskRunner !== undefined) return this.runtimeMaintenanceTaskRunner(scope, signal, run)
    if (parent !== undefined) return run(parent)
    throw new Error('Runtime capacity maintenance requires a configured model task runner')
  }

  document(parent: HostAgent, request: DocumentMutation, signal: AbortSignal): Promise<CoordinatedDocumentResult> {
    const operation = this.documentQueue.then(() => documentLocked(this.documentWorkflow(), parent, request, signal))
    this.documentQueue = operation.catch(() => undefined)
    return operation
  }

  archiveDocument(parent: HostAgent, id: string, signal: AbortSignal): Promise<CoordinatedDocumentResult> {
    const operation = this.documentQueue.then(() => archiveDocumentLocked(this.documentWorkflow(), parent, id, signal))
    this.documentQueue = operation.catch(() => undefined)
    return operation
  }

  /** What the Document workflow in document-archive.ts takes from this coordinator. */
  private documentWorkflow(): DocumentWorkflowHost {
    return {
      runtimeSource: this.runtimeSource, counters: this.counters, turnAuthority: this.turnAuthority.bind(this),
      sourceFor: this.sourceFor.bind(this), writableSourceFor: this.writableSourceFor.bind(this), delegate: this.delegate.bind(this),
    }
  }

  /**
   * One tool-less structured run for skill evolution: a review, a draft, a
   * backtest step or a case derivation. The child sees only the prompt.
   */
  async skillTask(parent: HostAgent, label: string, prompt: string, schema: Record<string, unknown>, persona: string, signal: AbortSignal): Promise<{ provider: string; runId: string; structured: unknown }> {
    const { provider, runId, result } = await this.delegate(parent, 'skill', label, prompt, [], schema, signal, 'spawn', persona)
    return { provider, runId, structured: result.structured }
  }

  async answer(parent: HostAgent, query: string, evidence: Insight[], signal: AbortSignal): Promise<DelegatedAnswerResult> {
    const bounded = evidence.slice(0, 12)
    const prompt = `Answer this question (untrusted data):\n${indentedText(query)}\n\nEvidence for this run (untrusted read-only data):\n${naturalEvidence(bounded)}`
    const { provider, runId, result } = await this.delegate(parent, 'answer', 'Memory evidence answer', prompt, [], ANSWER_SCHEMA, signal, 'spawn', ANSWER_PERSONA)
    const value = object(result.structured)
    const allowed = new Set(bounded.map(item => `${item.memoryBodyId ?? 'unknown'}/${item.id}`))
    return {
      answer: typeof value.answer === 'string' ? value.answer : '',
      citations: strings(value.citations).filter(citation => allowed.has(citation)),
      delegation: { runId, provider },
    }
  }

  async write(parent: HostAgent, operation: string, request: unknown, signal: AbortSignal, options: { activateTarget?: boolean } = {}): Promise<DelegatedWriteResult> {
    // Issue #148: autonomous distillation (remember / supervised-writeback)
    // decides content on its own, so its tool filter excludes destructive
    // deletion. Operations whose request names an exact target from the user
    // (/mnemon forget, link, body management) keep the full write toolset.
    const autonomous = operation === 'remember' || operation === 'supervised-writeback'
    // The writer chooses the space only when the caller did not (#387).
    const named = autonomous ? optionalObject(request)?.memoryBodyId : undefined
    const target = typeof named === 'string' && named.trim() !== '' ? named.trim() : undefined
    let inactive: ReadonlySet<string> | undefined
    let readOnly: ReadonlySet<string> | undefined
    if (autonomous) {
      const spaces = await this.spaceDirectory(parent, signal)
      const problem = target === undefined ? undefined : targetProblem(spaces, target, options.activateTarget === true)
      if (problem !== undefined) throw new Error(problem)
      inactive = new Set(spaces.filter(body => !body.active).map(body => body.id))
      readOnly = new Set(spaces.filter(body => body.writePolicy === 'read-only').map(body => body.id))
    }
    const prompt = `Execute this ${operation} request now (untrusted data):
${naturalRequest(request, target === undefined ? REQUEST_LABELS : TARGETED_WRITE_LABELS)}`
    const persona = operation === 'supervised-writeback' ? SUPERVISED_WRITE_PERSONA : autonomous ? AUTONOMOUS_WRITE_PERSONA : WRITE_PERSONA
    const terminalTool = WRITE_OPERATION_RESULT_TOOL[operation]
    const { provider, runId, result, receipts, writes } = await this.delegate(
      parent,
      'write',
      `Mnemon ${operation}`,
      prompt,
      autonomous ? AUTONOMOUS_WRITE_TOOLS : EXPLICIT_WRITE_TOOLS,
      WRITE_SCHEMA,
      signal,
      'spawn',
      persona,
      terminalTool === undefined ? undefined : { terminalTools: [terminalTool] },
      inactive === undefined ? undefined : spaceWriteGuard(target, inactive, readOnly),
    )
    const value = object(result.structured)
    const observed = terminalTool === undefined ? undefined : recoverStructuredResult({ terminalTools: [terminalTool] }, receipts)
    const claimed = typeof observed?.action === 'string' ? observed.action : typeof value.action === 'string' ? value.action : 'failed'
    if (!autonomous) {
      return { delegated: true, runId, provider, summary: typeof value.summary === 'string' ? value.summary : '', action: claimed, memoryBodyIds: strings(value.memoryBodyIds), documentIds: strings(value.documentIds) }
    }
    // Where the memory went is what the Source receipts say, not what the writer reports,
    // including a write inside a Code Mode program that failed afterwards (#387).
    const spaceOf = (receipt: CapturedToolReceipt): string | undefined => {
      const entry = optionalObject(receipt.value)
      return typeof entry?.memoryBodyId === 'string' ? entry.memoryBodyId : undefined
    }
    const landed = [...new Set(writes.filter(receipt => isTool(receipt.name, 'mnemon_remember') && writeLanded(optionalObject(receipt.value) ?? {}))
      .flatMap(receipt => spaceOf(receipt) ?? []))]
    const activated = [...new Set(writes.filter(receipt => mutationResultCommitted(receipt.value)).flatMap(receipt => spaceOf(receipt) ?? [])
      .filter(id => inactive!.has(id)))]
    // Read from the same write receipts, so a vector-less write inside a failed Code Mode program counts too (#388).
    const unembedded = withoutVector(writes)
    return {
      delegated: true,
      runId,
      provider,
      summary: typeof value.summary === 'string' ? value.summary : '',
      // A writer that reports a write no receipt shows has written nothing.
      action: landed.length === 0 && mutationResultCommitted({ action: claimed }) ? 'unknown' : claimed,
      memoryBodyIds: landed,
      ...(activated.length === 0 ? {} : { activatedMemoryBodyIds: activated }),
      documentIds: strings(value.documentIds),
      ...(unembedded.length === 0 ? {} : { unembedded, hint: UNEMBEDDED_HINT }),
    }
  }

  /** The Memory Spaces this write can see; a write that cannot read them writes nothing (#387). */
  private async spaceDirectory(parent: HostAgent, signal: AbortSignal): Promise<MemorySpaceCatalog['items']> {
    try {
      return (await this.sourceFor(parent, 'memory-spaces').read<MemorySpaceCatalog>('body-directory', null, signal)).items
    } catch (error) {
      throw new Error('The Memory Space directory could not be read, so nothing was saved: ' + (error instanceof Error ? error.message : String(error)), { cause: error })
    }
  }

  async review(parent: HostAgent, signal: AbortSignal): Promise<DelegatedWriteResult | { delegated: false; action: 'skipped'; summary: string; documentIds: string[] }> {
    const config = this.runtimeSource.config.idleReview
    if (idleReviewBlockReason(parent, config.agentTeams) !== undefined) return { delegated: false, action: 'skipped', summary: 'Idle review is paused by the Agent Teams compatibility setting.', documentIds: [] }
    let preferred = config.provider
    if (preferred === 'fork') {
      try { this.provider('fork') } catch (error) {
        if (config.fallback === 'skip') return { delegated: false, action: 'skipped', summary: 'Fork provider unavailable; idle review skipped.', documentIds: [] }
        preferred = 'spawn'
      }
    }
    const prompt = preferred === 'fork' ? 'Review the inherited completed checkpoint now.' : reviewCheckpoint(parent.session, config.maxContextChars)
    const base = reviewPersona(config.runtimeMemory)
    const persona = preferred === 'fork' ? base : base.replaceAll('inherited', 'supplied bounded')
    // With runtime memory off the tool is withheld, not merely discouraged.
    const tools = config.runtimeMemory ? REVIEW_TOOLS : REVIEW_TOOLS.filter(tool => tool !== 'mnemon_runtime_memory')
    const writers = tools.filter(tool => tool !== 'mnemon_document_search')
    const { provider, runId, result } = await this.delegate(parent, 'review', 'Mnemon idle checkpoint review', prompt, tools, WRITE_SCHEMA, signal, preferred, persona, { terminalTools: writers })
    const value = object(result.structured)
    return {
      delegated: true,
      runId,
      provider,
      summary: typeof value.summary === 'string' ? value.summary : '',
      action: typeof value.action === 'string' ? value.action : 'failed',
      memoryBodyIds: strings(value.memoryBodyIds),
      documentIds: strings(value.documentIds),
    }
  }

  private async delegate(
    parent: HostAgent,
    operation: DelegatedOperation,
    label: string,
    prompt: string,
    tools: string[],
    outputSchema: Record<string, unknown>,
    signal: AbortSignal,
    preferredProvider: 'spawn' | 'fork' = 'spawn',
    persona = WRITE_PERSONA,
    recovery?: ToolReceiptRecovery,
    guard?: (execution: ToolExecution) => string | undefined,
  ): Promise<{ provider: string; runId: string; result: HostSubagentResult; receipts: CapturedToolReceipt[]; writes: CapturedToolReceipt[] }> {
    if (this.disposed) throw new Error('dsh-mnemon subagent coordinator is disposed')
    const provider = this.provider(preferredProvider)
    assertDshOutputSchema(outputSchema)
    if (this.resultRuntime === undefined) throw new Error('dsh-mnemon subagent result tool runtime is unavailable')
    // Keep the inherited tool inventory byte-stable. Only the child prompt
    // and arguments carry the revocable capability for this delegated run.
    const resultToolName = RESULT_TOOL_NAME
    const requestId = randomUUID()
    let captured: CapturedSubagentResult | undefined
    let pending: (CapturedSubagentResult & { parent: symbol }) | undefined
    let activeResultExecution: object | undefined
    const staged = new WeakMap<object, CapturedSubagentResult>()
    const recoverableTools = new Set(recovery?.terminalTools ?? [])
    const committedReceipts: CapturedToolReceipt[] = []
    const reviewReceipts: CapturedToolReceipt[] = []
    const writeReceipts: CapturedToolReceipt[] = []
    let reviewChildId: string | undefined
    // Code Mode sub-dispatches are provisional until their enclosing run_code
    // execution publishes a successful authoritative result.
    const stagedReceipts = new Map<symbol, CapturedToolReceipt[]>()
    let run: HostSubagentRun | undefined
    let completed: { provider: string; runId: string; result: HostSubagentResult; receipts: CapturedToolReceipt[]; writes: CapturedToolReceipt[] } | undefined
    let failure: unknown
    let disposeResultObserver: (() => unknown) | undefined
    let releaseWorkflow: (() => void) | undefined
    try {
      // A maintenance/task run has its own bounded View only when no parent
      // turn is open. Ordinary children reuse the parent's immutable View.
      if (tools.length > 0) {
        const execution = await this.runtimeSource.executions.workflow(parent, operation, signal)
        releaseWorkflow = execution.release
        signal = execution.signal
      }
      if (this.disposed) throw new Error('dsh-mnemon subagent coordinator is disposed')
      const observer = this.resultRuntime.on('tools/result', ((execution: ToolExecution, result: HostToolResultObservation) => {
        if (!this.resultRequests.has(requestId)) return
        // A committed Source result remains useful reconciliation evidence even
        // if its outer Code Mode execution or the reviewer later fails/aborts.
        if (operation === 'review' && execution.agent?.id === reviewChildId && execution.name !== undefined
          && recoverableTools.has(execution.name) && result.isError !== true && Object.hasOwn(result, 'value')) {
          reviewReceipts.push({ agentId: execution.agent!.id, name: execution.name, arguments: execution.arguments, value: result.value })
        }
        // A Memory Space write holds once its Source answers, whatever the Code Mode program
        // around it does next: where a write went is read from these (#387).
        if (operation === 'write' && execution.name !== undefined && SPACE_WRITE_TOOLS.has(execution.name) && execution.agent !== undefined
          && isSubagent(execution.agent) && result.isError !== true && Object.hasOwn(result, 'value')) {
          writeReceipts.push({ agentId: execution.agent.id, name: execution.name, arguments: execution.arguments, value: result.value })
        }
        if (signal.aborted) return
        if (execution.token !== undefined) {
          const entries = stagedReceipts.get(execution.token)
          if (entries !== undefined) {
            stagedReceipts.delete(execution.token)
            if (result.isError !== true) committedReceipts.push(...entries)
          }
        }
        if (execution.name === resultToolName) {
          const entry = staged.get(execution)
          if (entry === undefined) return
          staged.delete(execution)
          if (activeResultExecution === execution) activeResultExecution = undefined
          if (result.isError === true) return
          if (execution.parent === undefined) {
            if (captured === undefined) captured = entry
          } else if (captured === undefined && pending === undefined) {
            pending = { ...entry, parent: execution.parent }
          }
          return
        }
        if (pending !== undefined && pending.parent === execution.token) {
          const entry = pending
          pending = undefined
          if (result.isError !== true && captured === undefined) captured = { agentId: entry.agentId, value: entry.value }
        }
        if (execution.name === undefined || !recoverableTools.has(execution.name) || result.isError === true || !Object.hasOwn(result, 'value')) return
        const agent = execution.agent
        if (agent === undefined || !isSubagent(agent)) return
        const receipt: CapturedToolReceipt = { agentId: agent.id, name: execution.name, arguments: execution.arguments, value: result.value }
        if (execution.parent === undefined) committedReceipts.push(receipt)
        else stagedReceipts.set(execution.parent, [...(stagedReceipts.get(execution.parent) ?? []), receipt])
      }) as never)
      if (typeof observer !== 'function') throw new Error('dsh-mnemon subagent result observer registration did not return a disposer')
      disposeResultObserver = observer as () => unknown
      this.resultRequests.set(requestId, async (value, execution) => {
        signal.throwIfAborted()
        const agent = execution.agent
        if (agent === undefined || !isSubagent(agent)) throw new Error('Mnemon subagent result tools are restricted to delegated children')
        if (run !== undefined && agent.id !== run.id) throw new Error('Mnemon subagent result belongs to a different child')
        if (activeResultExecution !== undefined || pending !== undefined || captured !== undefined) throw new Error('Mnemon subagent result was already recorded')
        if (execution.concludeTurn === undefined) throw new Error('Mnemon subagent result tool requires terminal tool-call support')
        assertDshOutputValue(outputSchema, value)
        activeResultExecution = execution
        staged.set(execution, { agentId: agent.id, value })
        execution.concludeTurn()
        return { recorded: true }
      })
      const completionPersona = `${persona}

Completion protocol: call \`${resultToolName}\` exactly once with requestId \`${requestId}\` and result matching this JSON schema:
${JSON.stringify(outputSchema)}
This is the only completion channel for this run. Do not finish with a plain-text answer. The requestId expires when this run finishes or is cancelled.`
      const perOpMaxTokens = operation === 'migration' || operation === 'compaction' || operation === 'reconcile'
        ? this.runtimeMaintenanceMaxTokensResolver?.() ?? 8_192
        : operation === 'document-archive' ? 8_192
        : operation === 'metadata-maintenance' ? 4_096
        : operation === 'review' ? this.runtimeSource.config.idleReview.maxTokens
        : operation === 'skill' ? 16_384
        : undefined
      const fixed = this.taskAgentModelResolver?.()
      const baseAgentOptions = perOpMaxTokens === undefined ? undefined : { maxTokens: perOpMaxTokens }
      const resolvedAgentOptions = fixed === undefined ? baseAgentOptions : { ...(baseAgentOptions ?? {}), provider: fixed.provider, model: fixed.model }
      const host = this.resultRuntime
      // Every tool continuation ends with a user turn, which strict chat templates require (#327).
      const start = () => startWithContinuationTurns(host, parent, () => startSubagent(this.subagents, host.agents, provider, {
        label,
        prompt: [{ type: 'text', text: `${delegatedTaskLine(operation)}\n${prompt}` }],
        parent,
        signal,
        ...(resolvedAgentOptions === undefined ? {} : { agentOptions: resolvedAgentOptions }),
        maxDepth: 1,
        toolFilter: { allow: [...tools, resultToolName] },
        persona: completionPersona,
      }, host))
      run = operation === 'review'
        ? await startGuardedReview(this.resultRuntime, parent, [...tools, resultToolName], start, child => { reviewChildId = child.id }, reviewLayerPolicy())
        // A DSH without Agent ownership or scoped tool guards runs the child as before.
        : guard !== undefined ? await startGuardedChild(this.resultRuntime, parent, start, guard, { purpose: operation, optional: true })
        : await start()
      const activeRun = run
      const result = await activeRun.result
      if (captured !== undefined && captured.agentId !== activeRun.id) throw new Error('Mnemon subagent result was recorded by a different child')
      let structured = captured?.value ?? result.structured
      if (structured === undefined && result.stopReason === 'completed') {
        // Do not rerun a mutation after a missed handoff. A matching successful
        // tool receipt is already the host's authoritative commit evidence.
        structured = recoverStructuredResult(recovery, committedReceipts.filter(receipt => receipt.agentId === activeRun.id))
      }
      if (structured !== undefined) assertDshOutputValue(outputSchema, structured)
      if (result.stopReason !== 'completed') {
        const detail = subagentFailureDetail(activeRun, result)
        throw new Error(`memory subagent stopped with ${result.stopReason}${detail === undefined ? '' : `: ${detail}`}`)
      }
      if (structured === undefined) throw new Error('memory subagent completed without recording its result')
      if (operation === 'review' && ['failed', 'partial', 'unknown'].includes(String(object(structured).action))) throw new Error(`memory review reported ${object(structured).action}`)
      completed = {
        provider,
        runId: activeRun.id,
        result: { ...result, structured },
        receipts: committedReceipts.filter(receipt => receipt.agentId === activeRun.id),
        writes: writeReceipts.filter(receipt => receipt.agentId === activeRun.id),
      }
    } catch (error) {
      this.counters.failures += 1
      const receipts = reviewReceipts.map(reviewReceipt).filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== undefined)
      failure = operation === 'review' ? new IdleReviewError(error instanceof Error ? error.message : String(error), {
        status: receipts.length > 0 ? 'partial' : 'failed', provider,
        ...(reviewChildId === undefined ? {} : { runId: reviewChildId }), receipts,
      }, { cause: error }) : error
      throw failure
    } finally {
      // Revoke before asynchronous child disposal, including rejected startup.
      this.resultRequests.delete(requestId)
      let cleanupFailure: unknown
      if (run !== undefined) {
        this.finished(run.id)
        try {
          await run.dispose()
        } catch (error) {
          if (failure === undefined) cleanupFailure = error
        }
      }
      if (disposeResultObserver !== undefined) {
        try {
          await disposeResultObserver()
        } catch (error) {
          if (failure === undefined && cleanupFailure === undefined) cleanupFailure = error
        }
      }
      releaseWorkflow?.()
      if (cleanupFailure !== undefined) {
        this.counters.failures += 1
        if (operation !== 'review') throw cleanupFailure
        const receipts = reviewReceipts.map(reviewReceipt).filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== undefined)
        throw new IdleReviewError(cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure), {
          status: receipts.length > 0 ? 'partial' : 'failed', provider,
          ...(reviewChildId === undefined ? {} : { runId: reviewChildId }), receipts,
        }, { cause: cleanupFailure })
      }
    }
    if (completed === undefined) throw new Error('memory subagent did not complete')
    if (operation === 'skill') this.counters.skills = (this.counters.skills ?? 0) + 1
    else this.counters[operation === 'write' ? 'writes' : operation === 'review' ? 'reviews' : operation === 'placement' ? 'placements' : operation === 'migration' ? 'migrations' : operation === 'compaction' ? 'compactions' : operation === 'document-archive' ? 'documentArchives' : operation === 'metadata-maintenance' ? 'metadataMaintenances' : operation === 'reconcile' ? 'reconciliations' : 'answers'] += 1
    this.counters.lastRunId = completed.runId
    if (operation !== 'answer') this.counters.lastOperation = operation
    this.counters.lastAt = new Date().toISOString()
    return completed
  }

  private provider(preferred: 'spawn' | 'fork'): string {
    const names = this.subagents.list()
    const compatible = (name: string): boolean => {
      const provider = this.subagents.getProvider(name)
      return provider?.capabilities.depthLimit === true && childComposition(this.subagents, provider) !== undefined
    }
    if (preferred === 'fork') {
      const fork = this.subagents.getProvider('fork')
      if (!names.includes('fork') || !compatible('fork') || fork?.inheritsParentContext !== true) throw new Error('dsh-mnemon idle review requires the DSH fork provider with inherited parent context and structured tool isolation')
      return 'fork'
    }
    const isolated = (name: string): boolean => compatible(name) && this.subagents.getProvider(name)?.inheritsParentContext !== true
    const selected = names.includes('spawn') && isolated('spawn') ? 'spawn' : names.find(isolated)
    if (selected === undefined) throw new Error('dsh-mnemon requires a non-inheriting DSH subagent provider that limits depth and gives each child its own instructions and tools')
    return selected
  }

  private recallAuthority(agent: HostAgent, required: boolean): RecallAuthority | undefined {
    const authority = this.turnAuthority(agent, required)
    if (authority === undefined) return undefined
    const { context: turn, graph } = authority
    const grants = turn.view.readGrants.filter(candidate => candidate.schema === 'dsh-mnemon.memory-spaces/v1')
    if (grants.length !== 1) throw new Error('The current View has no unambiguous Memory Spaces ReadGrant')
    const value = optionalObject(grants[0]!.value)
    if (value === undefined || !Array.isArray(value.memoryBodyIds) || value.memoryBodyIds.some(id => typeof id !== 'string' || id.trim() === '')) throw new Error('The current View has invalid Memory Spaces read scope')
    return { context: turn, viewId: turn.view.id, memoryBodyIds: [...new Set(value.memoryBodyIds.map(String))], source: graph.source('memory-spaces', turn.scope).forTurn(turn) }
  }

  private turnAuthority(agent: HostAgent, required: boolean): { context: ComposableMemoryTurn; graph: MnemonRuntimeGraph } | undefined {
    const graph = this.runtimeSource.forAgent(agent)
    const turn = graph.composableTurns.activeTurn(agent.id)
    if (turn !== undefined) return { context: turn, graph }
    if (required) throw new Error('Recall requires the View pinned to the current turn')
    return undefined
  }


  private recordRecall(): void {
    this.counters.recalls += 1
    this.counters.lastOperation = 'recall'
    delete this.counters.lastRunId
    this.counters.lastAt = new Date().toISOString()
  }

  private sourceFor(parent: HostAgent, typeId: string): SourceSession {
    const graph = this.runtimeSource.forAgent(parent)
    return graph.source(typeId, agentScope(parent, graph.config))
  }

  /** View narrowing also governs implicit maintenance; operator management is separate. */
  private async writableSourceFor(parent: HostAgent, typeId: string, actionId: string): Promise<SourceSession> {
    const authority = this.turnAuthority(parent, false)
    if (authority === undefined) return this.sourceFor(parent, typeId)
    const source = authority.graph.source(typeId, authority.context.scope).forTurn(authority.context)
    await source.assertActionOffered(actionId, offer => authority.graph.config.writeEnabled && offer.authority === undefined)
    return source
  }
}
