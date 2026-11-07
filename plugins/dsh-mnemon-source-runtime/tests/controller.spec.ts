import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_ENTRY_DELIMITER } from '../src/contracts.ts'
import {
  RuntimeMemoryCapacityError,
  RuntimeMemoryController,
} from "../src/controller.ts"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(now = new Date('2026-08-13T08:00:00.000Z')): { directory: string; controller: RuntimeMemoryController } {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-runtime-'))
  directories.push(directory)
  return {
    directory,
    controller: new RuntimeMemoryController({ effectiveDataDir: () => directory }, () => now),
  }
}

describe('RuntimeMemoryController', () => {
  it('preserves importance through a separate USER.md store, plans and compaction (#469)', async () => {
    const { directory } = fixture()
    const controller = new RuntimeMemoryController({ effectiveDataDir: () => directory }, undefined, undefined,
      { effectiveDataDir: () => join(directory, 'profile') })
    await controller.mutate({ action: 'add', target: 'user', content: 'Keep the original rule', importance: 'critical' })
    const request = { action: 'replace' as const, target: 'user' as const, oldText: 'Keep the original rule', content: 'Correct the rule', importance: 'normal' as const }
    const plan = await controller.planMaintenance(request, { preserveImportance: true })
    expect(plan.pending?.importance).toBe('critical')
    await controller.compactAndMutate(plan.revision, request, [], undefined, { preserveImportance: true })
    expect(controller.snapshot().entries[0]?.importance).toBe('critical')
    await controller.mutate({ ...request, oldText: request.content, content: 'Another correction', importance: 'low' }, { preserveImportance: true })
    expect(controller.snapshot().entries[0]?.importance).toBe('critical')
    await controller.mutate({ ...request, oldText: 'Another correction', content: 'Manual reclassification', importance: 'low' })
    await controller.mutate({ ...request, oldText: 'Manual reclassification', content: 'Automatic promotion', importance: 'critical' }, { preserveImportance: true })
    expect(controller.snapshot().entries[0]?.importance).toBe('critical')
  })

  it('creates the JSON source of truth and deterministic Markdown projections', async () => {
    const { directory, controller } = fixture()
    await controller.mutate({ action: 'add', target: 'user', content: '用户偏好简洁回答', importance: 'critical' })
    await controller.mutate({ action: 'add', target: 'memory', content: '项目使用 TypeScript', importance: 'normal' })

    const root = join(directory, 'runtime')
    const source = JSON.parse(readFileSync(join(root, 'memories.json'), 'utf8')) as { version: number; entries: unknown[] }
    expect(source).toEqual({
      version: 1,
      entries: [
        {
          content: '用户偏好简洁回答',
          created_at: '2026-08-13T08:00:00.000Z',
          updated_at: '2026-08-13T08:00:00.000Z',
          target: 'user',
          importance: 'critical',
        },
        {
          content: '项目使用 TypeScript',
          created_at: '2026-08-13T08:00:00.000Z',
          updated_at: '2026-08-13T08:00:00.000Z',
          target: 'memory',
          importance: 'normal',
        },
      ],
    })
    expect(readFileSync(join(root, 'USER.md'), 'utf8')).toBe('用户偏好简洁回答\n')
    expect(readFileSync(join(root, 'MEMORY.md'), 'utf8')).toBe('项目使用 TypeScript\n')
    expect(existsSync(join(root, '.memories.lock'))).toBe(false)
  })

  it('projects one-line entries separated by a standalone section sign', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: '第一条\n  测试' })
    await controller.mutate({ action: 'add', target: 'memory', content: '第二条\t测试' })

    expect(controller.snapshot().entries.map(entry => entry.content)).toEqual(['第一条 测试', '第二条 测试'])
    expect(readFileSync(controller.memoryPath, 'utf8')).toBe('第一条 测试\n§\n第二条 测试\n')
    expect(RUNTIME_ENTRY_DELIMITER).toBe('\n§\n')
    await expect(controller.mutate({ action: 'add', target: 'memory', content: '不能包含 § 分隔符' })).rejects.toThrow('reserved § entry delimiter')
  })

  it('supports unique-substring replace and remove while preserving creation time', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: 'Use TypeScript for plugin code' })
    const replaced = await controller.mutate({ action: 'replace', target: 'memory', oldText: 'TypeScript', content: 'Use Rust for plugin code', importance: 'low' })
    expect(replaced).toMatchObject({ message: 'Entry replaced.', replaced: { from: 'Use TypeScript for plugin code', to: 'Use Rust for plugin code' } })
    expect(controller.snapshot().entries).toEqual([
      expect.objectContaining({ content: 'Use Rust for plugin code', importance: 'low', created_at: '2026-08-13T08:00:00.000Z' }),
    ])

    await expect(controller.mutate({ action: 'remove', target: 'memory', oldText: 'Rust' })).resolves.toMatchObject({ removed: 'Use Rust for plugin code', entryCount: 0 })
    expect(controller.snapshot().entries).toEqual([])
  })

  it.each([
    ['memory', 'remove'], ['memory', 'replace'], ['user', 'remove'], ['user', 'replace'],
  ] as const)('prefers an exact %s entry for %s over other substring matches', async (target, action) => {
    const now = new Date('2026-08-13T08:00:00.000Z')
    const { directory, controller } = fixture(now)
    const otherTarget = target === 'memory' ? 'user' : 'memory'
    await controller.mutate({ action: 'add', target, content: 'EGO_LINUX_CHROME' })
    await controller.mutate({ action: 'add', target, content: 'X', importance: 'critical', ...(target === 'memory' ? { branches: ['main'] } : {}) })
    await controller.mutate({ action: 'add', target: otherTarget, content: 'X' })
    const before = controller.snapshot()
    now.setTime(Date.parse('2026-08-14T08:00:00.000Z'))

    const result = await controller.mutate({ action, target, oldText: ' \nX\t ', ...(action === 'replace' ? { content: 'Y' } : {}) })
    expect(result).toMatchObject(action === 'remove'
      ? { removed: 'X', entryCount: 1 }
      : { replaced: { from: 'X', to: 'Y' }, entryCount: 2 })
    const entries = controller.snapshot().entries
    expect(entries.filter(entry => entry.content !== 'Y')).toEqual([before.entries[0], before.entries[2]])
    if (action === 'replace') {
      expect(entries[1]).toEqual({ ...before.entries[1], content: 'Y', updated_at: '2026-08-14T08:00:00.000Z' })
    }
    const projection = action === 'remove' ? 'EGO_LINUX_CHROME\n' : `EGO_LINUX_CHROME${RUNTIME_ENTRY_DELIMITER}Y\n`
    expect(readFileSync(target === 'memory' ? controller.memoryPath : controller.userPath, 'utf8')).toBe(projection)
    expect(new RuntimeMemoryController({ effectiveDataDir: () => directory }).snapshot().entries).toEqual(entries)
    expect(controller.contextProjection('main').entries.filter(entry => entry.target === target).map(entry => entry.content))
      .toEqual(action === 'remove' ? ['EGO_LINUX_CHROME'] : ['EGO_LINUX_CHROME', 'Y'])
    if (target === 'memory') {
      expect(controller.contextProjection('dev').entries.filter(entry => entry.target === target).map(entry => entry.content)).toEqual(['EGO_LINUX_CHROME'])
    }
  })

  it.each(['memory', 'user'] as const)('keeps substring fallback within %s when another target has an exact match', async target => {
    const { controller } = fixture()
    const otherTarget = target === 'memory' ? 'user' : 'memory'
    await controller.mutate({ action: 'add', target, content: 'EGO_LINUX_CHROME' })
    await controller.mutate({ action: 'add', target: otherTarget, content: 'X' })
    const other = controller.snapshot().entries[1]

    await expect(controller.mutate({ action: 'replace', target, oldText: 'X', content: 'Updated environment' }))
      .resolves.toMatchObject({ replaced: { from: 'EGO_LINUX_CHROME', to: 'Updated environment' } })
    expect(controller.snapshot().entries[1]).toEqual(other)
  })

  it.each(['remove', 'replace'] as const)('rejects %s of duplicate exact entries without choosing a branch or changing files', async action => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: 'X', branches: ['main'] })
    await controller.mutate({ action: 'add', target: 'memory', content: 'temporary value', branches: ['dev'] })
    await controller.mutate({ action: 'replace', target: 'memory', oldText: 'temporary value', content: 'X' })
    await controller.mutate({ action: 'add', target: 'memory', content: 'EGO_LINUX_CHROME' })
    const paths = [controller.sourcePath, controller.memoryPath, controller.userPath]
    const before = paths.map(path => readFileSync(path, 'utf8'))

    await expect(controller.mutate({ action, target: 'memory', oldText: 'X', content: 'Y', branches: ['main'] }))
      .rejects.toThrow('Multiple memory entries')
    expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(before)
  })

  it.each(['remove', 'replace'] as const)('rejects ambiguous substring %s without changing the source', async action => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: 'SQLite is local-first' })
    await controller.mutate({ action: 'add', target: 'memory', content: 'SQLite uses one file' })
    const paths = [controller.sourcePath, controller.memoryPath, controller.userPath]
    const before = paths.map(path => readFileSync(path, 'utf8'))
    await expect(controller.mutate({ action, target: 'memory', oldText: 'SQLite', content: 'Updated database' })).rejects.toThrow('Multiple memory entries')
    await expect(controller.mutate({ action, target: 'memory', oldText: 'missing', content: 'Updated database' })).rejects.toThrow('No memory entry')
    expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(before)
  })

  it('reads a malformed stored branch scope or origin as absent instead of breaking the projection', async () => {
    const { directory, controller } = fixture()
    const at = '2026-08-13T08:00:00.000Z'
    const entry = (content: string, extra: Record<string, unknown>) => ({ content, target: 'memory', importance: 'normal', created_at: at, updated_at: at, ...extra })
    mkdirSync(join(directory, 'runtime'), { recursive: true })
    writeFileSync(join(directory, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [
      entry('Scoped by a number', { branches: 5 }),
      entry('Scoped by an object', { branches: { main: true } }),
      entry('Scoped by a string', { branches: 'release-main' }),
      entry('Scoped with a bad name', { branches: ['main', 3] }),
      entry('Scoped to main', { branches: ['main'], origin: { machine: 'machine-a', label: 'desk', at } }),
      entry('Odd provenance', { origin: { machine: 1 }, extra: 'not an entry field' }),
    ] }))
    const visible = (branch: string) => controller.contextProjection(branch).entries.map(item => item.content).sort()
    const unscoped = ['Odd provenance', 'Scoped by a number', 'Scoped by a string', 'Scoped by an object', 'Scoped with a bad name']
    expect(visible('main')).toEqual([...unscoped, 'Scoped to main'].sort())
    expect(visible('dev')).toEqual(unscoped)

    await controller.mutate({ action: 'add', target: 'memory', content: 'Fresh entry', importance: 'low' })
    const stored = (JSON.parse(readFileSync(join(directory, 'runtime', 'memories.json'), 'utf8')) as { entries: Array<Record<string, unknown>> }).entries
    const find = (content: string) => stored.find(item => item['content'] === content)
    expect(find('Scoped to main')).toMatchObject({ branches: ['main'], origin: { machine: 'machine-a', label: 'desk', at } })
    for (const content of ['Scoped by a number', 'Scoped by an object', 'Scoped by a string', 'Scoped with a bad name']) expect(find(content)).not.toHaveProperty('branches')
    expect(find('Odd provenance')).not.toHaveProperty('origin')
    expect(find('Odd provenance')).not.toHaveProperty('extra')
  })

  it('serializes concurrent callers, including independent controller instances', async () => {
    const { directory, controller } = fixture()
    const other = new RuntimeMemoryController({ effectiveDataDir: () => directory })
    await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? controller : other).mutate({
      action: 'add',
      target: index % 3 === 0 ? 'user' : 'memory',
      content: `concurrent-entry-${index}`,
    })))
    const snapshot = controller.snapshot()
    expect(snapshot.entries).toHaveLength(20)
    expect(new Set(snapshot.entries.map(entry => entry.content)).size).toBe(20)
    const memoryProjection = snapshot.entries.filter(entry => entry.target === 'memory').map(entry => entry.content).join(RUNTIME_ENTRY_DELIMITER)
    expect(readFileSync(controller.memoryPath, 'utf8')).toBe(`${memoryProjection}\n`)
  })

  it('uses UTF-8 bytes for capacity and leaves every file unchanged on overflow', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'user', content: 'x'.repeat(4_090) })
    const beforeJson = readFileSync(controller.sourcePath, 'utf8')
    const beforeMarkdown = readFileSync(controller.userPath, 'utf8')
    await expect(controller.mutate({ action: 'add', target: 'user', content: '超出' })).rejects.toBeInstanceOf(RuntimeMemoryCapacityError)
    expect(readFileSync(controller.sourcePath, 'utf8')).toBe(beforeJson)
    expect(readFileSync(controller.userPath, 'utf8')).toBe(beforeMarkdown)
  })

  it('applies configured USER.md and MEMORY.md byte limits to every Runtime view and mutation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-runtime-configured-'))
    directories.push(directory)
    const controller = new RuntimeMemoryController(
      { effectiveDataDir: () => directory },
      undefined,
      { memory: 20_480, user: 10_240 },
    )

    await expect(controller.mutate({ action: 'add', target: 'user', content: 'u'.repeat(6_000) }))
      .resolves.toMatchObject({ usage: { used: 6_000, limit: 10_240 } })
    await controller.mutate({ action: 'add', target: 'memory', content: 'a'.repeat(8_000) })
    await expect(controller.mutate({ action: 'add', target: 'memory', content: 'b'.repeat(8_000) }))
      .resolves.toMatchObject({ usage: { used: 16_004, limit: 20_480 } })

    expect(controller.snapshot().targets).toMatchObject({
      user: { used: 6_000, limit: 10_240 },
      memory: { used: 16_004, limit: 20_480 },
    })
    expect((await controller.planMaintenance({ action: 'add', target: 'memory', content: 'c'.repeat(5_000) }))).toMatchObject({
      projected: 21_008,
      limit: 20_480,
      requiresMaintenance: true,
    })
  })

  it('combines a global USER.md with workspace MEMORY.md without moving or widening hidden entries', async () => {
    const globalRoot = mkdtempSync(join(tmpdir(), 'dsh-mnemon-runtime-global-user-'))
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'dsh-mnemon-runtime-workspace-memory-'))
    directories.push(globalRoot, workspaceRoot)
    const globalRunner = { effectiveDataDir: () => globalRoot }
    const workspaceRunner = { effectiveDataDir: () => workspaceRoot }
    const global = new RuntimeMemoryController(globalRunner)
    const workspace = new RuntimeMemoryController(workspaceRunner)
    await global.mutate({ action: 'add', target: 'user', content: 'Always stash before pulling.' })
    await global.mutate({ action: 'add', target: 'memory', content: 'Hidden global project fact.' })
    await workspace.mutate({ action: 'add', target: 'user', content: 'Hidden workspace profile.' })
    await workspace.mutate({ action: 'add', target: 'memory', content: 'Exclude environment YAML from commits.' })

    const combined = new RuntimeMemoryController(workspaceRunner, undefined, undefined, globalRunner)
    expect(combined.userPath).toBe(join(globalRoot, 'runtime', 'USER.md'))
    expect(combined.userSourcePath).toBe(join(globalRoot, 'runtime', 'memories.json'))
    expect(combined.memoryPath).toBe(join(workspaceRoot, 'runtime', 'MEMORY.md'))
    expect(combined.snapshot().entries.map(entry => entry.content)).toEqual([
      'Always stash before pulling.',
      'Exclude environment YAML from commits.',
    ])
    expect(combined.contextProjection().text).toContain('Always stash before pulling.')
    expect(combined.contextProjection().text).toContain('Exclude environment YAML from commits.')
    expect(combined.contextProjection().text).not.toContain('Hidden global project fact.')
    expect(combined.contextProjection().text).not.toContain('Hidden workspace profile.')

    await combined.mutate({ action: 'add', target: 'user', content: 'Prefer concise answers.' })
    await combined.mutate({ action: 'add', target: 'memory', content: 'Run tests before project commits.' })
    expect(global.snapshot().entries.map(entry => entry.content)).toEqual([
      'Always stash before pulling.',
      'Hidden global project fact.',
      'Prefer concise answers.',
    ])
    expect(workspace.snapshot().entries.map(entry => entry.content)).toEqual([
      'Hidden workspace profile.',
      'Exclude environment YAML from commits.',
      'Run tests before project commits.',
    ])

    const userPlan = await combined.planMaintenance({ action: 'add', target: 'user', content: 'Prefer Chinese replies.' })
    await combined.compactAndMutate(
      userPlan.revision,
      { action: 'add', target: 'user', content: 'Prefer Chinese replies.' },
      [{ content: 'Keep local changes safe before Git synchronization.', importance: 'critical' }],
    )
    expect(global.snapshot().entries.map(entry => entry.content)).toEqual([
      'Hidden global project fact.',
      'Keep local changes safe before Git synchronization.',
      'Prefer Chinese replies.',
    ])
  })

  it('keeps the global profile visible while branch-filtering only workspace memory', async () => {
    const globalRoot = mkdtempSync(join(tmpdir(), 'dsh-mnemon-runtime-global-branch-user-'))
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'dsh-mnemon-runtime-workspace-branch-memory-'))
    directories.push(globalRoot, workspaceRoot)
    const globalRunner = { effectiveDataDir: () => globalRoot }
    const workspaceRunner = { effectiveDataDir: () => workspaceRoot }
    const global = new RuntimeMemoryController(globalRunner)
    const workspace = new RuntimeMemoryController(workspaceRunner)
    await global.mutate({ action: 'add', target: 'user', content: 'Use the global user profile.' })
    await global.mutate({ action: 'add', target: 'memory', content: 'Hidden global project memory.' })
    await workspace.mutate({ action: 'add', target: 'user', content: 'Hidden workspace user profile.' })
    await workspace.mutate({ action: 'add', target: 'memory', content: 'Shared workspace fact.' })
    await workspace.mutate({ action: 'add', target: 'memory', content: 'Main-only workspace fact.', branches: ['main'] })
    await workspace.mutate({ action: 'add', target: 'memory', content: 'Dev-only workspace fact.', branches: ['dev'] })

    const combined = new RuntimeMemoryController(workspaceRunner, undefined, undefined, globalRunner)
    const complete = combined.snapshot()
    const onMain = combined.contextProjection('main')
    const onDev = combined.contextProjection('dev')

    expect(complete.entries.map(entry => entry.content)).toEqual([
      'Use the global user profile.',
      'Shared workspace fact.',
      'Main-only workspace fact.',
      'Dev-only workspace fact.',
    ])
    expect(onMain.revision).toBe(complete.revision)
    expect(onDev.revision).toBe(complete.revision)
    expect(onMain.text).toContain('Use the global user profile.')
    expect(onMain.text).toContain('Shared workspace fact.')
    expect(onMain.text).toContain('Main-only workspace fact.')
    expect(onMain.text).not.toContain('Dev-only workspace fact.')
    expect(onMain.text).not.toContain('Hidden global project memory.')
    expect(onMain.text).not.toContain('Hidden workspace user profile.')
    expect(onMain.text).toContain('Git branch: main (1 branch-scoped entry hidden)')
    expect(onMain.text).toContain('MEMORY.md (working reference)')
    expect(onDev.text).toContain('Use the global user profile.')
    expect(onDev.text).toContain('Dev-only workspace fact.')
    expect(onDev.text).not.toContain('Main-only workspace fact.')
    expect(readFileSync(combined.memoryPath, 'utf8')).toContain('Main-only workspace fact.')
    expect(readFileSync(combined.memoryPath, 'utf8')).toContain('Dev-only workspace fact.')
  })

  it('repairs derived files from memories.json when a controller starts', async () => {
    const { directory, controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: 'source-owned value' })
    writeFileSync(controller.memoryPath, 'manual edit\n')
    new RuntimeMemoryController({ effectiveDataDir: () => directory })
    expect(readFileSync(controller.memoryPath, 'utf8')).toBe('source-owned value\n')
  })

  it('omits default annotations and monitoring fields while retaining every entry and revision', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'user', content: 'Prefer concise Chinese replies.' })
    await controller.mutate({ action: 'add', target: 'user', content: 'Memory writes require authorization.', importance: 'critical' })
    await controller.mutate({ action: 'add', target: 'memory', content: 'Temporary synthetic note remains visible.', importance: 'low' })
    const snapshot = controller.snapshot()
    const paths = [controller.sourcePath, controller.userPath, controller.memoryPath]
    const files = paths.map(path => readFileSync(path, 'utf8'))
    const projected = controller.contextProjection()
    expect(projected.text).toContain('<runtime-memory-file name="USER.md">\nPrefer concise Chinese replies.')
    expect(projected.text).toContain('[importance=critical]\nMemory writes require authorization.')
    expect(projected.text).toContain('[importance=low]\nTemporary synthetic note remains visible.')
    expect(projected.text).not.toMatch(/Revision:|UTF-8 bytes:|entries:|created=0d|updated=0d/u)
    expect(projected.entries).toEqual(snapshot.entries)
    expect(projected.revision).toBe(snapshot.revision)
    expect(projected.totalEntries).toBe(3)
    expect(controller.snapshot().targets).toEqual(snapshot.targets)
    expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(files)
  })

  it('renders a bounded runtime context from the committed source', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'user', content: 'User prefers concise Chinese replies', importance: 'critical' })
    const context = controller.contextProjection().text
    expect(context).toContain('MNEMON RUNTIME MEMORY SNAPSHOT')
    expect(context).not.toContain('Revision:')
    expect(context).toContain('USER.md (user profile)')
    expect(context).toContain('<runtime-memory-file name="USER.md">\n[importance=critical]\nUser prefers concise Chinese replies\n</runtime-memory-file>')
    expect(context).toContain('MEMORY.md (working reference)')
    expect(context).toContain('<runtime-memory-file name="MEMORY.md">\n(empty)\n</runtime-memory-file>')
    expect(context).not.toContain('MNEMON RUNTIME MEMORY PROTOCOL')
    expect(context).not.toContain('WRITE PROTOCOL')
    expect(context).not.toContain(controller.sourcePath)
  })

  it('projects recorded importance and elapsed creation/update days without rewriting stored content', async () => {
    const now = new Date('2026-09-01T08:00:00.000Z')
    const { controller } = fixture(now)
    await controller.mutate({ action: 'add', target: 'user', content: 'Prefer concise replies.', importance: 'critical' })
    await controller.mutate({ action: 'add', target: 'memory', content: 'Use pnpm.', importance: 'normal' })
    await controller.mutate({ action: 'add', target: 'memory', content: 'Temporary compatibility note.', importance: 'low' })
    now.setTime(Date.parse('2026-09-13T08:00:00.000Z'))
    await controller.mutate({ action: 'replace', target: 'memory', oldText: 'Use pnpm.', content: 'Use pnpm 10.' })
    const stored = controller.snapshot()
    const paths = [controller.sourcePath, controller.userPath, controller.memoryPath]
    const files = paths.map(path => readFileSync(path, 'utf8'))

    now.setTime(Date.parse('2026-09-15T07:59:59.999Z'))
    const beforeDay = controller.contextProjection()
    expect(beforeDay.text).toContain('[importance=critical; created=13d; updated=13d]\nPrefer concise replies.')
    expect(beforeDay.text).toContain('[created=13d; updated=1d]\nUse pnpm 10.')
    expect(beforeDay.text).toContain('[importance=low; created=13d; updated=13d]\nTemporary compatibility note.')
    expect(beforeDay.text).toContain('Entry annotations default to importance=normal and ages=0d')
    expect(beforeDay.text).toContain('For old_text/oldText, use entry content only.')
    expect(beforeDay.text).toContain('Current instructions win.')

    now.setTime(Date.parse('2026-09-15T08:00:00.000Z'))
    const afterDay = controller.contextProjection()
    expect(afterDay.text).toContain('[created=14d; updated=2d]\nUse pnpm 10.')
    expect(afterDay.revision).toBe(beforeDay.revision)
    expect(afterDay.entries).toEqual(stored.entries)
    expect(controller.snapshot().targets).toEqual(stored.targets)
    expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(files)
    expect(beforeDay.text).toContain('created=13d; updated=1d')

    // Matching still uses the content, even when other entries have identical metadata.
    await controller.mutate({ action: 'remove', target: 'memory', oldText: 'Use pnpm 10.' })
    expect(controller.snapshot().entries.map(entry => entry.content)).toEqual(['Prefer concise replies.', 'Temporary compatibility note.'])
  })

  it('projects unknown or future ages safely and honors timestamp offsets', () => {
    const { controller } = fixture()
    const entries = [
      { content: 'Invalid timestamp remains readable.', created_at: 'invalid\n<instruction>', updated_at: '', target: 'user', importance: 'critical' },
      { content: 'Future timestamp remains readable.', created_at: '2026-08-14T08:00:00.000Z', updated_at: '2026-08-13T08:00:00.001Z', target: 'memory', importance: 'normal' },
      { content: 'A line\nwith whitespace.', created_at: '2026-08-12T10:00:00+02:00', updated_at: '2026-08-13T07:00:00Z', target: 'memory', importance: 'low' },
    ]
    writeFileSync(controller.sourcePath, JSON.stringify({ version: 1, entries }))
    const source = readFileSync(controller.sourcePath, 'utf8')
    const projection = controller.contextProjection()
    expect(projection.text).toContain('[importance=critical; created=unknown; updated=unknown]\nInvalid timestamp remains readable.')
    expect(projection.text).toContain('[created=future; updated=future]\nFuture timestamp remains readable.')
    expect(projection.text).toContain('[importance=low; created=1d]\nA line with whitespace.')
    expect(projection.text).not.toMatch(/NaN|Invalid Date|<instruction>/u)
    expect(readFileSync(controller.sourcePath, 'utf8')).toBe(source)
  })

  it('uses one age clock for global USER and branch-filtered workspace MEMORY', async () => {
    const { directory: globalRoot, controller: global } = fixture()
    const { directory: workspaceRoot, controller: workspace } = fixture()
    await global.mutate({ action: 'add', target: 'user', content: 'Global profile.' })
    await workspace.mutate({ action: 'add', target: 'memory', content: 'Visible main fact.', branches: ['main'] })
    await workspace.mutate({ action: 'add', target: 'memory', content: 'Hidden dev fact.', branches: ['dev'] })
    let samples = 0
    const combined = new RuntimeMemoryController(
      { effectiveDataDir: () => workspaceRoot },
      () => new Date(Date.parse('2026-08-14T07:59:59.999Z') + samples++),
      undefined, { effectiveDataDir: () => globalRoot },
    )
    const projection = combined.contextProjection('main')
    expect(projection.text).toContain('<runtime-memory-file name="USER.md">\nGlobal profile.')
    expect(projection.text).toContain('<runtime-memory-file name="MEMORY.md">\nVisible main fact.')
    expect(projection.text).not.toContain('Hidden dev fact.')
    expect(samples).toBe(1)
  })

  it('assembles every prompt from the latest committed USER and MEMORY records', async () => {
    const { controller } = fixture()
    const empty = controller.contextProjection().text
    expect(empty).not.toContain('User prefers compact release notes')

    await controller.mutate({ action: 'add', target: 'user', content: 'User prefers compact release notes', importance: 'critical' })
    await controller.mutate({ action: 'add', target: 'memory', content: 'Release checks run with pnpm verify' })
    const populated = controller.contextProjection().text

    expect(populated).toContain('User prefers compact release notes')
    expect(populated).toContain('Release checks run with pnpm verify')
    expect(readFileSync(controller.userPath, 'utf8')).toBe('User prefers compact release notes\n')
    expect(readFileSync(controller.memoryPath, 'utf8')).toBe('Release checks run with pnpm verify\n')
  })

  it('keeps every changed snapshot complete across add, replace, and remove operations', async () => {
    const { controller } = fixture()
    const revisions = new Set([controller.contextProjection().revision])

    await controller.mutate({ action: 'add', target: 'user', content: 'User prefers compact release notes' })
    await controller.mutate({ action: 'add', target: 'memory', content: 'Release checks run with pnpm verify' })
    const added = controller.contextProjection()
    revisions.add(added.revision)
    expect(added.text).toContain('User prefers compact release notes')
    expect(added.text).toContain('Release checks run with pnpm verify')

    await controller.mutate({ action: 'replace', target: 'memory', oldText: 'pnpm verify', content: 'Release checks run with pnpm run verify' })
    const replaced = controller.contextProjection()
    revisions.add(replaced.revision)
    expect(replaced.text).toContain('User prefers compact release notes')
    expect(replaced.text).toContain('Release checks run with pnpm run verify')
    expect(replaced.text).not.toContain('Release checks run with pnpm verify\n')

    await controller.mutate({ action: 'remove', target: 'user', oldText: 'compact release notes' })
    const removed = controller.contextProjection()
    revisions.add(removed.revision)
    expect(removed.text).not.toContain('User prefers compact release notes')
    expect(removed.text).toContain('Release checks run with pnpm run verify')
    expect(removed.text).toContain('USER.md (user profile)')
    expect(revisions.size).toBe(4)
  })

  it('packs semantic compaction candidates into an exact host-owned byte budget', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'user', content: 'Original verbose preference.' })
    const request = { action: 'add', target: 'user', content: 'Newest preference.' } as const
    const plan = await controller.planMaintenance(request)

    await controller.compactAndMutate(plan.revision, request, [
      { content: 'normal candidate that cannot join the critical one', importance: 'normal' },
      { content: 'critical rule', importance: 'critical' },
      { content: 'low detail', importance: 'low' },
    ], 28)

    expect(controller.snapshot().entries.map(entry => ({ content: entry.content, importance: entry.importance }))).toEqual([
      { content: 'critical rule', importance: 'critical' },
      { content: 'low detail', importance: 'low' },
      { content: 'Newest preference.', importance: 'normal' },
    ])
  })

  it('atomically compacts surviving entries and applies a capacity-blocked exact replacement', async () => {
    const { controller } = fixture()
    const oldContent = 'X'
    const containingEntry = `EGO_LINUX_CHROME ${'a'.repeat(4_984)}`
    const replacement = `new-${'n'.repeat(496)}`
    await controller.mutate({ action: 'add', target: 'memory', content: oldContent })
    await controller.mutate({ action: 'add', target: 'memory', content: containingEntry })
    await controller.mutate({ action: 'add', target: 'memory', content: 'b'.repeat(5_000) })
    const request = { action: 'replace', target: 'memory', oldText: oldContent, content: replacement } as const

    await expect(controller.mutate(request)).rejects.toBeInstanceOf(RuntimeMemoryCapacityError)
    const plan = await controller.planMaintenance(request)
    expect(plan).toMatchObject({
      action: 'replace',
      requiresMaintenance: true,
      pending: { content: replacement },
      excluded: { content: oldContent },
    })
    expect(plan.entries.map(entry => entry.content)).toEqual([containingEntry, 'b'.repeat(5_000)])

    const result = await controller.compactAndMutate(
      plan.revision,
      request,
      [{ content: 'Archived details remain available in project memory.', importance: 'normal' }],
      6_000,
    )
    expect(result).toMatchObject({ replaced: { from: oldContent, to: replacement } })
    expect(controller.snapshot().entries.map(entry => entry.content)).toEqual([
      'Archived details remain available in project memory.',
      replacement,
    ])
    expect(readFileSync(controller.memoryPath, 'utf8')).not.toContain(oldContent)
  })

  it('atomically commits a capacity-blocked add with the reviewed compaction', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-runtime-atomic-lineage-'))
    directories.push(directory)
    const controller = new RuntimeMemoryController(
      { effectiveDataDir: () => directory },
      undefined,
    )
    await controller.mutate({ action: 'add', target: 'memory', content: 'a'.repeat(5_000) })
    await controller.mutate({ action: 'add', target: 'memory', content: 'b'.repeat(5_000) })
    const request = { action: 'add', target: 'memory', content: 'new durable fact '.repeat(30) } as const
    await expect(controller.mutate(request)).rejects.toBeInstanceOf(RuntimeMemoryCapacityError)
    const plan = await controller.planMaintenance(request)
    const result = await controller.compactAndMutate(
      plan.revision,
      request,
      [{ content: 'Archived workspace history.', importance: 'normal' }],
      6_000,
    )

    expect(result).toMatchObject({ added: request.content.trim() })
    expect(controller.snapshot().entries.map(entry => entry.content)).toEqual([
      'Archived workspace history.',
      request.content.trim(),
    ])
  })

  it('moves the entries compaction leaves out to the local archive when asked to (issue 336)', async () => {
    const { directory, controller } = fixture()
    const first = 'Release gates close at 18:00 on release days.'
    const second = 'a'.repeat(5_050)
    const third = 'b'.repeat(5_050)
    for (const content of [first, second, third]) await controller.mutate({ action: 'add', target: 'memory', content, importance: 'normal' })
    await controller.mutate({ action: 'add', target: 'user', content: 'Prefers short answers.' })
    const request = { action: 'add', target: 'memory', content: 'Canary deploys run for one hour before the full rollout, and the release owner approves it.' } as const
    await expect(controller.mutate(request)).rejects.toBeInstanceOf(RuntimeMemoryCapacityError)
    const plan = await controller.planMaintenance(request)

    // Exact entries, as the Host passes them when no Memory Space can take an archive.
    const result = await controller.compactAndMutate(plan.revision, request,
      plan.entries.map(({ content, importance }) => ({ content, importance })), 6_000, { archive: 'local' })

    expect(controller.snapshot().entries.filter(entry => entry.target === 'memory').map(entry => entry.content)).toEqual([first, second, request.content])
    expect(result).toMatchObject({ added: request.content, archived: { entries: 1, path: join(directory, 'runtime', 'archived', 'MEMORY.md') } })
    const archivedLines = readFileSync(join(directory, 'runtime', 'archived', 'memories.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(archivedLines).toEqual([expect.objectContaining({ content: third, target: 'memory', importance: 'normal', fromRevision: plan.revision })])
    const archivedMarkdown = readFileSync(join(directory, 'runtime', 'archived', 'MEMORY.md'), 'utf8')
    expect(archivedMarkdown).toContain('# MEMORY.md archive')
    expect(archivedMarkdown).toContain(third)
    expect(readFileSync(controller.memoryPath, 'utf8')).not.toContain(third)

    // A later archive appends below the first, with one header.
    const next = { action: 'add', target: 'memory', content: 'c'.repeat(4_000) } as const
    const nextPlan = await controller.planMaintenance(next)
    await controller.compactAndMutate(nextPlan.revision, next, nextPlan.entries.map(({ content, importance }) => ({ content, importance })), 1_000, { archive: 'local' })
    const appended = readFileSync(join(directory, 'runtime', 'archived', 'MEMORY.md'), 'utf8')
    expect(appended.match(/# MEMORY\.md archive/g)).toHaveLength(1)
    expect(appended.indexOf(third)).toBeLessThan(appended.lastIndexOf('## '))
    expect(readFileSync(join(directory, 'runtime', 'archived', 'memories.jsonl'), 'utf8').trim().split('\n').length).toBeGreaterThan(1)
  })

  it('keeps an entry in both places, never in neither, when the commit after the local archive fails (issue 336)', async () => {
    const { directory, controller } = fixture()
    for (const content of ['a'.repeat(5_050), 'b'.repeat(5_050)]) await controller.mutate({ action: 'add', target: 'memory', content, importance: 'normal' })
    const request = { action: 'add', target: 'memory', content: 'c'.repeat(4_000) } as const
    const plan = await controller.planMaintenance(request)
    const before = controller.snapshot()
    const persist = vi.spyOn(controller as unknown as { persist(file: unknown): void }, 'persist').mockImplementationOnce(() => { throw new Error('disk full') })
    await expect(controller.compactAndMutate(plan.revision, request, plan.entries.map(({ content, importance }) => ({ content, importance })), 1_000, { archive: 'local' }))
      .rejects.toThrow('disk full')
    persist.mockRestore()
    expect(controller.snapshot().entries).toEqual(before.entries)
    expect(readFileSync(join(directory, 'runtime', 'archived', 'MEMORY.md'), 'utf8')).toContain('b'.repeat(5_050))
  })

  it('never follows a link at the local archive (issue 336)', async () => {
    const { directory, controller } = fixture()
    for (const content of ['a'.repeat(5_050), 'b'.repeat(5_050)]) await controller.mutate({ action: 'add', target: 'memory', content, importance: 'normal' })
    const outside = mkdtempSync(join(tmpdir(), 'dsh-mnemon-outside-'))
    directories.push(outside)
    writeFileSync(join(outside, 'profile'), 'export PATH=/usr/bin\n')
    const archive = join(directory, 'runtime', 'archived')
    mkdirSync(archive, { recursive: true })
    symlinkSync(join(outside, 'profile'), join(archive, 'memories.jsonl'))
    const request = { action: 'add', target: 'memory', content: 'c'.repeat(4_000) } as const
    const plan = await controller.planMaintenance(request)
    const before = controller.snapshot()
    const compact = () => controller.compactAndMutate(plan.revision, request, plan.entries.map(({ content, importance }) => ({ content, importance })), 1_000, { archive: 'local' })
    await expect(compact()).rejects.toThrow()
    expect(readFileSync(join(outside, 'profile'), 'utf8')).toBe('export PATH=/usr/bin\n')
    expect(controller.snapshot().entries).toEqual(before.entries)
    // A linked archive directory is refused the same way.
    rmSync(archive, { recursive: true })
    symlinkSync(outside, archive)
    await expect(compact()).rejects.toThrow('Runtime Memory archive is not a directory')
    expect(readdirSync(outside)).toEqual(['profile'])
    expect(controller.snapshot().entries).toEqual(before.entries)
    // So is a directory at either file, before the other file is written.
    rmSync(archive)
    mkdirSync(join(archive, 'MEMORY.md'), { recursive: true })
    await expect(compact()).rejects.toThrow('Runtime Memory archive file is not a regular file')
    expect(existsSync(join(archive, 'memories.jsonl'))).toBe(false)
    expect(controller.snapshot().entries).toEqual(before.entries)
    expect(plan.localArchive).toBe(true)
  })

  it('archives nothing locally unless asked, and never for USER.md', async () => {
    const { directory, controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: 'a'.repeat(5_000) })
    await controller.mutate({ action: 'add', target: 'memory', content: 'b'.repeat(5_000) })
    const request = { action: 'add', target: 'memory', content: 'new durable fact' } as const
    const plan = await controller.planMaintenance(request)
    const result = await controller.compactAndMutate(plan.revision, request, [{ content: 'Archived workspace history.', importance: 'normal' }], 6_000)
    expect(result).not.toHaveProperty('archived')
    expect(existsSync(join(directory, 'runtime', 'archived'))).toBe(false)
  })

  it('never archives or preserves a removed entry while recovering an already-over-capacity file', async () => {
    const { controller } = fixture()
    const now = '2026-08-13T08:00:00.000Z'
    const removed = `delete-${'x'.repeat(93)}`
    const entries = [removed, 'a'.repeat(5_150), 'b'.repeat(5_150)].map(content => ({
      content,
      created_at: now,
      updated_at: now,
      target: 'memory' as const,
      importance: 'normal' as const,
    }))
    writeFileSync(controller.sourcePath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
    writeFileSync(controller.memoryPath, `${entries.map(entry => entry.content).join(RUNTIME_ENTRY_DELIMITER)}\n`)
    const request = { action: 'remove', target: 'memory', oldText: 'delete-' } as const

    await expect(controller.mutate(request)).rejects.toBeInstanceOf(RuntimeMemoryCapacityError)
    const plan = await controller.planMaintenance(request)
    expect(plan).toMatchObject({ action: 'remove', requiresMaintenance: true, excluded: { content: removed } })
    expect(plan.pending).toBeUndefined()
    expect(plan.entries.map(entry => entry.content)).not.toContain(removed)

    const result = await controller.compactAndMutate(
      plan.revision,
      request,
      [{ content: 'Remaining history is archived.', importance: 'normal' }],
      6_000,
    )
    expect(result).toMatchObject({ removed })
    expect(controller.snapshot().entries.map(entry => entry.content)).toEqual(['Remaining history is archived.'])
  })

  it('leaves every local file unchanged when a compacted mutation conflicts or still exceeds capacity', async () => {
    const { directory, controller } = fixture()
    const oldContent = `old-${'o'.repeat(96)}`
    await controller.mutate({ action: 'add', target: 'memory', content: oldContent })
    await controller.mutate({ action: 'add', target: 'memory', content: 'a'.repeat(5_000) })
    await controller.mutate({ action: 'add', target: 'memory', content: 'b'.repeat(5_000) })
    const request = { action: 'replace', target: 'memory', oldText: 'old-', content: 'n'.repeat(3_000) } as const
    await expect(controller.mutate(request)).rejects.toBeInstanceOf(RuntimeMemoryCapacityError)
    const obsolete = await controller.planMaintenance(request)

    const other = new RuntimeMemoryController({ effectiveDataDir: () => directory })
    await other.mutate({ action: 'replace', target: 'memory', oldText: 'old-', content: 'concurrent replacement' })
    const paths = [controller.sourcePath, controller.memoryPath, controller.userPath]
    const afterConcurrent = paths.map(path => readFileSync(path, 'utf8'))
    await expect(controller.compactAndMutate(
      obsolete.revision,
      request,
      [{ content: 'summary', importance: 'normal' }],
      6_000,
    )).rejects.toThrow('changed while archival')
    expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(afterConcurrent)

    const currentRequest = {
      action: 'replace',
      target: 'memory',
      oldText: 'concurrent replacement',
      content: 'n'.repeat(3_000),
    } as const
    await expect(controller.mutate(currentRequest)).rejects.toBeInstanceOf(RuntimeMemoryCapacityError)
    const current = await controller.planMaintenance(currentRequest)
    const beforeOverflow = paths.map(path => readFileSync(path, 'utf8'))
    await expect(controller.compactAndMutate(
      current.revision,
      currentRequest,
      [{ content: 'c'.repeat(8_000), importance: 'normal' }],
      10_240,
    )).rejects.toBeInstanceOf(RuntimeMemoryCapacityError)
    expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(beforeOverflow)
  })

  it('rejects compaction output that duplicates the pending mutation or reintroduces its excluded entry', async () => {
    const { controller } = fixture()
    const oldContent = `obsolete-${'o'.repeat(91)}`
    const replacement = `corrected-${'n'.repeat(490)}`
    await controller.mutate({ action: 'add', target: 'memory', content: oldContent })
    await controller.mutate({ action: 'add', target: 'memory', content: 'a'.repeat(5_000) })
    await controller.mutate({ action: 'add', target: 'memory', content: 'b'.repeat(5_000) })
    const request = { action: 'replace', target: 'memory', oldText: 'obsolete-', content: replacement } as const
    await expect(controller.mutate(request)).rejects.toBeInstanceOf(RuntimeMemoryCapacityError)
    const plan = await controller.planMaintenance(request)
    const paths = [controller.sourcePath, controller.memoryPath, controller.userPath]
    const before = paths.map(path => readFileSync(path, 'utf8'))

    await expect(controller.compactAndMutate(
      plan.revision,
      request,
      [{ content: replacement, importance: 'normal' }],
      6_000,
    )).rejects.toThrow('duplicates the pending mutation')
    expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(before)

    await expect(controller.compactAndMutate(
      plan.revision,
      request,
      [{ content: oldContent, importance: 'normal' }],
      6_000,
    )).rejects.toThrow('reintroduces the replaced or removed entry')
    expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(before)
  })
})

describe('RuntimeMemoryController branch scoping', () => {
  it('projects branch-scoped memory entries only when the current branch matches', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: 'Shared cross-branch fact' })
    await controller.mutate({ action: 'add', target: 'memory', content: 'Main-branch architecture decision', branches: ['main'] })

    const onMain = controller.contextProjection('main')
    expect(onMain.text).toContain('Shared cross-branch fact')
    expect(onMain.text).toContain('Main-branch architecture decision')
    expect(onMain.text).toContain('Git branch: main')

    const onDev = controller.contextProjection('dev')
    expect(onDev.text).toContain('Shared cross-branch fact')
    expect(onDev.text).not.toContain('Main-branch architecture decision')
    expect(onDev.text).toContain('Git branch: dev')
    expect(onDev.text).toContain('1 branch-scoped entry hidden')

    const unscoped = controller.contextProjection()
    expect(unscoped.text).toContain('Main-branch architecture decision')
    expect(unscoped.text).toContain('Shared cross-branch fact')
    expect(unscoped.text).not.toContain('Git branch:')
  })

  it('never filters the user profile and keeps disk projections complete', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'user', content: 'User prefers concise answers' })
    await controller.mutate({ action: 'add', target: 'memory', content: 'Feature-flag decision for release branch', branches: ['release'] })

    const onMain = controller.contextProjection('main')
    expect(onMain.text).toContain('User prefers concise answers')
    expect(onMain.text).not.toContain('Feature-flag decision for release branch')
    expect(readFileSync(controller.memoryPath, 'utf8')).toBe('Feature-flag decision for release branch\n')
  })

  it('validates and stores branch tags on add', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: 'Multi-branch fact', branches: ['main', 'feature/deep'] })
    expect(controller.snapshot().entries[0]).toMatchObject({ branches: ['main', 'feature/deep'] })
  })

  it('rejects invalid branch names without changing the store', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: 'baseline' })
    const before = readFileSync(controller.sourcePath, 'utf8')
    const invalid = ['has space', 'dot..dot', '/leading-slash', 'trailing/', 'trailing.', 'x'.repeat(129), 'bad*name', 'a@{b', 'a^b', 'a:b', 'a~b']
    for (const name of invalid) {
      await expect(controller.mutate({ action: 'add', target: 'memory', content: `t-${encodeURIComponent(name)}`, branches: [name] })).rejects.toThrow(/branch name/)
    }
    await expect(controller.mutate({ action: 'add', target: 'memory', content: 'too many', branches: ['a', 'b', 'a'] })).rejects.toThrow(/repeat/)
    await expect(controller.mutate({
      action: 'add',
      target: 'memory',
      content: 'too many branches',
      branches: Array.from({ length: 17 }, (_, index) => `b${index}`),
    })).rejects.toThrow(/at most/)
    expect(readFileSync(controller.sourcePath, 'utf8')).toBe(before)
  })

  it('rejects branch scoping for the user target', async () => {
    const { controller } = fixture()
    await expect(controller.mutate({ action: 'add', target: 'user', content: 'scoped user fact', branches: ['main'] }))
      .rejects.toThrow('branches applies to target=memory only')
  })

  it('replace inherits, updates, and clears branch scope', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: 'v1 decision', branches: ['main'] })
    await controller.mutate({ action: 'replace', target: 'memory', oldText: 'v1 decision', content: 'v2 decision' })
    expect(controller.snapshot().entries[0]).toMatchObject({ branches: ['main'] })

    await controller.mutate({ action: 'replace', target: 'memory', oldText: 'v2 decision', content: 'v3 decision', branches: ['dev'] })
    expect(controller.snapshot().entries[0]).toMatchObject({ branches: ['dev'] })

    await controller.mutate({ action: 'replace', target: 'memory', oldText: 'v3 decision', content: 'v4 global', branches: [] })
    const cleared = controller.snapshot().entries[0]!
    expect(cleared).toMatchObject({ content: 'v4 global' })
    expect('branches' in cleared).toBe(false)
    expect(controller.contextProjection('nowhere').text).toContain('v4 global')
  })

  it('keeps legacy memories.json files (without branches) loadable and fully visible', async () => {
    const { directory, controller } = fixture()
    writeFileSync(controller.sourcePath, JSON.stringify({
      version: 1,
      entries: [{
        content: 'Legacy unscoped fact',
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z',
        target: 'memory',
        importance: 'normal',
      }],
    }, null, 2), 'utf8')
    const reloaded = new RuntimeMemoryController({ effectiveDataDir: () => directory })
    expect(reloaded.snapshot().entries).toEqual([
      { content: 'Legacy unscoped fact', created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z', target: 'memory', importance: 'normal' },
    ])
    expect(reloaded.contextProjection('any-branch').text).toContain('Legacy unscoped fact')
  })

  it('carries branch scope through semantic compaction', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: 'v1 branch-scoped', branches: ['main', 'dev'] })
    await controller.mutate({ action: 'add', target: 'memory', content: 'unscoped' })
    const request = { action: 'add', target: 'memory', content: 'new unscoped fact' } as const
    const plan = await controller.planMaintenance(request)

    await controller.compactAndMutate(plan.revision, request, [
      { content: 'branch-scoped merged', importance: 'normal', branches: ['main', 'dev'] },
      { content: 'unscoped merged', importance: 'normal' },
    ])
    expect(controller.snapshot().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'branch-scoped merged', branches: ['main', 'dev'] }),
      expect.objectContaining({ content: 'unscoped merged' }),
    ]))
    const projection = controller.contextProjection('dev')
    expect(projection.text).toContain('branch-scoped merged')
  })
})

describe('explicit Runtime pins', () => {
  it('retains low-importance pins through repeated local capacity archives and keeps branch filtering', async () => {
    const { directory } = fixture()
    const controller = new RuntimeMemoryController({ effectiveDataDir: () => directory }, () => new Date('2026-08-13'), { memory: 130, user: 512 })
    await controller.mutate({ action: 'add', target: 'memory', content: 'Ask before deleting data.', importance: 'low', branches: ['main'] })
    await controller.setPinned('memory', 'Ask before deleting data.', true)
    for (let index = 0; index < 4; index++) {
      const request = { action: 'add' as const, target: 'memory' as const, content: `Iteration ${index}: ` + 'ordinary '.repeat(6).trim(), importance: 'critical' as const }
      const plan = await controller.planMaintenance(request)
      await controller.compactAndMutate(plan.revision, request, plan.entries, 40, { archive: 'local' })
      expect(controller.snapshot().entries.find(entry => entry.pinned)).toMatchObject({ content: 'Ask before deleting data.', importance: 'low', branches: ['main'] })
      const projection = controller.contextProjection('main')
      expect(projection.text.indexOf('Ask before deleting data.')).toBeLessThan(projection.text.indexOf(`Iteration ${index}`))
      expect(controller.contextProjection('other').text).not.toContain('Ask before deleting data.')
    }
    const archive = readFileSync(join(directory, 'runtime', 'archived', 'memories.jsonl'), 'utf8')
    expect(archive).not.toContain('Ask before deleting data.')
    await controller.setPinned('memory', 'Ask before deleting data.', false)
    expect(controller.snapshot().entries.find(entry => entry.content === 'Ask before deleting data.')?.pinned).toBe(false)
  })

  it('rejects omission, rewriting and pin-state injection during compaction without a partial commit', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'user', content: 'Preserve this exact profile rule.', importance: 'critical' })
    await controller.setPinned('user', 'Preserve this exact profile rule.', true)
    const request = { action: 'add' as const, target: 'user' as const, content: 'New preference.' }
    const plan = await controller.planMaintenance(request)
    const before = controller.snapshot().entries
    for (const candidates of [[], [{ content: 'Rewritten profile rule.', importance: 'critical' as const }], [{ ...plan.entries[0]!, pinned: false }], [{ ...plan.entries[0]!, importance: 'low' as const }]]) {
      await expect(controller.compactAndMutate(plan.revision, request, candidates)).rejects.toThrow(/pinned|pin state/iu)
      expect(controller.snapshot().entries).toEqual(before)
    }
    await controller.compactAndMutate(plan.revision, request, plan.entries)
    expect(controller.snapshot().entries[0]).toEqual(before[0])
  })

  it('makes pin budget visible, rejects over-budget pins and preserves pins on manual replacement', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: 'Short rule' })
    await controller.setPinned('memory', 'Short rule', true)
    await controller.mutate({ action: 'replace', target: 'memory', oldText: 'Short rule', content: 'Updated rule' })
    expect(controller.snapshot().entries[0]?.pinned).toBe(true)
    expect(controller.snapshot().targets.memory.pinned).toMatchObject({ count: 1, limit: 1536, characters: expect.any(Number) })
    await controller.mutate({ action: 'add', target: 'memory', content: 'x'.repeat(1536) })
    const before = controller.snapshot().entries
    await expect(controller.setPinned('memory', 'x'.repeat(1536), true)).rejects.toThrow('projection requires')
    expect(controller.snapshot().entries).toEqual(before)
  })

  it('refuses capacity packing below the pinned set even when all pins are low importance', async () => {
    const { controller } = fixture()
    await controller.mutate({ action: 'add', target: 'memory', content: 'Never silently drop me.', importance: 'low' })
    await controller.setPinned('memory', 'Never silently drop me.', true)
    const request = { action: 'add' as const, target: 'memory' as const, content: 'Pending' }
    const plan = await controller.planMaintenance(request)
    await expect(controller.compactAndMutate(plan.revision, request, plan.entries, 5, { archive: 'local' })).rejects.toThrow('Pinned runtime entries')
    expect(controller.snapshot().entries.map(entry => entry.content)).toEqual(['Never silently drop me.'])
  })
})
