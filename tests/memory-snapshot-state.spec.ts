import { describe, expect, it } from 'vitest'
import type { ComposableMemoryView } from '../src/core/contracts/index.ts'
import { memorySnapshotState } from '../src/host/memory-snapshot-state.ts'

function view(): ComposableMemoryView {
  return {
    id: 'view:one', digest: 'one', createdAt: '2026-08-12T08:00:00Z',
    runtimeGeneration: 'generation:one', strategyInstanceKey: 'strategy:one', strategyTypeId: 'test',
    scope: { storage: 'custom', workspaceId: '/synthetic/workspace' }, explanation: 'Synthetic composition.',
    consistency: { mode: 'exact-snapshot', sourceRevisions: { runtime: 'one' } },
    projection: [{ id: 'runtime/projection', sourceInstanceKey: 'runtime', mode: 'eager', text: 'Synthetic full state.', revision: 'one',
      provenance: { sourceTypeId: 'runtime', snapshot: { version: 1, scope: 'a'.repeat(64), entries: ['b'.repeat(64)] } } }],
    readGrants: [{ id: 'grant:one', sourceInstanceKey: 'other', revision: 'unchanged', consistency: 'namespace-pinned-live-read', schema: 'opaque/v1',
      value: { namespace: ['synthetic-one', 'synthetic-two'], opaque: 'synthetic-private-grant' } }],
    routes: [{ id: 'other/read', sourceInstanceKey: 'other', sourceRouteId: 'read', description: 'Synthetic route.', capability: 'read',
      inputSchema: {}, readGrantId: 'grant:one', maxCalls: 4 }],
    actionOffers: [{ id: 'runtime/mutate', sourceInstanceKey: 'runtime', sourceActionId: 'mutate', description: 'Synthetic write.', capability: 'write', inputSchema: {} }],
  }
}

describe('memory snapshot authority boundaries', () => {
  it('does not checkpoint on content/revision/time changes within Source-certified scope', () => {
    const previous = view()
    const next = structuredClone(previous)
    next.id = 'view:two'; next.digest = 'two'; next.createdAt = '2026-08-13T08:00:00Z'
    next.consistency.sourceRevisions.runtime = 'two'
    next.projection[0]!.revision = 'two'
    next.projection[0]!.text = 'Synthetic revised complete state with different age annotations.'
    expect(memorySnapshotState(next)).toEqual(memorySnapshotState(previous))
    const serialized = JSON.stringify(memorySnapshotState(next))
    expect(serialized).not.toContain('synthetic-private-grant')
    expect(serialized).not.toContain('/synthetic/workspace')
  })

  it.each([
    ['scope', (value: ComposableMemoryView) => { value.scope.workspaceId = '/synthetic/other' }],
    ['storage', (value: ComposableMemoryView) => { value.scope.storage = 'workspace' }],
    ['generation', (value: ComposableMemoryView) => { value.runtimeGeneration = 'generation:two' }],
    ['Source removal', (value: ComposableMemoryView) => { value.projection = [] }],
    ['Source mode', (value: ComposableMemoryView) => { value.projection[0]!.mode = 'routed' }],
    ['grant removal', (value: ComposableMemoryView) => { value.readGrants = [] }],
    ['opaque grant narrowing', (value: ComposableMemoryView) => { value.readGrants[0]!.value = { namespace: ['synthetic-one'], opaque: 'synthetic-private-grant' } }],
    ['Route removal', (value: ComposableMemoryView) => { value.routes = [] }],
    ['Action removal', (value: ComposableMemoryView) => { value.actionOffers = [] }],
    ['Strategy guidance', (value: ComposableMemoryView) => { value.guidance = { system: 'Changed trusted policy.' } }],
    ['unavailable Source', (value: ComposableMemoryView) => { value.diagnostics = [{ code: 'source-unavailable', message: 'Unavailable.' }] }],
  ] as const)('checkpoints %s even when the rendered snapshot is identical', (_name, change) => {
    const previous = view()
    const next = structuredClone(previous)
    change(next)
    expect(memorySnapshotState(next)!.boundary).not.toBe(memorySnapshotState(previous)!.boundary)
  })

  it('compares unknown Source provenance in full and canonicalizes opaque JSON object keys', () => {
    const previous = view()
    previous.projection[0]!.provenance = { sourceTypeId: 'runtime', snapshot: { version: 2, scope: 'a'.repeat(64), entries: [] } }
    const next = structuredClone(previous)
    next.projection[0]!.text = 'Unknown future projection.'
    expect(memorySnapshotState(next)!.boundary).not.toBe(memorySnapshotState(previous)!.boundary)
    const reordered = structuredClone(previous)
    reordered.readGrants[0]!.value = { opaque: 'synthetic-private-grant', namespace: ['synthetic-one', 'synthetic-two'] }
    expect(memorySnapshotState(reordered)).toEqual(memorySnapshotState(previous))
  })
})
