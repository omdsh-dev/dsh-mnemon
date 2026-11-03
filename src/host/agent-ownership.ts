import { AsyncLocalStorage } from 'node:async_hooks'
import type { HostAgent } from './dsh.ts'

/** Public runtime relations; durable Session headers are never ownership authority. */
export interface AgentOwnershipHost {
  agents?: {
    get?(id: string): HostAgent | undefined
    list?(): HostAgent[]
    roots?(): HostAgent[]
    isOwnedBy?(id: string, parent: HostAgent): boolean
  } | undefined
  subagents?: {
    rootOf?(agent: HostAgent): HostAgent
    lineageOf?(agent: HostAgent): { readonly root: HostAgent; readonly ancestors: readonly string[] } | undefined
  }
}

export interface AgentPublicationHost extends AgentOwnershipHost {
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }): unknown
}

/** Mnemon-started activations cancel admission when subagent/start contains a hook exception. */
const starting = new AsyncLocalStorage<AbortController>()
// rootOf-only Hosts publish the direct creator here, before prompt admission.
// Weak keys do not retain disposed children; every use revalidates both live instances.
const publishedCreators = new WeakMap<HostAgent, HostAgent>()

export function withAgentStart<T>(signal: AbortSignal, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  return starting.run(controller, () => start(AbortSignal.any([signal, controller.signal])))
}

export function hasAgentOwnership(host: AgentOwnershipHost): boolean {
  return typeof host.agents?.isOwnedBy === 'function' || typeof host.subagents?.rootOf === 'function' || typeof host.subagents?.lineageOf === 'function'
}

/** Resolve only exact live instances, including ordinary forks whose persisted parent is irrelevant. */
export function agentRoot(host: AgentOwnershipHost, agent: HostAgent): HostAgent | undefined {
  const agents = host.agents
  if (typeof agents?.get === 'function' && agents.get(agent.id) !== agent) return undefined
  if (typeof agents?.roots === 'function') {
    const roots = agents.roots()
    const live = agents.list?.() ?? roots
    const seen = new Set<HostAgent>()
    let current: HostAgent | undefined = agent
    while (current !== undefined && !seen.has(current)) {
      if (roots.includes(current)) return current
      seen.add(current)
      const child: HostAgent = current
      current = live.find(parent => parent !== child && agents.isOwnedBy?.(child.id, parent))
    }
    return undefined
  }
  try {
    const root = host.subagents?.lineageOf?.(agent)?.root ?? host.subagents?.rootOf?.(agent)
    return root !== undefined && agents?.get?.(root.id) === root ? root : undefined
  } catch {
    // Source Hosts reject unmanaged, replaced and not-yet-published children.
    return undefined
  }
}

export function rootAgents(host: AgentOwnershipHost): HostAgent[] {
  if (typeof host.agents?.roots === 'function') return host.agents.roots()
  if (typeof host.agents?.list !== 'function' || typeof host.subagents?.rootOf !== 'function') {
    throw new Error('Mnemon requires DSH live Agent roots or subagent runtime ownership support')
  }
  return host.agents.list().filter(agent => agentRoot(host, agent) === agent)
}

/** Preserve a nested child's dispatch View from its verified direct creator, not a newer root turn. */
export function agentMemoryParent(host: AgentOwnershipHost, agent: HostAgent, creatorId?: string): HostAgent | undefined {
  if (typeof host.agents?.isOwnedBy === 'function') {
    return (host.agents.list?.() ?? host.agents.roots?.() ?? []).find(parent => parent !== agent && isAgentOwnedBy(host, agent, parent))
  }
  const id = host.subagents?.lineageOf?.(agent)?.ancestors.at(-1) ?? creatorId
  const parent = id === undefined ? publishedCreators.get(agent) : host.agents?.get?.(id)
  const root = agentRoot(host, agent)
  return parent !== undefined && host.agents?.get?.(parent.id) === parent && parent !== agent && root !== undefined && agentRoot(host, parent) === root ? parent : undefined
}

/** Verify the direct creator as well as exact live tree membership, including nested starts. */
export function isAgentOwnedBy(host: AgentOwnershipHost, agent: HostAgent, parent: HostAgent): boolean {
  if (typeof host.agents?.get === 'function' && host.agents.get(agent.id) !== agent) return false
  if (typeof host.agents?.isOwnedBy === 'function') return host.agents.isOwnedBy(agent.id, parent)
  return agentMemoryParent(host, agent) === parent
}

/**
 * Before lineageOf, source DSH publishes ownership at subagent/start, before prompt admission.
 * That notification contains listener exceptions, so Mnemon-started activations
 * abort their startup signal on failure. Native starts have no such scope.
 * Published older Hosts and lineageOf Hosts retain the serial agent/created rollback boundary.
 */
export function observeAgentPublication(host: AgentPublicationHost, listener: (agent: HostAgent, creatorId?: string) => void, options?: { prepend?: boolean }): unknown {
  const delayed = typeof host.agents?.isOwnedBy !== 'function' && typeof host.subagents?.lineageOf !== 'function' && typeof host.subagents?.rootOf === 'function'
  if (!delayed) return host.on('agent/created', (({ agent }: { agent: HostAgent }) => listener(agent)) as never, options)
  return host.on('subagent/start', ((info: { id: string; local: boolean; parentSessionId?: string }) => {
    if (!info.local) return
    const agent = host.agents?.get?.(info.id)
    if (agent === undefined) return
    const creator = agentMemoryParent(host, agent, info.parentSessionId)
    if (creator !== undefined) publishedCreators.set(agent, creator)
    try { listener(agent, info.parentSessionId) } catch (error) {
      starting.getStore()?.abort(error)
      throw error
    }
  }) as never, options)
}
