import { DEFAULT_MEMORY_VIEW_BUDGET } from '../src/core/contracts/index.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { RecordSnapshot } from '../src/sdk/source/index.ts'
import { assertMemoryOperationPlan, createRecordSource, MemoryReadCoverage, memoryReadCursor, memoryReadOffset } from '../src/sdk/source/index.ts'
import { composeMemoryContext, defineMemoryStrategy, installMemory } from '../src/sdk/index.ts'
import { MemoryCompositionRunner } from '../src/sdk/testing.ts'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
it('compares reviewed execution plans canonically and fences every payload field', () => {
  const plan = { args: ['--check', 'note with spaces'], workspace: '/owned', owner: 's1', version: 3 }
  expect(() => assertMemoryOperationPlan({ version: 3, owner: 's1', workspace: '/owned', args: plan.args }, plan)).not.toThrow()
  for (const change of [{ owner: 's2' }, { args: ['--write'] }, { workspace: '/other' }, { version: 4 }]) expect(() => assertMemoryOperationPlan(plan, { ...plan, ...change })).toThrow()
})
it('binds cursors to the complete query, View and snapshot', () => {
  const identity = { view: 'v1', scope: { workspace: '/a' }, snapshot: 'r1', query: 'hello' }, cursor = memoryReadCursor(identity, 10)
  expect(memoryReadOffset(cursor, identity)).toBe(10)
  for (const changed of [{ view: 'v2' }, { scope: { workspace: '/b' } }, { snapshot: 'r2' }, { query: 'other' }]) expect(() => memoryReadOffset(cursor, { ...identity, ...changed })).toThrow(/different/)
  expect(() => memoryReadOffset('bad', identity)).toThrow()
})
it('tracks contiguous coverage for exact resource versions, independently per View', () => {
  const coverage = new MemoryReadCoverage(), reference = { id: 'doc', revision: 'r1' }
  expect(coverage.observe('v1', reference, { start: 0, end: 10, total: 30 })).toBe(false)
  expect(coverage.observe('v1', reference, { start: 20, end: 30, total: 30 })).toBe(false)
  expect(coverage.observe('v2', reference, { start: 10, end: 20, total: 30 })).toBe(false)
  expect(coverage.observe('v1', { ...reference, revision: 'r2' }, { start: 10, end: 20, total: 30 })).toBe(false)
  expect(coverage.observe('v1', reference, { start: 10, end: 20, total: 30 })).toBe(true)
  expect(() => coverage.observe('v1', reference, { start: 0, end: 30, total: 31 })).toThrow(/length/)
  coverage.release('v1')
  expect(coverage.observe('v1', reference, { start: 10, end: 20, total: 30 })).toBe(false)
})
it('requires complete bounded reads before proposing a record revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mnemon-sdk-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const runner = new MemoryCompositionRunner(); cleanup.push(() => runner.dispose())
  const source = createRecordSource({ typeId: 'notes', packageName: 'independent-notes', role: 'external-notes', label: 'Notes', description: 'Versioned notes', kinds: ['note'], scopes: ['global'], defaultScope: 'global', reviewedRevisions: true, validate() {} }, { dataDir: directory })
  const strategy = defineMemoryStrategy({ manifest: { apiVersion: 'dsh-mnemon/v1', kind: 'strategy', typeId: 'notes', packageName: 'notes-strategy', deterministic: true, supportedSourceRoles: [], acceptedSourceCapabilities: ['recall'], maxSources: 2, maxRoutes: 4, maxActions: 4 }, compose: (request, sources) => composeMemoryContext(request, sources, [], { strategyTypeId: 'notes', explanation: 'Read by resource version.' }) })
  await runner.mount({ apply(ctx: Context) { installMemory(ctx, { sources: [source], strategies: [strategy] }) } }, { instanceId: 'notes' })
  const client = await runner.managementClient('source:notes', { storage: 'custom' })
  await client.mutate('create', { title: 'Reference', content: 'abcdefghij'.repeat(30), scope: 'global' }, { confirmed: true })
  const original = ((await client.read('snapshot')).value as unknown as RecordSnapshot).records[0]!
  const turn = await runner.beginTurn({ budget: { ...DEFAULT_MEMORY_VIEW_BUDGET, maxEvidenceCharacters: 100 } })
  const offer = turn.view.actionOffers[0]!, route = turn.view.routes[0]!
  const proposal = { title: 'Improved', content: 'A reviewed correction', scope: 'global', supersedes: { id: original.id, version: original.version } }
  const first = await turn.executeRoute(route.id, { id: original.id })
  expect(first).toMatchObject({ truncated: true, continuation: { routeId: route.id } })
  expect(first.items[0]?.reference).toEqual({ id: original.id, revision: String(original.version) })
  await expect(turn.executeAction(offer.id, proposal, () => true)).rejects.toThrow(/read|inspect/i)
  let next = first.continuation, text = first.items[0]!.text
  while (next) { const page = await turn.executeRoute(next.routeId, next.input); text += page.items[0]!.text; next = page.continuation }
  expect(text).toContain(original.content)
  await turn.executeAction(offer.id, proposal, () => true)
  const after = ((await client.read('snapshot')).value as unknown as RecordSnapshot).records
  expect(after.find(record => record.id === original.id)?.state).toBe('active')
  expect(after.find(record => record.id !== original.id)?.state).toBe('pending')
})
