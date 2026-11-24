import { createHash } from 'node:crypto'
import type { ComposableMemoryView } from '../core/contracts/index.ts'
import { canonicalMemoryJson } from '../core/definitions.ts'
import type { RuntimeSnapshotRefreshMode } from './protocol/config.ts'

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
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

function routedSourceType(provenance: unknown): 'documents' | 'memory-spaces' | undefined {
  if (!record(provenance)) return undefined
  return provenance.sourceTypeId === 'documents' || provenance.sourceTypeId === 'memory-spaces' ? provenance.sourceTypeId : undefined
}

function routedSourceScope(
  sourceTypeId: 'documents' | 'memory-spaces',
  grant: ComposableMemoryView['readGrants'][number],
): string | undefined {
  if (grant.consistency !== 'namespace-pinned-live-read' || !record(grant.value)) return undefined
  if (sourceTypeId === 'documents') {
    const { documentIds, archivedDocumentIds, ...scope } = grant.value
    if (grant.schema !== 'dsh-mnemon.documents/v1' || typeof scope.workspaceRoot !== 'string'
      || !stringList(documentIds) || !stringList(archivedDocumentIds)) return undefined
    return digest([grant.sourceInstanceKey, grant.schema, scope])
  }
  const { memoryBodyIds, knownMemoryBodyIds, ...scope } = grant.value
  if (grant.schema !== 'dsh-mnemon.memory-spaces/v1'
    || !stringList(memoryBodyIds) || !stringList(knownMemoryBodyIds)) return undefined
  const active = new Set(memoryBodyIds)
  const known = new Set(knownMemoryBodyIds)
  if (memoryBodyIds.some(id => !known.has(id))) return undefined
  const inactive = knownMemoryBodyIds.filter(id => !active.has(id)).sort()
  return digest([grant.sourceInstanceKey, grant.schema, scope, inactive])
}

export function readMemorySnapshotState(value: unknown): MemorySnapshotState | undefined {
  if (!record(value) || value.version !== 1 || !hash(value.boundary)
    || !Array.isArray(value.entries) || !value.entries.every(hash)) return undefined
  return {
    version: 1, boundary: value.boundary, entries: [...value.entries],
    ...(hash(value.branchVisibility) ? { branchVisibility: value.branchVisibility } : {}),
  }
}

export function memorySnapshotState(view: ComposableMemoryView | undefined, refresh: RuntimeSnapshotRefreshMode = 'on-change'): MemorySnapshotState | undefined {
  if (view === undefined) return undefined
  const entries: string[] = []
  const branchVisibility: string[] = []
  const runtimeScopes = new Map<string, string>()
  let completeRuntime = true
  const runtimeNormalized = view.projection.map(fragment => {
    const provenance = fragment.provenance
    const snapshot = record(provenance) ? provenance.snapshot : undefined
    if (!record(provenance) || provenance.sourceTypeId !== 'runtime') return fragment
    if (!record(snapshot) || snapshot.version !== 1 || !hash(snapshot.scope) || !Array.isArray(snapshot.entries) || !snapshot.entries.every(hash)) {
      completeRuntime = false
      return fragment
    }
    if (hash(snapshot.branchVisibility)) {
      branchVisibility.push(digest([fragment.sourceInstanceKey, fragment.id, snapshot.branchVisibility]))
      if (refresh === 'session-start') runtimeScopes.set(fragment.sourceInstanceKey, snapshot.scope)
    } else completeRuntime = false
    entries.push(...snapshot.entries.map(entry => digest([fragment.sourceInstanceKey, fragment.id, entry])))
    const { text: _text, revision: _revision, ...identity } = fragment
    return { ...identity, provenance: { ...provenance, snapshot: { version: 1, scope: snapshot.scope } } }
  })
  const routedScopes = new Map<string, string>()
  if (refresh === 'session-start' && completeRuntime && runtimeScopes.size > 0) {
    const routedTypes = new Map<string, 'documents' | 'memory-spaces' | null>()
    for (const fragment of view.projection) {
      const sourceType = fragment.mode === 'routed' ? routedSourceType(fragment.provenance) : undefined
      const current = routedTypes.get(fragment.sourceInstanceKey)
      if (sourceType === undefined) routedTypes.set(fragment.sourceInstanceKey, null)
      else if (current === undefined) routedTypes.set(fragment.sourceInstanceKey, sourceType)
      else if (current !== sourceType) routedTypes.set(fragment.sourceInstanceKey, null)
    }
    for (const [sourceInstanceKey, sourceType] of routedTypes) {
      if (sourceType === null) continue
      const matching = view.readGrants.filter(grant => grant.sourceInstanceKey === sourceInstanceKey)
      if (matching.length !== 1) continue
      const scope = routedSourceScope(sourceType, matching[0]!)
      if (scope !== undefined) routedScopes.set(sourceInstanceKey, scope)
    }
  }
  const projection = routedScopes.size === 0 ? runtimeNormalized : runtimeNormalized.map((fragment, index) => {
    const raw = view.projection[index]!
    if (!routedScopes.has(raw.sourceInstanceKey)) return fragment
    const { text: _text, revision: _revision, ...identity } = raw
    return identity
  })
  const grantIds = new Map<string, string>()
  const grants = !completeRuntime || runtimeScopes.size === 0 ? view.readGrants : view.readGrants.map(grant => {
    const scope = grant.schema === 'dsh-mnemon.runtime/v1' && grant.consistency === 'exact-snapshot'
      ? runtimeScopes.get(grant.sourceInstanceKey)
      : routedScopes.get(grant.sourceInstanceKey)
    if (scope === undefined) return grant
    const stableId = `${grant.sourceInstanceKey}/grant/${scope}`
    grantIds.set(grant.id, stableId)
    return { ...grant, id: stableId, revision: scope, value: null }
  })
  const routes = grantIds.size === 0 ? view.routes
    : view.routes.map(route => ({ ...route, readGrantId: grantIds.get(route.readGrantId) ?? route.readGrantId }))
  return {
    version: 1,
    boundary: digest({
      generation: view.runtimeGeneration, scope: view.scope,
      strategy: [view.strategyInstanceKey, view.strategyTypeId, view.strategyExtensions ?? []],
      projection, routes, actions: view.actionOffers, grants,
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
