import type { MemoryAdapterRegistration, MemoryCatalog, MemoryLayerRegistration, MemoryStrategyRegistration } from '../../kernel/src/catalog.ts'
import type { MemoryGuardRegistration, MemoryKernel } from '../../kernel/src/kernel.ts'
import type { MemorySource, MemoryTurnViewManager } from '../../kernel/src/view.ts'
import type { MemoryContributionSnapshot } from '../../contracts/src/index.ts'
import { MemoryGenerationHost, type CompileMemoryGenerationOptions } from '../../kernel/src/index.ts'
import { MemoryContributionRegistry, type MemoryContributionInstall, type MemoryContributionListener } from './registry.ts'

const EXTENSION_ID = /^[a-z][a-z0-9-]{0,127}$/u

export interface MemoryExtensionDescriptor {
  id: string
  version: string
  label: string
  description: string
}

export interface MemoryExtension {
  descriptor: MemoryExtensionDescriptor
  layers?: readonly MemoryLayerRegistration[]
  adapters?: readonly MemoryAdapterRegistration[]
  strategies?: readonly MemoryStrategyRegistration[]
  /** Trusted, query-independent Sources for extension Layers. */
  sources?: readonly MemorySource[]
  /** Guards can only deny; strategies and data-plane executors cannot bypass them. */
  guards?: readonly MemoryGuardRegistration[]
}

export interface MemoryBootAttachment {
  bindKernel(kernel: MemoryKernel): void
  bindTurnViews(manager: MemoryTurnViewManager): void
  dispose(): void
  release(): void
}

/** Compatibility name for the v0.3 pre-release API. */
export type MemoryExtensionAttachment = MemoryBootAttachment

interface AttachedTarget {
  catalog: MemoryCatalog
  kernel?: MemoryKernel
  viewManager?: MemoryTurnViewManager
  releases: Map<string, () => void>
  released: boolean
}

function reverseDispose(disposers: Array<() => void>): void {
  for (const dispose of disposers.reverse()) dispose()
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

function captureExtension(extension: MemoryExtension, id: string): MemoryExtension {
  const layers = extension.layers?.map(registration => Object.freeze({
    descriptor: deepFreeze(structuredClone(registration.descriptor)),
    ...(registration.execute === undefined ? {} : { execute: registration.execute }),
  }))
  const adapters = extension.adapters?.map(registration => Object.freeze({
    descriptor: deepFreeze(structuredClone(registration.descriptor)),
  }))
  const strategies = extension.strategies?.map(registration => Object.freeze({
    descriptor: deepFreeze(structuredClone(registration.descriptor)),
    propose: registration.propose,
  }))
  const sources = extension.sources?.map(source => Object.freeze({
    layerId: source.layerId,
    mode: source.mode,
    snapshot: source.snapshot,
  }))
  const guards = extension.guards?.map(guard => Object.freeze({ id: guard.id, decide: guard.decide }))
  return Object.freeze({
    descriptor: deepFreeze({ ...structuredClone(extension.descriptor), id }),
    ...(layers === undefined ? {} : { layers: Object.freeze(layers) }),
    ...(adapters === undefined ? {} : { adapters: Object.freeze(adapters) }),
    ...(strategies === undefined ? {} : { strategies: Object.freeze(strategies) }),
    ...(sources === undefined ? {} : { sources: Object.freeze(sources) }),
    ...(guards === undefined ? {} : { guards: Object.freeze(guards) }),
  })
}

/**
 * Minimal Boot assembler for one Host. It applies the same captured extension
 * set to every runtime graph while each graph owns its Catalog, Kernel, and
 * TurnView state. Cordis remains responsible for lifecycle and isolation.
 */
export class MemoryBoot {
  private readonly extensions = new Map<string, MemoryExtension>()
  private readonly targets = new Set<AttachedTarget>()

  register(extension: MemoryExtension): () => void {
    const id = extension.descriptor.id.trim()
    if (!EXTENSION_ID.test(id)) throw new Error('memory extension id must match [a-z][a-z0-9-]{0,127}')
    if (this.extensions.has(id)) throw new Error(`memory extension is already registered: ${id}`)
    const normalized = captureExtension(extension, id)
    const applied: AttachedTarget[] = []
    try {
      for (const target of this.targets) {
        target.releases.set(id, this.applyChecked(normalized, target))
        applied.push(target)
      }
    } catch (error) {
      for (const target of applied.reverse()) {
        target.releases.get(id)?.()
        target.releases.delete(id)
      }
      throw error
    }
    this.extensions.set(id, normalized)
    let active = true
    return () => {
      if (!active) return
      if (this.extensions.get(id) !== normalized) {
        active = false
        return
      }
      this.unregister(normalized)
      active = false
    }
  }

  attach(catalog: MemoryCatalog): MemoryBootAttachment {
    const target: AttachedTarget = { catalog, releases: new Map(), released: false }
    try {
      for (const extension of this.extensions.values()) {
        target.releases.set(extension.descriptor.id, this.apply(extension, target))
      }
    } catch (error) {
      reverseDispose([...target.releases.values()])
      throw error
    }
    this.targets.add(target)
    return {
      bindKernel: kernel => {
        if (target.released) throw new Error('memory extension attachment is released')
        if (target.kernel !== undefined) throw new Error('memory extension attachment already has a kernel')
        target.kernel = kernel
        const guardReleases = new Map<string, () => void>()
        try {
          for (const extension of this.extensions.values()) {
            const disposers: Array<() => void> = []
            try {
              for (const guard of extension.guards ?? []) disposers.push(kernel.registerGuard(guard))
              guardReleases.set(extension.descriptor.id, () => reverseDispose(disposers))
            } catch (error) {
              reverseDispose(disposers)
              throw error
            }
          }
          for (const [id, releaseGuards] of guardReleases) {
            const releaseCatalog = target.releases.get(id) ?? (() => {})
            target.releases.set(id, () => {
              releaseGuards()
              releaseCatalog()
            })
          }
        } catch (error) {
          reverseDispose([...guardReleases.values()])
          delete target.kernel
          throw error
        }
      },
      bindTurnViews: manager => {
        if (target.released) throw new Error('memory extension attachment is released')
        if (target.viewManager !== undefined) throw new Error('memory Boot attachment already has a TurnView manager')
        target.viewManager = manager
        const sourceReleases = new Map<string, () => void>()
        try {
          for (const extension of this.extensions.values()) {
            const disposers: Array<() => void> = []
            try {
              for (const source of extension.sources ?? []) {
                if (target.catalog.layer(source.layerId) === undefined) throw new Error(`MemorySource layer is unavailable: ${source.layerId}`)
                disposers.push(manager.registerSource(source))
              }
              sourceReleases.set(extension.descriptor.id, () => reverseDispose(disposers))
            } catch (error) {
              reverseDispose(disposers)
              throw error
            }
          }
          manager.assertSourcesReady()
          for (const [id, releaseSources] of sourceReleases) {
            const releasePrevious = target.releases.get(id) ?? (() => {})
            target.releases.set(id, () => {
              releaseSources()
              releasePrevious()
            })
          }
        } catch (error) {
          reverseDispose([...sourceReleases.values()])
          delete target.viewManager
          throw error
        }
      },
      dispose: () => {
        if (target.released) return
        target.released = true
        this.targets.delete(target)
        reverseDispose([...target.releases.values()])
        target.releases.clear()
      },
      // Releasing a retired runtime stops future extension updates but keeps
      // its registrations intact for operations already pinned to that graph.
      release: () => {
        if (target.released) return
        target.released = true
        this.targets.delete(target)
        target.releases.clear()
      },
    }
  }

  descriptors(): MemoryExtensionDescriptor[] {
    return [...this.extensions.values()]
      .map(extension => ({ ...extension.descriptor }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  private apply(extension: MemoryExtension, target: AttachedTarget): () => void {
    const disposers: Array<() => void> = []
    try {
      for (const layer of extension.layers ?? []) disposers.push(target.catalog.registerLayer(layer))
      for (const adapter of extension.adapters ?? []) disposers.push(target.catalog.registerAdapter(adapter))
      for (const strategy of extension.strategies ?? []) disposers.push(target.catalog.registerStrategy(strategy))
      if (target.kernel !== undefined) {
        for (const guard of extension.guards ?? []) disposers.push(target.kernel.registerGuard(guard))
      }
      if (target.viewManager !== undefined) {
        for (const source of extension.sources ?? []) {
          if (target.catalog.layer(source.layerId) === undefined) throw new Error(`MemorySource layer is unavailable: ${source.layerId}`)
          disposers.push(target.viewManager.registerSource(source))
        }
      }
      return () => reverseDispose(disposers)
    } catch (error) {
      reverseDispose(disposers)
      throw error
    }
  }

  private applyChecked(extension: MemoryExtension, target: AttachedTarget): () => void {
    const release = this.apply(extension, target)
    try {
      target.viewManager?.assertSourcesReady()
      return release
    } catch (error) {
      release()
      throw error
    }
  }

  /** Remove one global extension from every live graph, or restore it everywhere. */
  private unregister(extension: MemoryExtension): void {
    const id = extension.descriptor.id
    const removed: AttachedTarget[] = []
    try {
      for (const target of this.targets) {
        const release = target.releases.get(id)
        if (release === undefined) continue
        release()
        target.releases.delete(id)
        removed.push(target)
        target.viewManager?.assertSourcesReady()
      }
    } catch (error) {
      const rollbackFailures: unknown[] = []
      for (const target of removed.reverse()) {
        try {
          target.releases.set(id, this.applyChecked(extension, target))
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError)
        }
      }
      if (rollbackFailures.length > 0) {
        throw new AggregateError([error, ...rollbackFailures], `memory extension ${id} unload failed and could not be fully rolled back`)
      }
      throw error
    }
    this.extensions.delete(id)
  }
}

/** Compatibility name for the v0.3 pre-release API. */
export { MemoryBoot as MemoryExtensionHost }

export function defineMemoryExtension<T extends MemoryExtension>(extension: T): T {
  return extension
}

/** Process-global Boot, allowing extensions to contribute before the DSH Host mounts. */
export const memoryBoot = new MemoryBoot()

/** Compatibility name for the v0.3 pre-release API. */
export const memoryExtensions = memoryBoot

export function registerMemoryExtension(extension: MemoryExtension): () => void {
  return memoryBoot.register(extension)
}

/**
 * Stable ctx.mnemonMemory façade. New Source/Strategy definitions are scoped
 * to this Host while the legacy MemoryBoot is retained as a compatibility
 * input for v0.3 extensions registered before core mounts.
 */
export class MemoryRuntime extends MemoryBoot {
  private readonly contributions = new MemoryContributionRegistry()
  private readonly generationAttachments = new Set<MemoryGenerationAttachment>()
  private closed = false
  private disposal: Promise<void> | undefined

  constructor(private readonly inheritedBoot?: MemoryBoot) {
    super()
  }

  installContributions(value: MemoryContributionInstall): () => void {
    if (this.closed) throw new Error('Memory Runtime is disposed')
    return this.contributions.install(value)
  }

  contributionSnapshot(): MemoryContributionSnapshot {
    return this.contributions.snapshot()
  }

  onContributionsChanged(listener: MemoryContributionListener): () => void {
    return this.contributions.subscribe(listener)
  }

  /** Attach one Host runtime graph to the current definition set. */
  attachGeneration(options: CompileMemoryGenerationOptions = {}): MemoryGenerationAttachment {
    if (this.closed) throw new Error('Memory Runtime is disposed')
    const host = new MemoryGenerationHost(options)
    host.reconcile(this.contributions.snapshot())
    const unsubscribe = this.contributions.subscribe(snapshot => host.reconcile(snapshot))
    let attached = true
    const release = (): void => {
      if (!attached) return
      attached = false
      unsubscribe()
    }
    let disposal: Promise<void> | undefined
    const attachment: MemoryGenerationAttachment = {
      host,
      release,
      dispose: () => {
        if (disposal !== undefined) return disposal
        release()
        this.generationAttachments.delete(attachment)
        disposal = host.dispose()
        return disposal
      },
    }
    this.generationAttachments.add(attachment)
    return attachment
  }

  /** Core-Fiber shutdown also closes attachments left by a host adapter. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.disposal = Promise.allSettled([...this.generationAttachments].map(attachment => attachment.dispose())).then(results => {
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length > 0) throw new AggregateError(errors, 'Memory Runtime cleanup failed')
    })
    return this.disposal
  }

  override descriptors(): MemoryExtensionDescriptor[] {
    const descriptors = [...(this.inheritedBoot?.descriptors() ?? []), ...super.descriptors()]
    return [...new Map(descriptors.map(descriptor => [descriptor.id, descriptor])).values()]
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  override attach(catalog: MemoryCatalog): MemoryBootAttachment {
    const inherited = this.inheritedBoot?.attach(catalog)
    let own: MemoryBootAttachment
    try {
      own = super.attach(catalog)
    } catch (error) {
      inherited?.dispose()
      throw error
    }
    return {
      bindKernel: kernel => {
        try {
          inherited?.bindKernel(kernel)
          own.bindKernel(kernel)
        } catch (error) {
          own.dispose()
          inherited?.dispose()
          throw error
        }
      },
      bindTurnViews: manager => {
        try {
          inherited?.bindTurnViews(manager)
          own.bindTurnViews(manager)
        } catch (error) {
          own.dispose()
          inherited?.dispose()
          throw error
        }
      },
      dispose: () => {
        own.dispose()
        inherited?.dispose()
      },
      release: () => {
        own.release()
        inherited?.release()
      },
    }
  }
}

export interface MemoryGenerationAttachment {
  readonly host: MemoryGenerationHost
  /** Stop following definition changes while preserving leased generations. */
  release(): void
  /** Final-dispose every generation after the owning runtime graph is unused. */
  dispose(): Promise<void>
}

export { installMemory, type InstallMemoryOptions, type MemoryInstallContribution } from './install.ts'
export { MemoryContributionRegistry, type MemoryContributionInstall, type MemoryContributionListener } from './registry.ts'
export { defineMemorySource, defineMemoryStrategy } from '../../kernel/src/composition.ts'
export { record as memoryInputRecord, text as memoryInputText, integer as memoryInputInteger, stringArray as memoryInputStringArray, truncate as truncateMemoryText, receipt as createMemoryMutationReceipt } from './input.ts'
export { memoryConfigurationDigest } from './input.ts'
export type {
  ComposableMemoryView,
  MemoryActionOffer,
  MemoryCompositionEvaluationReport,
  MemoryEvidence,
  MemoryMutationReceipt,
  MemoryReadGrant,
  MemorySourceDefinition,
  MemorySourceFacts,
  MemorySourceManifest,
  MemorySourceRuntime,
  MemoryStrategyDefinition,
  MemoryStrategyManifest,
  MemoryViewRequest,
  MemoryViewSpec,
} from '../../contracts/src/index.ts'

export type { MemoryAdapterRegistration, MemoryLayerRegistration, MemoryStrategyRegistration } from '../../kernel/src/catalog.ts'
export type { MemoryGuardRegistration } from '../../kernel/src/kernel.ts'
export type { MemorySource } from '../../kernel/src/view.ts'
