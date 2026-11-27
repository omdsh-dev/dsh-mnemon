import { describe, expect, it, vi } from 'vitest'
import type { HostAgentHandle, HostAgentContext } from '../src/host/dsh.ts'
import { acquireReviewOwner, REVIEW_OWNER_ID } from '../src/host/review-owner.ts'

const meta = { cwd: '/workspace' }
const agentOptions = {}
const setup = async (_ctx: HostAgentContext): Promise<void> => {}

function fixture(options: { resume?: boolean } = {}) {
  const stored = new Set<string>()
  const created: string[] = []
  const resumed: string[] = []
  const dispose = vi.fn(async () => {})
  const archiveSession = vi.fn(async () => {})
  const unarchiveSession = vi.fn(async () => {})
  const registry = { archivedSessionIds: [] as string[], archiveSession, unarchiveSession }
  const handle = (): HostAgentHandle => ({ agent: {} as never, dispose })
  const agents: Record<string, unknown> = {
    create: vi.fn(async (input: { sessionId: string }) => {
      created.push(input.sessionId)
      stored.add(input.sessionId)
      return handle()
    }),
  }
  if (options.resume !== false) {
    agents.resume = vi.fn(async (input: { resumeSessionId: string }) => {
      if (!stored.has(input.resumeSessionId)) throw new Error('session is not stored')
      resumed.push(input.resumeSessionId)
      return handle()
    })
  }
  const host = { get: () => registry, agents }
  return { host, registry, created, resumed, unarchiveSession, archiveSession }
}

describe('reusable idle review owner', () => {
  it('creates the owner once and resumes the same session on later reviews', async () => {
    const f = fixture()
    await acquireReviewOwner(f.host, meta, agentOptions, new AbortController().signal, setup)
    await acquireReviewOwner(f.host, meta, agentOptions, new AbortController().signal, setup)
    expect(f.created).toEqual([REVIEW_OWNER_ID])
    expect(f.resumed).toEqual([REVIEW_OWNER_ID])
  })

  it('unarchives the stored owner before the next review', async () => {
    const f = fixture()
    f.registry.archivedSessionIds.push(REVIEW_OWNER_ID)
    await acquireReviewOwner(f.host, meta, agentOptions, new AbortController().signal, setup)
    expect(f.unarchiveSession).toHaveBeenCalledWith(REVIEW_OWNER_ID)
  })

  it('keeps one owner per review on a Host without resume instead of colliding on the stable id', async () => {
    const f = fixture({ resume: false })
    await acquireReviewOwner(f.host, meta, agentOptions, new AbortController().signal, setup)
    await acquireReviewOwner(f.host, meta, agentOptions, new AbortController().signal, setup)
    expect(f.created).toHaveLength(2)
    expect(new Set(f.created).size).toBe(2)
    for (const id of f.created) expect(id).toMatch(/^mnemon-review-owner-v1-/u)
    expect(f.created).not.toContain(REVIEW_OWNER_ID)
  })
})
