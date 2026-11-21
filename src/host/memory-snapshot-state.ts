import { createHash } from 'node:crypto'
import type { ComposableMemoryView } from '../core/contracts/index.ts'
import { canonicalMemoryJson } from '../core/definitions.ts'

export interface MemorySnapshotState {
  version: 1
  boundary: string
  entries: string[]
  branchVisibility?: string
}

export type RuntimeSnapshotRange = [start: number, end: number]

const digest = (value: unknown): string => createHash('sha256').update(canonicalMemoryJson(value)).digest('hex')
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function readMemorySnapshotState(value: unknown): MemorySnapshotState | undefined {
  if (!record(value) || value.version !== 1 || !hash(value.boundary)
    || !Array.isArray(value.entries) || !value.entries.every(hash)) return undefined
  return {
    version: 1, boundary: value.boundary, entries: [...value.entries],
    ...(hash(value.branchVisibility) ? { branchVisibility: value.branchVisibility } : {}),
  }
}

export function memorySnapshotState(view: ComposableMemoryView | undefined): MemorySnapshotState | undefined {
  if (view === undefined) return undefined
  const entries: string[] = []
  const branchVisibility: string[] = []
  let completeRuntime = true
  const projection = view.projection.map(fragment => {
    const provenance = fragment.provenance
    const snapshot = record(provenance) ? provenance.snapshot : undefined
    if (!record(provenance) || provenance.sourceTypeId !== 'runtime') return fragment
    if (!record(snapshot) || snapshot.version !== 1 || !hash(snapshot.scope) || !Array.isArray(snapshot.entries) || !snapshot.entries.every(hash)) {
      completeRuntime = false
      return fragment
    }
    if (hash(snapshot.branchVisibility)) branchVisibility.push(digest([fragment.sourceInstanceKey, fragment.id, snapshot.branchVisibility]))
    else completeRuntime = false
    entries.push(...snapshot.entries.map(entry => digest([fragment.sourceInstanceKey, fragment.id, entry])))
    const { text: _text, revision: _revision, ...identity } = fragment
    return { ...identity, provenance: { ...provenance, snapshot: { version: 1, scope: snapshot.scope } } }
  })
  return {
    version: 1,
    boundary: digest({
      generation: view.runtimeGeneration, scope: view.scope,
      strategy: [view.strategyInstanceKey, view.strategyTypeId, view.strategyExtensions ?? []],
      projection, routes: view.routes, actions: view.actionOffers, grants: view.readGrants,
      guidance: view.guidance ?? null, diagnostics: view.diagnostics ?? [],
    }),
    entries: entries.sort(),
    ...(completeRuntime && branchVisibility.length > 0 ? { branchVisibility: digest(branchVisibility.sort()) } : {}),
  }
}

export function retainsSnapshotEntries(previous: readonly string[], current: readonly string[]): boolean {
  const counts = new Map<string, number>()
  for (const entry of current) counts.set(entry, (counts.get(entry) ?? 0) + 1)
  for (const entry of previous) {
    const count = counts.get(entry) ?? 0
    if (count === 0) return false
    counts.set(entry, count - 1)
  }
  return true
}
