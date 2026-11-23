import { AsyncLocalStorage } from 'node:async_hooks'
import type { HostAgent, HostSubagentRun, ToolExecution } from './dsh.ts'
import type { MemoryToolName } from './protocol.ts'
import { activationOwned, isReservedChild, reservedChildId, withReservedChild, type ActivationOwnership } from './agent-compat.ts'

export interface ReviewToolHost {
  agents?: { isOwnedBy?(id: string, parent: HostAgent): boolean; get?(id: string): HostAgent | undefined }
  subagents?: ActivationOwnership
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): unknown
}

const startingChild = new AsyncLocalStorage<symbol>()

export function idleReviewBlockReason(parent: HostAgent, agentTeams: 'pause' | 'scoped' = 'pause'): 'agent-team' | undefined {
  if (agentTeams === 'scoped') return undefined
  try {
    const teams = parent.ctx?.get?.('agentTeams') as { isEnabled?(agent: HostAgent): boolean } | undefined
    if (teams === undefined) return undefined
    const tools = parent.ctx.tools
    const active = tools?.get?.('spawn_teammate', parent) !== undefined
      || typeof teams?.isEnabled === 'function' && teams.isEnabled(parent) && tools?.get?.('team_task_create', parent) !== undefined
    return active ? 'agent-team' : undefined
  } catch {
    return 'agent-team'
  }
}

export type ReviewToolPolicy = (execution: Readonly<ToolExecution>) => string | undefined

type ReviewLayer = 'working-memory' | 'documents'

const DOCUMENT_WRITE = 'mnemon_document_create' satisfies MemoryToolName
const WORKING_MEMORY_WRITE = 'mnemon_runtime_memory' satisfies MemoryToolName

function reviewLayer(execution: Readonly<ToolExecution>): ReviewLayer | undefined {
  if (execution.name === DOCUMENT_WRITE) return 'documents'
  if (execution.name !== WORKING_MEMORY_WRITE) return undefined
  const input = execution.arguments
  return typeof input === 'object' && input !== null && (input as { target?: unknown }).target === 'memory' ? 'working-memory' : undefined
}

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
    if (execution.name === 'run_code' || (execution.name !== undefined && allowed.has(execution.name))) return policy?.(execution)
    return `Mnemon review cannot execute ${JSON.stringify(execution.name)}; reuse the inherited checkpoint and bounded Document search.`
  }, { purpose: 'review', ...(published === undefined ? {} : { published }) })
}

export function confineReadOnlyPolicy(agent: HostAgent): void {
  if (typeof agent.session.append !== 'function') return
  const sandbox = agent.ctx?.get?.('sandboxPolicy') as { overrideOf?(session: unknown): unknown } | undefined
  if (sandbox !== undefined && sandbox.overrideOf?.(agent.session) !== 'read-only') {
    agent.session.append('sandbox/mode', { mode: 'read-only', source: 'delegation' })
  }
  const approval = agent.ctx?.get?.('approval') as { overrideOf?(session: unknown): unknown } | undefined
  if (approval !== undefined && approval.overrideOf?.(agent.session) !== 'never') {
    agent.session.append('approval/policy', { policy: 'never', source: 'delegation' })
  }
}

export function presentNativeTools(agent: HostAgent): (() => unknown) | undefined {
  const tools = agent.ctx?.tools
  if (typeof tools?.presentAs !== 'function') return undefined
  try {
    const dispose = tools.presentAs('native')
    return typeof dispose === 'function' ? dispose as () => unknown : undefined
  } catch {
    return undefined
  }
}

export interface GuardedChildOptions {
  purpose: string
  published?: (agent: HostAgent) => void
  configure?: (agent: HostAgent) => (() => unknown) | void
  optional?: boolean
}

export async function startGuardedChild(
  host: ReviewToolHost,
  parent: HostAgent,
  start: () => Promise<HostSubagentRun>,
  guard: (execution: ToolExecution) => string | undefined,
  options: GuardedChildOptions,
): Promise<HostSubagentRun> {
  parent.ctx?.fiber?.assertActive()
  const { purpose, published, configure } = options
  const agents = host.agents
  const reserved = activationOwned(host.subagents)
  if (reserved && typeof agents?.get !== 'function') throw new Error(`Mnemon ${purpose} requires exact live Agent lookup`)
  if (!reserved && typeof agents?.isOwnedBy !== 'function') {
    if (options.optional === true) return start()
    throw new Error(`Mnemon ${purpose} requires DSH Agent ownership and scoped tool guard support`)
  }
  const pending = Symbol(`Mnemon ${purpose} publication`)
  const guards = new Map<HostAgent, () => unknown>()
  let attachmentError: unknown
  let expectedChildId: string | undefined
  let run: HostSubagentRun | undefined
  const listener = host.on('agent/created', (({ agent }: { agent: HostAgent }) => {
    if (startingChild.getStore() !== pending) return
    if (reserved ? agent.id !== expectedChildId || !isReservedChild(agents, parent, agent) : !agents!.isOwnedBy!(agent.id, parent)) return
    try {
      parent.ctx?.fiber?.assertActive()
      agent.ctx?.fiber?.assertActive()
      const tools = agent.ctx?.tools
      if (typeof tools?.guard !== 'function') {
        if (options.optional === true && !reserved) return
        throw new Error(`Mnemon ${purpose} requires DSH scoped tool guard support`)
      }
      const restore = configure?.(agent)
      let dispose: unknown
      try {
        dispose = tools.guard(guard)
        if (typeof dispose !== 'function') throw new Error(`Mnemon ${purpose} tool guard did not return a disposer`)
      } catch (error) {
        if (typeof restore === 'function') {
          try { restore() } catch { }
        }
        throw error
      }
      const stopGuard = dispose as () => unknown
      guards.set(agent, typeof restore === 'function' ? async () => {
        const outcomes = await Promise.allSettled([
          Promise.resolve().then(() => stopGuard()),
          Promise.resolve().then(() => restore()),
        ])
        const failed = outcomes.filter(outcome => outcome.status === 'rejected')
        if (failed.length === 1) throw failed[0]!.reason
        if (failed.length > 1) throw new AggregateError(failed.map(outcome => outcome.reason), `Mnemon ${purpose} guard cleanup failed`)
      } : stopGuard)
      published?.(agent)
    } catch (error) {
      attachmentError = error
      throw error
    }
  }) as never, { prepend: true })
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
    run = await startingChild.run(pending, () => reserved ? withReservedChild(parent, () => {
      expectedChildId = reservedChildId(parent)
      return start()
    }, true) : start())
    if (attachmentError !== undefined) throw attachmentError
    const runId = run.id
    const child = run.localAgent ?? [...guards.keys()].find(agent => agent.id === runId)
    if (child === undefined || !guards.has(child)) {
      const local = run.localAgent ?? agents?.get?.(runId)
      if (!reserved && options.optional === true && guards.size === 0 && typeof local?.ctx?.tools?.guard !== 'function') {
        await closeObserver()
        return run
      }
      throw new Error(`Mnemon ${purpose} provider did not publish a local child with its scoped tool guard`)
    }
    await closeObserver()
    const active = run
    return { id: active.id, localAgent: child, result: active.result, async dispose() {
      try { await active.dispose() } finally { await release() }
    } }
  } catch (error) {
    try { await closeObserver() } catch { }
    try { await run?.dispose() } catch { }
    try { await release() } catch { }
    throw error
  }
}
