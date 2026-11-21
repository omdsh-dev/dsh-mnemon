import { AsyncLocalStorage } from 'node:async_hooks'
import type { HostAgent, HostSubagentProvider, HostSubagentRun, HostSubagentStartRequest, HostSubagentsService } from './dsh.ts'
import { activationOwned, claimReservedChild, isReservedChild, reservedChildId, titleTask, withReservedChild } from './agent-compat.ts'

export interface SubagentStartAgents {
  get?(id: string): HostAgent | undefined
  isOwnedBy?(id: string, parent: HostAgent): boolean
}

export interface SubagentPublications {
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): unknown
}

type ChildComposition = Pick<HostSubagentStartRequest, 'toolFilter' | 'persona'> & { setup?: (agent: HostAgent) => void }

const PERSONA_SECTION = 'deployment:persona-prefix'

const composingChild = new AsyncLocalStorage<symbol>()

export function childComposition(subagents: Pick<HostSubagentsService, 'startActivation'>, provider: HostSubagentProvider | undefined): 'request' | 'publication' | undefined {
  const capabilities = provider?.capabilities
  if (capabilities === undefined) return undefined
  if (capabilities.toolFilter === true && capabilities.persona === true) return 'request'
  const local = typeof subagents.startActivation === 'function' && typeof provider?.prepareContinuable === 'function'
  return local && !Object.hasOwn(capabilities, 'toolFilter') && !Object.hasOwn(capabilities, 'persona') ? 'publication' : undefined
}

export async function startSubagent(
  subagents: HostSubagentsService,
  agents: SubagentStartAgents | undefined,
  provider: string,
  request: HostSubagentStartRequest & { label: string },
  publications?: SubagentPublications,
  setup?: (agent: HostAgent) => void,
): Promise<HostSubagentRun> {
  if (typeof subagents.startActivation === 'function' && reservedChildId(request.parent) === undefined) {
    return withReservedChild(request.parent, () => startSubagent(subagents, agents, provider, request, publications, setup))
  }
  const { toolFilter, persona, ...task } = request
  if (setup === undefined && toolFilter === undefined && persona === undefined) {
    return startOnHost(subagents, agents, provider, request)
  }
  if (childComposition(subagents, subagents.getProvider(provider)) !== 'publication') {
    if (setup !== undefined) throw new Error('DSH cannot compose this local subagent before its first step')
    return startOnHost(subagents, agents, provider, request)
  }
  if (publications === undefined) throw new Error('This DSH takes no subagent persona or tool filter at start, and dsh-mnemon cannot observe the child it publishes')
  const composition: ChildComposition = { ...(toolFilter === undefined ? {} : { toolFilter }), ...(persona === undefined ? {} : { persona }), ...(setup === undefined ? {} : { setup }) }
  return startComposed(publications, agents, request.parent, composition, () => startOnHost(subagents, agents, provider, task), activationOwned(subagents))
}

async function startOnHost(
  subagents: HostSubagentsService,
  agents: SubagentStartAgents | undefined,
  provider: string,
  request: HostSubagentStartRequest & { label: string },
): Promise<HostSubagentRun> {
  if (typeof subagents.startActivation === 'function') {
    const { label, signal, name, ...task } = request
    const modern = activationOwned(subagents)
    const childId = claimReservedChild(request.parent)
    if (modern && (childId === undefined || agents?.get?.(request.parent.id) !== request.parent)) {
      throw new Error('Mnemon requires an exact live parent and reserved child identity on an activation-owned DSH')
    }
    const startCurrent = subagents.startActivation as unknown as (spec: Omit<HostSubagentStartRequest, 'label'> & { provider: string; label: string; childId: string; delivery: 'caller' }) => ReturnType<NonNullable<HostSubagentsService['startActivation']>>
    const activation = modern
      ? await startCurrent.call(subagents, { ...task, provider, label, signal, childId: childId!, delivery: 'caller',
        ...('resolveName' in subagents && typeof subagents.resolveName === 'function' && name !== undefined ? { name } : {}),
      })
      : await subagents.startActivation({ provider, label, ...(childId === undefined ? {} : { childId }), request: task, signal, delivery: 'caller' })
    const stop = () => { activation.dispose().catch(() => {}) }
    try {
      const release = () => signal.removeEventListener('abort', stop)
      signal.addEventListener('abort', stop, { once: true })
      void activation.result.then(release, release)
      if (signal.aborted) stop()
      const child = agents?.get?.(activation.childId)
      if (modern && (activation.childId !== childId || child === undefined || !isReservedChild(agents, request.parent, child))) {
        throw new Error('DSH did not return the reserved live Mnemon child')
      }
      if (modern && child !== undefined) titleTask(child, label.startsWith('Mnemon ') ? label : `Mnemon · ${label}`)
      const localAgent = child !== undefined && (modern || typeof agents?.isOwnedBy !== 'function' || agents.isOwnedBy(child.id, request.parent)) ? child : undefined
      return {
        id: activation.childId,
        ...(activation.messageId === undefined ? {} : { messageId: activation.messageId }),
        ...(localAgent === undefined ? {} : { localAgent }),
        result: activation.result,
        dispose: () => activation.dispose(),
      }
    } catch (error) {
      stop()
      throw error
    }
  }
  if (typeof subagents.start === 'function') {
    const { name: _name, ...legacy } = request
    return subagents.start(provider, legacy)
  }
  throw new Error('This DSH has neither subagents.startActivation nor subagents.start, so dsh-mnemon cannot start its memory subagent; install a dsh-mnemon release that supports this DSH version')
}

function compose(agent: HostAgent, { toolFilter, persona, setup }: ChildComposition): void {
  const prompt = agent.ctx.systemPrompt
  const tools = agent.ctx.tools
  if (persona !== undefined && (typeof prompt?.section !== 'function' || typeof prompt.getSectionOrder !== 'function')) {
    throw new Error('DSH gives this memory subagent no prompt section of its own, so dsh-mnemon cannot give it its instructions')
  }
  if (toolFilter !== undefined && typeof tools?.restrict !== 'function') {
    throw new Error('DSH gives this memory subagent no tool restriction of its own, so dsh-mnemon cannot limit it to its memory tools')
  }
  if (persona !== undefined) prompt!.section!({ name: PERSONA_SECTION, order: prompt!.getSectionOrder!('DEPLOYMENT_PERSONA_PREFIX'), text: persona })
  if (toolFilter !== undefined) tools!.restrict!(toolFilter)
  setup?.(agent)
}

async function startComposed(
  publications: SubagentPublications,
  agents: SubagentStartAgents | undefined,
  parent: HostAgent,
  composition: ChildComposition,
  start: () => Promise<HostSubagentRun>,
  reserved = false,
): Promise<HostSubagentRun> {
  const pending = Symbol('Mnemon child composition')
  const expectedChildId = reserved ? reservedChildId(parent) : undefined
  const composed = new Set<string>()
  let failure: unknown
  const listener = publications.on('agent/created', (({ agent }: { agent: HostAgent }) => {
    if (composingChild.getStore() !== pending) return
    if (reserved && (agent.id !== expectedChildId || !isReservedChild(agents, parent, agent))) return
    if (typeof agents?.isOwnedBy === 'function' && !agents.isOwnedBy(agent.id, parent)) return
    try {
      compose(agent, composition)
      composed.add(agent.id)
    } catch (error) {
      failure = error
      throw error
    }
  }) as never, { prepend: true })
  if (typeof listener !== 'function') throw new Error('dsh-mnemon could not observe the memory subagent DSH creates, so it does not start one')
  let stopObserving: (() => unknown) | undefined = listener as () => unknown
  const closeObserver = async () => {
    const stop = stopObserving
    stopObserving = undefined
    await stop?.()
  }
  let run: HostSubagentRun | undefined
  try {
    run = await composingChild.run(pending, start)
    if (failure !== undefined) throw failure
    if (!composed.has(run.id)) throw new Error(`dsh-mnemon did not see memory subagent ${run.id} created, so it could not give it its own instructions and tools`)
    await closeObserver()
    return run
  } catch (error) {
    try { await closeObserver() } catch { }
    try { await run?.dispose() } catch { }
    throw error
  }
}
