import type { HostSession } from './dsh.ts'
import type { MemorySnapshotState } from './memory-snapshot-state.ts'

const optedInSteps = new WeakMap<HostSession, { turn: number; step: number }>()

/** The preset can isolate its compaction service from the Agent's root context. */
export function markSnapshotCompactionStep(session: HostSession, turn: number, step: number): void {
  optedInSteps.set(session, { turn, step })
}

export function takeSnapshotCompactionStep(session: HostSession, turn: number, step: number): boolean {
  const active = optedInSteps.get(session)
  optedInSteps.delete(session)
  return active?.turn === turn && active.step === step
}

type ReadAuthority = (signal?: AbortSignal) => Promise<MemorySnapshotState | undefined>
const authorities = new WeakMap<HostSession, ReadAuthority>()
const summaryAuthority = new WeakMap<HostSession, { state: MemorySnapshotState | undefined }>()

export function bindSnapshotAuthority(session: HostSession, read: ReadAuthority): () => void {
  authorities.set(session, read)
  return () => { if (authorities.get(session) === read) authorities.delete(session) }
}

export function readSnapshotAuthority(session: HostSession, signal?: AbortSignal): Promise<MemorySnapshotState | undefined> | undefined {
  return authorities.get(session)?.(signal)
}

export function markSummaryAuthority(session: HostSession, state: MemorySnapshotState | undefined): void {
  summaryAuthority.set(session, { state })
}

export function takeSummaryAuthority(session: HostSession): { state: MemorySnapshotState | undefined } | undefined {
  const authority = summaryAuthority.get(session)
  summaryAuthority.delete(session)
  return authority
}
