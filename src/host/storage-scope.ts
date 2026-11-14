import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DOCUMENTS_DIRECTORY, DOCUMENTS_INDEX_FILE, summarizeDocumentIndex } from 'dsh-mnemon-source-documents/contracts'
import {
  MEMORY_PROVIDER_REGISTRY_FILE, MEMORY_SPACE_DATABASE_FILE, MEMORY_SPACE_REGISTRY_FILE, MEMORY_SPACES_DIRECTORY,
  summarizeMemoryProviderRegistry, summarizeMemorySpaceRegistry,
} from 'dsh-mnemon-source-memory-spaces/contracts'
import { RUNTIME_DIRECTORY, RUNTIME_MEMORIES_FILE, RUNTIME_PROJECTION_FILES, summarizeRuntimeMemories } from 'dsh-mnemon-source-runtime/contracts'
import { createStorageRoot, expandUserPath, resolveGlobalDataDir, type ResolvedConfig, type StorageRoot } from './config/index.ts'
import type { StorageAreaInventory, StorageAreaKind, StorageAreaStatus, StorageScopeCatalog, StorageScopeInventory, StorageScopeKind } from './protocol.ts'

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

// Each area is read through its Source's own names and counting rules, so an inventory follows
// the Source when its files change instead of reporting a store it no longer understands. The
// Source says whether a file can be counted; the messages the Status page shows stay here.
function runtimeArea(root: string): StorageAreaInventory {
  const path = join(root, RUNTIME_DIRECTORY)
  const source = join(path, RUNTIME_MEMORIES_FILE)
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

function memorySpacesArea(root: string): StorageAreaInventory {
  const path = join(root, MEMORY_SPACES_DIRECTORY)
  if (!existsSync(path)) return missing('memory-bodies', path)
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
      details: { registeredBodies: registered, activeBodies: registry?.active ?? 0, databases: databaseCount, registry: registry !== undefined },
      ...(invalidRegistry ? { issue: 'memory-space registry is invalid' } : {}),
    }
  } catch (error) {
    return { kind: 'memory-bodies', path, status: 'invalid', bytes: safeBytes(path), itemCount: 0, details: {}, issue: error instanceof Error ? error.message : String(error) }
  }
}

function documentsArea(root: string): StorageAreaInventory {
  const path = join(root, DOCUMENTS_DIRECTORY)
  const indexPath = join(path, DOCUMENTS_INDEX_FILE)
  if (!existsSync(indexPath)) return missing('documents', path)
  try {
    const index = summarizeDocumentIndex(readJson(indexPath))
    if (!index.valid) throw new Error('index.json is not a valid Documents index')
    return {
      kind: 'documents', path, status: index.documents === 0 ? 'empty' : 'ready',
      bytes: safeBytes(path), itemCount: index.documents,
      details: { activeDocuments: index.active, archivedDocuments: index.archived, index: DOCUMENTS_INDEX_FILE },
    }
  } catch (error) {
    return { kind: 'documents', path, status: 'invalid', bytes: safeBytes(path), itemCount: 0, details: {}, issue: error instanceof Error ? error.message : String(error) }
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

function inspect(kind: StorageScopeKind, rawRoot: string | undefined, activeRoot: string): StorageScopeInventory {
  if (rawRoot === undefined) return { kind, configured: false, active: false, available: false, totalBytes: 0, areas: [], issue: 'scope is not configured' }
  const root = canonical(rawRoot)
  const areas = [runtimeArea(root), memorySpacesArea(root), documentsArea(root), stateArea(root)]
  const exists = existsSync(root)
  const available = exists && (() => { try { return statSync(root).isDirectory() } catch { return false } })()
  return {
    kind, root, configured: true, active: root === activeRoot, available,
    totalBytes: areas.reduce((total, area) => total + area.bytes, 0), areas,
    ...(exists && !available ? { issue: 'storage root is not a directory' } : {}),
  }
}

/** Read-only storage catalog. It never creates, moves, or repairs files. */
export class StorageScopeInspector {
  constructor(private readonly runner: Pick<StorageRoot, 'effectiveDataDir'>, private readonly config: Pick<ResolvedConfig, 'dataDir' | 'storageScope'>) {}

  catalog(workspaceRoot?: string): StorageScopeCatalog {
    const activeRoot = canonical(this.runner.effectiveDataDir())
    const global = globalRoot()
    const workspace = workspaceRoot === undefined || workspaceRoot.trim() === '' ? undefined : join(canonical(workspaceRoot), '.mnemon')
    const configuredDataDir = this.config.dataDir === undefined ? undefined : canonical(this.config.dataDir)
    const activeKind: StorageScopeKind = this.config.storageScope
    const custom = configuredDataDir !== undefined && configuredDataDir !== global && configuredDataDir !== workspace ? configuredDataDir : undefined
    const workspaces = workspace === undefined ? undefined : createStorageRoot({ ...this.config, storageScope: 'workspaces' }, workspaceRoot).effectiveDataDir()
    return {
      activeKind,
      activeRoot,
      scopes: [
        inspect('global', activeKind === 'global' ? activeRoot : global, activeRoot),
        inspect('workspace', activeKind === 'workspace' ? activeRoot : workspace, activeRoot),
        inspect('custom', activeKind === 'custom' ? activeRoot : custom, activeRoot),
        inspect('workspaces', activeKind === 'workspaces' ? activeRoot : workspaces, activeRoot),
      ].map(scope => ({ ...scope, active: scope.kind === activeKind })),
      generatedAt: new Date().toISOString(),
    }
  }
}
