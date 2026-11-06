import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCompositionRunner } from 'dsh-mnemon/testing'
import { DocumentConflictError, DocumentController } from '../src/controller.ts'
import * as plugin from '../src/index.ts'
import { strategy } from './fixture.ts'

const releases: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const release of releases.splice(0).reverse()) await release() })

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mnemon-document-delete-'))
  releases.push(() => rmSync(directory, { recursive: true, force: true }))
  const workspace = join(directory, 'workspace')
  mkdirSync(workspace)
  const controller = new DocumentController(workspace, 10 * 1024 * 1024, undefined, join(directory, 'data'))
  return { directory, workspace, controller }
}

describe('permanent managed Document deletion', () => {
  it.each(['active', 'archived'] as const)('removes only the %s managed copy and releases its index entry', async status => {
    const f = fixture()
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
    const { controller } = fixture()
    const saved = await controller.mutate({ action: 'create', title: 'Protected', content: 'Original.' })
    await expect(controller.mutate({ action: 'delete', id: saved.document.id, fileRevision: saved.document.fileRevision! })).rejects.toThrow(/revision/i)
    const updating = controller.mutate({ action: 'update', id: saved.document.id, content: 'New content.' })
    const deleting = controller.mutate({ action: 'delete', id: saved.document.id, fileRevision: saved.document.fileRevision! }, saved.snapshot.revision)
    await updating
    await expect(deleting).rejects.toBeInstanceOf(DocumentConflictError)
    expect(controller.get(saved.document.id).content).toBe('New content.')
  })

  it('restores exact file bytes and index after an index commit fails, then allows a retry', async () => {
    const { controller } = fixture()
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
    const { controller } = fixture()
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
    const { controller } = fixture()
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
    const { controller } = fixture()
    const saved = await controller.mutate({ action: 'create', title: 'Direct edit', content: 'Reviewed content.' })
    const path = join(controller.storageRoot, saved.document.relativePath)
    writeFileSync(path, 'An external correction after confirmation.')
    await expect(controller.mutate({ action: 'delete', id: saved.document.id, fileRevision: saved.document.fileRevision! }, saved.snapshot.revision)).rejects.toBeInstanceOf(DocumentConflictError)
    expect(readFileSync(path, 'utf8')).toBe('An external correction after confirmation.')
    expect(controller.snapshot().total).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('rejects a managed file symlink without touching the target or metadata', async () => {
    const { controller, workspace } = fixture()
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
    const f = fixture()
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
