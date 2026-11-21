import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DOCUMENTS_DIRECTORY, DOCUMENTS_INDEX_FILE, summarizeDocumentIndex } from 'dsh-mnemon-source-documents/contracts'
import {
  MEMORY_PROVIDER_REGISTRY_FILE, MEMORY_SPACE_DATABASE_FILE, MEMORY_SPACE_REGISTRY_FILE, MEMORY_SPACES_DIRECTORY,
  summarizeMemoryProviderRegistry, summarizeMemorySpaceRegistry,
} from 'dsh-mnemon-source-memory-spaces/contracts'
import { RUNTIME_DIRECTORY, RUNTIME_MEMORIES_FILE, RUNTIME_PROJECTION_FILES, summarizeRuntimeMemories } from 'dsh-mnemon-source-runtime/contracts'
import { createStorageRoot, expandUserPath, resolveGlobalDataDir, type ResolvedConfig, type StorageRoot } from './config/index.ts'
import type { StorageAreaInventory, StorageAreaKind, StorageScopeCatalog, StorageScopeInventory, StorageScopeKind } from './protocol.ts'

export type { StorageAreaInventory, StorageAreaKind, StorageAreaStatus, StorageScopeCatalog, StorageScopeInventory, StorageScopeKind } from './protocol.ts'

function canonical(path: string): string {
  return resolve(expandUserPath(path))
}

function globalRoot(): string {
  return resolveGlobalDataDir()
}

function safeBytes(path: string): number {
  try {
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) return 0
    if (stats.isFile()) return stats.size
    if (!stats.isDirectory()) return 0
    return readdirSync(path, { withFileTypes: true }).reduce(
      (total, entry) => entry.isSymbolicLink() ? total : total + safeBytes(join(path, entry.name)),
      0,
    )
  } catch {
    return 0
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function missing(kind: StorageAreaKind, path: string): StorageAreaInventory {
  return { kind, path, status: 'missing', bytes: 0, itemCount: 0, details: {} }
}

function missingProjectionIssue(hasMemory: boolean, hasUser: boolean): string | undefined {
  if (hasMemory && hasUser) return undefined
  if (!hasMemory && !hasUser) return 'USER.md or MEMORY.md projection is missing'
  return hasMemory ? 'shared USER.md projection is missing' : 'MEMORY.md projection is missing'
}

function runtimeArea(root: string, userRoot: string = root): StorageAreaInventory {
  const path = join(root, RUNTIME_DIRECTORY)
  const resolvedUserRoot = canonical(userRoot)
  const sharedUser = resolvedUserRoot !== root
  const source = join(path, RUNTIME_MEMORIES_FILE)
  if (!sharedUser) {
    if (!existsSync(source)) return missing('runtime', path)
    try {
      const stored = summarizeRuntimeMemories(readJson(source))
      if (!stored.valid) throw new Error('memories.json is not a valid runtime-memory source')
      const projectionsHealthy = existsSync(join(path, RUNTIME_PROJECTION_FILES.user)) && existsSync(join(path, RUNTIME_PROJECTION_FILES.memory))
      return {
        kind: 'runtime', path,
        status: stored.entries === 0 ? 'empty' : projectionsHealthy ? 'ready' : 'invalid',
        bytes: safeBytes(path), itemCount: stored.entries,
        details: { userEntries: stored.user, memoryEntries: stored.memory, projectionsHealthy, source: RUNTIME_MEMORIES_FILE },
        ...(projectionsHealthy ? {} : { issue: 'USER.md or MEMORY.md projection is missing' }),
      }
    } catch (error) {
      return { kind: 'runtime', path, status: 'invalid', bytes: safeBytes(path), itemCount: 0, details: {}, issue: error instanceof Error ? error.message : String(error) }
    }
  }
  const userPath = join(resolvedUserRoot, RUNTIME_DIRECTORY)
  const userSource = join(userPath, RUNTIME_MEMORIES_FILE)
  const hasLocal = existsSync(source)
  const hasGlobal = existsSync(userSource)
  if (!hasLocal && !hasGlobal) return missing('runtime', path)
  try {
    const local = hasLocal ? summarizeRuntimeMemories(readJson(source)) : undefined
    if (local !== undefined && !local.valid) throw new Error('memories.json is not a valid runtime-memory source')
    const global = hasGlobal ? summarizeRuntimeMemories(readJson(userSource)) : undefined
    if (global !== undefined && !global.valid) throw new Error('shared USER.md memories.json is not a valid runtime-memory source')
    const userEntries = global?.user ?? 0
    const memoryEntries = local?.memory ?? 0
    const itemCount = userEntries + memoryEntries
    if (!hasLocal && userEntries === 0) return missing('runtime', path)
    const memoryProjection = !hasLocal || existsSync(join(path, RUNTIME_PROJECTION_FILES.memory))
    const userProjection = !hasGlobal || existsSync(join(userPath, RUNTIME_PROJECTION_FILES.user))
    const projectionsHealthy = memoryProjection && userProjection
    const issue = missingProjectionIssue(memoryProjection, userProjection)
    return {
      kind: 'runtime', path,
      status: itemCount === 0 ? 'empty' : projectionsHealthy ? 'ready' : 'invalid',
      bytes: safeBytes(path), itemCount,
      details: { userEntries, memoryEntries, projectionsHealthy, sharedUserProfile: true, source: RUNTIME_MEMORIES_FILE },
      ...(issue === undefined ? {} : { issue }),
    }
  } catch (error) {
    return { kind: 'runtime', path, status: 'invalid', bytes: safeBytes(path), itemCount: 0, details: {}, issue: error instanceof Error ? error.message : String(error) }
  }
}

function memorySpacesArea(root: string, targetRoot: string = root): StorageAreaInventory {
  const resolvedTarget = canonical(targetRoot)
  const sharedGlobal = resolvedTarget !== root
  const path = join(resolvedTarget, MEMORY_SPACES_DIRECTORY)
  if (!existsSync(path)) return { ...missing('memory-bodies', path), ...(sharedGlobal ? { details: { sharedGlobal: true } } : {}) }
  try {
    const registryPath = join(path, MEMORY_SPACE_REGISTRY_FILE)
    const registry = existsSync(registryPath) ? summarizeMemorySpaceRegistry(readJson(registryPath)) : undefined
    const registered = registry?.spaces ?? 0
    const databaseCount = readdirSync(path, { withFileTypes: true }).filter(entry => !entry.isSymbolicLink() && entry.isDirectory() && existsSync(join(path, entry.name, MEMORY_SPACE_DATABASE_FILE))).length
    const invalidRegistry = registry !== undefined && !registry.valid
    return {
      kind: 'memory-bodies', path,
      status: invalidRegistry ? 'invalid' : databaseCount === 0 && registered === 0 ? 'empty' : 'ready',
      bytes: safeBytes(path), itemCount: Math.max(registered, databaseCount),
      details: { registeredBodies: registered, activeBodies: registry?.active ?? 0, databases: databaseCount, registry: registry !== undefined, ...(sharedGlobal ? { sharedGlobal: true } : {}) },
      ...(invalidRegistry ? { issue: 'memory-space registry is invalid' } : {}),
    }
  } catch (error) {
    return { kind: 'memory-bodies', path, status: 'invalid', bytes: safeBytes(path), itemCount: 0, details: sharedGlobal ? { sharedGlobal: true } : {}, issue: error instanceof Error ? error.message : String(error) }
  }
}

function documentsArea(root: string, targetRoot: string = root): StorageAreaInventory {
  const resolvedTarget = canonical(targetRoot)
  const sharedGlobal = resolvedTarget !== root
  const path = join(resolvedTarget, DOCUMENTS_DIRECTORY)
  const indexPath = join(path, DOCUMENTS_INDEX_FILE)
  if (!existsSync(indexPath)) return { ...missing('documents', path), ...(sharedGlobal ? { details: { sharedGlobal: true } } : {}) }
  try {
    const index = summarizeDocumentIndex(readJson(indexPath))
    if (!index.valid) throw new Error('index.json is not a valid Documents index')
    return {
      kind: 'documents', path, status: index.documents === 0 ? 'empty' : 'ready',
      bytes: safeBytes(path), itemCount: index.documents,
      details: { activeDocuments: index.active, archivedDocuments: index.archived, index: DOCUMENTS_INDEX_FILE, ...(sharedGlobal ? { sharedGlobal: true } : {}) },
    }
  } catch (error) {
    return { kind: 'documents', path, status: 'invalid', bytes: safeBytes(path), itemCount: 0, details: sharedGlobal ? { sharedGlobal: true } : {}, issue: error instanceof Error ? error.message : String(error) }
  }
}

function stateArea(root: string): StorageAreaInventory {
  const path = join(root, 'state')
  if (!existsSync(path)) return missing('state', path)
  try {
    const entries = readdirSync(path, { withFileTypes: true }).filter(entry => !entry.isSymbolicLink())
    const files = entries.filter(entry => entry.isFile())
    const directories = entries.filter(entry => entry.isDirectory())
    const bytes = safeBytes(path)
    const providerRegistry = join(path, MEMORY_PROVIDER_REGISTRY_FILE)
    let providerConnections = 0
    let providerServices = 0
    if (existsSync(providerRegistry)) {
      try {
        const registry = summarizeMemoryProviderRegistry(readJson(providerRegistry))
        providerConnections = registry.connections
        providerServices = registry.services
      } catch {}
    }
    const occupied = files.length > 0 || directories.length > 0 || bytes > 0
    return {
      kind: 'state', path, status: occupied ? 'ready' : 'empty', bytes, itemCount: files.length > 0 ? files.length : directories.length,
      details: { reviewLedger: existsSync(join(path, 'review-ledger.json')), providerServices, providerConnections, files: files.length },
    }
  } catch (error) {
    return { kind: 'state', path, status: 'invalid', bytes: safeBytes(path), itemCount: 0, details: {}, issue: error instanceof Error ? error.message : String(error) }
  }
}

interface SplitRoots {
  userRoot?: string
  documentsRoot?: string
  memorySpacesRoot?: string
}

function inspect(kind: StorageScopeKind, rawRoot: string | undefined, activeRoot: string, split?: SplitRoots): StorageScopeInventory {
  if (rawRoot === undefined) return { kind, configured: false, active: false, available: false, totalBytes: 0, areas: [], issue: 'scope is not configured' }
  const root = canonical(rawRoot)
  const areas = [
    runtimeArea(root, split?.userRoot ?? root),
    memorySpacesArea(root, split?.memorySpacesRoot ?? root),
    documentsArea(root, split?.documentsRoot ?? root),
    stateArea(root),
  ]
  const exists = existsSync(root)
  const available = exists && (() => { try { return statSync(root).isDirectory() } catch { return false } })()
  return {
    kind, root, configured: true, active: root === activeRoot, available,
    totalBytes: areas.reduce((total, area) => total + (area.details.sharedGlobal === true ? 0 : area.bytes), 0), areas,
    ...(exists && !available ? { issue: 'storage root is not a directory' } : {}),
  }
}

export class StorageScopeInspector {
  constructor(
    private readonly runner: Pick<StorageRoot, 'effectiveDataDir'>,
    private readonly config: Pick<ResolvedConfig, 'dataDir' | 'storageScope'> & Partial<Pick<ResolvedConfig, 'runtimeUserScope' | 'documentsScope' | 'memorySpacesScope'>>,
  ) {}

  catalog(workspaceRoot?: string): StorageScopeCatalog {
    const activeRoot = canonical(this.runner.effectiveDataDir())
    const global = globalRoot()
    const workspace = workspaceRoot === undefined || workspaceRoot.trim() === '' ? undefined : join(canonical(workspaceRoot), '.mnemon')
    const configuredDataDir = this.config.dataDir === undefined ? undefined : canonical(this.config.dataDir)
    const activeKind: StorageScopeKind = this.config.storageScope
    const custom = configuredDataDir !== undefined && configuredDataDir !== global && configuredDataDir !== workspace ? configuredDataDir : undefined
    const workspaces = workspace === undefined ? undefined : createStorageRoot({ ...this.config, storageScope: 'workspaces' }, workspaceRoot).effectiveDataDir()
    const split: SplitRoots = {
      ...(this.config.runtimeUserScope === 'global' ? { userRoot: global } : {}),
      ...(this.config.documentsScope === 'global' ? { documentsRoot: global } : {}),
      ...(this.config.memorySpacesScope === 'global' ? { memorySpacesRoot: global } : {}),
    }
    return {
      activeKind,
      activeRoot,
      scopes: [
        inspect('global', activeKind === 'global' ? activeRoot : global, activeRoot),
        inspect('workspace', activeKind === 'workspace' ? activeRoot : workspace, activeRoot, activeKind === 'workspace' ? split : undefined),
        inspect('custom', activeKind === 'custom' ? activeRoot : custom, activeRoot, activeKind === 'custom' ? split : undefined),
        inspect('workspaces', activeKind === 'workspaces' ? activeRoot : workspaces, activeRoot, activeKind === 'workspaces' ? split : undefined),
      ].map(scope => ({ ...scope, active: scope.kind === activeKind })),
      generatedAt: new Date().toISOString(),
    }
  }
}
