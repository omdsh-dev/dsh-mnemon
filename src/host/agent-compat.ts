import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { HostAgent, HostAgentContext, HostAgentsService } from './dsh.ts'

/** Cordis errors may be wrapped by the review coordinator. */
export function isInactiveContextError(error: unknown): boolean {
  const seen = new Set<unknown>()
  while (error !== null && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    const value = error as { code?: unknown; message?: unknown; cause?: unknown }
    if (value.code === 'INACTIVE_EFFECT' || value.message === 'cannot create effect on inactive context') return true
    error = value.cause
  }
  return false
}

export function contextIsActive(ctx: Pick<HostAgentContext, 'fiber'> | undefined): boolean {
  try { ctx?.fiber?.assertActive(); return true } catch (error) {
    if (isInactiveContextError(error)) return false
    throw error
  }
}

export interface ActivationOwnership {
  rootOf?(agent: HostAgent): HostAgent
}

/** Cordis exposes resolved plugin configuration even when Subagent has no list(). */
export interface ProviderConfigurationHost {
  registry?: { values(): Iterable<{ fibers: Iterable<{ readonly effectiveConfig?: unknown }> }> }
}

export function configuredProviderNames(host: ProviderConfigurationHost | undefined): string[] {
  const names = new Set<string>()
  for (const runtime of host?.registry?.values() ?? []) {
    for (const fiber of runtime.fibers) {
      const config = fiber.effectiveConfig
      if (config && typeof config === 'object' && 'providerName' in config && typeof config.providerName === 'string') {
        names.add(config.providerName)
      }
    }
  }
  return [...names]
}

/** Official 0.2.2-rc.1 has registry ownership; master fcc0ad4 moved it into Subagent. */
export function activationOwned(subagents: ActivationOwnership | undefined): boolean {
  return typeof subagents?.rootOf === 'function'
}

/** Only live registry instances can be adopted; persisted lineage is not authority. */
export function isRootAgent(agents: HostAgentsService, subagents: ActivationOwnership, agent: HostAgent): boolean {
  if (agents.get(agent.id) !== agent) return false
  if (typeof agents.roots === 'function') return agents.roots().includes(agent)
  try { return subagents.rootOf?.(agent) === agent } catch { return false }
}

export function rootAgents(agents: HostAgentsService, subagents: ActivationOwnership): HostAgent[] {
  if (typeof agents.roots === 'function') return agents.roots()
  return (agents.list?.() ?? []).filter(agent => isRootAgent(agents, subagents, agent))
}

/** Persisted IDs keep completed internal sessions out of conversation automation after restart. */
export function isTaskRecord(id: string): boolean {
  return /^mnemon-(?:task|run)-v1-[0-9a-f-]{36}$/.test(id)
}

export function titleTask(agent: HostAgent, title: string): void {
  const service = agent.ctx.get?.('sessionTitle') as { rename?(session: HostAgent['session'], title: string): unknown } | undefined
  service?.rename?.(agent.session, title)
}

interface ReservedChild {
  readonly parent: HostAgent
  readonly id: string
  claimed?: boolean
  child?: HostAgent
}

const creatingChild = new AsyncLocalStorage<ReservedChild>()

/** Share one reservation across guard, continuation and composition wrappers, never across nested runs. */
export function withReservedChild<T>(parent: HostAgent, operation: () => Promise<T>, fresh = false): Promise<T> {
  const current = creatingChild.getStore()
  if (!fresh && current?.parent === parent && !current.claimed) return operation()
  return creatingChild.run({ parent, id: `mnemon-run-v1-${randomUUID()}` }, operation)
}

export function reservedChildId(parent: HostAgent): string | undefined {
  const current = creatingChild.getStore()
  return current?.parent === parent && !current.claimed ? current.id : undefined
}

export function claimReservedChild(parent: HostAgent): string | undefined {
  const current = creatingChild.getStore()
  if (current?.parent !== parent || current.claimed) return undefined
  current.claimed = true
  return current.id
}

export function isCreatingChild(agents: HostAgentsService, child: HostAgent): boolean {
  const current = creatingChild.getStore()
  return current !== undefined && isReservedChild(agents, current.parent, child)
}

/** A lineage string or same-tree relationship is not a creation capability. */
export function isReservedChild(
  agents: { get?(id: string): HostAgent | undefined } | undefined,
  parent: HostAgent,
  child: HostAgent,
): boolean {
  const current = creatingChild.getStore()
  if (current?.parent !== parent || !current.claimed || current.id !== child.id
    || agents?.get?.(parent.id) !== parent || agents.get(child.id) !== child
    || current.child !== undefined && current.child !== child) return false
  current.child = child
  return true
}
