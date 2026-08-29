import type { ResolvedConfig } from './config.ts'
import { resolve } from 'node:path'
import type { HostAgent, HostAgentsService, HostWorkspace, HostWorkspaceRegistry } from './contracts.ts'
import { DocumentManager } from './documents.ts'
import { MnemonPackManager } from './pack.ts'
import { createRunner, type MnemonRunner } from './runner.ts'
import { RuntimeMemoryController } from './runtime-memory.ts'
import { MnemonService } from './service.ts'
import { StorageScopeInspector } from './storage-scope.ts'
import { MemoryCatalog } from './memory-system/catalog.ts'
import { MemoryKernel } from './memory-system/kernel.ts'
import { registerDefaultMemorySystem } from './memory-system/defaults.ts'
import { MemoryTopologyManager } from './memory-system/topology.ts'
import { registerBuiltinMemoryAdapters } from './providers/memory-system.ts'
import { MemoryRuntime, type MemoryBoot, type MemoryGenerationAttachment } from '../packages/extension-sdk/src/index.ts'
import type { MemoryGenerationHost, MemoryTurnViewManager } from '../packages/kernel/src/index.ts'
import { createDefaultMemoryTurnViewManager } from './memory-view.ts'
import { MemoryReceiptBridge, type AuthorityCommitRecorder } from './memory-receipts.ts'
import { BUILTIN_MEMORY_BINDINGS } from './composable/bindings.ts'

export interface MnemonRuntimeGraph {
  config: ResolvedConfig
  runner: MnemonRunner
  service: MnemonService
  runtimeMemory: RuntimeMemoryController
  documents: DocumentManager
  storage: StorageScopeInspector
  packs: MnemonPackManager
  memoryCatalog: MemoryCatalog
  memoryTopology: MemoryTopologyManager
  memoryKernel: MemoryKernel
  memoryViews: MemoryTurnViewManager
  /** New Composable View runtime; absent only for a legacy MemoryBoot caller. */
  memoryComposition?: MemoryGenerationHost
  /** Detach from future definition changes without invalidating pinned turns. */
  retire(): void
  /** Detach this generation from future Host-global extension changes. */
  dispose(): void
}

export interface MnemonAgentRuntimeSource {
  readonly config: ResolvedConfig
  forAgent(agent: HostAgent): MnemonRuntimeGraph
  /** Retain one runtime generation for an Agent turn or delegated child lifetime. */
  bindAgentRuntime(agentId: string, graph: MnemonRuntimeGraph): () => void
}

/**
 * Build a complete generation before it can become visible. Constructors also
 * validate and initialize the selected storage root, so a failed candidate is
 * rejected by DSH settings validation without disturbing the active graph.
 */
export function createRuntimeGraph(config: ResolvedConfig, workspaceRoot?: string, extensions?: MemoryBoot): MnemonRuntimeGraph {
  const memoryCatalog = new MemoryCatalog()
  registerDefaultMemorySystem(memoryCatalog)
  registerBuiltinMemoryAdapters(memoryCatalog)
  const extensionAttachment = extensions?.attach(memoryCatalog)
  try {
    const configuredLayers = Object.entries(config.memoryTopology.layers).map(([id, layer]) => ({ id, ...layer }))
    const configuredIds = new Set(configuredLayers.map(layer => layer.id))
    const discoveredLayers = memoryCatalog.snapshot().layers
      .filter(layer => !configuredIds.has(layer.id))
      .map(layer => ({
        id: layer.id,
        enabled: false,
        participation: { recall: 'manual' as const, write: 'manual' as const, projection: 'manual' as const, maintenance: 'manual' as const },
        adapterIds: [],
      }))
    const memoryTopology = new MemoryTopologyManager(memoryCatalog, {
      id: config.memoryTopology.id,
      strategyId: config.memoryTopology.strategyId,
      layers: [...configuredLayers, ...discoveredLayers],
    })
    const memoryKernel = new MemoryKernel(memoryCatalog, memoryTopology)
    extensionAttachment?.bindKernel(memoryKernel)
    const runner = createRunner(config, undefined, workspaceRoot)
    let receiptBridge: MemoryReceiptBridge | undefined
    const recordCommit: AuthorityCommitRecorder = operation => {
      if (receiptBridge === undefined) throw new Error('memory receipt bridge is unavailable during runtime construction')
      return receiptBridge.record(operation)
    }
    const service = new MnemonService(runner, config, undefined, undefined, undefined, recordCommit)
    const globalUserConfig: ResolvedConfig = { ...config, storageScope: 'global' }
    delete globalUserConfig.dataDir
    const globalUserRunner = config.runtimeUserScope === 'global' ? createRunner(globalUserConfig) : undefined
    const runtimeMemory = new RuntimeMemoryController(runner, undefined, recordCommit, {
      memory: config.runtimeMemory.memoryLimitBytes,
      user: config.runtimeMemory.userLimitBytes,
    }, globalUserRunner)
    const documents = new DocumentManager(undefined, undefined, () => runner.effectiveDataDir(), recordCommit)
    const storage = new StorageScopeInspector(runner, config)
    const packs = new MnemonPackManager(runner, config, components => {
      if (components.includes('memory-spaces')) service.memoryBodies.reload()
      for (const component of components) {
        recordCommit({
          layerId: component,
          capability: 'import',
          operation: 'memory-pack-import',
          checkpoint: { component },
        })
      }
    })
    const memoryViews = createDefaultMemoryTurnViewManager(memoryKernel, { runtimeMemory, documents, service })
    extensionAttachment?.bindTurnViews(memoryViews)
    memoryViews.assertSourcesReady()
    receiptBridge = new MemoryReceiptBridge(memoryKernel, memoryViews)
    const detachReceiptSink = memoryKernel.registerReceiptSink(receiptBridge)
    const generationAttachment: MemoryGenerationAttachment | undefined = extensions instanceof MemoryRuntime
      ? extensions.attachGeneration({ bindings: new Map<string, unknown>([
        [BUILTIN_MEMORY_BINDINGS.runtime, runtimeMemory],
        [BUILTIN_MEMORY_BINDINGS.documents, documents],
        [BUILTIN_MEMORY_BINDINGS.memorySpaces, service],
      ]) })
      : undefined
    let retired = false
    let disposed = false
    return {
      config, runner, service, runtimeMemory, documents, storage, packs, memoryCatalog, memoryTopology, memoryKernel, memoryViews,
      ...(generationAttachment === undefined ? {} : { memoryComposition: generationAttachment.host }),
      retire: () => {
        if (retired || disposed) return
        retired = true
        generationAttachment?.release()
        extensionAttachment?.release()
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        generationAttachment?.release()
        void generationAttachment?.dispose()
        detachReceiptSink()
        memoryTopology.dispose()
        if (!retired) extensionAttachment?.dispose()
      },
    }
  } catch (error) {
    extensionAttachment?.dispose()
    throw error
  }
}

/** Resolve every property access against one generation, binding methods to it. */
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

/**
 * Stable faces handed to DSH registrations. `swap` is synchronous and contains
 * no user code, so all faces move to the same prevalidated generation in one
 * JavaScript turn. A method obtained before the swap stays bound to its old
 * generation until that invocation settles.
 */
export class LiveMnemonRuntime implements MnemonAgentRuntimeSource {
  private current: MnemonRuntimeGraph
  private readonly workspaceGraphs = new Map<string, MnemonRuntimeGraph>()
  private readonly agentGraphs = new Map<string, { token: symbol; graph: MnemonRuntimeGraph }>()
  private readonly retiredGraphs = new Set<MnemonRuntimeGraph>()
  private closed = false

  readonly config: ResolvedConfig
  readonly runner: MnemonRunner
  readonly service: MnemonService
  readonly runtimeMemory: RuntimeMemoryController
  readonly documents: DocumentManager
  readonly storage: StorageScopeInspector
  readonly packs: MnemonPackManager
  readonly memoryCatalog: MemoryCatalog
  readonly memoryTopology: MemoryTopologyManager
  readonly memoryKernel: MemoryKernel
  readonly memoryViews: MemoryTurnViewManager

  constructor(initial: MnemonRuntimeGraph, private readonly workspaceRegistry?: HostWorkspaceRegistry, private readonly agents?: HostAgentsService, private readonly extensions?: MemoryBoot) {
    this.current = initial
    this.config = liveProxy(() => this.current.config)
    this.runner = liveProxy(() => this.current.runner)
    this.service = liveProxy(() => this.current.service)
    this.runtimeMemory = liveProxy(() => this.current.runtimeMemory)
    this.documents = liveProxy(() => this.current.documents)
    this.storage = liveProxy(() => this.current.storage)
    this.packs = liveProxy(() => this.current.packs)
    this.memoryCatalog = liveProxy(() => this.current.memoryCatalog)
    this.memoryTopology = liveProxy(() => this.current.memoryTopology)
    this.memoryKernel = liveProxy(() => this.current.memoryKernel)
    this.memoryViews = liveProxy(() => this.current.memoryViews)
  }

  swap(next: MnemonRuntimeGraph): void {
    if (this.closed) {
      next.dispose()
      throw new Error('Mnemon runtime is disposed')
    }
    const previous = this.current
    this.current = next
    this.retireGraph(previous)
    for (const graph of this.workspaceGraphs.values()) this.retireGraph(graph)
    this.workspaceGraphs.clear()
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
    for (const graph of graphs) graph.dispose()
  }

  /** Resolve the runtime that must serve one Agent execution. */
  forAgent(agent: HostAgent): MnemonRuntimeGraph {
    this.assertOpen()
    const pinned = this.agentGraphs.get(agent.id)
    if (pinned !== undefined) return pinned.graph
    const parentSession = agent.session.header?.origin === 'subagent' ? agent.session.header.parentSession?.trim() : undefined
    const inherited = parentSession === undefined || parentSession === '' ? undefined : this.agentGraphs.get(parentSession)
    if (inherited !== undefined) return inherited.graph
    if (this.current.config.storageScope !== 'workspace') return this.current
    const cwd = agent.session.header?.cwd?.trim()
    if (cwd === undefined || cwd === '') throw new Error('the current DSH session has no workspace for Mnemon')
    return this.forWorkspacePath(cwd)
  }

  /** Resolve an authorized DSH workspace selected by the Web workbench. */
  forWorkspaceId(workspaceId: string): MnemonRuntimeGraph {
    this.assertOpen()
    const workspace = this.requireWorkspace(workspaceId)
    return this.current.config.storageScope === 'workspace' ? this.forWorkspacePath(workspace.path) : this.current
  }

  /** Resolve a Web request, preferring its explicit inspection workspace. */
  route(request: { workspaceId?: string; sessionId?: string }): {
    graph: MnemonRuntimeGraph
    selectedWorkspace?: HostWorkspace
    effectiveWorkspace?: HostWorkspace
    selectedRoot: string
    effectiveRoot: string
    aligned: boolean
  } {
    this.assertOpen()
    const effectiveAgent = this.agent(request.sessionId)
    const effectiveWorkspace = effectiveAgent === undefined ? undefined : this.workspaceForPath(effectiveAgent.session.header?.cwd)
    const selectedWorkspace = request.workspaceId === undefined || request.workspaceId.trim() === ''
      ? effectiveWorkspace
      : this.requireWorkspace(request.workspaceId)
    const graph = selectedWorkspace === undefined
      ? effectiveAgent === undefined ? this.current : this.forAgent(effectiveAgent)
      : this.current.config.storageScope === 'workspace' ? this.forWorkspacePath(selectedWorkspace.path) : this.current
    const effectiveGraph = effectiveAgent === undefined ? this.current : this.forAgent(effectiveAgent)
    const selectedRoot = resolve(graph.runner.effectiveDataDir())
    const effectiveRoot = resolve(effectiveGraph.runner.effectiveDataDir())
    return {
      graph,
      ...(selectedWorkspace === undefined ? {} : { selectedWorkspace }),
      ...(effectiveWorkspace === undefined ? {} : { effectiveWorkspace }),
      selectedRoot,
      effectiveRoot,
      aligned: selectedRoot === effectiveRoot,
    }
  }

  private forWorkspacePath(workspaceRoot: string): MnemonRuntimeGraph {
    const key = resolve(workspaceRoot)
    let graph = this.workspaceGraphs.get(key)
    if (graph === undefined) {
      graph = createRuntimeGraph(this.current.config, key, this.extensions)
      this.workspaceGraphs.set(key, graph)
    }
    return graph
  }

  private retireGraph(graph: MnemonRuntimeGraph): void {
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

  private workspaceForPath(path?: string): HostWorkspace | undefined {
    const normalized = path?.trim()
    if (normalized === undefined || normalized === '') return undefined
    const canonical = resolve(normalized)
    return this.workspaceRegistry?.list().find(workspace => resolve(workspace.path) === canonical)
  }
}
