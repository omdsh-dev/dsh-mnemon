import type { JsonValue, MemoryBody, MemoryProviderConnection } from '../contracts.ts'
import type { MemoryProviderAdapter, MemoryProviderScoreSemantics } from './adapter.ts'

/** Minimum parent authority a Provider needs; no private controller class. */
export interface MemorySpaceAuthority {
  readonly runner: { effectiveDataDir(): string }
  list(): MemoryBody[]
  providerConnection(id: string, expectedProviderId?: string): MemoryProviderConnection
}

/** Scoped command transport consumed by the Native Provider. */
export interface MemorySpaceNativeRunner {
  runJson(args: readonly string[], options?: { signal?: AbortSignal; store?: string }): Promise<JsonValue>
  runText(args: readonly string[], options?: { signal?: AbortSignal; store?: string }): Promise<string>
}

export interface MemoryProviderAdapterFactoryContext {
  memoryBodies: MemorySpaceAuthority
  config: { timeoutMs: number; defaultRecallLimit?: number }
  nativeRunner?: MemorySpaceNativeRunner
}

export interface MemoryAdapterFactory<Id extends string, Context, Adapter extends { readonly id: Id }> {
  readonly id: Id
  create(context: Context): Adapter
}

/** Lifecycle-owned factory directory used by Provider plugins and the Host. */
export class MemoryAdapterFactoryRegistry<Id extends string, Context, Adapter extends { readonly id: Id }> {
  private readonly factories = new Map<Id, MemoryAdapterFactory<Id, Context, Adapter>>()

  constructor(factories: readonly MemoryAdapterFactory<Id, Context, Adapter>[] = []) {
    for (const factory of factories) this.register(factory)
  }

  register(factory: MemoryAdapterFactory<Id, Context, Adapter>): () => void {
    if (this.factories.has(factory.id)) throw new Error(`memory adapter factory is already registered: ${factory.id}`)
    this.factories.set(factory.id, factory)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.factories.get(factory.id) === factory) this.factories.delete(factory.id)
    }
  }

  create(context: Context): Map<Id, Adapter> {
    const adapters = new Map<Id, Adapter>()
    for (const factory of this.factories.values()) {
      const adapter = factory.create(context)
      if (adapter.id !== factory.id) throw new Error(`memory adapter factory ${factory.id} returned ${adapter.id}`)
      if (adapters.has(adapter.id)) throw new Error(`memory adapter is already created: ${adapter.id}`)
      adapters.set(adapter.id, adapter)
    }
    return adapters
  }

  ids(): Id[] {
    return [...this.factories.keys()]
  }
}


export interface MemoryProviderAdapterFactory extends MemoryAdapterFactory<string, MemoryProviderAdapterFactoryContext, MemoryProviderAdapter> {
  scoreSemantics: MemoryProviderScoreSemantics
}

export class MemoryProviderAdapterRegistry extends MemoryAdapterFactoryRegistry<string, MemoryProviderAdapterFactoryContext, MemoryProviderAdapter> {}
