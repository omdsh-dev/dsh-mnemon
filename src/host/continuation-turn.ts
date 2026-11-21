import { AsyncLocalStorage } from 'node:async_hooks'
import type { HostAgent, HostPreStepDecision, HostSubagentRun, HostUserMessage } from './dsh.ts'
import { createPluginMessage } from './plugin-message.ts'
import { activationOwned, contextIsActive, isReservedChild, reservedChildId, withReservedChild, type ActivationOwnership } from './agent-compat.ts'

export const CONTINUATION_TEXT = 'Continue from the tool results above.'

const NO_USER_QUERY = /no user query found in messages/iu
const MALFORMED_RESULT = /^Tool call "mnemon_subagent_result": /u
export const RESULT_RETRY_TEXT = 'The model adapter rejected the mnemon_subagent_result arguments before executing the call. Submit only the result again, using the same requestId and the required result schema. Use complete valid JSON: close the result object and then the outer arguments object, including every final brace and bracket. Do not repeat completed writes or other work. Do not return a plain-text answer.'

export interface ContinuationHost {
  agents?: { isOwnedBy?(id: string, parent: HostAgent): boolean; get?(id: string): HostAgent | undefined }
  subagents?: ActivationOwnership
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): unknown
}

interface PreStepPayload {
  messages: HostUserMessage[]
  step: number
  signal: AbortSignal
}

interface RequestErrorPayload {
  turn: number
  step: number
  failure?: { message?: string; code?: string }
  signal: AbortSignal
}

const startingChild = new AsyncLocalStorage<symbol>()

function hasUserText(message: HostUserMessage): boolean {
  return message.role === 'user' && message.content.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '')
}

function continueAfterRefusal(agent: HostAgent): Array<() => unknown> {
  if (typeof agent.ctx?.on !== 'function' || !contextIsActive(agent.ctx)) return []
  let refused = false
  let retriedResult = false
  const retried = new Set<string>()
  const turn = () => createPluginMessage(CONTINUATION_TEXT, 'instructions')
  return [
    agent.ctx.on('agent/request-error', (async (payload: RequestErrorPayload, next: () => Promise<unknown>) => {
      const step = `${payload.turn}:${payload.step}`
      const session = agent.session
      if (payload.signal.aborted || typeof session.append !== 'function') return next()
      if (!retriedResult && payload.failure?.code === 'MALFORMED_RESPONSE' && MALFORMED_RESULT.test(payload.failure.message ?? '')) {
        retriedResult = true
        session.append('user/message', createPluginMessage(RESULT_RETRY_TEXT, 'instructions'), { surfaceOp: 'append' })
        return { kind: 'retry' }
      }
      if (payload.step < 2 || retried.has(step)
        || !NO_USER_QUERY.test(payload.failure?.message ?? '')) return next()
      retried.add(step)
      refused = true
      session.append('user/message', turn(), { surfaceOp: 'append' })
      return { kind: 'retry' }
    }) as never, { prepend: true }),
    agent.ctx.on('agent/pre-step', (async (payload: PreStepPayload, next: () => Promise<HostPreStepDecision>) => {
      const decision = await next()
      if (!refused || payload.step === 1 || payload.signal.aborted || decision.kind !== 'enter') return decision
      if (payload.messages.length > 0 && decision.messages.length === 0) return decision
      if (decision.messages.some(hasUserText)) return decision
      return { ...decision, messages: [...decision.messages, turn()] }
    }) as never, { prepend: true }),
  ]
}

export function attachContinuationTurns(agent: HostAgent): () => void {
  const stops = continueAfterRefusal(agent)
  return () => { for (const stop of stops.splice(0)) stop() }
}

export async function startWithContinuationTurns(host: ContinuationHost, parent: HostAgent, start: () => Promise<HostSubagentRun>): Promise<HostSubagentRun> {
  parent.ctx?.fiber?.assertActive()
  const reserved = activationOwned(host.subagents)
  const pending = Symbol('Mnemon delegated start')
  const stops: Array<() => unknown> = []
  let expectedChildId: string | undefined
  const listener = host.on('agent/created', (({ agent }: { agent: HostAgent }) => {
    if (startingChild.getStore() !== pending) return
    if (!contextIsActive(parent.ctx) || !contextIsActive(agent.ctx)) return
    if (reserved && (agent.id !== expectedChildId || !isReservedChild(host.agents, parent, agent))) return
    if (typeof host.agents?.isOwnedBy === 'function' && !host.agents.isOwnedBy(agent.id, parent)) return
    for (const stop of continueAfterRefusal(agent)) if (typeof stop === 'function') stops.push(stop)
  }) as never, { prepend: true })
  const release = async () => { for (const stop of stops.splice(0)) await stop() }
  let run: HostSubagentRun
  try {
    run = await startingChild.run(pending, () => reserved ? withReservedChild(parent, () => {
      expectedChildId = reservedChildId(parent)
      return start()
    }) : start())
  } catch (error) {
    await release()
    throw error
  } finally {
    if (typeof listener === 'function') await listener()
  }
  const active = run
  return { id: active.id, ...(active.localAgent === undefined ? {} : { localAgent: active.localAgent }), result: active.result, async dispose() {
    try { await active.dispose() } finally { await release() }
  } }
}
