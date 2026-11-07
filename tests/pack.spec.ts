import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { resolveConfig } from "../src/host/config.ts"
import { MnemonPackManager, MNEMON_PACK_FORMAT, MNEMON_PACK_MIME, documentVersion } from "../src/host/pack.ts"
import { createStorageRoot } from '../src/host/storage-root.ts'
import { sourceFixture } from './fixtures/sources.ts'
import { withMemoryStorageLock } from 'dsh-mnemon/extension-sdk'
import { DOCUMENTS_DIRECTORY, DOCUMENTS_LOCK_FILE, DOCUMENTS_LOCK_STALE_MS } from 'dsh-mnemon-source-documents/contracts'
import { RUNTIME_DIRECTORY, RUNTIME_ENTRY_DELIMITER, RUNTIME_LOCK_FILE, RUNTIME_LOCK_STALE_MS, RUNTIME_PROJECTION_FILES, runtimeProjection } from 'dsh-mnemon-source-runtime/contracts'
import { sqlite as nodeSqlite, writeSpace, type SpaceInsight } from '../plugins/dsh-mnemon-source-memory-spaces/tests/memory-space-db.ts'

const directories: string[] = []
const releases: Array<() => Promise<void>> = []
const now = () => new Date('2026-08-14T12:00:00.000Z')

function temporary(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `dsh-mnemon-${label}-`))
  directories.push(directory)
  return directory
}

function sqlite(seed: number): Buffer {
  const bytes = Buffer.alloc(4096)
  bytes.write('SQLite format 3\0', 0, 'binary')
  bytes[4095] = seed
  return bytes
}

function runner(root: string) {
  const config = resolveConfig({ storageScope: 'custom', dataDir: root, cliPath: '/fake/mnemon' })
  return { config, runner: createStorageRoot(config) }
}

async function fixture(label: string, seed: number, bodyId = 'project') {
  const root = temporary(label)
  const workspace = temporary(`${label}-workspace`)
  const created = runner(root)
  const sources = await sourceFixture({ dataDir: root, workspace })
  releases.push(sources.dispose)
  await sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Prefer concise answers', importance: 'normal' }, { confirmed: true })
  await sources.documents.mutate('mutate', { action: 'create', title: `Design ${seed}`, content: `# Design\n\nSeed ${seed}` }, { confirmed: true })
  const data = join(root, 'data')
  mkdirSync(join(data, bodyId), { recursive: true })
  writeFileSync(join(data, bodyId, 'mnemon.db'), sqlite(seed))
  writeFileSync(join(data, '.dsh-memory-bodies.json'), `${JSON.stringify({
    version: 1,
    bodies: [{ id: bodyId, name: `Space ${seed}`, description: `Seed ${seed}`, active: true, createdAt: now().toISOString(), updatedAt: now().toISOString() }],
  }, null, 2)}\n`)
  writeFileSync(join(root, 'active'), `${bodyId}\n`)
  return { root, workspace, ...created, manager: new MnemonPackManager(created.runner, created.config, undefined, now) }
}

/** Replace a fixture's Memory Spaces with real databases, as Mnemon writes them. */
function spaces(root: string, bodies: Array<{ id: string; name: string; insights: SpaceInsight[]; reads?: number; edges?: Parameters<typeof writeSpace>[1]['edges'] }>): void {
  const data = join(root, 'data')
  rmSync(data, { recursive: true, force: true })
  mkdirSync(data, { recursive: true })
  for (const body of bodies) {
    mkdirSync(join(data, body.id), { recursive: true })
    writeSpace(join(data, body.id, 'mnemon.db'), { insights: body.insights, ...(body.reads === undefined ? {} : { reads: body.reads }), ...(body.edges === undefined ? {} : { edges: body.edges }) })
  }
  const at = '2026-10-05T08:37:12.218Z'
  writeFileSync(join(data, '.dsh-memory-bodies.json'), `${JSON.stringify({
    version: 1, bodies: bodies.map(body => ({ id: body.id, name: body.name, description: '', active: true, createdAt: at, updatedAt: at })),
  }, null, 2)}\n`)
}

function registryOf(root: string): Array<{ id: string; name: string; active: boolean }> {
  return (JSON.parse(readFileSync(join(root, 'data', '.dsh-memory-bodies.json'), 'utf8')) as { bodies: Array<{ id: string; name: string; active: boolean }> }).bodies
}

/** Two memories as both machines first held them; `reads` bumps the counters a recall writes. */
function memories(reads = 0, extra: SpaceInsight[] = []): SpaceInsight[] {
  return [
    { id: 'i-1', content: 'The gateway routes by model family', accessCount: reads * 3, accessedAt: reads === 0 ? null : '2026-10-1' + String(reads % 10) + 'T04:11:13Z' },
    { id: 'i-2', content: 'Accounts warm up for a week before routing', accessCount: reads, accessedAt: reads === 0 ? null : '2026-10-1' + String(reads % 10) + 'T04:11:41Z' },
    ...extra,
  ]
}

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const release of releases.splice(0)) await release()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Mnemon Pack', () => {
  it('waits for independently loaded storage work before collecting a snapshot', async () => {
    const source = await fixture('pack-concurrency', 20)
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const write = withMemoryStorageLock(source.root, async () => {
      started.resolve()
      await finish.promise
      writeFileSync(join(source.root, 'data', 'project', 'mnemon.db'), sqlite(21))
    })
    await started.promise
    let settled = false
    const exportPromise = source.manager.exportPack('memory-spaces').then(value => { settled = true; return value })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    finish.resolve()
    await write
    const exported = await exportPromise
    const files = unzipSync(Buffer.from(exported.base64, 'base64'))
    expect(Buffer.from(files['payload/data/project/mnemon.db']!)).toEqual(sqlite(21))
  })

  it.each([false, true])('archives MEMORY merge overflow transactionally, blocked archive=%s (#468)', async blocked => {
    const source = await fixture('overflow-source', 91)
    const target = await fixture('overflow-target', 92)
    const entry = (content: string, importance: string) => ({ target: 'memory', content, importance, created_at: now().toISOString(), updated_at: now().toISOString() })
    const shared = entry('shared-' + 's'.repeat(3993), 'normal')
    const older = { ...entry('local-' + 'l'.repeat(3994), 'low'), branches: ['main'], origin: { machine: 'left', label: 'Desk', at: now().toISOString() } }
    const incoming = entry('remote-' + 'r'.repeat(3993), 'critical')
    const write = (root: string, entries: unknown[]) => writeFileSync(join(root, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries }))
    write(source.root, [shared, incoming]); write(target.root, [shared, older])
    const before = readFileSync(join(target.root, 'runtime', 'memories.json'))
    const archive = join(target.root, 'runtime', 'archived')
    if (blocked) writeFileSync(archive, 'keep this existing file')
    const pack = (await source.manager.exportPack('runtime')).base64
    if (blocked) {
      await expect(target.manager.importPack(pack, { mode: 'merge' })).rejects.toThrow()
      expect(readFileSync(join(target.root, 'runtime', 'memories.json'))).toEqual(before)
      expect(readFileSync(archive, 'utf8')).toBe('keep this existing file')
      return
    }
    const result = await target.manager.importPack(pack, { mode: 'merge' })
    expect(result.runtime).toEqual({ added: 1, held: 0, archived: 1 })
    const held = JSON.parse(readFileSync(join(target.root, 'runtime', 'memories.json'), 'utf8')).entries
    expect(held).toEqual([shared, incoming])
    expect(Buffer.byteLength(readFileSync(join(target.root, 'runtime', 'MEMORY.md')))).toBeLessThanOrEqual(10240)
    const overflow = join(archive, 'import-overflow')
    const files = readdirSync(overflow)
    expect(files).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(overflow, files[0]!), 'utf8')).entries).toEqual([older])
    await target.manager.importPack(pack, { mode: 'merge' })
    expect(readdirSync(overflow)).toEqual(files)
    expect(Object.keys(unzipSync(Buffer.from((await target.manager.exportPack('runtime')).base64, 'base64'))).some(name => name.includes('archived'))).toBe(false)
  })

  it('exports one native, checksummed Pack without leaking the host root', async () => {
    const source = await fixture('pack-export', 1)
    const exported = await source.manager.exportPack('full')
    const archive = Buffer.from(exported.base64, 'base64')
    const files = unzipSync(archive)
    const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString('utf8'))

    expect(exported).toMatchObject({ mimeType: MNEMON_PACK_MIME, targetRoot: source.root })
    expect(exported.fileName).toMatch(/^mnemon-backup-.*\.zip$/u)
    expect(manifest).toMatchObject({ format: MNEMON_PACK_FORMAT, version: 1, scope: 'full', components: ['runtime', 'documents', 'memory-spaces'] })
    expect(Object.keys(files)).toEqual(expect.arrayContaining([
      'payload/runtime/memories.json',
      'payload/documents/index.json',
      'payload/data/.dsh-memory-bodies.json',
      'payload/data/project/mnemon.db',
    ]))
    expect(archive.includes(Buffer.from(source.root))).toBe(false)
    expect(source.manager.inspectPack(exported.base64, '../unsafe name.mnemonpack')).toMatchObject({
      fileName: 'unsafe-name.mnemonpack', targetRoot: source.root, archiveBytes: archive.length,
      occupied: { runtime: true, documents: true, 'memory-spaces': true },
    })
  })

  it('names the root it reads and writes, and the default one the global scope would use', () => {
    const root = temporary('pack-target')
    const defaults = temporary('pack-default')
    vi.stubEnv('MNEMON_DATA_DIR', defaults)
    const created = runner(root)
    expect(new MnemonPackManager(created.runner, created.config).target()).toEqual({ root, scope: 'custom', defaultRoot: defaults })
  })

  it('exports each component independently with the same Pack envelope', async () => {
    const source = await fixture('pack-parts', 2)
    for (const scope of ['runtime', 'documents', 'memory-spaces'] as const) {
      const exported = await source.manager.exportPack(scope)
      const files = unzipSync(Buffer.from(exported.base64, 'base64'))
      expect(exported.manifest).toMatchObject({ scope, components: [scope] })
      expect(Object.keys(files).filter(path => path.startsWith('payload/')).every(path => path.startsWith(`payload/${scope === 'memory-spaces' ? 'data' : scope}/`))).toBe(true)
    }
  })

  it.each(['full', 'runtime', 'documents', 'memory-spaces'] as const)('exports byte-identical %s Packs across timezones', async (scope) => {
    const source = await fixture('pack-timezones', 23)
    vi.stubEnv('TZ', 'UTC')
    const reference = await source.manager.exportPack(scope)

    for (const [timeZone, offset] of [
      ['UTC', 0],
      ['America/Los_Angeles', 480],
      ['Etc/GMT+12', 720],
      ['Etc/GMT-14', -840],
      ['Asia/Kolkata', -330],
    ] as const) {
      vi.stubEnv('TZ', timeZone)
      expect(new Date('1980-01-01T00:00:00.000Z').getTimezoneOffset(), timeZone).toBe(offset)
      const exported = await source.manager.exportPack(scope)
      expect(exported.base64, timeZone).toBe(reference.base64)
    }
  })

  it('validates Runtime Pack capacity against the configured target limits', async () => {
    const sourceRoot = temporary('pack-configured-runtime-source')
    const sourceConfig = resolveConfig({
      storageScope: 'custom',
      dataDir: sourceRoot,
      cliPath: '/fake/mnemon',
      runtimeMemory: { memoryLimitBytes: 20_480 },
    })
    const sourceRunner = createStorageRoot(sourceConfig)
    const sources = await sourceFixture({ dataDir: sourceRoot, workspace: sourceRoot, memoryLimitBytes: 20_480 })
    releases.push(sources.dispose)
    await sources.runtime.mutate('mutate', { action: 'add', target: 'memory', content: 'a'.repeat(8_000) }, { confirmed: true })
    await sources.runtime.mutate('mutate', { action: 'add', target: 'memory', content: 'b'.repeat(8_000) }, { confirmed: true })
    const exported = await new MnemonPackManager(sourceRunner, sourceConfig, undefined, now).exportPack('runtime')

    const defaultTarget = runner(temporary('pack-default-runtime-target'))
    expect(() => new MnemonPackManager(defaultTarget.runner, defaultTarget.config).inspectPack(exported.base64))
      .toThrow('10240 byte limit')

    const configuredRoot = temporary('pack-configured-runtime-target')
    const configuredTarget = resolveConfig({
      storageScope: 'custom',
      dataDir: configuredRoot,
      cliPath: '/fake/mnemon',
      runtimeMemory: { memoryLimitBytes: 20_480 },
    })
    const configuredRunner = createStorageRoot(configuredTarget)
    expect(new MnemonPackManager(configuredRunner, configuredTarget).inspectPack(exported.base64).manifest.scope).toBe('runtime')
  })

  it('keeps an overlaid global USER.md outside a workspace Runtime Pack', async () => {
    const globalRoot = temporary('pack-global-user')
    const workspaceRoot = temporary('pack-workspace-runtime')
    const workspace = runner(workspaceRoot)
    const sources = await sourceFixture({ dataDir: workspaceRoot, workspace: workspaceRoot, userDataDir: globalRoot })
    releases.push(sources.dispose)
    await sources.runtime.mutate('mutate', { action: 'add', target: 'user', content: 'Private global profile fixture.' }, { confirmed: true })
    await sources.runtime.mutate('mutate', { action: 'add', target: 'memory', content: 'Workspace project fixture.' }, { confirmed: true })

    const exported = await new MnemonPackManager(workspace.runner, workspace.config, undefined, now).exportPack('runtime')
    const files = unzipSync(Buffer.from(exported.base64, 'base64'))
    const source = JSON.parse(Buffer.from(files['payload/runtime/memories.json']!).toString('utf8')) as { entries: Array<{ content: string }> }

    expect(source.entries.map(entry => entry.content)).toEqual(['Workspace project fixture.'])
    expect(Buffer.from(exported.base64, 'base64').includes(Buffer.from('Private global profile fixture.'))).toBe(false)
  })

  it('keeps remote provider connections and credentials outside Mnemon Packs', async () => {
    const source = await fixture('pack-provider-boundary', 22)
    const registryPath = join(source.root, 'data', '.dsh-memory-providers.json')
    writeFileSync(registryPath, JSON.stringify({
      version: 1, services: [{ providerId: 'openviking', enabled: true, settings: {
        endpoint: 'https://memory.example.com', targetUri: 'viking://user/team/memories', apiKey: 'must-not-enter-pack',
      } }],
    }))

    const exported = await source.manager.exportPack('memory-spaces')
    const archive = Buffer.from(exported.base64, 'base64')
    const files = unzipSync(archive)

    expect(archive.includes(Buffer.from('must-not-enter-pack'))).toBe(false)
    expect(Object.keys(files).some(path => path.includes('memory-providers'))).toBe(false)
    expect(existsSync(registryPath)).toBe(true)
  })

  it('reads and imports a payload of several megabytes without overflowing the stack (#368)', async () => {
    const source = await fixture('pack-large-source', 42)
    // An incompressible Memory Space, so the archive's base64 is well past the 4.5 MB the old check failed at.
    writeFileSync(join(source.root, 'data', 'project', 'mnemon.db'), Buffer.concat([sqlite(42), randomBytes(5 * 1024 * 1024)]))
    const exported = await source.manager.exportPack('memory-spaces')
    expect(exported.base64.length).toBeGreaterThan(6 * 1024 * 1024)
    expect(() => source.manager.inspectPack(exported.base64)).not.toThrow()

    const target = await fixture('pack-large-target', 43, 'other')
    await target.manager.importPack(exported.base64, { mode: 'merge' })
    expect(readFileSync(join(target.root, 'data', 'project', 'mnemon.db')).length).toBe(4096 + 5 * 1024 * 1024)

    // Still strict: padding in the middle or a length that is not a whole group is refused.
    expect(() => source.manager.inspectPack(exported.base64.slice(0, 100) + '=' + exported.base64.slice(101))).toThrow('base64')
    expect(() => source.manager.inspectPack(exported.base64.slice(0, -1))).toThrow('base64')
    // The largest payload the transport allows passes the check and fails only as a ZIP, and a
    // string holding a character above U+00FF is refused as base64 rather than by the stack.
    expect(() => source.manager.inspectPack('A'.repeat(64 * 1024 * 1024))).toThrow('invalid zip data')
    expect(() => source.manager.inspectPack('A'.repeat(9 * 1024 * 1024 - 1) + '中')).toThrow('base64')
  })

  it('rejects checksum tampering, unsafe paths, and malformed transport data', async () => {
    const source = await fixture('pack-tamper', 3)
    const exported = await source.manager.exportPack('runtime')
    const files = unzipSync(Buffer.from(exported.base64, 'base64'))
    const runtimeSource = files['payload/runtime/memories.json']!
    runtimeSource[0] = runtimeSource[0]! ^ 1
    const tampered = Buffer.from(zipSync(files)).toString('base64')
    expect(() => source.manager.inspectPack(tampered)).toThrow('checksum mismatch')

    const unsafe = Buffer.from(zipSync({ '../escape': strToU8('x') })).toString('base64')
    expect(() => source.manager.inspectPack(unsafe)).toThrow('unsafe Pack entry path')
    expect(() => source.manager.inspectPack('not-base64')).toThrow('base64')
  })

  describe.skipIf(nodeSqlite === undefined)('Memory Spaces synced between two machines (#370)', () => {
    /** The memories a space's database holds, by id. */
    const held = (root: string, id: string): string[] => {
      const database = new nodeSqlite!.DatabaseSync(join(root, 'data', id, 'mnemon.db'))
      try {
        return (database.prepare('SELECT id FROM insights ORDER BY id').all() as Array<{ id: string }>).map(row => row.id)
      } finally {
        database.close()
      }
    }

    it('keeps one space however many syncs bring back a space the other machine only read', async () => {
      const source = await fixture('pack-reads-source', 60)
      const target = await fixture('pack-reads-target', 61)
      spaces(source.root, [{ id: 'gateway', name: 'AI Gateway routing', insights: memories() }])
      spaces(target.root, [{ id: 'gateway', name: 'AI Gateway routing', insights: memories(2), reads: 2 }])
      const local = readFileSync(join(target.root, 'data', 'gateway', 'mnemon.db'))
      for (let round = 1; round <= 3; round += 1) {
        // The source recalls between syncs, as the reporter's machines did: 2, then 4, then 8 spaces before.
        spaces(source.root, [{ id: 'gateway', name: 'AI Gateway routing', insights: memories(round * 5), reads: round }])
        await target.manager.importPack((await source.manager.exportPack('memory-spaces')).base64, { mode: 'merge' })
        expect(registryOf(target.root).map(body => body.id)).toEqual(['gateway'])
      }
      // This machine's own copy stays, read counts included.
      expect(readFileSync(join(target.root, 'data', 'gateway', 'mnemon.db')).equals(local)).toBe(true)
    })

    it('takes in what the other machine only added, and keeps its own version when that is the newer one', async () => {
      const writer = await fixture('pack-writer', 66)
      const reader = await fixture('pack-reader', 67)
      spaces(writer.root, [{ id: 'gateway', name: 'AI Gateway routing', insights: memories() }])
      spaces(reader.root, [{ id: 'gateway', name: 'AI Gateway routing', insights: memories() }])
      const learned: SpaceInsight[] = []
      for (let round = 1; round <= 3; round += 1) {
        // One machine remembers something each round, the other only recalls: before, both gained a space a round.
        learned.push({ id: 'i-' + String(round + 2), content: 'Learned in round ' + String(round) })
        spaces(writer.root, [{ id: 'gateway', name: 'AI Gateway routing', insights: memories(round, learned), reads: round }])
        const written = readFileSync(join(writer.root, 'data', 'gateway', 'mnemon.db'))
        await reader.manager.importPack((await writer.manager.exportPack('memory-spaces')).base64, { mode: 'merge' })
        expect(registryOf(reader.root).map(body => body.id)).toEqual(['gateway'])
        expect(held(reader.root, 'gateway')).toEqual(['i-1', 'i-2', ...learned.map(insight => insight.id)].sort())
        spaces(reader.root, [{ id: 'gateway', name: 'AI Gateway routing', insights: memories(round + 4, learned), reads: 1 }])
        await writer.manager.importPack((await reader.manager.exportPack('memory-spaces')).base64, { mode: 'merge' })
        expect(registryOf(writer.root).map(body => body.id)).toEqual(['gateway'])
        expect(readFileSync(join(writer.root, 'data', 'gateway', 'mnemon.db')).equals(written)).toBe(true)
      }
      // An older version that comes back adds nothing either.
      spaces(reader.root, [{ id: 'gateway', name: 'AI Gateway routing', insights: memories(9), reads: 2 }])
      await writer.manager.importPack((await reader.manager.exportPack('memory-spaces')).base64, { mode: 'merge' })
      expect(registryOf(writer.root).map(body => body.id)).toEqual(['gateway'])
      expect(held(writer.root, 'gateway')).toHaveLength(5)
    })

    it('merges a space both machines added to into one, round after round', async () => {
      const left = await fixture('pack-both-left', 62)
      const right = await fixture('pack-both-right', 63)
      // What each machine holds, by id: both start from the same two memories and learn one each round.
      const contents = new Map(memories().map(insight => [insight.id, insight.content]))
      const write = (root: string, ids: string[], reads: number) => {
        spaces(root, [{ id: 'gateway', name: 'AI Gateway routing', reads, insights: ids.map(id => ({ id, content: contents.get(id)!, accessCount: reads })) }])
      }
      let leftIds = ['i-1', 'i-2']
      let rightIds = ['i-1', 'i-2']
      for (let round = 1; round <= 3; round += 1) {
        for (const [side, ids] of [['left', leftIds], ['right', rightIds]] as const) {
          const id = side + '-' + String(round)
          contents.set(id, 'Learned on the ' + side + ' machine in round ' + String(round))
          ids.push(id)
        }
        write(left.root, leftIds, round)
        write(right.root, rightIds, round + 3)
        await right.manager.importPack((await left.manager.exportPack('memory-spaces')).base64, { mode: 'merge' })
        await left.manager.importPack((await right.manager.exportPack('memory-spaces')).base64, { mode: 'merge' })
        for (const machine of [left, right]) expect(registryOf(machine.root).map(body => body.id)).toEqual(['gateway'])
        leftIds = held(left.root, 'gateway')
        rightIds = held(right.root, 'gateway')
        expect(leftIds).toEqual([...contents.keys()].sort())
        expect(rightIds).toEqual(leftIds)
      }
    })

    it('keeps one space when a merge here rewrote the edges the branch still holds as published (#391)', async () => {
      const source = await fixture('pack-edges-source', 70)
      const target = await fixture('pack-edges-target', 71)
      const published = { weight: 0.86, metadata: '{"sub_type":"similar_topic"}' }
      // Merging a copy back into this machine's space wrote every edge again: weight 0.5, the
      // reason as the only note, and the time of the merge.
      const rewritten = { weight: 0.5, metadata: '{"reason":"semantic"}', createdAt: '2026-10-16T10:35:00Z' }
      spaces(target.root, [{ id: 'gateway', name: 'AI Gateway routing', insights: memories(2), reads: 2, edges: [['i-1', 'i-2', rewritten]] }])
      const learned: SpaceInsight[] = []
      for (let round = 1; round <= 3; round += 1) {
        // The other machine still holds the edge as it was published, and keeps learning.
        learned.push({ id: 'i-' + String(round + 2), content: 'Learned in round ' + String(round) })
        spaces(source.root, [{ id: 'gateway', name: 'AI Gateway routing', insights: memories(round, learned), reads: round,
          edges: [['i-1', 'i-2', published], ['i-2', 'i-' + String(round + 2), published]] }])
        await target.manager.importPack((await source.manager.exportPack('memory-spaces')).base64, { mode: 'merge' })
        expect(registryOf(target.root).map(body => body.id)).toEqual(['gateway'])
        expect(held(target.root, 'gateway')).toEqual(['i-1', 'i-2', ...learned.map(insight => insight.id)])
      }
      const database = new nodeSqlite!.DatabaseSync(join(target.root, 'data', 'gateway', 'mnemon.db'))
      try {
        // This machine's values stay on the edge both hold; the edges only the other machine made arrive.
        expect(database.prepare("SELECT weight, metadata FROM edges WHERE source_id = 'i-1' AND target_id = 'i-2'").get()).toEqual({ weight: 0.5, metadata: '{"reason":"semantic"}' })
        expect(database.prepare('SELECT count(*) AS n FROM edges').get()).toEqual({ n: 4 })
      } finally {
        database.close()
      }
    })

    it.each([false, true])('keeps one inactive conflict copy and respects manual activation=%s as the remote grows (#449)', async activateCopy => {
      const source = await fixture('pack-forgotten-source', 68)
      const target = await fixture('pack-forgotten-target', 69)
      // This machine forgot i-2, as Mnemon's forget does; the other machine still holds it and keeps learning.
      spaces(target.root, [{ id: 'gateway', name: 'AI Gateway routing', insights: [memories()[0]!, { ...memories()[1]!, deletedAt: '2026-10-13T01:00:00Z', updatedAt: '2026-10-13T01:00:00Z' }] }])
      const learned: SpaceInsight[] = []
      let copyId: string | undefined
      for (let round = 1; round <= 3; round += 1) {
        learned.push({ id: 'i-' + String(round + 2), content: 'Learned in round ' + String(round) })
        spaces(source.root, [{ id: 'gateway', name: 'AI Gateway routing', insights: memories(round, learned), reads: round }])
        await target.manager.importPack((await source.manager.exportPack('memory-spaces')).base64, { mode: 'merge' })
        const bodies = registryOf(target.root)
        expect(bodies).toHaveLength(2)
        const copy = bodies.find(body => body.id !== 'gateway')!
        expect(bodies.find(body => body.id === 'gateway')).toMatchObject({ name: 'AI Gateway routing', active: true })
        expect(copy.name).toMatch(/^AI Gateway routing \(import conflict [a-f0-9]{8}\)$/u)
        expect(copy.active).toBe(round > 1 && activateCopy)
        if (copyId !== undefined) expect(copy.id).toBe(copyId)
        copyId = copy.id
        if (round === 1 && activateCopy) {
          const path = join(target.root, 'data', '.dsh-memory-bodies.json')
          const registry = JSON.parse(readFileSync(path, 'utf8'))
          registry.bodies.find((body: { id: string }) => body.id === copy.id).active = true
          writeFileSync(path, JSON.stringify(registry))
        }
        // The forgotten memory stays forgotten here; the copy holds the other machine's version, as it grows.
        expect(held(target.root, 'gateway')).toEqual(['i-1', 'i-2'])
        expect(held(target.root, bodies.find(body => body.id !== 'gateway')!.id)).toEqual(['i-1', 'i-2', ...learned.map(insight => insight.id)])
      }
    })

    it('does not add again a copy held under another id or name, and keeps different spaces apart', async () => {
      const source = await fixture('pack-copies-source', 64)
      const target = await fixture('pack-copies-target', 65)
      const edited = { ...memories()[1]!, content: 'Accounts warm up for two weeks before routing', updatedAt: '2026-10-13T01:00:00Z' }
      // This machine edited i-2, holds the other machine's version as a copy it has since renamed,
      // and an empty space of each of two names.
      spaces(target.root, [
        { id: 'gateway', name: 'AI Gateway routing', insights: [memories(1)[0]!, edited] },
        { id: 'copy-here', name: 'AI Gateway routing, the other one', insights: memories(2, [{ id: 'i-3', content: 'Only one machine learned this' }]) },
        { id: 'ideas', name: 'Ideas', insights: [] },
        { id: 'drafts-here', name: 'Drafts', insights: [] },
      ])
      // The other machine's version of the space is the copy held here; its own copy of it has another id.
      spaces(source.root, [
        { id: 'gateway', name: 'AI Gateway routing', insights: memories(4, [{ id: 'i-3', content: 'Only one machine learned this' }]) },
        { id: 'copy-there', name: 'AI Gateway routing', insights: [memories(7)[0]!, edited], reads: 3 },
        { id: 'notes', name: 'Notes', insights: [] },
        { id: 'drafts-there', name: 'Drafts', insights: [] },
      ])
      await target.manager.importPack((await source.manager.exportPack('memory-spaces')).base64, { mode: 'merge' })
      // Nothing new arrived but Notes: an empty space of another name is still a space of its own.
      expect(registryOf(target.root).map(body => body.id).sort()).toEqual(['copy-here', 'drafts-here', 'gateway', 'ideas', 'notes'])
      expect(held(target.root, 'gateway')).toEqual(['i-1', 'i-2'])
    })
  })

  it('keeps a valid branch scope and origin through an import and drops malformed ones', async () => {
    const source = await fixture('pack-entry-fields-source', 41)
    const files = unzipSync(Buffer.from((await source.manager.exportPack('runtime')).base64, 'base64'))
    const at = now().toISOString()
    const entry = (content: string, target: 'memory' | 'user', extra: Record<string, unknown> = {}) => ({ content, target, importance: 'normal', created_at: at, updated_at: at, ...extra })
    // As a damaged archive or another installation could carry them.
    const entries = [
      entry('Scoped to main', 'memory', { branches: ['main'], origin: { machine: 'machine-a', label: 'desk', at } }),
      entry('Scoped by a number', 'memory', { branches: 5 }),
      entry('Scoped with a bad name', 'memory', { branches: ['main', 3] }),
      entry('Odd provenance', 'memory', { origin: { machine: 1 }, extra: 'not an entry field' }),
      entry('Profile with a scope', 'user', { branches: ['main'] }),
    ]
    files['payload/runtime/memories.json'] = strToU8(`${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
    files['payload/runtime/MEMORY.md'] = strToU8(entries.filter(item => item.target === 'memory').map(item => item.content).join(RUNTIME_ENTRY_DELIMITER))
    files['payload/runtime/USER.md'] = strToU8('Profile with a scope')
    const checksums = JSON.parse(Buffer.from(files['checksums.json']!).toString('utf8')) as { files: Record<string, string> }
    for (const path of Object.keys(checksums.files)) checksums.files[path] = createHash('sha256').update(files[path]!).digest('hex')
    files['checksums.json'] = strToU8(`${JSON.stringify(checksums, null, 2)}\n`)

    const target = runner(temporary('pack-entry-fields-target'))
    await new MnemonPackManager(target.runner, target.config, undefined, now).importPack(Buffer.from(zipSync(files)).toString('base64'), { mode: 'merge' })
    const stored = (JSON.parse(readFileSync(join(target.runner.effectiveDataDir(), 'runtime', 'memories.json'), 'utf8')) as { entries: Array<Record<string, unknown>> }).entries
    const find = (content: string) => stored.find(item => item['content'] === content)
    expect(find('Scoped to main')).toMatchObject({ branches: ['main'], origin: { machine: 'machine-a', label: 'desk', at } })
    for (const content of ['Scoped by a number', 'Scoped with a bad name', 'Profile with a scope']) expect(find(content)).not.toHaveProperty('branches')
    expect(find('Odd provenance')).not.toHaveProperty('origin')
    expect(find('Odd provenance')).not.toHaveProperty('extra')
  })

  it('replaces a complete target atomically and refreshes the Memory Space catalog callback', async () => {
    const source = await fixture('pack-replace-source', 4, 'source')
    const target = await fixture('pack-replace-target', 5, 'target')
    const exported = await source.manager.exportPack('full')
    const refreshed = vi.fn()
    const manager = new MnemonPackManager(target.runner, target.config, refreshed, now)

    await expect(manager.importPack(exported.base64, { mode: 'replace' })).resolves.toMatchObject({ imported: true, components: ['runtime', 'documents', 'memory-spaces'] })

    expect(readdirSync(join(target.root, 'data')).filter(name => !name.startsWith('.'))).toEqual(['source'])
    expect(readFileSync(join(target.root, 'data', 'source', 'mnemon.db'))).toEqual(sqlite(4))
    expect(readFileSync(join(target.root, 'active'), 'utf8')).toBe('source\n')
    expect(refreshed).toHaveBeenCalledWith(['runtime', 'documents', 'memory-spaces'])
    expect(readdirSync(target.root).some(name => name.startsWith('.dsh-pack-stage-') || name.startsWith('.dsh-pack-backup-'))).toBe(false)
  })

  describe('Project Documents merged against what a sync last agreed on', () => {
    /** A machine with its own Documents Source to edit them, and its Pack manager. */
    async function documents(label: string) {
      const root = temporary(label)
      const created = runner(root)
      const sources = await sourceFixture({ dataDir: root, workspace: temporary(`${label}-workspace`) })
      releases.push(sources.dispose)
      return { root, sources, manager: new MnemonPackManager(created.runner, created.config, undefined, now) }
    }
    const indexOf = (root: string) => (JSON.parse(readFileSync(join(root, 'documents', 'index.json'), 'utf8')) as { documents: Array<Parameters<typeof documentVersion>[0]> }).documents
    const textOf = (root: string, id: string) => readFileSync(join(root, indexOf(root).find(document => document.id === id)!.relativePath), 'utf8')
    const edit = async (machine: Awaited<ReturnType<typeof documents>>, id: string, content: string) => {
      await machine.sources.documents.read('snapshot')
      await machine.sources.documents.mutate('mutate', { action: 'update', id, content }, { confirmed: true })
    }

    it('takes the branch version of a document only the branch changed, and keeps an edit made only here', async () => {
      const here = await documents('pack-agreed-here')
      await here.sources.documents.mutate('mutate', { action: 'create', title: 'Release plan', content: '# Release plan\n\nVersion 1' }, { confirmed: true })
      const [first] = indexOf(here.root)
      const agreed = { [first!.id]: documentVersion(first!) }
      const there = await documents('pack-agreed-there')
      await there.manager.importPack((await here.manager.exportPack('documents')).base64, { mode: 'merge' })
      await edit(there, first!.id, '# Release plan\n\nVersion 2 from there')
      // Only the branch changed it: the document here moves on, no copy beside it.
      await here.manager.importPack((await there.manager.exportPack('documents')).base64, { mode: 'merge', documentsBase: agreed })
      expect(indexOf(here.root).map(document => [document.id, document.revision])).toEqual([[first!.id, 2]])
      // Only this machine changed it: the branch's older version adds nothing.
      await edit(there, first!.id, '# Release plan\n\nVersion 3 from there')
      const branch = (await here.manager.exportPack('documents')).base64
      const moved = { [first!.id]: documentVersion(indexOf(here.root)[0]!) }
      await there.manager.importPack(branch, { mode: 'merge', documentsBase: moved })
      expect(indexOf(there.root).map(document => [document.id, document.revision])).toEqual([[first!.id, 3]])
    })

    it('keeps one copy of a document both sides changed, as a merge without an agreement does', async () => {
      const here = await documents('pack-both-here')
      await here.sources.documents.mutate('mutate', { action: 'create', title: 'Release plan', content: '# Release plan\n\nVersion 1' }, { confirmed: true })
      const [first] = indexOf(here.root)
      const agreed = { [first!.id]: documentVersion(first!) }
      const there = await documents('pack-both-there')
      await there.manager.importPack((await here.manager.exportPack('documents')).base64, { mode: 'merge' })
      await edit(here, first!.id, '# Release plan\n\nHere')
      await edit(there, first!.id, '# Release plan\n\nThere')
      const branch = (await there.manager.exportPack('documents')).base64
      await here.manager.importPack(branch, { mode: 'merge', documentsBase: agreed })
      await here.manager.importPack(branch, { mode: 'merge', documentsBase: agreed })
      expect(indexOf(here.root)).toHaveLength(2)
    })

    it('brings back a document this machine no longer holds, as a merge without an agreement does', async () => {
      const source = await documents('pack-removed-source')
      await source.sources.documents.mutate('mutate', { action: 'create', title: 'Old notes', content: '# Old notes' }, { confirmed: true })
      const [old] = indexOf(source.root)
      const target = await documents('pack-removed-target')
      await target.manager.importPack((await source.manager.exportPack('documents')).base64, { mode: 'merge', documentsBase: { [old!.id]: documentVersion(old!) } })
      expect(indexOf(target.root).map(document => document.id)).toEqual([old!.id])
    })

    it('keeps both versions of a document both sides changed, this one at a revision above both', async () => {
      const here = await documents('pack-both-revisions-here')
      await here.sources.documents.mutate('mutate', { action: 'create', title: 'Release plan', content: '# Release plan\n\nVersion 1' }, { confirmed: true })
      const [first] = indexOf(here.root)
      const agreed = { [first!.id]: documentVersion(first!) }
      const there = await documents('pack-both-revisions-there')
      await there.manager.importPack((await here.manager.exportPack('documents')).base64, { mode: 'merge' })
      await edit(here, first!.id, '# Release plan\n\nHere, once')
      await edit(here, first!.id, '# Release plan\n\nHere, twice')
      await edit(there, first!.id, '# Release plan\n\nThere, once')
      await here.manager.importPack((await there.manager.exportPack('documents')).base64, { mode: 'merge', documentsBase: agreed })
      const [mine, theirs] = indexOf(here.root)
      // Revision 3 here and 2 there: this version moves above both, so the other machine takes it as the newer one.
      expect([mine!.id, mine!.revision]).toEqual([first!.id, 4])
      expect(textOf(here.root, first!.id)).toContain('Here, twice')
      expect(textOf(here.root, theirs!.id)).toContain('There, once')
    })

    it('keeps an archive here and a rename there of the same text, one beside the other', async () => {
      const here = await documents('pack-both-meta-here')
      await here.sources.documents.mutate('mutate', { action: 'create', title: 'Release plan', content: '# Release plan\n\nVersion 1' }, { confirmed: true })
      const [first] = indexOf(here.root)
      const agreed = { [first!.id]: documentVersion(first!) }
      const there = await documents('pack-both-meta-there')
      await there.manager.importPack((await here.manager.exportPack('documents')).base64, { mode: 'merge' })
      await here.sources.documents.read('snapshot')
      await here.sources.documents.mutate('archive', { id: first!.id, summary: 'Shipped' } as never, { confirmed: true })
      await there.sources.documents.read('snapshot')
      await there.sources.documents.mutate('mutate', { action: 'update', id: first!.id, title: 'Release plan, renamed there' }, { confirmed: true })
      const branch = (await there.manager.exportPack('documents')).base64
      await here.manager.importPack(branch, { mode: 'merge', documentsBase: agreed })
      // Merging the same version again, as a retried sync does, adds no second copy.
      await here.manager.importPack(branch, { mode: 'merge', documentsBase: agreed })
      expect(indexOf(here.root).map(document => [document.id === first!.id, document.title, document.status, document.archiveSummary])).toEqual([
        [true, 'Release plan', 'archived', 'Shipped'],
        [false, 'Release plan, renamed there', 'active', undefined],
      ])
    })

    it('takes a title only the branch changed, and keeps a rename made here beside a text the branch changed', async () => {
      const here = await documents('pack-meta-here')
      await here.sources.documents.mutate('mutate', { action: 'create', title: 'Release plan', content: '# Release plan\n\nVersion 1' }, { confirmed: true })
      const [first] = indexOf(here.root)
      const agreed = { [first!.id]: documentVersion(first!) }
      const there = await documents('pack-meta-there')
      await there.manager.importPack((await here.manager.exportPack('documents')).base64, { mode: 'merge' })
      await there.sources.documents.read('snapshot')
      await there.sources.documents.mutate('mutate', { action: 'update', id: first!.id, title: 'Release plan, renamed there' }, { confirmed: true })
      await here.manager.importPack((await there.manager.exportPack('documents')).base64, { mode: 'merge', documentsBase: agreed })
      expect(indexOf(here.root).map(document => [document.id, document.title])).toEqual([[first!.id, 'Release plan, renamed there']])

      // Now both sides changed it: here its title, there its text. Neither replaces the other.
      const renamed = { [first!.id]: documentVersion(indexOf(here.root)[0]!) }
      await here.sources.documents.read('snapshot')
      await here.sources.documents.mutate('mutate', { action: 'update', id: first!.id, title: 'Release plan, renamed here' }, { confirmed: true })
      await edit(there, first!.id, '# Release plan\n\nVersion 2 from there')
      await here.manager.importPack((await there.manager.exportPack('documents')).base64, { mode: 'merge', documentsBase: renamed })
      expect(indexOf(here.root).map(document => [document.id === first!.id, document.title])).toEqual([[true, 'Release plan, renamed here'], [false, 'Release plan, renamed there']])
      expect(textOf(here.root, first!.id)).toContain('Version 1')
    })

    it('never replaces a document with a lower revision from the branch, as an older dsh-mnemon republishes', async () => {
      const here = await documents('pack-revision-here')
      await here.sources.documents.mutate('mutate', { action: 'create', title: 'Release plan', content: '# Release plan\n\nVersion 1' }, { confirmed: true })
      const older = (await here.manager.exportPack('documents')).base64
      const [first] = indexOf(here.root)
      await edit(here, first!.id, '# Release plan\n\nVersion 2')
      const agreed = { [first!.id]: documentVersion(indexOf(here.root)[0]!) }
      await here.manager.importPack(older, { mode: 'merge', documentsBase: agreed })
      expect(indexOf(here.root).find(document => document.id === first!.id)?.revision).toBe(2)
      expect(textOf(here.root, first!.id)).toContain('Version 2')
    })
  })

  it('merges components without overwriting a divergent Memory Space id', async () => {
    const source = await fixture('pack-merge-source', 6, 'shared')
    const target = await fixture('pack-merge-target', 7, 'shared')
    const path = join(source.root, 'data', '.dsh-memory-bodies.json')
    const sourceRegistry = JSON.parse(readFileSync(path, 'utf8'))
    sourceRegistry.bodies[0].name = '长'.repeat(100)
    writeFileSync(path, JSON.stringify(sourceRegistry))
    const exported = await source.manager.exportPack('full')

    await target.manager.importPack(exported.base64, { mode: 'merge' })

    const registry = JSON.parse(readFileSync(join(target.root, 'data', '.dsh-memory-bodies.json'), 'utf8')) as { bodies: Array<{ id: string }> }
    expect(registry.bodies).toHaveLength(2)
    expect(new Set(registry.bodies.map(body => body.id)).size).toBe(2)
    const copy = registryOf(target.root).find(body => body.id !== 'shared')!
    expect(copy).toMatchObject({ active: false, name: expect.stringContaining('import conflict') })
    expect(copy.name).toHaveLength(100)
    expect(readdirSync(join(target.root, 'data')).filter(name => !name.startsWith('.'))).toHaveLength(2)
    const runtime = JSON.parse(readFileSync(join(target.root, 'runtime', 'memories.json'), 'utf8')) as { entries: unknown[] }
    expect(runtime.entries).toHaveLength(1)
    const documents = JSON.parse(readFileSync(join(target.root, 'documents', 'index.json'), 'utf8')) as { documents: unknown[] }
    expect(documents.documents).toHaveLength(2)

    // Merging the same pack again, as a retried sync does, keeps the one copy it made.
    await target.manager.importPack(exported.base64, { mode: 'merge' })
    expect((JSON.parse(readFileSync(join(target.root, 'data', '.dsh-memory-bodies.json'), 'utf8')) as { bodies: unknown[] }).bodies).toHaveLength(2)
    expect((JSON.parse(readFileSync(join(target.root, 'documents', 'index.json'), 'utf8')) as { documents: unknown[] }).documents).toHaveLength(2)
  })

  it('imports only the requested component from a complete Pack', async () => {
    const source = await fixture('pack-partial-source', 8, 'source')
    const target = await fixture('pack-partial-target', 9, 'target')
    const beforeDatabase = readFileSync(join(target.root, 'data', 'target', 'mnemon.db'))
    const exported = await source.manager.exportPack('full')

    await target.manager.importPack(exported.base64, { mode: 'replace', components: ['runtime'] })

    expect(readFileSync(join(target.root, 'data', 'target', 'mnemon.db'))).toEqual(beforeDatabase)
    expect(readdirSync(join(target.root, 'data')).filter(name => !name.startsWith('.'))).toEqual(['target'])
  })

  it.each(['replace', 'merge'] as const)('keeps the local MEMORY.md archive through a %s import (issue 336)', async mode => {
    const source = await fixture(`pack-archive-source-${mode}`, 12, 'source')
    const target = await fixture(`pack-archive-target-${mode}`, 13, 'target')
    // The only copy of what left MEMORY.md while no Memory Space could take it.
    const archive = join(target.root, 'runtime', 'archived')
    mkdirSync(archive, { recursive: true })
    writeFileSync(join(archive, 'MEMORY.md'), '# MEMORY.md archive\n\n## 2026-10-08T00:00:00.000Z\n\nArchived durable fact.\n')
    writeFileSync(join(archive, 'memories.jsonl'), '{"content":"Archived durable fact."}\n')
    mkdirSync(join(archive, 'notes'))
    writeFileSync(join(archive, 'notes', 'kept.md'), 'A note kept beside the archive.\n')
    // A link in the archive is not carried, and what it points at is left alone.
    const outside = join(temporary(`pack-archive-outside-${mode}`), 'outside.md')
    writeFileSync(outside, 'Outside the archive.\n')
    symlinkSync(outside, join(archive, 'linked.md'))
    const exported = await source.manager.exportPack('full')

    await target.manager.importPack(exported.base64, { mode, components: ['runtime'] })

    expect(readFileSync(join(archive, 'MEMORY.md'), 'utf8')).toContain('Archived durable fact.')
    expect(readFileSync(join(archive, 'memories.jsonl'), 'utf8')).toBe('{"content":"Archived durable fact."}\n')
    expect(statSync(join(archive, 'MEMORY.md')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(archive, 'notes', 'kept.md'), 'utf8')).toBe('A note kept beside the archive.\n')
    expect(existsSync(join(archive, 'linked.md'))).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('Outside the archive.\n')
    expect(readdirSync(target.root).some(name => name.startsWith('.dsh-pack-stage-') || name.startsWith('.dsh-pack-backup-'))).toBe(false)
  })

  it('refuses to replace an initialized root with an empty Memory Space set', async () => {
    const empty = runner(temporary('pack-empty-source'))
    const emptyManager = new MnemonPackManager(empty.runner, empty.config, undefined, now)
    const exported = await emptyManager.exportPack('memory-spaces')
    const target = await fixture('pack-empty-target', 10, 'default')

    await expect(target.manager.importPack(exported.base64, { mode: 'replace' })).rejects.toThrow('last Mnemon Store')

    expect(readFileSync(join(target.root, 'data', 'default', 'mnemon.db'))).toEqual(sqlite(10))
    expect(readFileSync(join(target.root, 'active'), 'utf8')).toBe('default\n')
  })

  it('leaves the target untouched when staging a merge fails', async () => {
    const source = await fixture('pack-rollback-source', 10)
    const target = await fixture('pack-rollback-target', 11)
    const exported = await source.manager.exportPack('full')
    const runtimeBefore = readFileSync(join(target.root, 'runtime', 'memories.json'))
    writeFileSync(join(target.root, 'documents', 'index.json'), '{ broken')

    await expect(target.manager.importPack(exported.base64, { mode: 'merge' })).rejects.toThrow()

    expect(readFileSync(join(target.root, 'runtime', 'memories.json'))).toEqual(runtimeBefore)
    expect(readdirSync(target.root).some(name => name.startsWith('.dsh-pack-stage-') || name.startsWith('.dsh-pack-backup-'))).toBe(false)
  })

  it('refuses to copy a live WAL database as an inconsistent snapshot', async () => {
    const source = await fixture('pack-wal', 12)
    writeFileSync(join(source.root, 'data', 'project', 'mnemon.db-wal'), 'pending')
    await expect(source.manager.exportPack('memory-spaces')).rejects.toThrow('not checkpointed')
  })

  it('carries and lands USER.md and MEMORY.md byte for byte as the Runtime Source writes them', async () => {
    const root = temporary('pack-runtime-bytes')
    const sources = await sourceFixture({ dataDir: root, workspace: temporary('pack-runtime-bytes-workspace') })
    releases.push(sources.dispose)
    for (const [target, content] of [
      ['user', 'Prefers concise answers'], ['memory', '项目使用 pnpm workspace'], ['memory', 'A rare character \u{20BB7} takes four bytes'], ['user', 'Écrit en français'],
    ] as const) await sources.runtime.mutate('mutate', { action: 'add', target, content, importance: 'normal' }, { confirmed: true })
    const written = (file: string) => readFileSync(join(root, RUNTIME_DIRECTORY, file))
    const created = runner(root)
    const exported = await new MnemonPackManager(created.runner, created.config, undefined, now).exportPack('runtime')
    const files = unzipSync(Buffer.from(exported.base64, 'base64'))
    const stored = JSON.parse(written('memories.json').toString('utf8')) as { entries: Array<{ target: 'user' | 'memory'; content: string }> }
    for (const target of ['user', 'memory'] as const) {
      const file = RUNTIME_PROJECTION_FILES[target]
      expect(Buffer.from(files[`payload/runtime/${file}`]!).equals(written(file)), file).toBe(true)
      expect(Buffer.from(runtimeProjection(stored.entries, target), 'utf8').equals(written(file)), file).toBe(true)
    }
    expect(JSON.parse(Buffer.from(files['payload/runtime/memories.json']!).toString('utf8'))).toEqual(stored)

    const target = temporary('pack-runtime-bytes-target')
    const landed = runner(target)
    await new MnemonPackManager(landed.runner, landed.config, undefined, now).importPack(exported.base64, { mode: 'replace' })
    for (const file of Object.values(RUNTIME_PROJECTION_FILES)) expect(readFileSync(join(target, RUNTIME_DIRECTORY, file)).equals(written(file)), file).toBe(true)
  })

  it('takes over a Source lock only when that Source would, and waits for one it holds', async () => {
    const source = await fixture('pack-source-locks', 14)
    const runtimeLock = join(source.root, RUNTIME_DIRECTORY, RUNTIME_LOCK_FILE)
    const documentsLock = join(source.root, DOCUMENTS_DIRECTORY, DOCUMENTS_LOCK_FILE)
    // Left behind by a process that stopped: older than its Source's own stale rule.
    for (const [lock, staleMs] of [[runtimeLock, RUNTIME_LOCK_STALE_MS], [documentsLock, DOCUMENTS_LOCK_STALE_MS]] as const) {
      writeFileSync(lock, 'stopped\n')
      const left = new Date(Date.now() - staleMs - 5_000)
      utimesSync(lock, left, left)
    }
    await source.manager.exportPack('full')
    expect([existsSync(runtimeLock), existsSync(documentsLock)]).toEqual([false, false])

    // Held by a live writer: the export starts while it holds the lock and finishes after it lets go.
    for (const [scope, lock] of [['runtime', runtimeLock], ['documents', documentsLock]] as const) {
      writeFileSync(lock, 'held\n')
      const released = new Float64Array(new SharedArrayBuffer(8))
      const writer = new Worker(`
        const { workerData } = require('node:worker_threads')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
        // Stamped before the lock goes: nothing can take it earlier than this.
        new Float64Array(workerData.released)[0] = Date.now()
        require('node:fs').rmSync(workerData.lock, { force: true })
      `, { eval: true, workerData: { lock, released: released.buffer } })
      const exited = new Promise(resolve => writer.once('exit', resolve))
      const exported = await source.manager.exportPack(scope)
      const finished = Date.now()
      await exited
      expect(exported.manifest.components).toEqual([scope])
      expect(released[0], scope).toBeGreaterThan(0)
      expect(finished, scope).toBeGreaterThanOrEqual(released[0]!)
      expect(existsSync(lock)).toBe(false)
    }
  })
})

it('roundtrips pins and preserves them ahead of unpinned critical entries in a merge overflow', async () => {
  const source = await fixture('pinned-pack-source', 93)
  const target = await fixture('pinned-pack-target', 94)
  const entry = (content: string, importance: string) => ({ target: 'memory', content, importance, created_at: now().toISOString(), updated_at: now().toISOString() })
  const pinned = { ...entry('Pinned-' + 'p'.repeat(893), 'low'), pinned: true, branches: ['main'], origin: { machine: 'desk', label: 'Desktop', at: now().toISOString() } }
  const local = entry('Local-' + 'l'.repeat(4994), 'normal')
  const incoming = entry('Incoming-' + 'r'.repeat(4991), 'critical')
  const write = (root: string, entries: unknown[]) => writeFileSync(join(root, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries }))
  write(source.root, [pinned, incoming]); write(target.root, [local])
  const pack = (await source.manager.exportPack('runtime')).base64
  await target.manager.importPack(pack, { mode: 'merge' })
  expect(JSON.parse(readFileSync(join(target.root, 'runtime', 'memories.json'), 'utf8')).entries).toEqual([pinned, incoming])
  const restored = await fixture('pinned-pack-restore', 95)
  await restored.manager.importPack((await target.manager.exportPack('runtime')).base64, { mode: 'replace' })
  expect(JSON.parse(readFileSync(join(restored.root, 'runtime', 'memories.json'), 'utf8')).entries[0]).toEqual(pinned)
  // A legacy copy with no pin field cannot erase an explicit local decision.
  const { pinned: _flag, ...legacy } = pinned
  write(source.root, [legacy])
  await target.manager.importPack((await source.manager.exportPack('runtime')).base64, { mode: 'merge' })
  expect(JSON.parse(readFileSync(join(target.root, 'runtime', 'memories.json'), 'utf8')).entries[0].pinned).toBe(true)
  // An explicit later unpin is carried by the same merge path used by sync.
  write(source.root, [{ ...pinned, pinned: false, updated_at: '2026-08-15T00:00:00.000Z' }])
  await target.manager.importPack((await source.manager.exportPack('runtime')).base64, { mode: 'merge' })
  expect(JSON.parse(readFileSync(join(target.root, 'runtime', 'memories.json'), 'utf8')).entries[0].pinned).toBe(false)
})

it('rejects a merge whose pins exceed capacity without changing hot memory or creating an overflow archive', async () => {
  const source = await fixture('pin-capacity-source', 96)
  const target = await fixture('pin-capacity-target', 97)
  for (const [root, prefix] of [[source.root, 'remote'], [target.root, 'local']]) {
    writeFileSync(join(root!, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [{ target: 'memory', content: prefix + 'x'.repeat(294), importance: 'low', pinned: true, created_at: now().toISOString(), updated_at: now().toISOString() }] }))
  }
  const before = readFileSync(join(target.root, 'runtime', 'memories.json'))
  const manager = new MnemonPackManager(target.runner, { ...target.config, runtimeMemory: { ...target.config.runtimeMemory, memoryLimitBytes: 512 } }, undefined, now)
  await expect(manager.importPack((await source.manager.exportPack('runtime')).base64, { mode: 'merge' })).rejects.toThrow('Pinned runtime entries exceed')
  expect(readFileSync(join(target.root, 'runtime', 'memories.json'))).toEqual(before)
  expect(existsSync(join(target.root, 'runtime', 'archived'))).toBe(false)
})
