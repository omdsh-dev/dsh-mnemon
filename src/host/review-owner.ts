import type { CreateHostAgentOptions, HostAgentContext, HostAgentHandle, HostWorkspaceRegistry, ResumeHostAgentOptions } from './dsh.ts'

/**
 * Stable identity of the idle-review owner session.
 *
 * The owner is a parent shell for one review run and is archived when the run
 * ends. A fresh uuid per run therefore leaves one archived, event-free session
 * file per review on disk, and DSH's `session/list` scans every stored session
 * on each Web start. Reusing one identity keeps that residue at one file.
 */
export const REVIEW_OWNER_ID = 'mnemon-review-owner-v1-6f1d7c2a-9b34-4c8e-8a51-2d0f4b7e3c19'

/** The Host surface owner acquisition needs. */
export interface ReviewOwnerHost {
  readonly agents?: {
    create?(options: CreateHostAgentOptions): Promise<HostAgentHandle>
    resume?(options: ResumeHostAgentOptions): Promise<HostAgentHandle>
  }
  get?(name: string): unknown
}

/**
 * Acquire the reusable idle-review owner session.
 *
 * The session is unarchived before use so a resumed owner is a normal session
 * again, and it is created on the first run only. When the Host cannot resume a
 * persisted session, the owner is created instead, which degrades to the
 * previous one-session-per-run behaviour but never fails a review.
 * @param host - Host context exposing the agent registry and workspace registry.
 * @param meta - owner session metadata, including cwd and preset.
 * @param agentOptions - provider and output controls for the owner.
 * @param signal - review cancellation.
 * @param setup - composition mounted on the owner's scoped context.
 * @returns the owner handle; disposing it unregisters the owner.
 */
export async function acquireReviewOwner(
  host: ReviewOwnerHost,
  meta: NonNullable<CreateHostAgentOptions['meta']>,
  agentOptions: NonNullable<CreateHostAgentOptions['agentOptions']>,
  signal: AbortSignal,
  setup: (ctx: HostAgentContext) => Promise<void>,
): Promise<HostAgentHandle> {
  const agents = host.agents
  if (agents === undefined) throw new Error('Host agent registry is unavailable for idle review')
  const registry = host.get?.('workspaceRegistry') as HostWorkspaceRegistry | undefined
  if (registry?.archivedSessionIds?.includes(REVIEW_OWNER_ID) === true) {
    await registry.unarchiveSession?.(REVIEW_OWNER_ID)
  }
  if (typeof agents.resume === 'function') {
    try {
      return await agents.resume({ resumeSessionId: REVIEW_OWNER_ID, agentOptions, signal, setup })
    } catch {
      // The owner is not stored yet, or this Host cannot resume it: create it.
    }
  }
  if (typeof agents.create !== 'function') throw new Error('Host agent registry cannot create the idle review owner')
  return await agents.create({ sessionId: REVIEW_OWNER_ID, meta, agentOptions, signal, setup })
}
