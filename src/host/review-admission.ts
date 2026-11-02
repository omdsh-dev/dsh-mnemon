import { randomUUID } from 'node:crypto'
import type { HostAgent, ToolExecution } from './dsh.ts'
import { openAgentTurn } from './agent-memory-turn.ts'

const RESULT_TOOL = 'mnemon_subagent_result'
const CHECK_TIMEOUT_MS = 5_000
interface Challenge { agent: HostAgent; execution?: ToolExecution; accepted: boolean }

/** An in-turn no-op challenge through the mandatory review completion channel.
 * Inventory alone cannot see execution-time guards. No errors are classified as
 * permission failures, and an unavailable checkpoint is never a permanent ban.
 */
export class AutomaticReviewAdmission {
  private readonly challenges = new Map<string, Challenge>()
  private readonly controllers = new Set<AbortController>()
  private readonly draining = new WeakSet<HostAgent>()
  private disposed = false

  /** Only an unexpired, host-issued challenge for this exact Agent can no-op. */
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
    signal.throwIfAborted()
    const tools = agent.ctx.tools
    // PTC records durable dispatch events on this Agent. They are valid only
    // inside a real turn, whose stopping hook must await this entire check.
    if (this.disposed || tools?.execute === undefined || this.draining.has(agent) || openAgentTurn(agent) === undefined) return false
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
      let executing = false
      const cleanup = () => {
        for (const stop of stops.reverse()) stop()
        this.draining.delete(agent)
      }
      try {
        stops.push(agent.ctx.on('tools/result', ((execution: ToolExecution, result: { isError?: boolean }) => {
          if (execution === challenge.execution) challenge.accepted = result.isError === false
        }) as never))
        // Automatic admission must not open an approval prompt. Preserve all
        // other decisions and guards; an approval requirement means skip now.
        stops.push(agent.ctx.on('tools/pre-execute', (async (execution: ToolExecution, next: () => Promise<{ kind: string }>) => {
          const decision = await next()
          return execution.agent === agent && (execution.callId === callId || execution.rootCallId === callId) && decision.kind === 'ask'
            ? { kind: 'cancel' } : decision
        }) as never, { prepend: true }))
        const args = { requestId, result: {} }
        const pending = tools.execute!({
          callId, agent, signal: combined,
          name: codeMode ? 'run_code' : RESULT_TOOL,
          arguments: codeMode ? {
            description: 'Check automatic memory review availability',
            code: `await tools.mnemon_subagent_result(${JSON.stringify(args)})`,
          } : args,
        })
        executing = true
        this.draining.add(agent)
        // Cancellation requests a stop, never abandons PTC's dispatch/log
        // drain. Letting turn-stopping return early would append turn/end
        // before a delayed settle event and make the whole Session unreadable.
        const outcome = await pending.finally(cleanup)
        combined.throwIfAborted()
        return challenge.execution !== undefined && challenge.accepted && outcome.isError === false
      } finally {
        // Revoke even if an extension ignores cancellation and returns later.
        this.challenges.delete(requestId)
        combined.removeEventListener('abort', revoke)
        if (!executing) cleanup()
      }
    }
    try {
      // Native-first also handles DSH's `both` presentation when run_code is
      // denied. Pure Code Mode rejects native dispatch before policy; fallback
      // uses a real run_code execution, never a fabricated parent token.
      if (await attempt(false)) return true
      return tools.get?.('run_code', agent) !== undefined && await attempt(true)
    } catch {
      signal.throwIfAborted()
      return false
    } finally {
      clearTimeout(timeout)
      this.controllers.delete(controller)
    }
  }
}
