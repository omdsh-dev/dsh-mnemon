import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withMemoryStorageLock } from '../../sdk/storage-lock.ts'
import { canonicalWorkspacePath, workspaceStorageId } from '../../sdk/workspace-storage.ts'
import type { HostAgent, HostAgentsService, HostContextShape, HostWorkspaceRegistry } from '../dsh.ts'
import type { ResolvedConfig, WorkspaceMemoryParticipation } from '../protocol.ts'
import type { MnemonAgentRuntimeSource } from '../runtime.ts'

export interface StorageRoot {
  effectiveDataDir(): string
  withExclusive<T>(operation: () => T | Promise<T>): Promise<T>
}

export function isUserHomePath(value: string): boolean {
  return value === '~' || /^~[/\\]/u.test(value)
}

export function expandUserPath(value: string, home = homedir()): string {
  if (value === '~') return home
  if (/^~[/\\]/u.test(value)) return join(home, value.slice(2))
  return value
}

export function resolveGlobalDataDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.MNEMON_DATA_DIR?.trim()
  return resolve(expandUserPath(configured || '~/.mnemon', home))
}

function expandDirectory(value: string): string {
  return resolve(expandUserPath(value))
}

function storageDirectory(config: Pick<ResolvedConfig, 'storageScope' | 'dataDir'>, workspaceRoot?: string): string {
  const globalRoot = resolveGlobalDataDir()
  switch (config.storageScope) {
    case 'global': return globalRoot
    case 'custom': return expandDirectory(config.dataDir!)
    case 'workspace': return resolve(workspaceRoot ?? process.cwd(), '.mnemon')
    case 'workspaces': return join(config.dataDir === undefined ? globalRoot : expandDirectory(config.dataDir), 'workspaces', workspaceStorageId(resolve(workspaceRoot ?? process.cwd())))
  }
}

export function createStorageRoot(config: Pick<ResolvedConfig, 'storageScope' | 'dataDir'>, workspaceRoot?: string): StorageRoot {
  const directory = storageDirectory(config, workspaceRoot)
  return {
    effectiveDataDir: () => directory,
    withExclusive: operation => withMemoryStorageLock(directory, operation),
  }
}

export const WORKSPACE_MEMORY_EXCLUDED = 'Memory is disabled for this workspace by excludedWorkspaces. Remove the workspace from that setting to resume memory participation; existing data is retained.'

function existingWorkspace(path: string | undefined): string | undefined {
  if (path === undefined || path.trim() === '') return undefined
  const expanded = expandUserPath(path.trim())
  try {
    const canonical = canonicalWorkspacePath(expanded)
    return statSync(canonical).isDirectory() ? canonical : undefined
  } catch { return undefined }
}

export class WorkspaceMemoryPolicy {
  private readonly parentWorkspaces = new WeakMap<HostAgent, string>()
  constructor(
    private readonly entries: () => readonly string[],
    private readonly agents?: Pick<HostAgentsService, 'get'>,
    private readonly workspaces?: HostWorkspaceRegistry,
  ) {}

  forWorkspace(path?: string): WorkspaceMemoryParticipation {
    const entries = this.entries()
    if (entries.length === 0) return { excluded: false }
    const invalidEntries: number[] = []
    const roots = new Set(entries.flatMap((entry, index) => {
      const root = existingWorkspace(entry)
      if (root === undefined) { invalidEntries.push(index); return [] }
      return [root]
    }))
    const workspace = existingWorkspace(path)
    return {
      excluded: workspace !== undefined && roots.has(workspace),
      ...(workspace === undefined ? { reason: 'workspace-unavailable' as const } : {}),
      ...(invalidEntries.length === 0 ? {} : { invalidEntries }),
    }
  }

  forAgent(agent: HostAgent): WorkspaceMemoryParticipation {
    let owner = agent
    let workspace: string | undefined
    const seen = new Set<HostAgent>()
    while (!seen.has(owner)) {
      seen.add(owner)
      const id = owner.session.header?.origin === 'subagent' ? owner.session.header.parentSession?.trim() : undefined
      if (!id) { workspace = owner.session.header?.cwd; break }
      const parent = this.agents?.get(id)
      if (parent === undefined) {
        workspace = this.parentWorkspaces.get(owner) ?? this.workspaces?.list().find(item => item.sessionIds?.includes(id))?.path
        break
      }
      owner = parent
    }
    if (agent.session.header?.origin === 'subagent' && workspace !== undefined) this.parentWorkspaces.set(agent, workspace)
    return this.forWorkspace(workspace)
  }
}

export function assertAgentMemoryIncluded(runtime: Pick<MnemonAgentRuntimeSource, 'memoryParticipation'>, agent: HostAgent): void {
  if (runtime.memoryParticipation?.(agent).excluded) throw new Error(WORKSPACE_MEMORY_EXCLUDED)
}

interface LoaderLike {
  config?: { baseUrl?: string }
  ctx?: { baseUrl?: string }
  context?: { baseUrl?: string }
}

export function resolveLoaderAnchor(ctx: Pick<HostContextShape, 'get'>): string | undefined {
  const loader = ctx.get('loader') as LoaderLike | undefined
  const anchor = loader?.config?.baseUrl ?? loader?.ctx?.baseUrl ?? loader?.context?.baseUrl
  return typeof anchor === 'string' && anchor.trim() !== '' ? anchor : undefined
}

export function resolveProfileBaseDir(ctx: HostContextShape, options: { fallbackToCwd?: boolean } = {}): string | undefined {
  const editor = ctx.get('configEditor') as { documentPath?: unknown } | undefined
  if (typeof editor?.documentPath === 'string' && editor.documentPath.trim() !== '') {
    return resolve(dirname(editor.documentPath))
  }
  const profile = ctx.get('profileContext') as { dir?: unknown } | undefined
  if (typeof profile?.dir === 'string' && profile.dir.trim() !== '') {
    return resolve(profile.dir)
  }
  const anchor = resolveLoaderAnchor(ctx)
  if (anchor !== undefined) {
    try {
      const anchorPath = anchor.startsWith('file:') ? fileURLToPath(anchor) : resolve(anchor)
      try {
        return statSync(anchorPath).isDirectory() ? anchorPath : dirname(anchorPath)
      } catch {
        return /\.[a-z0-9]+$/iu.test(anchorPath) ? dirname(anchorPath) : anchorPath
      }
    } catch {
    }
  }
  const baseDir = (ctx as unknown as { baseDir?: unknown }).baseDir
  if (typeof baseDir === 'string' && baseDir.trim() !== '') {
    return resolve(baseDir)
  }
  return options.fallbackToCwd ? process.cwd() : undefined
}
