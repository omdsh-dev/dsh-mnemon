import { AgentMemoryTurn, openAgentTurn } from './agent-memory-turn.ts'
import type { HostAgent, HostPreStepDecision, HostSession, HostSessionEvent, HostUserMessage, ToolExecution } from './dsh.ts'
import { applyMemoryViewGuidance } from './guidance.ts'
import { createPluginMessage } from './plugin-message.ts'
import type { MnemonAgentRuntimeSource, MnemonRuntimeGraph } from './runtime.ts'
import { modelMemoryWake } from './view-presentation.ts'

export const FINISHED_TASK_REFUSAL = 'This Mnemon task has finished. Send a new user message in this conversation to continue working with memory.'

interface Step {
  agent: HostAgent
  turn: number
  step: number
  messages: HostUserMessage[]
  signal: AbortSignal
}

interface Assembly {
  sections: Array<{ name: string; text: string }>
  contexts: Array<{ name: string; text: string }>
}

const CONTINUATION_GUIDANCE = 'This is a new user request in a completed Mnemon task conversation. The previous task stays completed. Use the current memory View and ordinary memory tools for this request; require receipts for changes. Do not repeat the previous task or submit its expired completion request.'

/** Older workers have no reserved ID: require their own Host descriptor and task contract. */
export function isLegacyMemoryTask(agent: HostAgent): boolean {
  if (agent.session.header?.origin !== 'subagent') return false
  const events = agent.session.snapshotEvents(agent.session.inheritedEventCount ?? 0)
  const descriptor = events.findLastIndex(event => event.type === 'subagent/descriptor')
  if (descriptor < 0 || typeof events[descriptor]!.data.label !== 'string' || !events[descriptor]!.data.label.startsWith('Mnemon ')) return false
  const own = events.slice(descriptor + 1)
  const textOf = (value: unknown): string => {
    const message = value as { content?: Array<{ type?: string; text?: string }> } | undefined
    return message?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') ?? ''
  }
  const prompt = own.find(event => event.type === 'user/message'
    && ((event.data.message ?? event.data) as { source?: { kind?: string } }).source?.kind === 'user')
  if (prompt === undefined || !/^\[dsh-mnemon:delegated [a-z-]+\](?:\n|$)/u.test(textOf(prompt.data.message ?? prompt.data))) return false
  // This is a Host-recorded system instruction, not a quoted user message. It
  // also identifies interrupted workers and PTC runs whose visible tool is an executor.
  return own.some(event => event.type === 'system/message'
    && textOf(event.data.message).includes('Completion protocol: call `mnemon_subagent_result` exactly once with requestId `'))
}

/** A resumed task receives memory authority only for a newly accepted human turn. */
export class TaskContinuation {
  private readonly memory: AgentMemoryTurn
  private authorizedTurn: number | undefined
  private readonly stops: Array<() => unknown> = []
  private readonly views = new Map<string, MnemonRuntimeGraph>()
  private closed = false

  constructor(private readonly agent: HostAgent, private readonly runtime: MnemonAgentRuntimeSource, private readonly liveAgent: (id: string) => HostAgent | undefined) {
    this.memory = new AgentMemoryTurn(agent, runtime, undefined, true)
  }

  start(): () => void {
    try {
      const guard = this.agent.ctx.tools?.guard?.(execution => this.guard(execution))
      if (typeof guard !== 'function') throw new Error('Task continuation requires a scoped memory tool guard')
      this.stops.push(guard as () => unknown)
      this.stops.push(this.agent.ctx.on('agent/pre-step', ((step: Step, next: () => Promise<HostPreStepDecision>) => this.preStep(step, next)) as never, { prepend: true }))
      this.stops.push(this.agent.ctx.on('system-prompt/assemble', (async (_assembly: Assembly, context: { agent?: HostAgent }, next: () => Promise<Assembly>) => {
        const assembly = await next()
        if (context.agent !== undefined && context.agent !== this.agent) return assembly
        const pin = this.memory.current
        return applyMemoryViewGuidance(assembly, pin?.context.view, pin?.graph.config.routingGuidance)
      }) as never))
      this.stops.push(this.agent.ctx.on('session/event', ((session: HostSession, event: HostSessionEvent) => {
        if (session === this.agent.session && event.type === 'turn/end' && event.data.turn === this.authorizedTurn) this.end()
      }) as never))
      return () => this.dispose()
    } catch (error) { this.dispose(); throw error }
  }

  ownsHumanTurn(actor: HostAgent): boolean {
    return !this.closed && actor === this.agent && this.liveAgent(actor.id) === actor
      && this.authorizedTurn !== undefined && this.memory.current?.turn === this.authorizedTurn
      && openAgentTurn(actor) === this.authorizedTurn
  }

  guard(execution: ToolExecution): string | undefined {
    if (!execution.name?.startsWith('mnemon_')) return undefined
    const actor = execution.agent
    if (this.closed || actor === undefined || this.liveAgent(actor.id) !== actor) return FINISHED_TASK_REFUSAL
    if (actor !== this.agent) {
      // Delegation can outlive its parent's turn only while it holds one of the
      // actual user-issued Views. A new automatic child cannot acquire a grant.
      try {
        const graph = this.runtime.forAgent(actor)
        const pin = graph.composableTurns.activeTurn(actor.id)
        if (pin !== undefined && this.views.get(pin.view.id) === graph) return undefined
      } catch { /* A missing/disposed graph cannot grant continuation authority. */ }
      return FINISHED_TASK_REFUSAL
    }
    if (this.authorizedTurn === undefined) return FINISHED_TASK_REFUSAL
    if (execution.name === 'mnemon_subagent_result') return 'The previous Mnemon task result is already settled. Use ordinary memory tools for the new user request.'
    if (this.memory.current?.turn !== this.authorizedTurn) return this.memory.unavailableReason ?? 'Memory is unavailable for this request.'
    return undefined
  }

  private async preStep(step: Step, next: () => Promise<HostPreStepDecision>): Promise<HostPreStepDecision> {
    const decision = await next()
    if (step.agent !== this.agent) return decision
    if (decision.kind === 'reject' || step.signal.aborted || this.closed || this.liveAgent(this.agent.id) !== this.agent) {
      this.end()
      return decision
    }
    const starting = this.authorizedTurn !== step.turn
    if (starting) this.end()
    if (decision.messages.some(message => message.source.kind === 'user'
      && message.content.some(block => block.type !== 'text' || (block.text?.trim().length ?? 0) > 0))) this.authorizedTurn = step.turn
    if (this.authorizedTurn !== step.turn || openAgentTurn(this.agent) !== step.turn) return decision
    try { await this.memory.begin(step.turn, step.signal) } catch (error) { this.end(); throw error }
    const pin = this.memory.current
    for (const [id, graph] of this.views) if (graph.composableTurns.get(id) === undefined) this.views.delete(id)
    if (pin !== undefined) this.views.set(pin.context.view.id, pin.graph)
    if (!starting && step.step !== 1) return decision
    const wake = pin === undefined ? '' : modelMemoryWake(pin.graph, pin.context).text
    return { ...decision, messages: [...decision.messages, createPluginMessage(`${CONTINUATION_GUIDANCE}\n\n${wake}`, 'instructions')] }
  }

  private end(): void {
    this.authorizedTurn = undefined
    this.memory.end()
  }

  private dispose(): void {
    if (this.closed) return
    this.closed = true
    try { for (const stop of this.stops.splice(0).reverse()) stop() }
    finally { this.authorizedTurn = undefined; this.memory.dispose(); this.views.clear() }
  }
}
