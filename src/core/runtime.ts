import type { MemoryContributionSnapshot } from './contracts/index.ts'
import { MemoryGenerationHost, type CompileMemoryGenerationOptions } from './index.ts'
import { MemoryContributionRegistry, type MemoryContributionInstall, type MemoryContributionListener } from '../sdk/registry.ts'

/** The single Cordis-owned registry of Source and Strategy definitions. */
export class MemoryRuntime {
  private readonly contributions = new MemoryContributionRegistry()
  private readonly generationAttachments = new Set<MemoryGenerationAttachment>()
  private closed = false
  private disposal: Promise<void> | undefined
  private readonly disposalFailures: unknown[] = []

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
        disposal = host.dispose().finally(() => { this.generationAttachments.delete(attachment) })
        // Retired graphs may release in a synchronous Host callback. Observe
        // rejection now and report it at Core shutdown, including detached graphs.
        void disposal.catch(error => { this.disposalFailures.push(error) })
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
    this.disposal = Promise.allSettled([...this.generationAttachments].map(attachment => attachment.dispose())).then(() => {
      if (this.disposalFailures.length > 0) throw new AggregateError(this.disposalFailures, 'Memory Runtime cleanup failed')
    })
    return this.disposal
  }

}

export interface MemoryGenerationAttachment {
  readonly host: MemoryGenerationHost
  /** Stop following definition changes while preserving leased generations. */
  release(): void
  /** Final-dispose every generation after the owning runtime graph is unused. */
  dispose(): Promise<void>
}
