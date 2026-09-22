import { AsyncLocalStorage } from 'node:async_hooks'
import type { HostAgent, HostSubagentRun, ToolExecution } from './dsh.ts'

export interface ReviewToolHost {
  agents?: { isOwnedBy?(id: string, parent: HostAgent): boolean }
  on(name: string, listener: (...args: never[]) => unknown): unknown
}

// One store distinguishes nested starts as well as independent overlapping starts.
const startingReview = new AsyncLocalStorage<symbol>()

/**
 * The published Agent Teams alpha.2 tool suite installs its policy before a
 * provider publishes a child descriptor. Both rc.2 in-process providers then
 * lose membership on step two. Inspect public services/capabilities only and
 * skip before creating a child; do not remove another plugin's policy.
 */
export function idleReviewBlockReason(parent: HostAgent): 'agent-team' | undefined {
  return parent.ctx?.get?.('agentTeams') !== undefined
    && parent.ctx.tools?.get?.('spawn_teammate', parent) !== undefined ? 'agent-team' : undefined
}

/**
 * DSH restrict() filters inherited capabilities, leaving own-scope plugin tools
 * visible. Attach its monotonic execution guard during publication, before a
 * review child can run. Async context attributes concurrent provider starts;
 * public registry ownership verifies the exact causal parent.
 */
export async function startGuardedReview(
  host: ReviewToolHost,
  parent: HostAgent,
  toolNames: readonly string[],
  start: () => Promise<HostSubagentRun>,
  published?: (agent: HostAgent) => void,
): Promise<HostSubagentRun> {
  const agents = host.agents
  if (typeof agents?.isOwnedBy !== 'function') throw new Error('Mnemon review requires DSH Agent ownership and scoped tool guard support')
  const pending = Symbol('Mnemon review publication')
  const allowed = new Set(toolNames)
  const guards = new Map<HostAgent, () => unknown>()
  let attachmentError: unknown
  let run: HostSubagentRun | undefined
  const listener = host.on('agent/created', (({ agent }: { agent: HostAgent }) => {
    if (startingReview.getStore() !== pending || !agents.isOwnedBy!(agent.id, parent)) return
    try {
      const tools = agent.ctx.tools
      if (typeof tools?.guard !== 'function') throw new Error('Mnemon review requires DSH scoped tool guard support')
      const dispose = tools.guard((execution: ToolExecution) => {
        // PTC is a transport: DSH also guards each end-capability sub-dispatch.
        if (execution.name === 'run_code' || (execution.name !== undefined && allowed.has(execution.name))) return
        return `Mnemon review cannot execute ${JSON.stringify(execution.name)}; reuse the inherited checkpoint and bounded Document search.`
      })
      if (typeof dispose !== 'function') throw new Error('Mnemon review tool guard did not return a disposer')
      guards.set(agent, dispose as () => unknown)
      published?.(agent)
    } catch (error) {
      attachmentError = error
      // Synchronous publication failure lets the provider roll back the child.
      throw error
    }
  }) as never)
  if (typeof listener !== 'function') throw new Error('Mnemon review creation observer did not return a disposer')
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
    if (failed.length) throw new AggregateError(failed.map(outcome => outcome.reason), 'Mnemon review guard cleanup failed')
  }
  try {
    run = await startingReview.run(pending, start)
    if (attachmentError !== undefined) throw attachmentError
    const child = run.localAgent
    if (child === undefined || !guards.has(child)) {
      throw new Error('Mnemon review provider did not publish a local child with its scoped tool guard')
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
