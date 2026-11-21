import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { HostAgent, HostAgentContext, HostAgentsService, HostSessionEvent } from './dsh.ts'
import { sessionEvents } from './session-events.ts'

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

export function activationOwned(subagents: ActivationOwnership | undefined): boolean {
  return typeof subagents?.rootOf === 'function'
}

export function isRootAgent(agents: HostAgentsService, subagents: ActivationOwnership, agent: HostAgent): boolean {
  if (agents.get(agent.id) !== agent) return false
  if (typeof agents.roots === 'function') return agents.roots().includes(agent)
  try { return subagents.rootOf?.(agent) === agent } catch { return false }
}

export function rootAgents(agents: HostAgentsService, subagents: ActivationOwnership): HostAgent[] {
  if (typeof agents.roots === 'function') return agents.roots()
  return (agents.list?.() ?? []).filter(agent => isRootAgent(agents, subagents, agent))
}

export function isTaskRecord(id: string): boolean {
  return /^mnemon-(?:task|run)-v1-[0-9a-f-]{36}$/.test(id)
}

export function titleTask(agent: HostAgent, title: string): void {
  const service = agent.ctx.get?.('sessionTitle') as { rename?(session: HostAgent['session'], title: string): unknown } | undefined
  service?.rename?.(agent.session, title)
}

export function watchTaskTitle(agent: HostAgent): () => unknown {
  if (!/^mnemon-task-v1-[0-9a-f-]{36}$/.test(agent.id) || agent.session.header?.origin === 'subagent') return () => undefined
  const service = agent.ctx.get?.('sessionTitle') as {
    get?(session: HostAgent['session']): { eventSeq: number; title: string; source: { kind: string }; messageSeqs: readonly number[] } | undefined
    refresh?(session: HostAgent['session']): Promise<unknown>
  } | undefined
  if (typeof service?.get !== 'function' || typeof service.refresh !== 'function') return () => undefined
  let requested = false
  return agent.ctx.on('session/event', ((session: HostAgent['session'], event: HostSessionEvent) => {
    if (requested || session !== agent.session || event.type !== 'user/message') return
    const source = event.data.source as { kind?: string } | undefined
    const content = event.data.content as Array<{ type?: string; text?: string }> | undefined
    if (source?.kind !== 'user' || !content?.some(block => block.type === 'text' && block.text?.trim())) return
    requested = true
    const current = service.get!(session)
    if (current?.source.kind !== 'user' || current.messageSeqs.length !== 0 || !current.title.startsWith('Mnemon · ')) return
    for (const recorded of sessionEvents(session, 0, current.eventSeq + 1)) {
      if (recorded.type === 'user/message' && (recorded.data.source as { kind?: string } | undefined)?.kind === 'user') return
      if (recorded.type !== 'session/title') continue
      if (recorded.seq !== current.eventSeq) return
      void Promise.resolve().then(() => {
        if (contextIsActive(agent.ctx) && service.get!(session)?.eventSeq === current.eventSeq) return service.refresh!(session)
      }).catch(() => undefined)
      return
    }
  }) as never)
}

interface ReservedChild {
  readonly parent: HostAgent
  readonly id: string
  claimed?: boolean
  child?: HostAgent
}

const creatingChild = new AsyncLocalStorage<ReservedChild>()

export function withReservedChild<T>(parent: HostAgent, operation: () => Promise<T>, fresh = false, id?: string): Promise<T> {
  const current = creatingChild.getStore()
  if (!fresh && current?.parent === parent && !current.claimed) return operation()
  return creatingChild.run({ parent, id: id ?? `mnemon-run-v1-${randomUUID()}` }, operation)
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
