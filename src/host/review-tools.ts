import { AsyncLocalStorage } from 'node:async_hooks'
import type { HostAgent, HostSubagentRun, ToolExecution } from './dsh.ts'
import type { MemoryToolName } from './protocol.ts'

export interface ReviewToolHost {
  agents?: { isOwnedBy?(id: string, parent: HostAgent): boolean; get?(id: string): HostAgent | undefined }
  on(name: string, listener: (...args: never[]) => unknown): unknown
}

// One store distinguishes nested starts as well as independent overlapping starts.
const startingChild = new AsyncLocalStorage<symbol>()

/**
 * Pausing stays the conservative default while Team tools are installed; the
 * operator can select scoped review instead (verified with each supported DSH
 * and its official Teams, tests/agent-team-review-host.spec.ts). That opt-in
 * still requires startGuardedReview; it never removes another plugin's policy.
 */
export function idleReviewBlockReason(parent: HostAgent, agentTeams: 'pause' | 'scoped' = 'pause'): 'agent-team' | undefined {
  return agentTeams !== 'scoped' && parent.ctx?.get?.('agentTeams') !== undefined
    && parent.ctx.tools?.get?.('spawn_teammate', parent) !== undefined ? 'agent-team' : undefined
}

export type ReviewToolPolicy = (execution: Readonly<ToolExecution>) => string | undefined

type ReviewLayer = 'working-memory' | 'documents'

/** The two writes an idle review can make, one per layer; both are rows of the tool table. */
const DOCUMENT_WRITE = 'mnemon_document_create' satisfies MemoryToolName
const WORKING_MEMORY_WRITE = 'mnemon_runtime_memory' satisfies MemoryToolName

function reviewLayer(execution: Readonly<ToolExecution>): ReviewLayer | undefined {
  if (execution.name === DOCUMENT_WRITE) return 'documents'
  if (execution.name !== WORKING_MEMORY_WRITE) return undefined
  const input = execution.arguments
  // Profile changes (target=user) never belong in a Document, so they stay independent.
  return typeof input === 'object' && input !== null && (input as { target?: unknown }).target === 'memory' ? 'working-memory' : undefined
}

/**
 * One idle review pass records project knowledge in one layer (#319). The first
 * Document creation or working-memory change it admits claims the pass; the
 * other layer is refused from then on, even when that first call fails, so a
 * refused or full layer is never evaded by writing the same knowledge elsewhere.
 */
export function reviewLayerPolicy(): ReviewToolPolicy {
  let claimed: ReviewLayer | undefined
  return execution => {
    const layer = reviewLayer(execution)
    if (layer === undefined) return undefined
    claimed ??= layer
    if (claimed === layer) return undefined
    return claimed === 'documents'
      ? 'This idle review already created a Document, so it cannot also change working memory (target=memory). Finish with the result tool.'
      : 'This idle review already changed working memory, so it cannot also create a Document. Finish with the result tool.'
  }
}

/**
 * DSH restrict() filters inherited capabilities, leaving own-scope plugin tools
 * visible. Attach its monotonic execution guard during publication, before a
 * review child can run. Async context attributes concurrent provider starts;
 * public registry ownership verifies the exact causal parent. An optional
 * policy then judges each allowed call, PTC sub-dispatches included.
 */
export function startGuardedReview(
  host: ReviewToolHost,
  parent: HostAgent,
  toolNames: readonly string[],
  start: () => Promise<HostSubagentRun>,
  published?: (agent: HostAgent) => void,
  policy?: ReviewToolPolicy,
): Promise<HostSubagentRun> {
  const allowed = new Set(toolNames)
  return startGuardedChild(host, parent, start, execution => {
    // PTC is a transport: DSH also guards each end-capability sub-dispatch.
    if (execution.name === 'run_code' || (execution.name !== undefined && allowed.has(execution.name))) return policy?.(execution)
    return `Mnemon review cannot execute ${JSON.stringify(execution.name)}; reuse the inherited checkpoint and bounded Document search.`
  }, { purpose: 'review', ...(published === undefined ? {} : { published }) })
}

export interface GuardedChildOptions {
  /** What the child does, as the errors name it. */
  purpose: string
  /** Each child the start publishes, once its guard holds. */
  published?: (agent: HostAgent) => void
  /**
   * Start the child unguarded when it cannot be guarded, rather than refuse: on a DSH without
   * Agent ownership or scoped tool guards, or from a provider that runs no local child. A local
   * child with a scoped tool guard that DSH published out of the guard's sight still fails.
   */
  optional?: boolean
}

/**
 * Start a child whose every tool call `guard` judges first: a returned text refuses the call
 * and is what the child reads instead of a result. The guard is attached when DSH publishes
 * the child, before it can run.
 */
export async function startGuardedChild(
  host: ReviewToolHost,
  parent: HostAgent,
  start: () => Promise<HostSubagentRun>,
  guard: (execution: ToolExecution) => string | undefined,
  options: GuardedChildOptions,
): Promise<HostSubagentRun> {
  const { purpose, published } = options
  const agents = host.agents
  if (typeof agents?.isOwnedBy !== 'function') {
    if (options.optional === true) return start()
    throw new Error(`Mnemon ${purpose} requires DSH Agent ownership and scoped tool guard support`)
  }
  const pending = Symbol(`Mnemon ${purpose} publication`)
  const guards = new Map<HostAgent, () => unknown>()
  let attachmentError: unknown
  let run: HostSubagentRun | undefined
  const listener = host.on('agent/created', (({ agent }: { agent: HostAgent }) => {
    if (startingChild.getStore() !== pending || !agents.isOwnedBy!(agent.id, parent)) return
    try {
      const tools = agent.ctx?.tools
      if (typeof tools?.guard !== 'function') {
        if (options.optional === true) return
        throw new Error(`Mnemon ${purpose} requires DSH scoped tool guard support`)
      }
      const dispose = tools.guard(guard)
      if (typeof dispose !== 'function') throw new Error(`Mnemon ${purpose} tool guard did not return a disposer`)
      guards.set(agent, dispose as () => unknown)
      published?.(agent)
    } catch (error) {
      attachmentError = error
      // Synchronous publication failure lets the provider roll back the child.
      throw error
    }
  }) as never)
  if (typeof listener !== 'function') throw new Error(`Mnemon ${purpose} creation observer did not return a disposer`)
  let disposeObserver: (() => unknown) | undefined = listener as () => unknown
  const closeObserver = async () => {
    const dispose = disposeObserver
    disposeObserver = undefined
    await dispose?.()
  }
  const release = async () => {
    const disposers = [...guards.values()]
    guards.clear()
    const outcomes = await Promise.allSettled(disposers.map(async dispose => { await dispose() }))
    const failed = outcomes.filter(outcome => outcome.status === 'rejected')
    if (failed.length) throw new AggregateError(failed.map(outcome => outcome.reason), `Mnemon ${purpose} guard cleanup failed`)
  }
  try {
    run = await startingChild.run(pending, start)
    if (attachmentError !== undefined) throw attachmentError
    const runId = run.id
    // A DSH 0.2.1 activation names its child only by id; the guard attached at publication still holds it.
    const child = run.localAgent ?? [...guards.keys()].find(agent => agent.id === runId)
    if (child === undefined || !guards.has(child)) {
      // Only a child that cannot be guarded runs as before; a guardable one published out of sight fails closed.
      const local = run.localAgent ?? agents.get?.(runId)
      if (options.optional === true && guards.size === 0 && typeof local?.ctx?.tools?.guard !== 'function') {
        await closeObserver()
        return run
      }
      throw new Error(`Mnemon ${purpose} provider did not publish a local child with its scoped tool guard`)
    }
    // Close publication observation before transferring the owned child; a
    // disposer failure must take the same rollback path as a failed start.
    await closeObserver()
    const active = run
    return { id: active.id, localAgent: child, result: active.result, async dispose() {
      try { await active.dispose() } finally { await release() }
    } }
  } catch (error) {
    try { await closeObserver() } catch { /* Preserve the original start failure. */ }
    try { await run?.dispose() } catch { /* Guards remain until child cleanup settles. */ }
    try { await release() } catch { /* Every guard disposer was attempted. */ }
    throw error
  }
}
