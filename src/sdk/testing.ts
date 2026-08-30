import { Context, type Plugin } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { MemoryRuntime } from '../../packages/extension-sdk/src/index.ts'
import {
  DEFAULT_MEMORY_VIEW_BUDGET,
  type CompileMemoryGenerationOptions,
  type MemoryGenerationHost,
  type MemoryGenerationLease,
} from '../../packages/kernel/src/index.ts'
import type { ComposableMemoryView, MemoryViewRequest, MemoryJsonValue, MemorySourceManagementResult } from '../../packages/contracts/src/index.ts'

export interface MemoryTestEntry<C> {
  instanceId: string
  config?: C
}

export interface MemoryTestTurn {
  readonly view: ComposableMemoryView
  readonly lease: MemoryGenerationLease
  release(): void
}

export interface MemoryTestManagementClient {
  readonly sourceInstanceKey: string
  readonly revision: string
  read(operation: string, input?: MemoryJsonValue): Promise<MemorySourceManagementResult>
  mutate(operation: string, input: MemoryJsonValue, options: { confirmed: true; expectedRevision?: string }): Promise<MemorySourceManagementResult>
}

/**
 * A test fixture, not a production service or a second Loader. It mounts real
 * Cordis Fibers against the same Runtime/compiler used by the Host. The small
 * Loader identity adapter supplies only stable Entry ids for installMemory.
 * No built-in Source, Provider, database, browser, or private binding is needed.
 */
export class MemoryCompositionRunner {
  readonly context = new Context()
  readonly runtime = new MemoryRuntime()
  readonly generations: MemoryGenerationHost
  private readonly entryIds = new WeakMap<object, string>()
  private readonly entries = new Map<string, { dispose(): Promise<void> }>()
  private readonly attachment
  private closed = false

  constructor(options: CompileMemoryGenerationOptions = {}) {
    this.context.provide('mnemonMemory', this.runtime)
    this.context.provide('loader', {
      locate: (fiber: object) => this.entryIds.get(fiber),
      import: (specifier: string) => import(specifier),
      unwrapExports: (module: Record<string, unknown>) => module.default ?? module,
    })
    this.attachment = this.runtime.attachGeneration(options)
    this.generations = this.attachment.host
  }

  async mount<C>(plugin: Plugin.Object<C>, entry: MemoryTestEntry<C>): Promise<() => Promise<void>> {
    if (this.closed) throw new Error('MemoryCompositionRunner is disposed')
    const id = entry.instanceId.trim()
    if (id === '' || this.entries.has(id)) throw new Error(`duplicate or empty test Entry id: ${id}`)
    const boundPlugin: Plugin.Object<C | undefined> = {
      ...plugin,
      apply: (ctx: Context, config: C | undefined) => {
        this.entryIds.set(ctx.fiber, id)
        return plugin.apply(ctx, config as C)
      },
    }
    const fiber = this.context.plugin(boundPlugin, entry.config)
    this.entries.set(id, fiber)
    try {
      await fiber.await()
    } catch (error) {
      this.entries.delete(id)
      await fiber.dispose()
      throw error
    }
    return async () => {
      if (this.entries.get(id) !== fiber) return
      this.entries.delete(id)
      await fiber.dispose()
    }
  }

  async beginTurn(request: Partial<MemoryViewRequest> = {}): Promise<MemoryTestTurn> {
    if (this.closed) throw new Error('MemoryCompositionRunner is disposed')
    const lease = this.generations.acquire()
    try {
      const view = await lease.generation.compose({
        scope: request.scope ?? { storage: 'custom' },
        scenario: request.scenario ?? 'plugin-test',
        budget: request.budget ?? { ...DEFAULT_MEMORY_VIEW_BUDGET },
      })
      return { view, lease, release: () => lease.release() }
    } catch (error) {
      lease.release()
      throw error
    }
  }

  /** Same scoped management contract a Source page receives, backed by real generations. */
  async managementClient(sourceInstanceKey: string, scopeValue: MemoryViewRequest['scope'] = { storage: 'custom' }): Promise<MemoryTestManagementClient> {
    const scope = structuredClone(scopeValue)
    const initial = this.generations.acquire()
    let revision: string
    try {
      const instance = (await initial.generation.managementCatalog(scope)).sources.find(source => source.sourceInstanceKey === sourceInstanceKey)
      if (instance === undefined) throw new Error(`No managed test Source: ${sourceInstanceKey}`)
      revision = instance.revision
    } finally { initial.release() }
    const execute = async (mode: 'read' | 'mutate', operation: string, input: MemoryJsonValue, options?: { confirmed: true; expectedRevision?: string }) => {
      const lease = this.generations.acquire()
      try {
        const result = await lease.generation.executeManagement({
          sourceInstanceKey, scope, mode, operation, input, confirmed: options?.confirmed === true,
          ...(mode === 'read' ? {} : { expectedRevision: options?.expectedRevision ?? revision }),
        })
        revision = result.revision
        return result
      } finally { lease.release() }
    }
    return {
      sourceInstanceKey, get revision() { return revision },
      read: (operation, input = null) => execute('read', operation, input),
      mutate: (operation, input, options) => execute('mutate', operation, input, options),
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const failures: unknown[] = []
    for (const fiber of [...this.entries.values()].reverse()) {
      try { await fiber.dispose() } catch (error) { failures.push(error) }
    }
    this.entries.clear()
    try { await this.attachment.dispose() } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'MemoryCompositionRunner cleanup failed')
  }
}

export { DEFAULT_MEMORY_VIEW_BUDGET }

/**
 * Evaluate a trusted, already-built DSH Client artifact in a test. Dependencies
 * are explicit (normally the test's React and UI primitives), so no production
 * Loader, global registry, source alias, or second copy of React is required.
 * This is a test fixture, not another Client Loader implementation.
 */
export function loadMemoryClientArtifact<T extends object = Record<string, unknown>>(
  path: string | URL,
  dependencies: Readonly<Record<string, unknown>>,
): T {
  let declaration: { id: string; factory(require: (id: string) => unknown): unknown } | undefined
  const loader = { load(value: typeof declaration) {
    if (declaration !== undefined || value === undefined || typeof value.id !== 'string' || typeof value.factory !== 'function') {
      throw new Error('Expected exactly one DSH Client artifact declaration')
    }
    declaration = value
  } }
  const actualWindow = (globalThis as unknown as { window?: object }).window ?? {}
  const window = new Proxy(actualWindow, {
    get(target, key) {
      if (key === '__ModuleLoader__') return loader
      const value = Reflect.get(target, key, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  new Function('window', readFileSync(path, 'utf8'))(window)
  if (declaration === undefined) throw new Error('No DSH Client declaration in artifact')
  return declaration.factory(id => {
    if (!Object.hasOwn(dependencies, id)) throw new Error(`Missing Client test dependency: ${id}`)
    return dependencies[id]
  }) as T
}
