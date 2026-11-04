import { AsyncLocalStorage } from 'node:async_hooks'
import type { HostAgent, HostSubagentProvider, HostSubagentRun, HostSubagentStartRequest, HostSubagentsService } from './dsh.ts'

/** The Agent registry lookups that find an activation's local child. */
export interface SubagentStartAgents {
  get?(id: string): HostAgent | undefined
  isOwnedBy?(id: string, parent: HostAgent): boolean
}

/** Where DSH reports each Agent it publishes, before the Agent's first step. */
export interface SubagentPublications {
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): unknown
}

/** A delegated child's own tools and persona. */
type ChildComposition = Pick<HostSubagentStartRequest, 'toolFilter' | 'persona'>

/** DSH's deployment persona, which a child's own section of the same name replaces for that child. */
const PERSONA_SECTION = 'deployment:persona-prefix'

// Distinguishes overlapping starts, as continuation-turn.ts does.
const composingChild = new AsyncLocalStorage<symbol>()

/**
 * How a provider gives a delegated child its own tools and persona:
 * - `request`: on DSH 0.2.0 the start request carries both, and DSH applies
 *   them in the child's own scope;
 * - `publication`: DSH 0.2.1 takes neither, in the request or from any
 *   provider, and a child joins its parent's composition, so Mnemon applies
 *   them in the child's scope itself while DSH publishes the child.
 *   Only for a provider whose children DSH creates in this process: one that
 *   prepares local activations, as DSH's spawn and fork do;
 * - undefined: neither, so the provider is not used.
 */
export function childComposition(subagents: Pick<HostSubagentsService, 'startActivation'>, provider: HostSubagentProvider | undefined): 'request' | 'publication' | undefined {
  const capabilities = provider?.capabilities
  if (capabilities === undefined) return undefined
  if (capabilities.toolFilter === true && capabilities.persona === true) return 'request'
  const local = typeof subagents.startActivation === 'function' && typeof provider?.prepareContinuable === 'function'
  return local && !Object.hasOwn(capabilities, 'toolFilter') && !Object.hasOwn(capabilities, 'persona') ? 'publication' : undefined
}

/**
 * Start one delegated child through the subagent API the running DSH offers:
 * DSH 0.2.0 runs it with the one-shot `start`, DSH 0.2.1 as a managed
 * activation (#356). An activation keeps a run's contract:
 * - caller delivery returns the result to Mnemon, so the parent conversation
 *   gets no completion notice;
 * - its signal covers only startup, so a later abort disposes the child, which
 *   is how an aborted run stopped;
 * - the live child in the Agent registry stands in for `localAgent`.
 *
 * The child's tools and persona stay in the request where the provider takes
 * them, as on DSH 0.2.0. On DSH 0.2.1 they are registered in the child's own
 * scope as DSH publishes it, after DSH has composed it and before its first
 * step, which needs `publications`.
 */
export async function startSubagent(
  subagents: HostSubagentsService,
  agents: SubagentStartAgents | undefined,
  provider: string,
  request: HostSubagentStartRequest & { label: string },
  publications?: SubagentPublications,
): Promise<HostSubagentRun> {
  const { toolFilter, persona, ...task } = request
  if ((toolFilter === undefined && persona === undefined) || childComposition(subagents, subagents.getProvider(provider)) !== 'publication') {
    return startOnHost(subagents, agents, provider, request)
  }
  if (publications === undefined) throw new Error('This DSH takes no subagent persona or tool filter at start, and dsh-mnemon cannot observe the child it publishes')
  const composition: ChildComposition = { ...(toolFilter === undefined ? {} : { toolFilter }), ...(persona === undefined ? {} : { persona }) }
  return startComposed(publications, agents, request.parent, composition, () => startOnHost(subagents, agents, provider, task))
}

async function startOnHost(
  subagents: HostSubagentsService,
  agents: SubagentStartAgents | undefined,
  provider: string,
  request: HostSubagentStartRequest & { label: string },
): Promise<HostSubagentRun> {
  if (typeof subagents.startActivation === 'function') {
    const { label, signal, ...task } = request
    const activation = await subagents.startActivation({ provider, label, request: task, signal, delivery: 'caller' })
    // A second dispose from the caller reports any failure of this one.
    const stop = () => { activation.dispose().catch(() => {}) }
    try {
      const release = () => signal.removeEventListener('abort', stop)
      signal.addEventListener('abort', stop, { once: true })
      void activation.result.then(release, release)
      if (signal.aborted) stop()
      // The child is resident until the activation settles, which takes at least one model turn.
      const child = agents?.get?.(activation.childId)
      const localAgent = child !== undefined && (typeof agents?.isOwnedBy !== 'function' || agents.isOwnedBy(child.id, request.parent)) ? child : undefined
      return {
        id: activation.childId,
        ...(localAgent === undefined ? {} : { localAgent }),
        result: activation.result,
        dispose: () => activation.dispose(),
      }
    } catch (error) {
      // The caller never received this run, so nothing else would release the child.
      stop()
      throw error
    }
  }
  if (typeof subagents.start === 'function') return subagents.start(provider, request)
  throw new Error('This DSH has neither subagents.startActivation nor subagents.start, so dsh-mnemon cannot start its memory subagent; install a dsh-mnemon release that supports this DSH version')
}

/**
 * Register the child's persona and tool filter in its own scope, as DSH 0.2.1
 * still does for a child an earlier release recorded with them:
 * the persona replaces the deployment persona and the filter narrows the tools
 * the child shares with its parent, for that child alone. Its scope releases
 * both with it.
 */
function compose(agent: HostAgent, { toolFilter, persona }: ChildComposition): void {
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
}

/**
 * Start a child and compose it while DSH publishes it, ahead of other plugins'
 * listeners. Async context attributes concurrent starts, and DSH's ownership
 * check confirms the parent. A failed composition makes DSH roll the child
 * back; a child that was not seen published is disposed and refused.
 */
async function startComposed(
  publications: SubagentPublications,
  agents: SubagentStartAgents | undefined,
  parent: HostAgent,
  composition: ChildComposition,
  start: () => Promise<HostSubagentRun>,
): Promise<HostSubagentRun> {
  const pending = Symbol('Mnemon child composition')
  const composed = new Set<string>()
  let failure: unknown
  const listener = publications.on('agent/created', (({ agent }: { agent: HostAgent }) => {
    if (composingChild.getStore() !== pending) return
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
    // Stop observing before handing the run over; a failure here takes the same path as a failed start.
    await closeObserver()
    return run
  } catch (error) {
    try { await closeObserver() } catch { /* Preserve the start failure. */ }
    // The caller never receives this run, so nothing else would stop the child.
    try { await run?.dispose() } catch { /* Preserve the start failure. */ }
    throw error
  }
}
