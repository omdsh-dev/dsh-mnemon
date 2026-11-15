import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import {
  DOCUMENT_FILENAME_PATTERN, DOCUMENTS_DIRECTORY, DOCUMENTS_INDEX_FILE, DOCUMENTS_LOCK_FILE,
  parseDocumentIndex, summarizeDocumentIndex, type DocumentRecord,
} from '../src/contracts.ts'
import { DocumentCapacityError, DocumentConflictError, DocumentController, DocumentManager } from '../src/controller.ts'
import { documentEvidence } from '../src/evidence.ts'
import * as plugin from '../src/index.ts'
import { strategy } from './fixture.ts'

const directories: string[] = []
const releases: Array<() => void | Promise<void>> = []

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-documents-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const release of releases.splice(0).reverse()) await release()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Mnemon Documents control plane', () => {
  it('preserves tied search order, excerpts, live reads and selected-only access updates', async () => {
    let now = new Date('2026-10-01T00:00:00.000Z')
    const controller = new DocumentController(workspace(), 1024 * 1024, () => now)
    for (let i = 0; i < 100; i++) await controller.mutate({ action: 'create', title: `storage ${i}`, description: 'schema', content: `# storage **schema** ${i}` })
    const original = controller.catalog().documents
    now = new Date('2026-10-03T00:00:00.000Z')
    const result = await controller.search('storage schema', { limit: 10 })
    expect(result.results.map(row => [row.id, row.score, row.excerpt])).toEqual(original.slice(0, 10).map((row, i) => [row.id, 6, `storage schema ${i}`]))
    expect(controller.catalog().documents.map(row => row.lastAccessedAt)).toEqual(original.map((row, i) => i < 10 ? now.toISOString() : row.lastAccessedAt))
    const last = original[99]!
    writeFileSync(join(controller.workspaceRoot, last.relativePath), 'External changed content live-sentinel')
    expect((await controller.search('live-sentinel', { allowedIds: [last.id] })).results[0]?.content).toBe('External changed content live-sentinel')
    expect((await controller.search('storage schema', { allowedIds: [] })).results).toEqual([])
    rmSync(join(controller.workspaceRoot, last.relativePath))
    // Missing files (ENOENT) skip cleanly so one disappeared active file does not break search.
    expect((await controller.search('storage schema', { limit: 1 })).results[0]?.id).toBe(original[0]!.id)
    // Non-ENOENT broken eligible files still fail even if they would rank below the limit.
    mkdirSync(join(controller.workspaceRoot, last.relativePath))
    await expect(controller.search('storage schema', { limit: 1 })).rejects.toThrow()
    expect((await controller.search('storage schema', { allowedIds: [original[0]!.id] })).results[0]?.id).toBe(original[0]!.id)
  })

  it('reads no bodies for revision/catalog, one for a single read, and reuses verified UI excerpts', async () => {
    const controller = new DocumentController(workspace())
    for (let index = 0; index < 24; index++) await controller.mutate({ action: 'create', title: `Record ${index}`, content: `Original ${index}` })
    const readBody = vi.spyOn(controller as unknown as { readBody(record: unknown): string }, 'readBody')
    const catalog = controller.catalog()
    expect(controller.revision()).toBe(catalog.revision)
    expect(catalog.documents).toHaveLength(24)
    expect(catalog.documents.every(record => record.healthy && record.excerpt === '')).toBe(true)
    expect(readBody).not.toHaveBeenCalled()
    controller.get(catalog.documents[0]!.id)
    expect(readBody).toHaveBeenCalledOnce()
    readBody.mockClear()
    expect(controller.snapshot().documents.every(record => record.excerpt.startsWith('Original'))).toBe(true)
    expect(readBody).not.toHaveBeenCalled()
  })

  it('reads each newly imported body once for full snapshots instead of rereading the collection', async () => {
    const controller = new DocumentController(workspace())
    const readBody = vi.spyOn(controller as unknown as { readBody(record: unknown): string }, 'readBody')
    for (let index = 0; index < 32; index++) {
      const result = await controller.mutate({ action: 'create', title: `Record ${index}`, content: `Original ${index}` })
      expect(result.snapshot.total).toBe(index + 1)
      expect(result.snapshot.documents.every(record => record.healthy && record.excerpt.startsWith('Original'))).toBe(true)
    }
    expect(readBody).toHaveBeenCalledTimes(32)
  })

  it('rechecks a management revision inside the mutation queue', async () => {
    const controller = new DocumentController(workspace())
    const revision = controller.revision()
    const first = controller.mutate({ action: 'create', title: 'First', content: 'Kept.' }, revision)
    const stale = controller.mutate({ action: 'create', title: 'Stale', content: 'Must not commit.' }, revision)
    await first
    await expect(stale).rejects.toBeInstanceOf(DocumentConflictError)
    expect(controller.snapshot().documents.map(document => document.title)).toEqual(['First'])
  })

  it('keeps cached index records isolated from mutable controller results', async () => {
    const controller = new DocumentController(workspace())
    const added = await controller.mutate({ action: 'create', title: 'Metadata', content: 'Preserved.', sourcePaths: ['notes.md'], sessionIds: ['original'] })
    const first = controller.snapshot(), revision = first.revision
    first.documents[0]!.title = 'Untrusted caller change'
    first.documents[0]!.sourcePaths.push('injected.md')
    first.documents[0]!.sessionIds.length = 0
    controller.get(added.document.id).memoryBodyIds.push('injected-space')
    const next = controller.snapshot()
    expect(next.revision).toBe(revision)
    expect(next.documents[0]).toMatchObject({ title: 'Metadata', sourcePaths: ['notes.md'], sessionIds: ['original'], memoryBodyIds: [] })
  })

  it('does not cache an index mutation when its atomic write fails', async () => {
    const controller = new DocumentController(workspace())
    const before = await controller.mutate({ action: 'create', title: 'Durable metadata', content: 'Stored.' })
    const revision = controller.revision()
    const internal = controller as unknown as { atomicWrite(path: string, content: string): void }
    const atomicWrite = internal.atomicWrite.bind(controller)
    const failure = vi.spyOn(internal, 'atomicWrite').mockImplementation((path, content) => {
      if (path === controller.indexPath) throw new Error('injected index write failure')
      atomicWrite(path, content)
    })
    await expect(controller.mutate({ action: 'update', id: before.document.id, title: 'Uncommitted metadata' }, revision)).rejects.toThrow('index write failure')
    failure.mockRestore()
    expect(controller.revision()).toBe(revision)
    expect(controller.snapshot().documents[0]).toMatchObject({ title: 'Durable metadata', revision: 1 })
  })

  it('creates an isolated active/archive directory and managed Markdown projection', async () => {
    const root = workspace()
    writeFileSync(join(root, 'ADR.md'), '# Original\nDo not mutate me.\n')
    const controller = new DocumentController(root)
    const result = await controller.mutate({
      action: 'create',
      title: 'SQLite deployment decision',
      description: 'Why this project uses an embedded database.',
      content: '# Decision\n\nUse SQLite so deployment remains single-file.',
      sourcePaths: ['ADR.md'],
      sessionIds: ['session-1'],
    })

    expect(result.document.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.document.relativePath).toMatch(/^\.mnemon\/documents\/active\//)
    expect(result.document.sourcePaths).toEqual(['ADR.md'])
    expect(readFileSync(join(root, 'ADR.md'), 'utf8')).toContain('Do not mutate me.')
    const projection = readFileSync(join(root, result.document.relativePath), 'utf8')
    expect(projection).toContain(`id: "${result.document.id}"`)
    expect(projection).toContain('source_paths:\n  - "ADR.md"')
    expect(projection).toContain('# Decision')
    expect(controller.snapshot()).toMatchObject({ activeCount: 1, archivedCount: 0, total: 1 })
  })

  it('updates through the index authority and searches active documents deterministically', async () => {
    const controller = new DocumentController(workspace())
    const first = await controller.mutate({ action: 'create', title: 'Release checklist', content: 'Run typecheck and WebUI E2E before push.' })
    await controller.mutate({ action: 'create', title: 'Database notes', content: 'SQLite keeps deployment local.' })
    const updated = await controller.mutate({ action: 'update', id: first.document.id, content: 'Run typecheck, unit tests, and real WebUI E2E before push.' })

    expect(updated.document.revision).toBe(2)
    expect(updated.document.contentHash).not.toBe(first.document.contentHash)
    const result = await controller.search('WebUI E2E')
    expect(result.results.map(document => document.id)).toEqual([first.document.id])
    expect(result.results[0]).toMatchObject({ status: 'active', score: expect.any(Number) })
  })

  it('matches focused Chinese queries by bounded bigrams instead of one full sentence token', async () => {
    const controller = new DocumentController(workspace())
    const release = await controller.mutate({
      action: 'create',
      title: 'Project Lantern 发布运行手册',
      content: '数据库 migration 完成后，依次提升到 5%、12%、35%、65%、100%。自动回滚按错误率和延迟阈值执行。',
    })
    await controller.mutate({ action: 'create', title: '事故记录', content: '数据库故障复盘与发布历史。' })

    const result = await controller.search('数据库迁移后灰度阶段顺序 自动回滚阈值 发布手册')
    expect(result.results.map(document => document.id)).toEqual([release.document.id])
  })

  it('uses actual active bytes, excludes cold archives, and proposes LRU eviction', async () => {
    const root = workspace()
    let tick = 0
    const controller = new DocumentController(root, 1_300, () => new Date(Date.UTC(2026, 7, 13, 0, 0, tick++)))
    const oldest = await controller.mutate({ action: 'create', title: 'Old topic', content: 'a'.repeat(180) })
    const recent = await controller.mutate({ action: 'create', title: 'Recent topic', content: 'b'.repeat(180) })

    let capacity: DocumentCapacityError | undefined
    try {
      await controller.mutate({ action: 'create', title: 'Overflow topic', content: 'c'.repeat(320) })
    } catch (error) {
      if (error instanceof DocumentCapacityError) capacity = error
      else throw error
    }
    expect(capacity?.candidates.map(record => record.id)).toEqual([oldest.document.id, recent.document.id])

    const archived = await controller.archive(oldest.document.id, oldest.document.revision, { summary: 'Archived old topic with original path.', memoryBodyIds: ['space-1'] })
    expect(archived.document.relativePath).toMatch(/^\.mnemon\/documents\/archived\//)
    expect(existsSync(join(root, oldest.document.relativePath))).toBe(false)
    expect(existsSync(join(root, archived.document.relativePath))).toBe(true)
    const snapshot = controller.snapshot()
    expect(snapshot).toMatchObject({ activeCount: 1, archivedCount: 1 })
    expect(snapshot.activeBytes).toBe(recent.document.sizeBytes)
    await expect(controller.search('Old')).resolves.toMatchObject({ total: 0 })
    await expect(controller.search('Old', { includeArchived: true })).resolves.toMatchObject({ total: 1 })
  })

  it('preserves the active copy when an archive races a document revision or index persistence fails', async () => {
    const controller = new DocumentController(workspace())
    const created = await controller.mutate({ action: 'create', title: 'Concurrency', content: 'Revision one.' })
    await controller.mutate({ action: 'update', id: created.document.id, content: 'Revision two.' })
    await expect(controller.archive(created.document.id, created.document.revision, { summary: 'stale', memoryBodyIds: [] })).rejects.toBeInstanceOf(DocumentConflictError)
    expect(controller.get(created.document.id)).toMatchObject({ status: 'active', content: 'Revision two.' })

    const activePath = join(controller.workspaceRoot, created.document.relativePath)
    const activeBytesBefore = readFileSync(activePath)
    const internal = controller as unknown as { atomicWrite(path: string, content: string): void }
    const atomicWrite = internal.atomicWrite.bind(controller)
    const failure = vi.spyOn(internal, 'atomicWrite').mockImplementation((path, content) => {
      if (path === controller.indexPath) throw new Error('injected archive index failure')
      atomicWrite(path, content)
    })
    await expect(controller.archive(created.document.id, 2, { summary: 'Attempted archive', memoryBodyIds: [] })).rejects.toThrow('injected archive index failure')
    failure.mockRestore()
    expect(readFileSync(activePath)).toEqual(activeBytesBefore)
    expect(existsSync(join(controller.archivedDirectory, created.document.filename))).toBe(false)
    expect(controller.get(created.document.id)).toMatchObject({ status: 'active', revision: 2, content: 'Revision two.' })
  })

  it('rejects source traversal and resolves one controller per workspace', async () => {
    const root = workspace()
    const manager = new DocumentManager()
    expect(manager.forWorkspace(root)).toBe(manager.forWorkspace(root))
    await expect(manager.forWorkspace(root).mutate({ action: 'create', title: 'Unsafe', content: 'x', sourcePaths: ['../outside.md'] })).rejects.toThrow('inside the workspace')
  })

  it('places managed Documents under the same configured storage root as runtime memory and Memory Spaces', async () => {
    const root = workspace()
    const storageRoot = workspace()
    const manager = new DocumentManager(undefined, undefined, () => storageRoot)

    const result = await manager.forWorkspace(root).mutate({ action: 'create', title: 'Unified storage', content: 'All managed memory belongs below one selected root.' })

    expect(result.document.relativePath).toMatch(/^documents\/active\//)
    expect(result.snapshot.directory).toBe(join(storageRoot, 'documents'))
    expect(existsSync(join(storageRoot, result.document.relativePath))).toBe(true)
    expect(existsSync(join(root, '.mnemon', 'documents'))).toBe(false)
  })
})

describe('Source-owned query-local excerpts', () => {
  it('keeps a matching window and explicitly omits surrounding text', () => {
    const content = 'before '.repeat(1_000) + 'sentinel here ' + 'after '.repeat(1_000)
    const excerpt = documentEvidence(content, 'sentinel', 1_000)
    expect(excerpt).toContain('sentinel here')
    expect(excerpt).toContain('[earlier content omitted]')
    expect(excerpt).toContain('[later content omitted]')
    expect(excerpt.length).toBeLessThanOrEqual(1_000)
  })

  it('never overflows tiny budgets with omission labels or broken Unicode', () => {
    for (const content of ['a'.repeat(900) + 'sentinel', '\u{1F600}'.repeat(500), '中文'.repeat(500) + '\u{1F600} sentinel']) {
      for (let limit = 0; limit < 70; limit++) {
        const excerpt = documentEvidence(content, 'sentinel', limit)
        expect(excerpt.length).toBeLessThanOrEqual(limit)
        expect(/\p{Surrogate}/u.test(excerpt)).toBe(false)
      }
    }
  })
})

describe('Documents storage contracts', () => {
  /** A controller over a separate storage root, as the Starter mounts it, with one active and one archived document. */
  async function stored(): Promise<{ root: string; controller: DocumentController; index: unknown }> {
    const root = workspace()
    const controller = new DocumentController(workspace(), undefined, () => new Date('2026-10-17T08:00:00.000Z'), root)
    await controller.mutate({ action: 'create', title: 'Release checklist', description: 'Steps', content: '# Release\n\nTag, then publish.', sourcePaths: ['README.md'] })
    const archived = await controller.mutate({ action: 'create', title: '旧的设计', content: 'Retired design' })
    await controller.archive(archived.document.id, archived.document.revision, { summary: 'Superseded', memoryBodyIds: ['project'] })
    return { root, controller, index: JSON.parse(readFileSync(join(root, DOCUMENTS_DIRECTORY, DOCUMENTS_INDEX_FILE), 'utf8')) as unknown }
  }

  function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'doc-1', title: 'Title', description: '', status: 'active', filename: 'title-doc1.md', relativePath: 'documents/active/title-doc1.md',
      sourcePaths: [], sessionIds: [], createdAt: '2026-10-17T08:00:00.000Z', updatedAt: '2026-10-17T08:00:00.000Z',
      lastAccessedAt: '2026-10-17T08:00:00.000Z', revision: 1, contentHash: 'a'.repeat(64), sizeBytes: 10, memoryBodyIds: [],
      ...overrides,
    }
  }

  it('name the files the controller reads, writes and locks', async () => {
    const { root, controller } = await stored()
    expect(controller.directory).toBe(join(root, DOCUMENTS_DIRECTORY))
    expect(controller.indexPath).toBe(join(root, DOCUMENTS_DIRECTORY, DOCUMENTS_INDEX_FILE))
    expect(controller.lockPath).toBe(join(root, DOCUMENTS_DIRECTORY, DOCUMENTS_LOCK_FILE))
    // The names a Mnemon Pack has always carried them under.
    expect([DOCUMENTS_DIRECTORY, DOCUMENTS_INDEX_FILE, DOCUMENTS_LOCK_FILE]).toEqual(['documents', 'index.json', '.index.lock'])
  })

  it('read the index the controller writes as it stands, each file name one it generates', async () => {
    const { index, controller } = await stored()
    const parsed = parseDocumentIndex(index)
    expect(parsed).toEqual(index)
    expect(parsed.documents.map(document => document.status)).toEqual(['active', 'archived'])
    expect(parsed.documents.every(document => DOCUMENT_FILENAME_PATTERN.test(document.filename))).toBe(true)
    for (const document of parsed.documents) expect(readFileSync(join(controller.storageRoot, document.relativePath), 'utf8')).toContain(`id: ${JSON.stringify(document.id)}`)
  })

  it('place a record where its status puts it, whatever path a copy names', async () => {
    // Without a storage root the controller records the legacy `.mnemon/` prefix.
    const root = workspace()
    const controller = new DocumentController(root)
    await controller.mutate({ action: 'create', title: 'Legacy layout', content: 'Body' })
    const index = JSON.parse(readFileSync(controller.indexPath, 'utf8')) as { documents: DocumentRecord[] }
    expect(index.documents[0]!.relativePath).toMatch(/^\.mnemon\/documents\/active\//u)
    expect(parseDocumentIndex(index).documents[0]!.relativePath).toBe(`documents/active/${index.documents[0]!.filename}`)
    expect(parseDocumentIndex({ version: 1, documents: [record({ status: 'archived', relativePath: '../../outside.md' })] }).documents[0]!.relativePath)
      .toBe('documents/archived/title-doc1.md')
  })

  it('keep what a record holds and drop what it does not', () => {
    const parsed = parseDocumentIndex({ version: 1, documents: [record({
      sourcePaths: ['a.md', 7, null], sessionIds: ['s-1', {}], memoryBodyIds: ['project', false],
      archivedAt: '2026-10-17T09:00:00.000Z', archiveSummary: 'Moved', healthy: true, excerpt: 'not stored',
    }), record({ id: 'doc-2', archivedAt: 5, archiveSummary: null })] })
    expect(parsed.documents[0]).toEqual({ ...record(), sourcePaths: ['a.md'], sessionIds: ['s-1'], memoryBodyIds: ['project'], archivedAt: '2026-10-17T09:00:00.000Z', archiveSummary: 'Moved' })
    expect(parsed.documents[1]).not.toHaveProperty('archivedAt')
    expect(parsed.documents[1]).not.toHaveProperty('archiveSummary')
  })

  it('refuse a whole index for one bad record, saying which rule it broke', () => {
    const refusals: Array<[unknown, string]> = [
      [null, 'Documents index.json is invalid'],
      [{ version: 2, documents: [] }, 'Documents index.json is invalid'],
      [{ version: 1, documents: {} }, 'Documents index.json is invalid'],
      [{ version: 1, documents: ['doc-1'] }, 'Documents index contains an invalid or duplicate id'],
      [{ version: 1, documents: [record({ id: '  ' })] }, 'Documents index contains an invalid or duplicate id'],
      [{ version: 1, documents: [record(), record()] }, 'Documents index contains an invalid or duplicate id'],
      [{ version: 1, documents: [record({ status: 'deleted' })] }, 'Documents index contains an invalid record'],
      [{ version: 1, documents: [record({ title: 1 })] }, 'Documents index contains an invalid record'],
      [{ version: 1, documents: [record({ revision: 1.5 })] }, 'Documents index contains invalid metadata'],
      [{ version: 1, documents: [record({ sizeBytes: 2 ** 53 })] }, 'Documents index contains invalid metadata'],
      [{ version: 1, documents: [record({ lastAccessedAt: undefined })] }, 'Documents index contains invalid metadata'],
      [{ version: 1, documents: [record({ sessionIds: 's-1' })] }, 'Documents index contains invalid lists'],
    ]
    for (const filename of ['../escape.md', 'nested/file.md', 'back\\slash.md', 'notes.txt', '.md', 'space name.md', 'C:file.md']) {
      refusals.push([{ version: 1, documents: [record({ filename })] }, 'Documents index contains an unsafe filename'])
    }
    for (const [value, message] of refusals) expect(() => parseDocumentIndex(value), JSON.stringify(value)).toThrow(message)
    expect(DOCUMENT_FILENAME_PATTERN.test('..md')).toBe(true)
  })

  it('summarize a stored index for an inventory without judging its records, and never throw', async () => {
    const { index } = await stored()
    expect(summarizeDocumentIndex(index)).toEqual({ valid: true, documents: 2, active: 1, archived: 1 })
    // A record that is an object counts whatever its status; anything else is skipped.
    expect(summarizeDocumentIndex({ version: 7, documents: [{ status: 'active' }, { status: 'gone' }, 3, null, { status: 'archived' }] }))
      .toEqual({ valid: true, documents: 3, active: 1, archived: 1 })
    for (const value of [null, [], { documents: 'none' }, { version: 1 }]) {
      expect(summarizeDocumentIndex(value)).toEqual({ valid: false, documents: 0, active: 0, archived: 0 })
    }
  })
})

function deleteFixture() {
  const directory = workspace()
  const workspaceDir = join(directory, 'workspace')
  mkdirSync(workspaceDir)
  const controller = new DocumentController(workspaceDir, 10 * 1024 * 1024, undefined, join(directory, 'data'))
  return { directory, workspace: workspaceDir, controller }
}

describe('permanent managed Document deletion', () => {
  it.each(['active', 'archived'] as const)('removes only the %s managed copy and releases its index entry', async status => {
    const f = deleteFixture()
    const original = join(f.workspace, 'notes.md')
    writeFileSync(original, 'Original project file stays untouched.')
    let saved = await f.controller.mutate({ action: 'create', title: 'Disposable draft', content: 'Temporary copy.', sourcePaths: ['notes.md'] })
    if (status === 'archived') saved = await f.controller.archive(saved.document.id, saved.document.revision, { summary: 'Local archive.', memoryBodyIds: [] })
    const path = join(f.controller.storageRoot, saved.document.relativePath)
    expect(existsSync(path)).toBe(true)
    const plan = f.controller.capacityPlan({ action: 'delete', id: saved.document.id, fileRevision: saved.document.fileRevision! })
    expect(plan).toMatchObject({ projected: 0, fits: true, candidates: [] })
    const deleted = await f.controller.mutate({ action: 'delete', id: saved.document.id, fileRevision: saved.document.fileRevision! }, saved.snapshot.revision)
    expect(deleted).toMatchObject({ action: 'deleted', snapshot: { total: 0, activeCount: 0, archivedCount: 0, activeBytes: 0 } })
    expect(existsSync(path)).toBe(false)
    expect(JSON.parse(readFileSync(f.controller.indexPath, 'utf8')).documents).toEqual([])
    expect(readFileSync(original, 'utf8')).toBe('Original project file stays untouched.')
    expect(() => f.controller.get(saved.document.id)).toThrow('document not found')
    expect(new DocumentController(f.workspace, undefined, undefined, f.controller.storageRoot).snapshot().total).toBe(0)
  })

  it('requires the index revision and checks it after queued writes before deleting', async () => {
    const { controller } = deleteFixture()
    const saved = await controller.mutate({ action: 'create', title: 'Protected', content: 'Original.' })
    await expect(controller.mutate({ action: 'delete', id: saved.document.id, fileRevision: saved.document.fileRevision! })).rejects.toThrow(/revision/i)
    const updating = controller.mutate({ action: 'update', id: saved.document.id, content: 'New content.' })
    const deleting = controller.mutate({ action: 'delete', id: saved.document.id, fileRevision: saved.document.fileRevision! }, saved.snapshot.revision)
    await updating
    await expect(deleting).rejects.toBeInstanceOf(DocumentConflictError)
    expect(controller.get(saved.document.id).content).toBe('New content.')
  })

  it('restores exact file bytes and index after an index commit fails, then allows a retry', async () => {
    const { controller } = deleteFixture()
    const saved = await controller.mutate({ action: 'create', title: 'Durable draft', content: '# Keep\n\nExact body.' })
    const path = join(controller.storageRoot, saved.document.relativePath)
    const before = readFileSync(path)
    const index = readFileSync(controller.indexPath)
    const writer = controller as unknown as { atomicWrite(path: string, content: string): void }
    const atomicWrite = writer.atomicWrite.bind(controller)
    const fault = vi.spyOn(writer, 'atomicWrite').mockImplementation((target, content) => {
      if (target === controller.indexPath) throw new Error('simulated index write failure')
      atomicWrite(target, content)
    })
    await expect(controller.mutate({ action: 'delete', id: saved.document.id, fileRevision: saved.document.fileRevision! }, saved.snapshot.revision)).rejects.toThrow('simulated index write failure')
    expect(readFileSync(path)).toEqual(before)
    expect(readFileSync(controller.indexPath)).toEqual(index)
    expect(controller.snapshot()).toMatchObject({ revision: saved.snapshot.revision, total: 1 })
    fault.mockRestore()
    await expect(controller.mutate({ action: 'delete', id: saved.document.id, fileRevision: saved.document.fileRevision! }, saved.snapshot.revision)).resolves.toMatchObject({ action: 'deleted' })
  })

  it('rejects an index path that names another managed file', async () => {
    const { controller } = deleteFixture()
    const first = await controller.mutate({ action: 'create', title: 'First', content: 'First body.' })
    const second = await controller.mutate({ action: 'create', title: 'Second', content: 'Second body.' })
    const index = JSON.parse(readFileSync(controller.indexPath, 'utf8'))
    index.documents[0].relativePath = second.document.relativePath
    writeFileSync(controller.indexPath, JSON.stringify(index))
    await expect(controller.mutate({ action: 'delete', id: first.document.id, fileRevision: first.document.fileRevision! }, controller.revision())).rejects.toThrow(/managed path/i)
    expect(controller.get(second.document.id).content).toBe('Second body.')
    expect(controller.snapshot().total).toBe(2)
  })

  it('rejects a damaged index when both file fields point at another document', async () => {
    const { controller } = deleteFixture()
    const first = await controller.mutate({ action: 'create', title: 'First', content: 'First body.' })
    const second = await controller.mutate({ action: 'create', title: 'Second', content: 'Protected body.' })
    const index = JSON.parse(readFileSync(controller.indexPath, 'utf8'))
    index.documents[0].filename = second.document.filename
    index.documents[0].relativePath = second.document.relativePath
    writeFileSync(controller.indexPath, JSON.stringify(index))
    await expect(controller.mutate({ action: 'delete', id: first.document.id, fileRevision: first.document.fileRevision! }, controller.revision())).rejects.toThrow(/managed path/i)
    expect(controller.get(second.document.id).content).toBe('Protected body.')
    expect(existsSync(join(controller.storageRoot, first.document.relativePath))).toBe(true)
  })

  it('preserves edits made directly to the managed file after confirmation', async () => {
    const { controller } = deleteFixture()
    const saved = await controller.mutate({ action: 'create', title: 'Direct edit', content: 'Reviewed content.' })
    const path = join(controller.storageRoot, saved.document.relativePath)
    writeFileSync(path, 'An external correction after confirmation.')
    await expect(controller.mutate({ action: 'delete', id: saved.document.id, fileRevision: saved.document.fileRevision! }, saved.snapshot.revision)).rejects.toBeInstanceOf(DocumentConflictError)
    expect(readFileSync(path, 'utf8')).toBe('An external correction after confirmation.')
    expect(controller.snapshot().total).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('rejects a managed file symlink without touching the target or metadata', async () => {
    const { controller, workspace } = deleteFixture()
    const saved = await controller.mutate({ action: 'create', title: 'Link', content: 'Managed.' })
    const path = join(controller.storageRoot, saved.document.relativePath)
    const original = join(workspace, 'original.md')
    writeFileSync(original, 'External original.')
    rmSync(path)
    symlinkSync(original, path)
    await expect(controller.mutate({ action: 'delete', id: saved.document.id, fileRevision: saved.document.fileRevision! }, saved.snapshot.revision)).rejects.toThrow(/regular managed file/i)
    expect(readFileSync(original, 'utf8')).toBe('External original.')
    expect(controller.snapshot().total).toBe(1)
  })
})

describe('Documents deletion authority', () => {
  async function setup() {
    const f = deleteFixture()
    const runner = new MemoryCompositionRunner()
    releases.push(() => runner.dispose())
    await runner.mount(strategy, { instanceId: 'strategy' })
    await runner.mount(plugin, { instanceId: 'documents', config: { dataDir: f.controller.storageRoot } })
    const base = { sourceInstanceKey: 'source:documents', scope: { storage: 'custom' as const, workspaceId: f.workspace } }
    const added = await f.controller.mutate({ action: 'create', title: 'Selected draft', content: 'Only this copy.' })
    return { ...f, runner, base, added }
  }

  it('requires confirmed management and a fresh revision; does not invoke an archive workflow', async () => {
    const f = await setup()
    const request = { ...f.base, mode: 'mutate' as const, operation: 'delete', input: { id: f.added.document.id, fileRevision: f.added.document.fileRevision! }, expectedRevision: f.added.snapshot.revision }
    await expect(f.runner.executeManagement({ ...request, confirmed: false })).rejects.toThrow(/confirm/i)
    expect(f.controller.get(f.added.document.id).content).toBe('Only this copy.')
    const deleted = await f.runner.executeManagement({ ...request, confirmed: true })
    expect(deleted.value).toMatchObject({ action: 'deleted', snapshot: { total: 0, archivedCount: 0 } })
  })

  it('allows a confirmed Agent delete only for documents in its pinned ReadGrant', async () => {
    const f = await setup()
    const turn = await f.runner.beginTurn({ scope: f.base.scope })
    const manage = turn.view.actionOffers.find(offer => offer.sourceActionId === 'manage')!
    await expect(turn.executeAction(manage.id, { action: 'delete', id: f.added.document.id, fileRevision: f.added.document.fileRevision! }, () => true)).rejects.toThrow(/confirm/i)
    const outside = await f.controller.mutate({ action: 'create', title: 'Not in View', content: 'Must survive.' })
    await expect(turn.executeAction(manage.id, { action: 'delete', id: outside.document.id, fileRevision: outside.document.fileRevision!, confirmed: true, expectedRevision: outside.snapshot.revision }, () => true)).rejects.toThrow(/ReadGrant/)
    await expect(turn.executeAction(manage.id, { action: 'delete', id: f.added.document.id, fileRevision: f.added.document.fileRevision!, confirmed: true, expectedRevision: f.added.snapshot.revision }, () => true)).rejects.toMatchObject({ code: 'revision-conflict' })
    await expect(turn.executeAction(manage.id, { action: 'delete', id: f.added.document.id, fileRevision: f.added.document.fileRevision!, confirmed: true, expectedRevision: outside.snapshot.revision }, () => true)).resolves.toMatchObject({ completion: 'committed', details: { action: 'deleted' } })
    expect(f.controller.get(outside.document.id).content).toBe('Must survive.')
    turn.release()
  })

  it('exposes the post-search index revision so an Agent can confirm deleting a pinned archive', async () => {
    const f = await setup()
    await f.controller.archive(f.added.document.id, 1, { summary: 'Local archive.', memoryBodyIds: ['existing-reference'] })
    const turn = await f.runner.beginTurn({ scope: f.base.scope })
    const result = await turn.executeRoute(turn.view.routes[0]!.id, { query: 'Only this copy', includeArchived: true })
    const revision = (result.metadata as { indexRevision: string }).indexRevision
    expect(revision).toBe(f.controller.revision())
    const manage = turn.view.actionOffers.find(offer => offer.sourceActionId === 'manage')!
    await expect(turn.executeAction(manage.id, { action: 'delete', id: f.added.document.id, fileRevision: (result.items[0]!.provenance as { fileRevision: string }).fileRevision, confirmed: true, expectedRevision: revision! }, () => true))
      .resolves.toMatchObject({ completion: 'committed', details: { action: 'deleted', document: { memoryBodyIds: ['existing-reference'] }, snapshot: { total: 0 } } })
    turn.release()
  })
})
