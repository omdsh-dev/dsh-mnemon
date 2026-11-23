import { randomUUID } from 'node:crypto'
import type { HostAgent, HostAgentContext, ToolExecution } from './dsh.ts'
import { openAgentStep } from './agent-memory-turn.ts'
import { executeHostTool, usesToolBatchExecution } from './tool-execution.ts'
import type { ReviewAccessStatus } from './protocol.ts'

const RESULT_TOOL = 'mnemon_subagent_result'
const RUN_CODE_TOOL = 'run_code'
const CHECK_TIMEOUT_MS = 5_000
const PROBE_DESCRIPTION = 'Check automatic memory review availability'

type HostTools = NonNullable<HostAgentContext['tools']>
interface AdmissionEventHost {
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): unknown
}
interface Challenge { agent: HostAgent | undefined; execution?: ToolExecution; accepted: boolean }

function isAutoPermissionPreset(agent: HostAgent): boolean {
  const permissionPresets = agent.ctx.get?.('permissionPresets') as { current?(session: unknown): unknown } | undefined
  try {
    return permissionPresets?.current?.(agent.session) === 'auto'
  } catch {
    return false
  }
}

function resultToolVisible(tools: HostTools, agent?: HostAgent): boolean {
  if (typeof tools.executable === 'function') return tools.executable(RESULT_TOOL, agent) !== undefined
  if (typeof tools.get === 'function') return tools.get(RESULT_TOOL, agent) !== undefined
  return true
}

function probeCode(args: Record<string, unknown>): string {
  return `await tools.mnemon_subagent_result(${JSON.stringify(args)})`
}

function deniedByAgentGuards(
  tools: HostTools, agent: HostAgent, signal: AbortSignal, callId: string,
  args: { requestId: string; result: Record<string, never> }, codeMode: boolean,
): boolean {
  const check = (name: string, input: Record<string, unknown>, parent?: symbol): boolean => tools.checkGuards?.(Object.freeze({
    token: Symbol('mnemon-review-admission'),
    callId,
    rootCallId: callId,
    name,
    arguments: Object.freeze(input),
    agent,
    signal,
    ...(parent === undefined ? {} : { parent }),
  })) !== undefined
  if (!codeMode) return check(RESULT_TOOL, args)
  return check(RUN_CODE_TOOL, { description: PROBE_DESCRIPTION, code: probeCode(args) })
    || check(RESULT_TOOL, args, Symbol('mnemon-review-admission-parent'))
}

export class AutomaticReviewAdmission {
  private readonly challenges = new Map<string, Challenge>()
  private readonly controllers = new Set<AbortController>()
  private readonly draining = new WeakSet<HostAgent>()
  private readonly statuses = new WeakMap<HostAgent, ReviewAccessStatus>()
  private disposed = false

  constructor(private readonly host?: AdmissionEventHost) {}

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
    const standaloneHost = usesToolBatchExecution(tools) && typeof tools.checkGuards === 'function' && isAutoPermissionPreset(agent)
      ? this.host : undefined
    const probeAgent = standaloneHost === undefined ? agent : undefined
    const eventHost = standaloneHost ?? agent.ctx
    const controller = new AbortController()
    this.controllers.add(controller)
    const combined = AbortSignal.any([signal, controller.signal])
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
    timeout.unref?.()
    const attempt = async (codeMode: boolean): Promise<'available' | 'unknown-tool' | 'rejected'> => {
      combined.throwIfAborted()
      const requestId = randomUUID()
      const callId = randomUUID()
      const args = { requestId, result: Object.freeze({}) }
      if (standaloneHost !== undefined && deniedByAgentGuards(tools, agent, combined, callId, args, codeMode)) {
        unavailable('handler-not-reached')
        return 'rejected'
      }
      const challenge: Challenge = { agent: probeAgent, accepted: false }
      this.challenges.set(requestId, challenge)
      const revoke = () => this.challenges.delete(requestId)
      combined.addEventListener('abort', revoke, { once: true })
      const stops: (() => unknown)[] = []
      const track = (disposer: unknown) => {
        if (typeof disposer === 'function') stops.push(disposer as () => unknown)
      }
      let approvalRequired = false
      let executing = false
      const cleanup = () => {
        for (const stop of stops.reverse()) stop()
        this.draining.delete(agent)
      }
      try {
        track(eventHost.on('tools/result', ((execution: ToolExecution, result: { isError?: boolean }) => {
          if (execution === challenge.execution) challenge.accepted = result.isError === false
        }) as never))
        track(eventHost.on('tools/pre-execute', (async (execution: ToolExecution, next: () => Promise<{ kind: string }>) => {
          const decision = await next()
          if (execution.agent === probeAgent && (execution.callId === callId || execution.rootCallId === callId) && decision.kind === 'ask') {
            approvalRequired = true
            return { kind: 'cancel' }
          }
          return decision
        }) as never, { prepend: true }))
        const pending = executeHostTool(tools, {
          callId, signal: combined,
          ...(probeAgent === undefined ? {} : { agent: probeAgent }),
          name: codeMode ? RUN_CODE_TOOL : RESULT_TOOL,
          arguments: codeMode ? {
            description: PROBE_DESCRIPTION,
            code: probeCode(args),
          } : args,
        })
        executing = true
        this.draining.add(agent)
        const outcome = await pending.finally(cleanup)
        combined.throwIfAborted()
        if (challenge.execution !== undefined && challenge.accepted && outcome.isError === false) {
          this.statuses.set(agent, { state: 'available', checkedAt: new Date().toISOString() })
          return 'available'
        }
        unavailable(approvalRequired ? 'approval-required' : challenge.execution === undefined ? 'handler-not-reached' : 'result-rejected')
        return outcome.error?.info?.code === 'UNKNOWN_TOOL' ? 'unknown-tool' : 'rejected'
      } finally {
        this.challenges.delete(requestId)
        combined.removeEventListener('abort', revoke)
        if (!executing) cleanup()
      }
    }
    try {
      if (standaloneHost !== undefined && (!resultToolVisible(tools, agent) || !resultToolVisible(tools))) {
        return unavailable('handler-not-reached')
      }
      const native = await attempt(false)
      if (native === 'available') return true
      const tryCodeMode = standaloneHost !== undefined
        ? native === 'unknown-tool'
        : usesToolBatchExecution(tools) || tools.get?.(RUN_CODE_TOOL, agent) !== undefined
      return tryCodeMode && await attempt(true) === 'available'
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
