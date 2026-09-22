import type { MemoryActionOffer } from '../core/contracts/index.ts'
import type { HostContextShape, HostAgent, ToolExecution } from './dsh.ts'

/** Narrow adapter for the published DSH approval service; missing service is denial. */
interface ApprovalFace {
  request(request: { agent: HostAgent; toolName: string; callId?: string; reason: string; signal: AbortSignal }): Promise<string>
}

export async function authorizeMemoryAction(ctx: Pick<HostContextShape, 'get'>, offer: MemoryActionOffer, exec: ToolExecution, writable: () => boolean): Promise<boolean> {
  exec.signal.throwIfAborted()
  if (!writable()) return false
  if (offer.authority === undefined) return true
  if (!exec.agent) return false
  const service = ctx.get('approval') as ApprovalFace | undefined
  if (!service || typeof service.request !== 'function') return false
  const outcome = await service.request({ agent: exec.agent, toolName: exec.name ?? 'mnemon_view_action', ...(exec.callId ? { callId: exec.callId } : {}),
    reason: `This action requires ${offer.authority}: ${offer.description}`, signal: exec.signal })
  exec.signal.throwIfAborted()
  return outcome === 'allowed-once' && writable()
}
