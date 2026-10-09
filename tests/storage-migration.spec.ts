import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateStorageRoot, planMigration, storageAreas } from "../src/host/storage-migration.ts"

const directories: string[] = []

function temporary(label = 'migration'): string {
  const directory = mkdtempSync(join(tmpdir(), `dsh-mnemon-${label}-`))
  directories.push(directory)
  return directory
}

function populated(root: string): void {
  mkdirSync(join(root, 'runtime'), { recursive: true })
  mkdirSync(join(root, 'state'), { recursive: true })
  writeFileSync(join(root, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [] }))
  writeFileSync(join(root, 'state', 'machine.json'), JSON.stringify({ version: 1, id: 'machine', label: 'host', createdAt: 'now' }))
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Mnemon data-directory migration', () => {
  it('counts what a move would carry and treats a sibling directory as the same device', () => {
    const source = temporary('migration-source')
    populated(source)
    const target = join(temporary('migration-parent'), 'moved')
    const plan = planMigration(source, target)
    expect(plan).toEqual({ from: source, to: target, source: { files: 2, bytes: expect.any(Number) }, targetOccupied: false, sameDevice: true })
    expect(plan.blocked).toBeUndefined()
  })

  it('refuses a move onto itself, into itself, or onto data that already exists', () => {
    const source = temporary('migration-source')
    populated(source)
    expect(planMigration(source, source).blocked).toBe('the data directory is already this directory')
    expect(planMigration(source, join(source, 'nested')).blocked).toBe('one directory is inside the other')
    expect(planMigration(join(source, 'runtime'), source).blocked).toBe('one directory is inside the other')
    const occupied = temporary('migration-occupied')
    writeFileSync(join(occupied, 'memories.json'), '{}')
    expect(planMigration(source, occupied)).toEqual(expect.objectContaining({ targetOccupied: true, blocked: 'the target directory already holds data' }))
  })

  it('refuses a filesystem root as either side of the move', () => {
    const source = temporary('migration-source')
    populated(source)
    const root = parse(source).root
    expect(() => planMigration(source, root)).toThrow('the Mnemon data directory must not be a filesystem root')
    expect(() => planMigration(root, source)).toThrow('the Mnemon data directory must not be a filesystem root')
  })

  it('moves the directory in one rename when the target does not exist yet', async () => {
    const source = temporary('migration-source')
    populated(source)
    const target = join(temporary('migration-parent'), 'moved')
    const result = await migrateStorageRoot(source, target)
    expect(result).toEqual({ from: source, to: target, source: 'rename', files: 2, bytes: expect.any(Number), removed: true })
    expect(existsSync(source)).toBe(false)
    expect(readFileSync(join(target, 'state', 'machine.json'), 'utf8')).toContain('"machine"')
  })

  it('copies and verifies into a target that already exists, and keeps the source when asked to', async () => {
    const source = temporary('migration-source')
    populated(source)
    const target = temporary('migration-target')
    const result = await migrateStorageRoot(source, target, { remove: false })
    expect(result).toEqual({ from: source, to: target, source: 'copy', files: 2, bytes: expect.any(Number), removed: false })
    expect(existsSync(source)).toBe(true)
    expect(readdirSync(target).sort()).toEqual(['runtime', 'state'])
    expect(readFileSync(join(target, 'runtime', 'memories.json'), 'utf8')).toBe(readFileSync(join(source, 'runtime', 'memories.json'), 'utf8'))
  })

  it('removes the source after a copy unless the caller keeps it, and reports the areas it carries', async () => {
    const source = temporary('migration-source')
    populated(source)
    const target = temporary('migration-target')
    expect(storageAreas(source)).toEqual(['runtime', 'state'])
    await migrateStorageRoot(source, target)
    expect(existsSync(source)).toBe(false)
    expect(storageAreas(target)).toEqual(['runtime', 'state'])
  })

  it('reports a blocked plan through the same refusal a caller sees at move time', async () => {
    const source = temporary('migration-source')
    populated(source)
    await expect(migrateStorageRoot(source, source)).rejects.toThrow('cannot move the Mnemon data directory: the data directory is already this directory')
  })
})
