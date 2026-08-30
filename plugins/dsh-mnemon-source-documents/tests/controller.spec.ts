import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentCapacityError, DocumentConflictError, DocumentController, DocumentManager } from "../src/controller.ts"

const directories: string[] = []

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-documents-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Mnemon Documents control plane', () => {
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

  it('preserves the active copy when an archive races a document revision', async () => {
    const controller = new DocumentController(workspace())
    const created = await controller.mutate({ action: 'create', title: 'Concurrency', content: 'Revision one.' })
    await controller.mutate({ action: 'update', id: created.document.id, content: 'Revision two.' })
    await expect(controller.archive(created.document.id, created.document.revision, { summary: 'stale', memoryBodyIds: [] })).rejects.toBeInstanceOf(DocumentConflictError)
    expect(controller.get(created.document.id)).toMatchObject({ status: 'active', content: 'Revision two.' })
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
    const agent = { session: { header: { cwd: root } } } as never

    const result = await manager.forAgent(agent).mutate({ action: 'create', title: 'Unified storage', content: 'All managed memory belongs below one selected root.' })

    expect(result.document.relativePath).toMatch(/^documents\/active\//)
    expect(result.snapshot.directory).toBe(join(storageRoot, 'documents'))
    expect(existsSync(join(storageRoot, result.document.relativePath))).toBe(true)
    expect(existsSync(join(root, '.mnemon', 'documents'))).toBe(false)
  })
})
