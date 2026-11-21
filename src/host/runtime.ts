import { isDefaultSourceInstance, isWorkspaceStorageScope, type MnemonSyncAutoBackup } from './protocol.ts'
import { resolve } from 'node:path'
import type { HostAgent, HostAgentsService, HostWorkspace, HostWorkspaceRegistry } from './dsh.ts'
import { MnemonPackManager } from './pack.ts'
import { MnemonReviewLedger } from './review-ledger.ts'
import { MnemonGitSync } from './git-sync.ts'
import type { MnemonGitHubAuth } from './github-auth.ts'
import { StorageScopeInspector } from './storage-scope.ts'
import { createStorageRoot, mainStrategyTypeId, WorkspaceMemoryPolicy, type ResolvedConfig } from './config/index.ts'
import { canonicalWorkspacePath } from '../sdk/workspace-storage.ts'
import { SourceSession } from './source-session.ts'
import { MemoryRuntime } from '../core/runtime.ts'
import type { MemoryGenerationHost } from '../core/generation.ts'
import { ComposableMemoryTurnManager } from '../core/turns.ts'
import { MEMORY_CAPABILITIES, type MemoryOperationScope } from '../core/contracts/index.ts'
import { allowsParticipation } from './access.ts'
import type { CompileMemoryGenerationOptions } from '../core/composition.ts'
import { MemoryExecutions } from './memory-executions.ts'
import type { WorkspaceMemoryParticipation } from './protocol.ts'

export interface MnemonRuntimeGraph {
  readonly config: ResolvedConfig
  readonly allowLinkedSkillUpdates?: boolean
  readonly directory: string
  readonly workspaceRoot?: string
  readonly storage: StorageScopeInspector
  readonly packs: MnemonPackManager
  readonly sync: MnemonGitSync
  readonly reviews: MnemonReviewLedger
  readonly memoryComposition: MemoryGenerationHost
  readonly composableTurns: ComposableMemoryTurnManager
  source(typeId: string, scope?: MemoryOperationScope): SourceSession
  retire(): void
  dispose(): void
}

export interface MnemonAgentRuntimeSource {
  readonly config: ResolvedConfig
  readonly executions: MemoryExecutions
  forAgent(agent: HostAgent, options?: { independent?: boolean }): MnemonRuntimeGraph
  memoryParticipation?(agent: HostAgent): WorkspaceMemoryParticipation
  bindAgentRuntime(agentId: string, graph: MnemonRuntimeGraph): () => void
  onChanged?(listener: () => void): () => void
}

export function agentScope(agent: HostAgent, config: ResolvedConfig): MemoryOperationScope {
  const workspaceId = agent.session.header?.cwd?.trim()
  return { storage: config.storageScope, ...(workspaceId ? { workspaceId: resolve(workspaceId) } : {}), sessionId: agent.id, agentId: agent.id }
}

export function memoryGenerationOptions(
  config: ResolvedConfig,
  workspaceRoot: string | undefined,
  allowLinkedSkillUpdates = config.skills?.allowLinkedUpdates ?? false,
): CompileMemoryGenerationOptions {
  const directory = createStorageRoot(config, workspaceRoot).effectiveDataDir()
  const globalDirectory = createStorageRoot({ storageScope: 'global' }).effectiveDataDir()
  const userDirectory = config.runtimeUserScope === 'global' ? globalDirectory : directory
  const documentsDirectory = config.documentsScope === 'global' ? globalDirectory : directory
  const memorySpacesDirectory = config.memorySpacesScope === 'global' ? globalDirectory : directory
  return {
    strategyTypeId: mainStrategyTypeId(config),
    strategyFallback: 'sole-strategy',
    sourceTimeoutMs: config.timeoutMs,
    sourceCapabilities: installed => MEMORY_CAPABILITIES.filter(capability =>
      (config.writeEnabled || !['write', 'archive', 'link', 'forget', 'maintain', 'import'].includes(capability))
      && allowsParticipation(config, installed.definition.manifest.typeId, capability, 'automatic')),
    sourceConfiguration: (installed, strategyTypeId) => {
      const type = installed.definition.manifest.typeId
      if (!isDefaultSourceInstance(installed.instanceKey, type)) return {}
      const layered = strategyTypeId === 'default-three-tier' && config.lifecycleEnabled
      const bm25 = layered && config.runtimeMemory.bm25Recall
        && (type === 'runtime' || type === 'documents')
        && allowsParticipation(config, type, 'project', 'automatic') && allowsParticipation(config, type, 'search', 'automatic')
        ? { bm25Recall: true } : {}
      const indexPush = layered && config.runtimeMemory.indexPush
        && allowsParticipation(config, type, 'project', 'automatic')
        && ((type === 'documents' && allowsParticipation(config, 'documents', 'search', 'automatic'))
          || (type === 'memory-spaces' && allowsParticipation(config, 'memory-spaces', 'recall', 'automatic')))
        ? { bm25IndexPush: true } : {}
      if (type === 'runtime') return { dataDir: directory, userDataDir: userDirectory, memoryLimitBytes: config.runtimeMemory.memoryLimitBytes, userLimitBytes: config.runtimeMemory.userLimitBytes, deferLowPriority: config.runtimeMemory.deferLowPriority, ...bm25 }
      if (type === 'documents') return {
        dataDir: documentsDirectory,
        ...bm25,
        ...indexPush,
        ...(config.documents?.limitBytes === undefined ? {} : { limitBytes: config.documents.limitBytes }),
        ...(config.documents === undefined ? {} : { documents: config.documents }),
      }
      if (type === 'skills') return {
        dataDir: directory,
        allowLinkedUpdates: allowLinkedSkillUpdates,
        ...(config.skills?.skillRoots === undefined ? {} : { skillRoots: config.skills.skillRoots }),
        ...(config.skills?.dshHome === undefined ? {} : { dshHome: config.skills.dshHome }),
        ...(config.skills?.agentsHome === undefined ? {} : { agentsHome: config.skills.agentsHome }),
      }
      if (type === 'memory-spaces') return JSON.parse(JSON.stringify({
        dataDir: memorySpacesDirectory, cliPath: config.cliPath, store: config.store, timeoutMs: config.timeoutMs,
        defaultRecallLimit: config.defaultRecallLimit, writeEnabled: config.writeEnabled, ...indexPush,
        embedding: config.embedding, recallQuality: config.recallQuality, persistenceStrategy: config.persistenceStrategy,
      }))
      return {}
    },
  }
}

export function createRuntimeGraph(
  config: ResolvedConfig,
  workspaceRoot: string | undefined,
  extensions: MemoryRuntime,
  allowLinkedSkillUpdates = config.skills?.allowLinkedUpdates ?? false,
): MnemonRuntimeGraph {
  const root = createStorageRoot(config, workspaceRoot)
  const directory = root.effectiveDataDir()
  const attachment = extensions.attachGeneration(memoryGenerationOptions(config, workspaceRoot, allowLinkedSkillUpdates))
  const evaluation = attachment.host.inspect().evaluation
  if (evaluation.state === 'rejected') {
    void attachment.dispose()
    throw new Error(evaluation.diagnostics.map(value => value.message).join('; '))
  }
  const composableTurns = new ComposableMemoryTurnManager(attachment.host)
  const packs = new MnemonPackManager(root, config, () => {}, () => new Date())
  let disposed = false
  return {
    config, allowLinkedSkillUpdates, directory, ...(workspaceRoot === undefined ? {} : { workspaceRoot }), storage: new StorageScopeInspector(root, config), packs, sync: new MnemonGitSync(root, config, packs),
    reviews: new MnemonReviewLedger(root),
    memoryComposition: attachment.host, composableTurns,
    source: (type, scope = { storage: config.storageScope, ...(workspaceRoot === undefined ? {} : { workspaceId: workspaceRoot }) }) => new SourceSession(attachment.host, composableTurns, type, scope),
    retire: () => attachment.release(),
    dispose: () => {
      if (disposed) return
      disposed = true
      composableTurns.dispose()
      void attachment.dispose()
    },
  }
}

export const PROVIDER_REDISCOVERY_TIMING = { delayMs: 10_000, retryDelayMs: 30_000, attempts: 3 }

const rediscoveredDirectories = new Set<string>()

function finalRediscoveryAnswer(error: unknown): boolean {
  return /unsupported Memory Spaces management mutation operation|is not installed/u.test(error instanceof Error ? error.message : String(error))
}

function liveProxy<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_placeholder, property) {
      const target = resolve()
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
    has(_placeholder, property) {
      return property in resolve()
    },
    ownKeys() {
      return Reflect.ownKeys(resolve())
    },
    getOwnPropertyDescriptor(_placeholder, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), property)
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true }
    },
  })
}

export class LiveMnemonRuntime implements MnemonAgentRuntimeSource {
  readonly executions = new MemoryExecutions(this)
  private current: MnemonRuntimeGraph
  private readonly workspaceGraphs = new Map<string, MnemonRuntimeGraph>()
  private readonly agentGraphs = new Map<string, { token: symbol; graph: MnemonRuntimeGraph }>()
  private readonly retiredGraphs = new Set<MnemonRuntimeGraph>()
  private readonly rediscoveries = new Map<MnemonRuntimeGraph, () => void>()
  private githubAuth: MnemonGitHubAuth | undefined
  private autoBackupView: (() => MnemonSyncAutoBackup | undefined) | undefined
  private closed = false
  private readonly changeListeners = new Set<() => void>()
  private readonly workspacePolicy: WorkspaceMemoryPolicy

  readonly config: ResolvedConfig
  readonly storage: StorageScopeInspector
  readonly packs: MnemonPackManager
  readonly sync: MnemonGitSync
  readonly reviews: MnemonReviewLedger

  constructor(initial: MnemonRuntimeGraph, private readonly workspaceRegistry: HostWorkspaceRegistry | undefined, private readonly agents: Pick<HostAgentsService, 'get'> | undefined, private readonly extensions: MemoryRuntime) {
    this.current = initial
    this.config = liveProxy(() => this.current.config)
    this.workspacePolicy = new WorkspaceMemoryPolicy(() => this.config.excludedWorkspaces, agents, workspaceRegistry)
    this.storage = liveProxy(() => this.current.storage)
    this.packs = liveProxy(() => this.current.packs)
    this.sync = liveProxy(() => this.current.sync)
    this.reviews = liveProxy(() => this.current.reviews)
    this.rediscoverProviders(initial)
  }

  useGitHubAuth(auth: MnemonGitHubAuth | undefined): void {
    this.githubAuth = auth
    this.applyGitHubAuth(this.current)
  }

  private applyGitHubAuth(graph: MnemonRuntimeGraph): void {
    if (this.githubAuth !== undefined) graph.sync.useGitHubAuth(this.githubAuth)
  }

  useAutoBackup(view: (() => MnemonSyncAutoBackup | undefined) | undefined): void {
    this.autoBackupView = view
    if (view !== undefined) this.current.sync.useAutoBackup(view)
  }

  private applyAutoBackup(graph: MnemonRuntimeGraph): void {
    if (this.autoBackupView !== undefined) graph.sync.useAutoBackup(this.autoBackupView)
  }

  onChanged(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  swap(next: MnemonRuntimeGraph): void {
    if (this.closed) {
      next.dispose()
      throw new Error('Mnemon runtime is disposed')
    }
    const previous = this.current
    this.current = next
    this.applyGitHubAuth(next)
    this.applyAutoBackup(next)
    this.rediscoverProviders(next)
    this.retireGraph(previous)
    for (const graph of this.workspaceGraphs.values()) this.retireGraph(graph)
    this.workspaceGraphs.clear()
    for (const listener of [...this.changeListeners]) {
      try { listener() }
      catch (error) { console.warn('dsh-mnemon: runtime change listener failed', error) }
    }
  }

  snapshot(): MnemonRuntimeGraph {
    this.assertOpen()
    return this.current
  }

  bindAgentRuntime(agentId: string, graph: MnemonRuntimeGraph): () => void {
    this.assertOpen()
    const id = agentId.trim()
    if (id === '') throw new Error('Mnemon runtime binding requires an Agent id')
    if (this.agentGraphs.has(id)) throw new Error(`Mnemon runtime is already pinned for Agent ${id}`)
    const token = Symbol(id)
    this.agentGraphs.set(id, { token, graph })
    return () => {
      if (this.agentGraphs.get(id)?.token !== token) return
      this.agentGraphs.delete(id)
      this.collectRetired(graph)
    }
  }

  dispose(): void {
    if (this.closed) return
    this.executions.dispose()
    this.changeListeners.clear()
    this.closed = true
    const graphs = new Set<MnemonRuntimeGraph>([
      this.current,
      ...this.workspaceGraphs.values(),
      ...[...this.agentGraphs.values()].map(binding => binding.graph),
      ...this.retiredGraphs,
    ])
    this.agentGraphs.clear()
    this.workspaceGraphs.clear()
    this.retiredGraphs.clear()
    for (const stop of this.rediscoveries.values()) stop()
    this.rediscoveries.clear()
    for (const graph of graphs) graph.dispose()
  }

  memoryParticipation(agent: HostAgent): WorkspaceMemoryParticipation { return this.workspacePolicy.forAgent(agent) }
  workspaceParticipation(path?: string): WorkspaceMemoryParticipation { return this.workspacePolicy.forWorkspace(path) }
  workspaceParticipations() { return (this.workspaceRegistry?.list() ?? []).map(workspace => ({ id: workspace.id, participation: this.workspaceParticipation(workspace.path) })) }

  forAgent(agent: HostAgent, options: { independent?: boolean } = {}): MnemonRuntimeGraph {
    this.assertOpen()
    if (!options.independent) {
      const pinned = this.agentGraphs.get(agent.id)
      if (pinned !== undefined) return pinned.graph
      const parentSession = agent.session.header?.origin === 'subagent' ? agent.session.header.parentSession?.trim() : undefined
      const inherited = parentSession === undefined || parentSession === '' ? undefined : this.agentGraphs.get(parentSession)
      if (inherited !== undefined) return inherited.graph
    }
    if (!isWorkspaceStorageScope(this.current.config.storageScope)) return this.current
    const cwd = agent.session.header?.cwd?.trim()
    if (cwd === undefined || cwd === '') throw new Error('the current DSH session has no workspace for Mnemon')
    return this.forWorkspacePath(cwd)
  }

  forWorkspaceId(workspaceId: string): MnemonRuntimeGraph {
    this.assertOpen()
    const workspace = this.requireWorkspace(workspaceId)
    return isWorkspaceStorageScope(this.current.config.storageScope) ? this.forWorkspacePath(workspace.path) : this.current
  }

  route(request: { workspaceId?: string; sessionId?: string }): {
    graph: MnemonRuntimeGraph
    selectedWorkspace?: HostWorkspace
    effectiveWorkspace?: HostWorkspace
    selectedRoot: string
    effectiveRoot: string
    aligned: boolean
    liveSession: boolean
    participation: WorkspaceMemoryParticipation
  } {
    this.assertOpen()
    const effectiveAgent = this.agent(request.sessionId)
    const effectiveWorkspace = effectiveAgent === undefined
      ? this.workspaceForSession(request.sessionId)
      : this.workspaceForPath(effectiveAgent.session.header?.cwd)
    const selectedWorkspace = request.workspaceId === undefined || request.workspaceId.trim() === ''
      ? effectiveWorkspace
      : this.requireWorkspace(request.workspaceId)
    const effectiveGraph = effectiveAgent !== undefined ? this.forAgent(effectiveAgent)
      : effectiveWorkspace !== undefined && isWorkspaceStorageScope(this.current.config.storageScope) ? this.forWorkspacePath(effectiveWorkspace.path) : this.current
    const graph = selectedWorkspace === undefined
      ? effectiveGraph
      : isWorkspaceStorageScope(this.current.config.storageScope) ? this.forWorkspacePath(selectedWorkspace.path) : this.current
    const selectedRoot = resolve(graph.directory)
    const effectiveRoot = resolve(effectiveGraph.directory)
    return {
      graph,
      ...(selectedWorkspace === undefined ? {} : { selectedWorkspace }),
      ...(effectiveWorkspace === undefined ? {} : { effectiveWorkspace }),
      selectedRoot,
      effectiveRoot,
      aligned: selectedRoot === effectiveRoot,
      liveSession: effectiveAgent !== undefined,
      participation: effectiveAgent !== undefined && selectedWorkspace?.path === effectiveWorkspace?.path
        ? this.memoryParticipation(effectiveAgent) : this.workspaceParticipation(selectedWorkspace?.path),
    }
  }

  private forWorkspacePath(workspaceRoot: string): MnemonRuntimeGraph {
    const key = this.current.config.storageScope === 'workspaces' ? canonicalWorkspacePath(resolve(workspaceRoot)) : resolve(workspaceRoot)
    let graph = this.workspaceGraphs.get(key)
    if (graph === undefined) {
      graph = createRuntimeGraph(this.current.config, key, this.extensions, this.current.allowLinkedSkillUpdates)
      this.applyGitHubAuth(graph)
      this.applyAutoBackup(graph)
      this.rediscoverProviders(graph)
      this.workspaceGraphs.set(key, graph)
    }
    return graph
  }

  private rediscoverProviders(graph: MnemonRuntimeGraph): void {
    if (this.workspaceParticipation(graph.workspaceRoot).excluded) return
    if (!graph.config.writeEnabled || !allowsParticipation(graph.config, 'memory-spaces', 'maintain', 'automatic')) return
    const directory = resolve(graph.config.memorySpacesScope === 'global'
      ? createStorageRoot({ storageScope: 'global' }).effectiveDataDir()
      : graph.directory)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    const release = () => { if (this.rediscoveries.get(graph) === stop) this.rediscoveries.delete(graph) }
    const schedule = (attempt: number, delayMs: number) => {
      timer = setTimeout(() => void ask(attempt), delayMs)
      timer.unref?.()
    }
    const ask = async (attempt: number) => {
      timer = undefined
      if (rediscoveredDirectories.has(directory)) return release()
      rediscoveredDirectories.add(directory)
      running = true
      let again = false
      try {
        await graph.source('memory-spaces').mutate('provider-rediscover', { trigger: 'startup' }, controller.signal)
      } catch (error) {
        again = !finalRediscoveryAnswer(error)
      } finally {
        running = false
      }
      if (controller.signal.aborted) return
      if (again) {
        rediscoveredDirectories.delete(directory)
        if (attempt < PROVIDER_REDISCOVERY_TIMING.attempts) return schedule(attempt + 1, PROVIDER_REDISCOVERY_TIMING.retryDelayMs)
      }
      release()
    }
    const stop = () => {
      if (timer !== undefined) clearTimeout(timer)
      if (running) rediscoveredDirectories.delete(directory)
      controller.abort(new Error('the Mnemon runtime was replaced'))
    }
    this.rediscoveries.get(graph)?.()
    this.rediscoveries.set(graph, stop)
    schedule(1, PROVIDER_REDISCOVERY_TIMING.delayMs)
  }

  private retireGraph(graph: MnemonRuntimeGraph): void {
    this.rediscoveries.get(graph)?.()
    this.rediscoveries.delete(graph)
    graph.retire()
    if ([...this.agentGraphs.values()].some(binding => binding.graph === graph)) this.retiredGraphs.add(graph)
    else graph.dispose()
  }

  private collectRetired(graph: MnemonRuntimeGraph): void {
    if (!this.retiredGraphs.has(graph)) return
    if ([...this.agentGraphs.values()].some(binding => binding.graph === graph)) return
    this.retiredGraphs.delete(graph)
    graph.dispose()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Mnemon runtime is disposed')
  }

  private agent(sessionId?: string): HostAgent | undefined {
    const normalized = sessionId?.trim()
    return normalized === undefined || normalized === '' ? undefined : this.agents?.get(normalized)
  }

  private requireWorkspace(workspaceId: string): HostWorkspace {
    const normalized = workspaceId.trim()
    const workspace = normalized === '' ? undefined : this.workspaceRegistry?.get(normalized)
    if (workspace === undefined) throw new Error('selected DSH workspace is unavailable')
    return workspace
  }

  private workspaceForSession(sessionId?: string): HostWorkspace | undefined {
    const normalized = sessionId?.trim()
    if (normalized === undefined || normalized === '') return undefined
    return this.workspaceRegistry?.list().find(workspace => workspace.sessionIds?.includes(normalized) === true)
  }

  private workspaceForPath(path?: string): HostWorkspace | undefined {
    const normalized = path?.trim()
    if (normalized === undefined || normalized === '') return undefined
    const canonical = resolve(normalized)
    return this.workspaceRegistry?.list().find(workspace => resolve(workspace.path) === canonical)
  }
}
