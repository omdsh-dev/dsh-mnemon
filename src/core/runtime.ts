import { prepareMemoryContributions, type MemoryContributionSnapshot } from './contributions.ts'
import { MemoryGenerationHost } from './generation.ts'
import type { CompileMemoryGenerationOptions } from './composition.ts'
import { MemoryContributionRegistry, type MemoryContributionInstall, type MemoryContributionListener } from './registry.ts'
import type { MnemonMemoryService } from '../sdk/service.ts'

interface MemoryCoreContext {
  provide(name: string, service: MnemonMemoryService): unknown
  effect(factory: () => () => Promise<void>, label?: string): unknown
}

export function provideMemoryRuntime(context: MemoryCoreContext): MemoryRuntime {
  const runtime = new MemoryRuntime()
  context.provide('mnemonMemory', runtime.service)
  context.effect(() => () => runtime.dispose(), 'dsh-mnemon.core()')
  return runtime
}

export class MemoryRuntime {
  readonly service: MnemonMemoryService = Object.freeze<MnemonMemoryService>({
    installContributions: (contribution, options) => {
      if (this.closed) throw new Error('Memory Runtime is disposed')
      return this.installContributions(prepareMemoryContributions(contribution, options))
    },
  })
  private readonly contributions = new MemoryContributionRegistry()
  private readonly generationAttachments = new Set<MemoryGenerationAttachment>()
  private closed = false
  private disposal: Promise<void> | undefined
  private readonly disposalFailures: unknown[] = []
  private batchDepth = 0
  private batchSnapshot: MemoryContributionSnapshot | undefined
  private readonly committedListeners = new Set<MemoryContributionListener>()
  private contributionsPending = false
  private readonly reconciliations = new Map<MemoryGenerationHost, MemoryContributionSnapshot>()

  async batch<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Memory Runtime is disposed')
    if (this.batchDepth++ === 0) this.batchSnapshot = this.contributions.snapshot()
    try { return await operation() }
    finally {
      if (--this.batchDepth === 0) {
        this.batchSnapshot = undefined
        const pending = [...this.reconciliations]
        this.reconciliations.clear()
        for (const [host, snapshot] of pending) {
          if (host.isDisposed) continue
          try {
            host.reconcile(snapshot)
          } catch (error) {
            if (!host.isDisposed) throw error
          }
        }
        if (this.contributionsPending) {
          this.contributionsPending = false
          this.notifyCommitted()
        }
      }
    }
  }

  installContributions(value: MemoryContributionInstall): () => void {
    if (this.closed) throw new Error('Memory Runtime is disposed')
    const release = this.contributions.install(value)
    this.notifyCommitted()
    return () => {
      const revision = this.contributions.snapshot().revision
      release()
      if (this.contributions.snapshot().revision !== revision) this.notifyCommitted()
    }
  }

  contributionSnapshot(): MemoryContributionSnapshot {
    return this.contributions.snapshot()
  }

  onContributionsChanged(listener: MemoryContributionListener): () => void {
    return this.contributions.subscribe(listener)
  }

  committedContributionSnapshot(): MemoryContributionSnapshot {
    return this.batchSnapshot ?? this.contributions.snapshot()
  }

  onCommittedContributionsChanged(listener: MemoryContributionListener): () => void {
    this.committedListeners.add(listener)
    return () => { this.committedListeners.delete(listener) }
  }

  private notifyCommitted(): void {
    if (this.closed) return
    if (this.batchDepth) { this.contributionsPending = true; return }
    const snapshot = this.contributions.snapshot()
    for (const listener of [...this.committedListeners]) {
      try {
        listener(snapshot)
      } catch {
      }
    }
  }

  attachGeneration(options: CompileMemoryGenerationOptions = {}): MemoryGenerationAttachment {
    if (this.closed) throw new Error('Memory Runtime is disposed')
    const host = new MemoryGenerationHost(options)
    host.reconcile(this.batchSnapshot ?? this.contributions.snapshot())
    if (this.batchSnapshot !== undefined) this.reconciliations.set(host, this.contributions.snapshot())
    let attached = true
    let unsubscribe: () => void = () => {}
    const release = (): void => {
      if (!attached) return
      attached = false
      unsubscribe()
      this.reconciliations.delete(host)
    }
    unsubscribe = this.contributions.subscribe(snapshot => {
      if (host.isDisposed) {
        release()
        return
      }
      if (this.batchDepth) this.reconciliations.set(host, snapshot)
      else host.reconcile(snapshot)
    })
    let disposal: Promise<void> | undefined
    const attachment: MemoryGenerationAttachment = {
      host,
      release,
      dispose: () => {
        if (disposal !== undefined) return disposal
        release()
        disposal = host.dispose().finally(() => { this.generationAttachments.delete(attachment) })
        void disposal.catch(error => { this.disposalFailures.push(error) })
        return disposal
      },
    }
    this.generationAttachments.add(attachment)
    return attachment
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.closed = true
    this.committedListeners.clear()
    this.disposal = Promise.allSettled([...this.generationAttachments].map(attachment => attachment.dispose())).then(() => {
      if (this.disposalFailures.length > 0) throw new AggregateError(this.disposalFailures, 'Memory Runtime cleanup failed')
    })
    return this.disposal
  }

}

export interface MemoryGenerationAttachment {
  readonly host: MemoryGenerationHost
  release(): void
  dispose(): Promise<void>
}
