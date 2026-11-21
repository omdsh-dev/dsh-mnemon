import { randomUUID } from 'node:crypto'
import type { HostAgent, ToolExecution } from './dsh.ts'
import { openAgentStep } from './agent-memory-turn.ts'
import { executeHostTool, usesToolBatchExecution } from './tool-execution.ts'
import type { ReviewAccessStatus } from './protocol.ts'

const RESULT_TOOL = 'mnemon_subagent_result'
const CHECK_TIMEOUT_MS = 5_000
interface Challenge { agent: HostAgent; execution?: ToolExecution; accepted: boolean }

export class AutomaticReviewAdmission {
  private readonly challenges = new Map<string, Challenge>()
  private readonly controllers = new Set<AbortController>()
  private readonly draining = new WeakSet<HostAgent>()
  private readonly statuses = new WeakMap<HostAgent, ReviewAccessStatus>()
  private disposed = false

  status(agent: HostAgent): ReviewAccessStatus {
    return { ...(this.statuses.get(agent) ?? { state: 'unchecked' }) }
  }

  acknowledge(args: unknown, execution: ToolExecution): boolean {
    if (typeof args !== 'object' || args === null || !('requestId' in args) || typeof args.requestId !== 'string') return false
    const challenge = this.challenges.get(args.requestId)
    if (challenge === undefined || challenge.agent !== execution.agent || challenge.execution !== undefined) return false
    execution.signal.throwIfAborted()
    challenge.execution = execution
    return true
  }

  dispose(): void {
    this.disposed = true
    this.challenges.clear()
    for (const controller of this.controllers) controller.abort()
  }

  async check(agent: HostAgent, signal: AbortSignal): Promise<boolean> {
    const unavailable = (reason: NonNullable<ReviewAccessStatus['reason']>): false => {
      this.statuses.set(agent, { state: 'unavailable', reason, checkedAt: new Date().toISOString() })
      return false
    }
    if (signal.aborted) { unavailable('cancelled'); signal.throwIfAborted() }
    const tools = agent.ctx.tools
    if (this.disposed) return unavailable('disposed')
    if (tools?.execute === undefined) return unavailable('executor-unavailable')
    if (this.draining.has(agent)) return unavailable('check-in-flight')
    if (openAgentStep(agent) === undefined) return unavailable('no-open-step')
    const controller = new AbortController()
    this.controllers.add(controller)
    const combined = AbortSignal.any([signal, controller.signal])
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
    timeout.unref?.()
    const attempt = async (codeMode: boolean): Promise<boolean> => {
      combined.throwIfAborted()
      const requestId = randomUUID()
      const callId = randomUUID()
      const challenge: Challenge = { agent, accepted: false }
      this.challenges.set(requestId, challenge)
      const revoke = () => this.challenges.delete(requestId)
      combined.addEventListener('abort', revoke, { once: true })
      const stops: (() => unknown)[] = []
      let approvalRequired = false
      let executing = false
      const cleanup = () => {
        for (const stop of stops.reverse()) stop()
        this.draining.delete(agent)
      }
      try {
        stops.push(agent.ctx.on('tools/result', ((execution: ToolExecution, result: { isError?: boolean }) => {
          if (execution === challenge.execution) challenge.accepted = result.isError === false
        }) as never))
        stops.push(agent.ctx.on('tools/pre-execute', (async (execution: ToolExecution, next: () => Promise<{ kind: string }>) => {
          const decision = await next()
          if (execution.agent === agent && (execution.callId === callId || execution.rootCallId === callId) && decision.kind === 'ask') {
            approvalRequired = true
            return { kind: 'cancel' }
          }
          return decision
        }) as never, { prepend: true }))
        const args = { requestId, result: {} }
        const pending = executeHostTool(tools, {
          callId, agent, signal: combined,
          name: codeMode ? 'run_code' : RESULT_TOOL,
          arguments: codeMode ? {
            description: 'Check automatic memory review availability',
            code: `await tools.mnemon_subagent_result(${JSON.stringify(args)})`,
          } : args,
        })
        executing = true
        this.draining.add(agent)
        const outcome = await pending.finally(cleanup)
        combined.throwIfAborted()
        if (challenge.execution !== undefined && challenge.accepted && outcome.isError === false) {
          this.statuses.set(agent, { state: 'available', checkedAt: new Date().toISOString() })
          return true
        }
        return unavailable(approvalRequired ? 'approval-required' : challenge.execution === undefined ? 'handler-not-reached' : 'result-rejected')
      } finally {
        this.challenges.delete(requestId)
        combined.removeEventListener('abort', revoke)
        if (!executing) cleanup()
      }
    }
    try {
      if (await attempt(false)) return true
      return (usesToolBatchExecution(tools) || tools.get?.('run_code', agent) !== undefined) && await attempt(true)
    } catch {
      unavailable(signal.aborted ? 'cancelled' : this.disposed ? 'disposed' : controller.signal.aborted ? 'timeout' : 'execution-error')
      signal.throwIfAborted()
      return false
    } finally {
      clearTimeout(timeout)
      this.controllers.delete(controller)
    }
  }
}
