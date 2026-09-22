import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { defineMemoryStrategy, installMemory } from 'dsh-mnemon/extension-sdk'
import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import type { Context } from '@deepseek-ai/cordis'
import { createRecordSource, RecordStore, reviseRecord, type RecordSnapshot, type RecordSourceOptions } from '../src/index.ts'

const options = { typeId: 'test-records', role: 'test-records', label: 'Records', description: 'Test records', kinds: ['note'], scopes: ['project', 'global'] as const, defaultScope: 'project' as const, validate() {} }
const policy = { apply(ctx: Context) { installMemory(ctx, { strategies: [defineMemoryStrategy({
  manifest: { apiVersion: COMPOSABLE_MEMORY_API_VERSION, kind: 'strategy', typeId: 'records-policy', packageName: 'records-policy', deterministic: true, supportedSourceRoles: ['test-records'], maxSources: 5, maxRoutes: 5, maxActions: 5 },
  compose(request, sources) { return { strategyTypeId: 'records-policy', explanation: 'Test composition', sources: sources.map(source => ({ sourceInstanceKey: source.sourceInstanceKey, projection: { mode: 'eager', maxCharacters: Math.floor(request.budget.maxProjectionCharacters / sources.length) }, routeIds: source.routeIds, actionIds: source.actionIds })) } },
})] }) } }
async function fixture(overrides: Partial<RecordSourceOptions> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mnemon-records-'))
  const runner = new MemoryCompositionRunner()
  const source = { apply(ctx: Context) { installMemory(ctx, { sources: [createRecordSource({ ...options, ...overrides }, { dataDir })] }) } }
  const unmount = await runner.mount(source, { instanceId: 'notes' })
  await runner.mount(policy, { instanceId: 'policy' })
  return { runner, dataDir, source, unmount, scope: { storage: 'custom' as const, workspaceId: '/project-a', sessionId: 'test-session' } }
}

describe('scoped record Source', () => {
  it('offers only the owning Source kinds and scopes and rejects unsupported model writes without changing records', async () => {
    const { runner, scope } = await fixture({ kinds: ['fact', 'decision'], scopes: ['project'] })
    try {
      const turn = await runner.beginTurn({ scope }), offer = turn.view.actionOffers[0]!
      expect(offer.inputSchema).toMatchObject({ properties: { kind: { enum: ['fact', 'decision'], default: 'fact' }, scope: { enum: ['project'], default: 'project' } } })
      await expect(turn.executeAction(offer.id, { title: 'Convention', kind: 'convention' }, () => true)).rejects.toThrow(/kind|schema|enum/)
      const client = await runner.managementClient('source:notes', scope)
      expect(((await client.read('snapshot')).value as unknown as RecordSnapshot).records).toHaveLength(0)
      await turn.executeAction(offer.id, { title: 'Convention', kind: 'fact', scope: 'project' }, () => true)
      expect(((await client.read('snapshot')).value as unknown as RecordSnapshot).records[0]).toMatchObject({ kind: 'fact', scope: 'project', state: 'pending' })
    } finally { await runner.dispose() }
  })

  it('receives a cross-plugin proposal once and refuses changed retries without overwriting the destination', async () => {
    const { runner, scope } = await fixture()
    try {
      const client = await runner.managementClient('source:notes', scope)
      const input = { transferKey: 'source:learning:candidate-1', title: 'Shared convention', content: 'Use published contracts', scope: 'project' }
      await client.mutate('receive-proposal', input, { confirmed: true })
      await client.mutate('receive-proposal', input, { confirmed: true })
      let snapshot = (await client.read('snapshot')).value as unknown as RecordSnapshot
      expect(snapshot.records).toHaveLength(1)
      expect(snapshot.records[0]).toMatchObject({ state: 'pending', signals: 1 })
      const record = snapshot.records[0]!
      await client.mutate('approve', { id: record.id, version: record.version }, { confirmed: true })
      await client.mutate('receive-proposal', input, { confirmed: true })
      snapshot = (await client.read('snapshot')).value as unknown as RecordSnapshot
      expect(snapshot.records[0]?.state).toBe('active')
      await expect(client.mutate('receive-proposal', { ...input, content: 'Different' }, { confirmed: true })).rejects.toThrow('different content')
      const other = await runner.managementClient('source:notes', { ...scope, workspaceId: '/other' })
      await expect(other.mutate('receive-proposal', input, { confirmed: true })).rejects.toThrow('different content or scope')
    } finally { await runner.dispose() }
  })

  it('transfers portable records across workspace paths while retaining local revisions and rejecting authority fields', async () => {
    const { runner, scope, source } = await fixture({ transfer: true })
    try {
      const client = await runner.managementClient('source:notes', scope)
      await client.mutate('create', { title: 'Portable note', content: 'before' }, { confirmed: true })
      const exported = await client.read('transfer-export', { track: 'project' })
      const portable = structuredClone(exported.value) as any
      expect(JSON.stringify(portable)).not.toContain(scope.workspaceId)
      expect(portable.entries[0].value.history).toBeUndefined()
      await runner.mount(source, { instanceId: 'copy' })
      const copied = await runner.managementClient('source:copy', { ...scope, workspaceId: '/second-device-checkout' })
      await copied.mutate('transfer-import', { snapshot: portable }, { confirmed: true })
      expect(((await copied.read('snapshot')).value as unknown as RecordSnapshot).records[0]!.workspaceId).toBe('/second-device-checkout')
      const other = await runner.managementClient('source:notes', { ...scope, workspaceId: '/other' })
      await expect(other.mutate('transfer-import', { snapshot: portable }, { confirmed: true })).rejects.toThrow('another scope')
      portable.entries[0].value.content = 'after'
      const imported = await client.mutate('transfer-import', { snapshot: portable }, { confirmed: true })
      expect(imported.value).toEqual(portable)
      expect(((await client.read('snapshot')).value as unknown as RecordSnapshot).records[0]!.history[0]!.content).toBe('before')
      const repeated = await client.mutate('transfer-import', { snapshot: portable }, { confirmed: true })
      expect(repeated.revision).toBe(imported.revision)
      portable.entries[0].value.workspaceId = '/another'
      await expect(client.mutate('transfer-import', { snapshot: portable }, { confirmed: true })).rejects.toThrow('local authority')
    } finally { await runner.dispose() }
  })
  it('imports approved exports with explicit conflict decisions and scope checks', async () => {
    const { runner, scope } = await fixture()
    try {
      const client = await runner.managementClient('source:notes', scope)
      await client.mutate('create', { title: 'Original' }, { confirmed: true })
      const exported = (await client.read('export')).value as unknown as RecordSnapshot
      const record = structuredClone(exported.records[0]!); record.title = 'Remote edit'
      await expect(client.mutate('import', { records: [record] } as any, { confirmed: true })).rejects.toThrow(/conflict/)
      await client.mutate('import', { records: [record], conflicts: 'replace' } as any, { confirmed: true })
      const changed = (await client.read('snapshot')).value as unknown as RecordSnapshot
      expect(changed.records[0]?.title).toBe('Remote edit'); expect(changed.records[0]?.history[0]?.title).toBe('Original')
      const other = await runner.managementClient('source:notes', { ...scope, workspaceId: '/other' })
      await expect(other.mutate('import', { records: [record] } as any, { confirmed: true })).rejects.toThrow(/scope/)
    } finally { await runner.dispose() }
  })
  it('fences extra model actions to the exact active record version in the View', async () => {
    const { runner, scope } = await fixture({ modelActions: [{ id: 'complete', capability: 'write', description: 'Complete a record', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }], mutate(_operation, input, context) { const record = context.records.find(record => record.id === input.id)!; reviseRecord(record, 'complete'); record.data.status = 'done' } })
    try {
      const client = await runner.managementClient('source:notes', scope)
      await client.mutate('create', { title: 'Active task' }, { confirmed: true })
      const record = ((await client.read('snapshot')).value as unknown as RecordSnapshot).records[0]!
      const turn = await runner.beginTurn({ scope })
      const offer = turn.view.actionOffers.find(offer => offer.sourceActionId === 'complete')!
      await expect(turn.executeAction(offer.id, { id: 'outside' }, () => true)).rejects.toThrow(/View|changed/)
      const receipt = await turn.executeAction(offer.id, { id: record.id }, () => true)
      expect(JSON.stringify(receipt)).toContain(record.id)
      await expect(turn.executeAction(offer.id, { id: record.id }, () => true)).rejects.toThrow(/changed/)
    } finally { await runner.dispose() }
  })
  it('keeps proposals inactive, deduplicates signals and requires a new View after approval', async () => {
    const { runner, scope } = await fixture()
    try {
      const turn = await runner.beginTurn({ scope })
      const input = { title: 'Deployment convention', content: 'Use port 8301.' }
      expect((await turn.executeAction(turn.view.actionOffers[0]!.id, input, () => true)).completion).toBe('candidate')
      await turn.executeAction(turn.view.actionOffers[0]!.id, input, () => true)
      const client = await runner.managementClient('source:notes', scope)
      const snapshot = (await client.read('snapshot')).value as unknown as RecordSnapshot
      expect(snapshot.records).toHaveLength(1)
      expect(snapshot.records[0]?.signals).toBe(2)
      const pending = await runner.beginTurn({ scope })
      expect((await pending.executeRoute(pending.view.routes[0]!.id, {})).items).toHaveLength(0)
      await client.mutate('approve', { id: snapshot.records[0]!.id, content: 'Use port 8302.' }, { confirmed: true })
      expect((await pending.executeRoute(pending.view.routes[0]!.id, {})).items).toHaveLength(0)
      const approved = await runner.beginTurn({ scope })
      expect((await approved.executeRoute(approved.view.routes[0]!.id, { query: '8302' })).items).toHaveLength(1)
      expect((await approved.executeRoute(approved.view.routes[0]!.id, { query: '8301' })).items).toHaveLength(0)
    } finally { await runner.dispose() }
  })
  it('isolates projects and instances and rejects denied, unconfirmed and stale writes', async () => {
    const { runner, scope, source } = await fixture()
    try {
      await runner.mount(source, { instanceId: 'other' })
      const a = await runner.managementClient('source:notes', scope)
      const stale = await runner.managementClient('source:notes', scope)
      await a.mutate('create', { title: 'A only' }, { confirmed: true })
      await expect(stale.mutate('create', { title: 'Stale' }, { confirmed: true })).rejects.toThrow(/revision/i)
      const b = await runner.managementClient('source:notes', { ...scope, workspaceId: '/project-b' })
      expect(((await b.read('snapshot')).value as unknown as RecordSnapshot).records).toHaveLength(0)
      const other = await runner.managementClient('source:other', scope)
      expect(((await other.read('snapshot')).value as unknown as RecordSnapshot).records).toHaveLength(0)
      const snapshot = (await a.read('snapshot')).value as unknown as RecordSnapshot
      await expect(b.mutate('update', { id: snapshot.records[0]!.id, title: 'Intrusion' }, { confirmed: true })).rejects.toThrow(/scope/)
      await expect(runner.executeManagement({ sourceInstanceKey: 'source:notes', scope, operation: 'create', input: { title: 'No confirmation' }, mode: 'mutate', confirmed: false, expectedRevision: a.revision })).rejects.toThrow(/confirm/i)
      const turn = await runner.beginTurn({ scope })
      await expect(turn.executeAction(turn.view.actionOffers[0]!.id, { title: 'Denied' }, () => false)).rejects.toThrow(/authoriz/i)
    } finally { await runner.dispose() }
  })
  it('retains history and data across archive, restore and unload/reload', async () => {
    const { runner, scope, source, unmount } = await fixture()
    try {
      const client = await runner.managementClient('source:notes', scope)
      let result = await client.mutate('create', { title: 'Keep me', content: 'Original' }, { confirmed: true })
      const id = (result.value as unknown as RecordSnapshot).records[0]!.id
      await client.mutate('update', { id, content: 'Edited' }, { confirmed: true })
      await client.mutate('archive', { id }, { confirmed: true })
      const turn = await runner.beginTurn({ scope })
      expect((await turn.executeRoute(turn.view.routes[0]!.id, {})).items).toHaveLength(0)
      expect((await turn.executeRoute(turn.view.routes[0]!.id, { archived: true })).items).toHaveLength(1)
      turn.release()
      await client.mutate('restore', { id }, { confirmed: true })
      await unmount(); await runner.mount(source, { instanceId: 'notes' })
      const restored = await runner.managementClient('source:notes', scope)
      result = await restored.read('snapshot')
      const record = (result.value as unknown as RecordSnapshot).records[0]!
      expect(record.content).toBe('Edited'); expect(record.state).toBe('active')
      expect(record.history[0]?.content).toBe('Original')
    } finally { await runner.dispose() }
  })
  it('preserves a damaged file and does not write after cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mnemon-damaged-records-'))
    const store = new RecordStore(directory)
    await writeFile(store.file, '{broken')
    await expect(store.change(undefined, () => {})).rejects.toThrow(/damaged/)
    expect(await readFile(store.file, 'utf8')).toBe('{broken')
    const controller = new AbortController(); controller.abort()
    await expect(store.change(undefined, () => {}, controller.signal)).rejects.toThrow()
    expect(await readFile(store.file, 'utf8')).toBe('{broken')
  })
  it('serializes simultaneous writes and rejects the stale revision inside the lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mnemon-concurrent-records-'))
    const store = new RecordStore(directory)
    const initial = await store.read()
    const values = await Promise.allSettled([store.change(initial.revision, records => { records.push({ id: 'one', kind: 'note', title: 'one', content: '', scope: 'global', state: 'active', data: {}, signals: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1, history: [] }) }), store.change(initial.revision, () => {})])
    expect(values.map(value => value.status)).toEqual(['fulfilled', 'rejected'])
    expect((await store.read()).records).toHaveLength(1)
  })
})

it('requires a full model read before a revision and preserves the exact original until approval', async () => {
  const { runner, scope } = await fixture({ reviewedRevisions: true })
  try {
    const client = await runner.managementClient('source:notes', scope)
    let result = await client.mutate('create', { title: 'Release procedure', content: 'Check the published version.' }, { confirmed: true })
    const original = (result.value as unknown as RecordSnapshot).records[0]!
    const turn = await runner.beginTurn({ scope }), proposal = { title: 'Release procedure', content: 'Check the published version and verify its peer compatibility.', supersedes: { id: original.id, version: original.version } }
    await expect(turn.executeAction(turn.view.actionOffers[0]!.id, proposal, () => true)).rejects.toThrow('Read the full original')
    await turn.executeRoute(turn.view.routes[0]!.id, { id: original.id })
    expect((await turn.executeAction(turn.view.actionOffers[0]!.id, proposal, () => true)).completion).toBe('candidate')
    const snapshot = (await client.read('snapshot')).value as unknown as RecordSnapshot, candidate = snapshot.records.find(record => record.state === 'pending')!
    expect(snapshot.records.find(record => record.id === original.id)).toMatchObject({ state: 'active', version: 1, content: original.content })
    await expect(client.mutate('approve', { id: candidate.id, version: candidate.version }, { confirmed: true })).rejects.toThrow('current original')
    result = await client.mutate('approve', { id: candidate.id, version: candidate.version, supersededVersion: original.version }, { confirmed: true })
    expect((result.value as unknown as RecordSnapshot).records.find(record => record.id === original.id)).toMatchObject({ state: 'archived', data: { mnemonSupersededBy: candidate.id } })
    expect(result.records).toEqual(expect.arrayContaining([{ id: original.id, state: 'archived', revision: '2' }, { id: candidate.id, state: 'active', revision: '2' }]))
    await expect(client.mutate('restore', { id: original.id, version: 2 }, { confirmed: true })).rejects.toThrow('historical version')
    turn.release()
  } finally { await runner.dispose() }
})
it('applies a batch atomically and refuses changed or cross-scope selections', async () => {
  const { runner, scope } = await fixture()
  try {
    const client = await runner.managementClient('source:notes', scope)
    await client.mutate('propose', { title: 'First' }, { confirmed: true })
    await client.mutate('propose', { title: 'Second' }, { confirmed: true })
    const snapshot = (await client.read('snapshot')).value as unknown as RecordSnapshot
    const input = { recordIds: snapshot.records.map(record => record.id), versions: Object.fromEntries(snapshot.records.map(record => [record.id, record.version])) }
    input.versions[input.recordIds[1]!] = 99
    await expect(client.mutate('batch-approve', input, { confirmed: true })).rejects.toThrow('changed')
    expect(((await client.read('snapshot')).value as unknown as RecordSnapshot).records.every(record => record.state === 'pending')).toBe(true)
    input.versions[input.recordIds[1]!] = 1
    const other = await runner.managementClient('source:notes', { ...scope, workspaceId: '/another' })
    await expect(other.mutate('batch-approve', input, { confirmed: true })).rejects.toThrow('changed')
    const result = await client.mutate('batch-approve', input, { confirmed: true })
    expect((result.value as unknown as RecordSnapshot).records.every(record => record.state === 'active')).toBe(true)
    expect(result.records).toHaveLength(2)
  } finally { await runner.dispose() }
})
