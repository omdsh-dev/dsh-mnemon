import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { DocumentController } from '../src/controller.ts'
import type { DocumentMutationResult, DocumentRecord, DocumentSnapshot } from '../src/contracts.ts'
import * as plugin from '../src/index.ts'
import { strategy } from './fixture.ts'

describe('standalone documents Source', () => {
  it('manages create/read/update/search/local-archive within its selected Source store', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-documents-management-'))
    const workspace = join(directory, 'workspace')
    mkdirSync(workspace)
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount(plugin, { instanceId: 'work', config: { dataDir: join(directory, 'data') } })
      const base = { sourceInstanceKey: 'source:work', scope: { storage: 'custom' as const, workspaceId: workspace }, confirmed: false }
      const initial = await runner.executeManagement({ ...base, mode: 'read', operation: 'snapshot', input: null })
      const added = await runner.executeManagement({ ...base, mode: 'mutate', operation: 'mutate', confirmed: true, expectedRevision: initial.revision,
        input: { action: 'create', title: 'Managed doc', content: 'alpha sentinel' } })
      const { document } = added.value as unknown as plugin.DocumentMutationResult
      await expect(runner.executeManagement({ ...base, mode: 'mutate', operation: 'mutate', confirmed: true, expectedRevision: initial.revision,
        input: { action: 'update', id: document.id, content: 'stale' } })).rejects.toThrow('revision conflict')
      const updated = await runner.executeManagement({ ...base, mode: 'mutate', operation: 'mutate', confirmed: true, expectedRevision: added.revision,
        input: { action: 'update', id: document.id, content: 'beta sentinel' } })
      const loaded = await runner.executeManagement({ ...base, mode: 'read', operation: 'document', input: { id: document.id } })
      expect(loaded.value).toMatchObject({ content: 'beta sentinel' })
      const capacity = await runner.executeManagement({ ...base, mode: 'read', operation: 'capacity-plan', input: { action: 'create', title: 'Plan', content: 'new narrative' } })
      expect(capacity.value).toMatchObject({ fits: true })
      const search = await runner.executeManagement({ ...base, mode: 'read', operation: 'search', input: { query: 'beta' } })
      expect(search.value).toMatchObject({ total: 1 })
      await expect(runner.executeManagement({ ...base, mode: 'mutate', operation: 'archive', confirmed: true, expectedRevision: search.revision,
        input: { id: document.id, documentRevision: 1 } })).rejects.toMatchObject({ code: 'revision-conflict' })
      const archived = await runner.executeManagement({ ...base, mode: 'mutate', operation: 'archive', confirmed: true, expectedRevision: search.revision, input: { id: document.id } })
      expect(archived.value).toMatchObject({ action: 'archived', document: { status: 'archived', memoryBodyIds: [] } })
      const archivedTurn = await runner.beginTurn({ scope: base.scope })
      const archivedEvidence = await archivedTurn.executeRoute(archivedTurn.view.routes[0]!.id, { query: 'beta', includeArchived: true })
      const otherWorkspace = await runner.executeManagement({ ...base, scope: { ...base.scope, workspaceId: directory }, mode: 'read', operation: 'snapshot', input: null })
      // A configured dataDir is one explicit authority, even if a caller's cwd changes.
      expect(otherWorkspace.value).toMatchObject({ total: 1, workspaceRoot: directory })
      await expect(runner.executeManagement({ ...base, scope: { storage: 'custom' }, mode: 'read', operation: 'snapshot', input: null })).rejects.toThrow('unavailable')
    } finally { await runner.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('owns storage and composes two independent configured instances with no private Host binding', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-documents-plugin-'))
    const workspace = join(directory, 'workspace')
    mkdirSync(workspace)
    const runner = new MemoryCompositionRunner()
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount(plugin, { instanceId: 'work', config: { dataDir: join(directory, 'work') } })
      await runner.mount(plugin, { instanceId: 'personal', config: { dataDir: join(directory, 'personal') } })
      const first = await runner.beginTurn({ scope: { storage: 'custom', workspaceId: workspace } })
      const offer = first.view.actionOffers.find(value => value.sourceInstanceKey === 'source:work')!
      const receipt = await first.executeAction(offer.id,
        { action: 'create', title: 'Work', content: 'work-only sentinel' }, () => true)
      expect(receipt.status).toBe('succeeded')
      expect(receipt.completion).toBe('committed')
      first.release()
      const next = await runner.beginTurn({ scope: { storage: 'custom', workspaceId: workspace } })
      expect(next.view.sourcePresentations?.find(value => value.sourceInstanceKey === 'source:work')).toMatchObject({
        mode: 'routed', visibleItems: 1, totalItems: 1, items: [{ title: 'Work' }],
      })
      const route = next.view.routes.find(value => value.sourceInstanceKey === 'source:work')!
      const evidence = await next.executeRoute(route.id, { query: 'sentinel' })
      expect(evidence.items).toHaveLength(1)
      const suggestions = await next.executeRoute(route.id, { query: 'unmatched-secret' })
      const personal = next.view.routes.find(value => value.sourceInstanceKey === 'source:personal')!
      expect((await next.executeRoute(personal.id, { query: 'sentinel' })).items).toHaveLength(0)
      next.release()
    } finally {
      await runner.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails invalid configuration before publishing a Source', async () => {
    const runner = new MemoryCompositionRunner()
    try {
      await expect(runner.mount(plugin, { instanceId: 'invalid', config: { limitBytes: -1 } })).rejects.toThrow()
      expect(runner.inspect().evaluation.sourceInstanceKeys).toHaveLength(0)
    } finally { await runner.dispose() }
  })
})

describe('create-only Documents Action', () => {
  const releases: Array<() => Promise<void>> = []
  afterEach(async () => { for (const release of releases.splice(0).reverse()) await release() })

  async function fixture(limitBytes = 10 * 1024 * 1024) {
    const directory = mkdtempSync(join(tmpdir(), 'mnemon-documents-create-'))
    const workspace = join(directory, 'workspace')
    mkdirSync(workspace)
    const runner = new MemoryCompositionRunner()
    releases.push(async () => { try { await runner.dispose() } finally { rmSync(directory, { recursive: true, force: true }) } })
    await runner.mount(strategy, { instanceId: 'strategy' })
    await runner.mount(plugin, { instanceId: 'documents', config: { dataDir: join(directory, 'data'), limitBytes } })
    const base = { sourceInstanceKey: 'source:documents', scope: { storage: 'custom' as const, workspaceId: workspace }, confirmed: false }
    const initial = await runner.executeManagement({ ...base, mode: 'read', operation: 'snapshot', input: null })
    const original = await runner.executeManagement({ ...base, mode: 'mutate', operation: 'mutate', confirmed: true, expectedRevision: initial.revision,
      input: { action: 'create', title: 'Release implementation', content: '# Original implementation\n\n```ts\nconst retries = 3\n```\n\nKeep this exact implementation.', sessionIds: ['user-session'] } })
    const { document } = original.value as unknown as plugin.DocumentMutationResult
    const read = () => runner.executeManagement({ ...base, mode: 'read', operation: 'document', input: { id: document.id } })
    const snapshot = () => runner.executeManagement({ ...base, mode: 'read', operation: 'snapshot', input: null })
    const turn = await runner.beginTurn({ scope: base.scope })
    const create = turn.view.actionOffers.find(offer => offer.sourceActionId === 'create')
    return { runner, base, document, original, turn, create, read, snapshot }
  }

  it.each(['create', 'manage'])('can update a document committed by the %s Action in the same execution', async action => {
    const f = await fixture()
    const manage = f.turn.view.actionOffers.find(offer => offer.sourceActionId === 'manage')!
    const created = await f.turn.executeAction(action === 'create' ? f.create!.id : manage.id,
      { title: 'New draft', content: 'Initial content.', ...(action === 'manage' ? { action: 'create' } : {}) }, () => true)
    const id = (created.details as unknown as plugin.DocumentMutationResult).document.id
    await expect(f.turn.executeAction(manage.id, { action: 'update', id, content: 'Corrected content.' }, () => true))
      .resolves.toMatchObject({ completion: 'committed', details: { action: 'updated', document: { id, revision: 2, content: 'Corrected content.' } } })
    expect((await f.read()).value).toMatchObject({ content: f.document.content, revision: f.document.revision })
  })

  it('creates a separate document even with the same title and preserves the existing original', async () => {
    const f = await fixture()
    expect(f.create).toBeDefined()
    const result = await f.turn.executeAction(f.create!.id, { title: f.document.title, content: 'Additional rollout evidence.' }, () => true)
    expect(result).toMatchObject({ status: 'succeeded', completion: 'committed', details: { action: 'created', document: { revision: 1 } } })
    expect((result.details as unknown as plugin.DocumentMutationResult).document.id).not.toBe(f.document.id)
    expect((await f.read()).value).toMatchObject({ content: f.document.content, contentHash: f.document.contentHash, revision: f.document.revision })
    expect((await f.snapshot()).value).toMatchObject({ activeCount: 2 })
  })

  it.each([
    { action: 'update', id: 'original' },
    { action: 'archive', id: 'original' },
    { action: 'create' },
    { id: 'original' },
    { operation: 'manage' },
  ])('rejects mutation selectors %j without changing persisted data', async selector => {
    const f = await fixture()
    expect(f.create).toBeDefined()
    const input = { title: 'Condensed replacement', content: 'Summary without implementation.', ...selector,
      ...('id' in selector ? { id: f.document.id } : {}) } as MemoryJsonValue
    await expect(f.turn.executeAction(f.create!.id, input, () => true)).rejects.toThrow()
    expect((await f.read()).value).toMatchObject({ content: f.document.content, contentHash: f.document.contentHash, revision: f.document.revision })
    expect(await f.snapshot()).toMatchObject({ revision: f.original.revision, value: { activeCount: 1, archivedCount: 0 } })
  })

  it('fails at capacity without archiving or overwriting an existing document', async () => {
    const f = await fixture(2048)
    expect(f.create).toBeDefined()
    await expect(f.turn.executeAction(f.create!.id, { title: 'Too large', content: 'x'.repeat(2048) }, () => true)).rejects.toThrow(/capacity/i)
    expect((await f.read()).value).toMatchObject({ content: f.document.content, status: 'active', revision: f.document.revision })
    expect(await f.snapshot()).toMatchObject({ revision: f.original.revision, value: { activeCount: 1, archivedCount: 0 } })
  })

  it('keeps the existing manage Action available for an authorized update', async () => {
    const f = await fixture()
    const manage = f.turn.view.actionOffers.find(offer => offer.sourceActionId === 'manage')!
    await expect(f.turn.executeAction(manage.id, { action: 'update', id: f.document.id, content: 'Explicitly revised implementation.' }, () => true))
      .resolves.toMatchObject({ completion: 'committed', details: { action: 'updated' } })
    expect((await f.read()).value).toMatchObject({ content: 'Explicitly revised implementation.', revision: f.document.revision + 1 })
  })
})

describe('Bounded snapshot excerpt admission through public Cordis management', () => {
  const CACHE_LIMIT = 2_048
  const contentFor = (index: number) => `Original record ${String(index).padStart(4, '0')}.`

  /** Seed valid real-disk records from one public write, avoiding a quadratic
   * fixture import. Reads, mutations and snapshots use actual Cordis management. */
  async function fixture(size: number) {
    const root = mkdtempSync(join(tmpdir(), 'mnemon-excerpt-boundary-'))
    const workspace = join(root, 'workspace'), dataDir = join(root, 'data')
    const runner = new MemoryCompositionRunner()
    mkdirSync(workspace)
    try {
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount(plugin, { instanceId: 'work', config: { dataDir } })
      const client = await runner.managementClient('source:work', { storage: 'custom', workspaceId: workspace })
      const seed = (await client.mutate('mutate', { action: 'create', title: 'Seed record', content: 'Seed content.' }, { confirmed: true })).value as unknown as DocumentMutationResult
      const { content: seedContent, ...template } = seed.document
      const stored = readFileSync(join(dataDir, template.relativePath), 'utf8')
      const records = Array.from({ length: size }, (_, index): DocumentRecord => {
        const content = contentFor(index), filename = `record-${index}.md`
        const record = { ...template, id: `cache-record-${index}`, title: `Record ${index}`, filename,
          relativePath: `documents/active/${filename}`, contentHash: createHash('sha256').update(content).digest('hex') }
        const markdown = stored.replaceAll(template.id, record.id).replaceAll(template.title, record.title)
          .replaceAll(seedContent, content).replaceAll(template.contentHash, record.contentHash)
        record.sizeBytes = Buffer.byteLength(markdown)
        writeFileSync(join(dataDir, record.relativePath), markdown, { mode: 0o600 })
        return record
      })
      const saveIndex = (documents: DocumentRecord[]) => writeFileSync(seed.snapshot.indexPath, JSON.stringify({ version: 1, documents }) + '\n')
      saveIndex(records)
      rmSync(join(dataDir, template.relativePath))
      const readBody = vi.spyOn(DocumentController.prototype as unknown as { readBody(record: DocumentRecord): string }, 'readBody')
      return { root, dataDir, client, records, readBody, saveIndex,
        indexRecords: () => (JSON.parse(readFileSync(seed.snapshot.indexPath, 'utf8')) as { documents: DocumentRecord[] }).documents,
        snapshot: async () => (await client.read('snapshot')).value as unknown as DocumentSnapshot,
        async dispose() { readBody.mockRestore(); await runner.dispose(); rmSync(root, { recursive: true, force: true }) },
      }
    } catch (error) { await runner.dispose(); rmSync(root, { recursive: true, force: true }); throw error }
  }

  it.each([2_048, 2_049, 4_096])('does not cycle the whole cache at %i documents', async size => {
    const f = await fixture(size)
    try {
      await f.snapshot()
      expect(f.readBody).toHaveBeenCalledTimes(size)
      const controller = f.readBody.mock.contexts[0] as unknown as { excerpts: Map<string, unknown> }
      for (let repeat = 0; repeat < 3; repeat++) {
        f.readBody.mockClear()
        const snapshot = await f.snapshot()
        expect(snapshot.total).toBe(size)
        expect(snapshot.activeCount).toBe(size)
        expect(snapshot.documents.map(record => record.excerpt)).toEqual(f.records.map((_, index) => contentFor(index)))
        expect(snapshot.documents.every(record => record.healthy)).toBe(true)
        expect(f.readBody).toHaveBeenCalledTimes(Math.max(0, size - CACHE_LIMIT))
        expect(f.readBody.mock.calls.map(([record]) => record.id)).toEqual(f.records.slice(CACHE_LIMIT).map(record => record.id))
        expect(controller.excerpts.size).toBe(Math.min(size, CACHE_LIMIT))
      }
    } finally { await f.dispose() }
  })

  it('changes admission on archive, renamed paths and removed index members without keeping orphan cache entries', async () => {
    const f = await fixture(CACHE_LIMIT + 1)
    try {
      await f.snapshot()
      const controller = f.readBody.mock.contexts[0] as unknown as { excerpts: Map<string, unknown> }
      const oldPath = join(f.dataDir, f.records[0]!.relativePath)
      const archived = (await f.client.mutate('archive', { id: f.records[0]!.id, documentRevision: 1, summary: 'Kept as a cold copy.' }, { confirmed: true })).value as unknown as DocumentMutationResult
      expect(archived.snapshot).toMatchObject({ total: CACHE_LIMIT + 1, activeCount: CACHE_LIMIT, archivedCount: 1 })
      expect(archived.snapshot.documents[0]).toMatchObject({ healthy: true, excerpt: contentFor(0), status: 'archived' })
      expect(controller.excerpts.has(oldPath)).toBe(false)
      expect(controller.excerpts.has(join(f.dataDir, archived.document.relativePath))).toBe(true)
      expect(controller.excerpts.size).toBe(CACHE_LIMIT)

      const records = f.indexRecords(), renamed = records[1]!, previous = join(f.dataDir, renamed.relativePath)
      renamed.filename = 'renamed-record.md'; renamed.relativePath = `documents/active/${renamed.filename}`
      renameSync(previous, join(f.dataDir, renamed.relativePath))
      f.saveIndex(records)
      f.readBody.mockClear()
      expect((await f.snapshot()).documents[1]).toMatchObject({ healthy: true, excerpt: contentFor(1), relativePath: renamed.relativePath })
      expect(f.readBody.mock.calls.map(([record]) => record.id)).toEqual([renamed.id, records[CACHE_LIMIT]!.id])
      expect(controller.excerpts.has(previous)).toBe(false)
      expect(controller.excerpts.size).toBe(CACHE_LIMIT)

      rmSync(join(f.dataDir, archived.document.relativePath))
      f.saveIndex(records.slice(1))
      f.readBody.mockClear()
      expect((await f.snapshot()).total).toBe(CACHE_LIMIT)
      expect(f.readBody.mock.calls.map(([record]) => record.id)).toEqual([records[CACHE_LIMIT]!.id])
      expect(controller.excerpts.has(join(f.dataDir, archived.document.relativePath))).toBe(false)
      expect(controller.excerpts.size).toBe(CACHE_LIMIT)
      f.readBody.mockClear()
      await f.snapshot()
      expect(f.readBody).not.toHaveBeenCalled()

      const added = (await f.client.mutate('mutate', { action: 'create', title: 'New overflow', content: 'Still in the full UI snapshot.' }, { confirmed: true })).value as unknown as DocumentMutationResult
      expect(added.snapshot.total).toBe(CACHE_LIMIT + 1)
      expect(added.snapshot.documents.at(-1)?.excerpt).toBe('Still in the full UI snapshot.')
      f.readBody.mockClear()
      await f.snapshot()
      expect(f.readBody.mock.calls.map(([record]) => record.id)).toEqual([added.document.id])
      expect(controller.excerpts.size).toBe(CACHE_LIMIT)
    } finally { await f.dispose() }
  })

  it.each([0, CACHE_LIMIT])('keeps external rewrite, replacement, deletion and permissions live for record %i', async index => {
    const f = await fixture(CACHE_LIMIT + 1)
    try {
      const target = f.records[index]!, path = join(f.dataDir, target.relativePath)
      const original = readFileSync(path, 'utf8'), fixed = new Date('2025-01-01T00:00:00.000Z')
      utimesSync(path, fixed, fixed)
      const initial = await f.snapshot()
      const select = (snapshot: DocumentSnapshot) => snapshot.documents.find(record => record.id === target.id)!
      const edited = original.replace('Original record', 'Modified record')
      expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(original))
      writeFileSync(path, edited); utimesSync(path, fixed, fixed)
      expect(statSync(path, { bigint: true }).mtimeNs).toBe(BigInt(fixed.getTime()) * 1_000_000n)
      f.readBody.mockClear()
      const changed = await f.snapshot()
      expect(changed.revision).toBe(initial.revision)
      expect(select(changed)).toMatchObject({ healthy: true, excerpt: contentFor(index).replace('Original', 'Modified') })
      expect(f.readBody).toHaveBeenCalledTimes(index < CACHE_LIMIT ? 2 : 1)

      const replacement = join(f.root, 'replacement.md')
      writeFileSync(replacement, original.replace('Original record', 'Replaced record'))
      utimesSync(replacement, fixed, fixed); renameSync(replacement, path)
      expect(select(await f.snapshot()).excerpt).toBe(contentFor(index).replace('Original', 'Replaced'))
      rmSync(path)
      const missing = await f.snapshot()
      expect(missing.total).toBe(CACHE_LIMIT + 1)
      expect(select(missing)).toMatchObject({ healthy: false, excerpt: '' })
      writeFileSync(path, original, { mode: 0o600 })
      expect(select(await f.snapshot())).toMatchObject({ healthy: true, excerpt: contentFor(index) })
      chmodSync(path, 0)
      try {
        if (process.getuid?.() !== 0 && process.platform !== 'win32') await expect(f.snapshot()).rejects.toThrow()
      } finally { chmodSync(path, 0o600) }
      expect(select(await f.snapshot())).toMatchObject({ healthy: true, excerpt: contentFor(index) })
      expect((await f.client.read('document', { id: target.id })).value).toMatchObject({ content: contentFor(index) })
    } finally { await f.dispose() }
  })
})

describe('Documents disk-backed snapshot freshness through the public SDK', () => {
  async function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'mnemon-documents-io-'))
    const workspace = join(root, 'workspace'), dataDir = join(root, 'data')
    mkdirSync(workspace)
    const scope = { storage: 'custom' as const, workspaceId: workspace }
    const runners: MemoryCompositionRunner[] = []
    const mount = async () => {
      const runner = new MemoryCompositionRunner()
      runners.push(runner)
      await runner.mount(strategy, { instanceId: 'strategy' })
      await runner.mount(plugin, { instanceId: 'work', config: { dataDir } })
      const client = await runner.managementClient('source:work', scope)
      return { runner, client }
    }
    return { root, workspace, dataDir, scope, mount,
      async dispose() {
        for (const runner of runners.reverse()) await runner.dispose()
        rmSync(root, { recursive: true, force: true })
      },
    }
  }

  it('observes same-size external edits with restored mtime, replacements, deletion and restoration', async () => {
    const f = await fixture()
    try {
      const { runner, client } = await f.mount()
      const created = (await client.mutate('mutate', { action: 'create', title: 'External changes', content: 'Original story one.' }, { confirmed: true })).value as unknown as DocumentMutationResult
      await client.mutate('mutate', { action: 'create', title: 'Other story', content: 'Unchanged second story.' }, { confirmed: true })
      const path = join(f.dataDir, created.document.relativePath)
      const fixedTime = new Date('2025-01-01T00:00:00.000Z')
      utimesSync(path, fixedTime, fixedTime)
      const original = readFileSync(path, 'utf8'), before = statSync(path)
      const snapshot = async () => (await client.read('snapshot')).value as unknown as DocumentSnapshot
      const selected = (value: DocumentSnapshot) => value.documents.find(document => document.id === created.document.id)!
      const initial = await snapshot()
      expect(initial.total).toBe(2)
      expect(selected(initial).excerpt).toBe('Original story one.')

      const edited = original.replace('Original story one.', 'Modified story one.')
      expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(original))
      writeFileSync(path, edited)
      utimesSync(path, before.atime, before.mtime)
      expect(statSync(path, { bigint: true }).mtimeNs).toBe(BigInt(fixedTime.getTime()) * 1_000_000n)
      const changed = await snapshot()
      expect(selected(changed)).toMatchObject({ healthy: true, excerpt: 'Modified story one.' })
      expect(changed.revision).toBe(initial.revision) // Body edits do not invent an index revision.
      expect((await client.read('document', { id: created.document.id })).value).toMatchObject({ content: 'Modified story one.' })

      const replacement = join(f.root, 'replacement.md')
      writeFileSync(replacement, original.replace('Original story one.', 'Replaced story one.'))
      utimesSync(replacement, before.atime, before.mtime)
      renameSync(replacement, path)
      expect(selected(await snapshot()).excerpt).toBe('Replaced story one.')

      rmSync(path)
      expect(selected(await snapshot())).toMatchObject({ healthy: false, excerpt: '' })
      const missing = await runner.beginTurn({ scope: f.scope })
      expect(missing.view.readGrants[0]!.value).toMatchObject({ documentIds: expect.not.arrayContaining([created.document.id]) })
      missing.release()
      await expect(client.read('document', { id: created.document.id })).rejects.toThrow()

      writeFileSync(path, original, { mode: 0o600 })
      expect(selected(await snapshot())).toMatchObject({ healthy: true, excerpt: 'Original story one.' })
      const restored = await runner.beginTurn({ scope: f.scope })
      expect(restored.view.readGrants[0]!.value).toMatchObject({ documentIds: expect.arrayContaining([created.document.id]) })
      restored.release()
    } finally { await f.dispose() }
  })

  it('does not let a warm excerpt bypass changed file permissions', async () => {
    const f = await fixture()
    try {
      const { client } = await f.mount()
      const added = (await client.mutate('mutate', { action: 'create', title: 'Private', content: 'Private body.' }, { confirmed: true })).value as unknown as DocumentMutationResult
      const path = join(f.dataDir, added.document.relativePath)
      expect((await client.read('snapshot')).value).toMatchObject({ documents: [{ excerpt: 'Private body.' }] })
      chmodSync(path, 0)
      try {
        if (process.getuid?.() !== 0 && process.platform !== 'win32') await expect(client.read('snapshot')).rejects.toThrow()
      } finally { chmodSync(path, 0o600) }
      expect((await client.read('document', { id: added.document.id })).value).toMatchObject({ content: 'Private body.' })
      expect((await client.read('snapshot')).value).toMatchObject({ documents: [{ excerpt: 'Private body.' }] })
    } finally { await f.dispose() }
  })

  it('retains cross-generation index freshness and fences stale mutations without losing full receipts', async () => {
    const f = await fixture()
    try {
      const { runner, client } = await f.mount()
      const first = await runner.beginTurn({ scope: f.scope })
      const offer = first.view.actionOffers[0]!
      const receipt = await first.executeAction(offer.id, { action: 'create', title: 'Durable', content: 'Original authority.' }, () => true)
      expect(receipt).toMatchObject({ status: 'succeeded', completion: 'committed', committedAt: expect.any(String) })
      const details = receipt.details as unknown as DocumentMutationResult
      expect(details.snapshot).toMatchObject({ total: 1, documents: [{ healthy: true, excerpt: 'Original authority.' }] })
      const indexPath = join(f.dataDir, 'documents', 'index.json')
      expect(JSON.parse(readFileSync(indexPath, 'utf8')).documents[0].id).toBe(details.document.id)
      expect(statSync(indexPath).mode & 0o777).toBe(0o600)
      expect(statSync(join(f.dataDir, details.document.relativePath)).mode & 0o777).toBe(0o600)
      first.release()
      const before = await client.read('snapshot')
      const second = await f.mount()
      const updated = await second.client.mutate('mutate', { action: 'update', id: details.document.id, content: 'Updated authority.' }, { confirmed: true })
      expect(updated.revision).not.toBe(before.revision)
      await expect(client.mutate('mutate', { action: 'update', id: details.document.id, content: 'Stale overwrite.' }, { confirmed: true, expectedRevision: before.revision })).rejects.toThrow('revision conflict')
      const current = await client.read('snapshot')
      expect(current.revision).toBe(updated.revision)
      expect(current.value).toMatchObject({ total: 1, documents: [{ revision: 2, excerpt: 'Updated authority.' }] })
      expect((await client.read('document', { id: details.document.id })).value).toMatchObject({ content: 'Updated authority.' })
    } finally { await f.dispose() }
  })

  it('observes external index edits/replacements and does not hide corruption or removal behind a cached revision', async () => {
    const f = await fixture()
    try {
      const { client } = await f.mount()
      await client.mutate('mutate', { action: 'create', title: 'Initial', content: 'Stored body.' }, { confirmed: true })
      const path = join(f.dataDir, 'documents', 'index.json')
      const fixedTime = new Date('2025-01-01T00:00:00.000Z')
      utimesSync(path, fixedTime, fixedTime)
      const before = await client.read('snapshot')
      const original = readFileSync(path, 'utf8'), stat = statSync(path)
      const edited = original.replace('Initial', 'Changed')
      expect(edited.length).toBe(original.length)
      writeFileSync(path, edited)
      utimesSync(path, stat.atime, stat.mtime)
      expect(statSync(path, { bigint: true }).mtimeNs).toBe(BigInt(fixedTime.getTime()) * 1_000_000n)
      const changed = await client.read('snapshot')
      expect(changed.revision).not.toBe(before.revision)
      expect(changed.value).toMatchObject({ documents: [{ title: 'Changed', excerpt: 'Stored body.' }] })

      const replacement = join(f.root, 'replacement-index.json')
      writeFileSync(replacement, original.replace('Initial', 'Another'))
      utimesSync(replacement, stat.atime, stat.mtime)
      renameSync(replacement, path)
      expect((await client.read('snapshot')).value).toMatchObject({ documents: [{ title: 'Another' }] })

      writeFileSync(path, original.replace('"version": 1', '"version": 9'))
      utimesSync(path, stat.atime, stat.mtime)
      await expect(client.read('snapshot')).rejects.toThrow()
      writeFileSync(path, original)
      expect((await client.read('snapshot')).revision).toBe(before.revision)
      rmSync(path)
      await expect(client.read('snapshot')).rejects.toThrow()
      writeFileSync(path, original, { mode: 0o600 })
      expect((await client.read('snapshot')).revision).toBe(before.revision)
      chmodSync(path, 0)
      try {
        if (process.getuid?.() !== 0 && process.platform !== 'win32') await expect(client.read('snapshot')).rejects.toThrow()
      } finally { chmodSync(path, 0o600) }
      expect((await client.read('snapshot')).revision).toBe(before.revision)
    } finally { await f.dispose() }
  })

  it('checks an unchanged source revision again inside the real mutation queue', async () => {
    const f = await fixture()
    try {
      const { runner, client } = await f.mount()
      const base = { scope: f.scope, sourceInstanceKey: 'source:work', mode: 'mutate' as const, operation: 'mutate', confirmed: true, expectedRevision: client.revision }
      const writes = await Promise.allSettled([
        runner.executeManagement({ ...base, input: { action: 'create', title: 'Winner', content: 'Committed once.' } }),
        runner.executeManagement({ ...base, input: { action: 'create', title: 'Stale', content: 'Must not commit.' } }),
      ])
      expect(writes[0]!.status).toBe('fulfilled')
      expect(writes[1]).toMatchObject({ status: 'rejected', reason: { code: 'revision-conflict' } })
      expect((await client.read('snapshot')).value).toMatchObject({ total: 1, documents: [{ title: 'Winner', excerpt: 'Committed once.' }] })
    } finally { await f.dispose() }
  })
})
