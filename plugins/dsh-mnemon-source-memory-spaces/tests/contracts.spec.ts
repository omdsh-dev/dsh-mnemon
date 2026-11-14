import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveMemorySpacesConfig } from '../src/config.ts'
import {
  isNativeProvider, MEMORY_PROVIDER_REGISTRY_FILE, MEMORY_SPACE_DATABASE_FILE, MEMORY_SPACE_DESCRIPTION_MAX_LENGTH, MEMORY_SPACE_ID_PATTERN,
  MEMORY_SPACE_NAME_MAX_LENGTH, MEMORY_SPACE_REGISTRY_FILE, MEMORY_SPACES_DIRECTORY, MNEMON_ACTIVE_STORE_FILE, NATIVE_PROVIDER_ID,
  parseMemorySpaceRegistry, summarizeMemoryProviderRegistry, summarizeMemorySpaceRegistry,
} from '../src/contracts.ts'
import { validateMemorySpaceId } from '../src/memory-spaces.ts'
import type { ProcessRunner } from '../src/providers/process.ts'
import { createRunner } from '../src/runner.ts'
import { TestNativeProvider as MnemonNativeProvider, createRegistry, installedCliStub, nativeDefinition, nativeDescriptor } from './providers.ts'

const FAKE_CLI = installedCliStub()
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function dataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-spaces-contracts-'))
  directories.push(directory)
  return directory
}

function registryOn(dataDir: string) {
  const runner = createRunner(resolveMemorySpacesConfig({ cliPath: FAKE_CLI, dataDir }), vi.fn<ProcessRunner>())
  return { runner, registry: createRegistry(runner, true, () => new Date('2026-10-17T08:00:00.000Z')) }
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'project', name: 'Project', description: 'Facts', active: true, createdAt: '2026-10-17T08:00:00.000Z', updatedAt: '2026-10-17T08:00:00.000Z', ...overrides }
}

describe('Memory Spaces storage contracts', () => {
  it('name the stores, registries and selection the Source and its Mnemon runner use', () => {
    const dataDir = dataDirectory()
    mkdirSync(join(dataDir, MEMORY_SPACES_DIRECTORY, 'project'), { recursive: true })
    writeFileSync(join(dataDir, MEMORY_SPACES_DIRECTORY, 'project', MEMORY_SPACE_DATABASE_FILE), 'database')
    writeFileSync(join(dataDir, MNEMON_ACTIVE_STORE_FILE), 'project\n')
    const { runner, registry } = registryOn(dataDir)
    expect(registry.directory).toBe(join(dataDir, MEMORY_SPACES_DIRECTORY))
    expect(registry.registryPath).toBe(join(dataDir, MEMORY_SPACES_DIRECTORY, MEMORY_SPACE_REGISTRY_FILE))
    expect(registry.providerRegistryPath).toBe(join(dataDir, 'state', MEMORY_PROVIDER_REGISTRY_FILE))
    expect(registry.list().map(space => space.dbPath)).toEqual([join(dataDir, MEMORY_SPACES_DIRECTORY, 'project', MEMORY_SPACE_DATABASE_FILE)])
    expect(runner.persistedStore()).toBe('project')
    writeFileSync(join(dataDir, MNEMON_ACTIVE_STORE_FILE), '../elsewhere\n')
    expect(runner.persistedStore()).toBe('default')
    // The names a Mnemon Pack has always carried them under.
    expect([MEMORY_SPACES_DIRECTORY, MEMORY_SPACE_REGISTRY_FILE, MEMORY_SPACE_DATABASE_FILE, MNEMON_ACTIVE_STORE_FILE, MEMORY_PROVIDER_REGISTRY_FILE])
      .toEqual(['data', '.dsh-memory-bodies.json', 'mnemon.db', 'active', 'memory-providers.json'])
  })

  it('take a space id exactly as the Source validates one', () => {
    for (const id of ['default', 'A-1_b', '9lives']) {
      expect(MEMORY_SPACE_ID_PATTERN.test(id)).toBe(true)
      expect(validateMemorySpaceId(id)).toBe(id)
    }
    for (const id of ['', '-lead', '_lead', 'a.b', 'a/b', '..', 'ä', 'a b']) {
      expect(MEMORY_SPACE_ID_PATTERN.test(id)).toBe(false)
      expect(() => validateMemorySpaceId(id)).toThrow()
    }
  })

  it('read the registry the Source writes, keeping only what a copy carries', () => {
    const dataDir = dataDirectory()
    for (const id of ['project', 'research']) {
      mkdirSync(join(dataDir, MEMORY_SPACES_DIRECTORY, id), { recursive: true })
      writeFileSync(join(dataDir, MEMORY_SPACES_DIRECTORY, id, MEMORY_SPACE_DATABASE_FILE), 'database')
    }
    const { registry } = registryOn(dataDir)
    registry.update('research', { name: 'Research notes', description: 'Papers read' })
    const stored = JSON.parse(readFileSync(registry.registryPath, 'utf8')) as { version: number; bodies: Array<Record<string, unknown>> }
    const parsed = parseMemorySpaceRegistry(stored)
    expect(parsed).toEqual({ version: 1, bodies: stored.bodies.map(({ id, name, description, active, createdAt, updatedAt }) => ({ id, name, description, active, createdAt, updatedAt })) })
    // Discovery order follows the directory listing, which differs between file systems.
    expect(Object.fromEntries(parsed.bodies.map(body => [body.id, body.name]))).toEqual({ project: 'project', research: 'Research notes' })
    expect(parsed.bodies.filter(body => body.active)).toHaveLength(1)
    const extra = parseMemorySpaceRegistry({ version: 1, bodies: [entry({ active: 'yes', placement: { mode: 'automatic' }, externalId: 'x', metadataSource: 'ai' })] })
    expect(extra.bodies).toEqual([{ ...entry(), active: false }])
  })

  it('refuse a whole registry for one bad space, saying which rule it broke', () => {
    const refusals: Array<[unknown, string]> = [
      [null, 'Memory Space registry is invalid'],
      [{ version: 2, bodies: [] }, 'Memory Space registry is invalid'],
      [{ version: 1, bodies: {} }, 'Memory Space registry is invalid'],
      [{ version: 1, bodies: ['project'] }, 'Memory Space registry contains an invalid or duplicate id'],
      [{ version: 1, bodies: [entry({ id: '../escape' })] }, 'Memory Space registry contains an invalid or duplicate id'],
      [{ version: 1, bodies: [entry(), entry()] }, 'Memory Space registry contains an invalid or duplicate id'],
      [{ version: 1, bodies: [entry({ name: '  ' })] }, 'Memory Space registry contains invalid metadata'],
      [{ version: 1, bodies: [entry({ name: 'n'.repeat(101) })] }, 'Memory Space registry contains invalid metadata'],
      [{ version: 1, bodies: [entry({ description: 'd'.repeat(1001) })] }, 'Memory Space registry contains invalid metadata'],
      [{ version: 1, bodies: [entry({ description: undefined })] }, 'Memory Space registry contains invalid metadata'],
      [{ version: 1, bodies: [entry({ updatedAt: 7 })] }, 'Memory Space registry contains invalid timestamps'],
    ]
    for (const [value, message] of refusals) expect(() => parseMemorySpaceRegistry(value), JSON.stringify(value)).toThrow(message)
    expect(parseMemorySpaceRegistry({ version: 1, bodies: [entry({ name: 'n'.repeat(100), description: 'd'.repeat(1000) })] }).bodies).toHaveLength(1)
  })

  it('limit a space name and description by the rule the registry writes and a copy is read with', async () => {
    expect([MEMORY_SPACE_NAME_MAX_LENGTH, MEMORY_SPACE_DESCRIPTION_MAX_LENGTH]).toEqual([100, 1000])
    const dataDir = dataDirectory()
    mkdirSync(join(dataDir, MEMORY_SPACES_DIRECTORY, 'project'), { recursive: true })
    writeFileSync(join(dataDir, MEMORY_SPACES_DIRECTORY, 'project', MEMORY_SPACE_DATABASE_FILE), 'database')
    const { registry } = registryOn(dataDir)
    const name = 'n'.repeat(MEMORY_SPACE_NAME_MAX_LENGTH)
    const description = 'd'.repeat(MEMORY_SPACE_DESCRIPTION_MAX_LENGTH)
    expect(registry.update('project', { name, description })).toMatchObject({ name, description })
    expect(() => registry.update('project', { name: `${name}n` })).toThrow('name is too long (max 100 characters)')
    expect(() => registry.update('project', { description: `${description}d` })).toThrow('description is too long (max 1000 characters)')
    const stored = JSON.parse(readFileSync(registry.registryPath, 'utf8')) as unknown
    expect(parseMemorySpaceRegistry(stored).bodies).toMatchObject([{ id: 'project', name, description }])
    // Creating a space checks both before anything else; at the limits, whatever stops this
    // fixture's create later, it is not their length.
    await expect(registry.create({ name: `${name}n`, description: 'Facts' })).rejects.toThrow('name is too long (max 100 characters)')
    await expect(registry.create({ name, description: `${description}d` })).rejects.toThrow('description is too long (max 1000 characters)')
    expect(await registry.create({ name, description }).then(() => '', (error: unknown) => String(error))).not.toContain('too long')
  })

  it('name the Mnemon Native Provider as its own package does', () => {
    expect(NATIVE_PROVIDER_ID).toBe('mnemon-native')
    expect(nativeDescriptor.id).toBe(NATIVE_PROVIDER_ID)
    expect(nativeDefinition.manifest.typeId).toBe(NATIVE_PROVIDER_ID)
    expect(new MnemonNativeProvider({ runJson: vi.fn(), runText: vi.fn() }).id).toBe(NATIVE_PROVIDER_ID)
    // A child instance keeps the type; an id alone counts only without one.
    expect(isNativeProvider({ id: NATIVE_PROVIDER_ID })).toBe(true)
    expect(isNativeProvider({ id: 'local', typeId: NATIVE_PROVIDER_ID })).toBe(true)
    expect(isNativeProvider({ id: NATIVE_PROVIDER_ID, typeId: 'openviking' })).toBe(false)
    expect(isNativeProvider({ id: 'openviking' })).toBe(false)
  })

  it('summarize a stored registry for an inventory without judging its spaces', () => {
    expect(summarizeMemorySpaceRegistry({ version: 1, bodies: [entry(), entry({ id: 'other', active: false }), 'loose', null] })).toEqual({ valid: true, spaces: 2, active: 1 })
    // A legacy version 2 file is counted but is not the registry this Source writes.
    expect(summarizeMemorySpaceRegistry({ version: 2, bodies: [entry()] })).toEqual({ valid: false, spaces: 1, active: 1 })
    for (const value of [null, [], 'registry', { version: 1 }, { version: 1, bodies: {} }]) {
      expect(summarizeMemorySpaceRegistry(value)).toEqual({ valid: false, spaces: 0, active: 0 })
    }
  })

  it('summarize the Provider registry the Source writes', () => {
    const dataDir = dataDirectory()
    const { registry } = registryOn(dataDir)
    registry.syncProviderService('holographic', { dataPath: join(dataDir, 'facts.json') }, ['alpha', 'beta'].map(name => ({
      externalId: `namespace-${name}`, name, description: 'Provider namespace.', connection: {},
    })))
    const stored = JSON.parse(readFileSync(registry.providerRegistryPath, 'utf8')) as unknown
    expect(summarizeMemoryProviderRegistry(stored)).toEqual({ valid: true, services: 1, connections: 2 })
    // Every entry of the list counts, well-formed or not.
    expect(summarizeMemoryProviderRegistry({ services: { a: {}, b: {} }, bodies: [1, 'two', null] })).toEqual({ valid: true, services: 2, connections: 3 })
    for (const value of [{ services: [], bodies: {} }, { services: 'a' }]) {
      expect(summarizeMemoryProviderRegistry(value)).toEqual({ valid: true, services: 0, connections: 0 })
    }
    for (const value of [null, [], 'registry']) {
      expect(summarizeMemoryProviderRegistry(value)).toEqual({ valid: false, services: 0, connections: 0 })
    }
  })
})
