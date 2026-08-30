import type {
  InstalledMemorySource,
  InstalledMemoryStrategy,
  MemoryContributionSnapshot,
} from "../core/contracts/index.ts"
import { captureMemoryContributionSnapshot } from "../core/composition.ts"

export interface MemoryContributionInstall {
  sources?: readonly InstalledMemorySource[]
  strategies?: readonly InstalledMemoryStrategy[]
}

export type MemoryContributionListener = (snapshot: MemoryContributionSnapshot) => void

/**
 * Scope-local definition registry behind ctx.mnemonMemory.
 *
 * It owns definitions only. Runtime objects are created and drained by a
 * generation host attached by dsh-mnemon core.
 */
export class MemoryContributionRegistry {
  private readonly sources = new Map<string, InstalledMemorySource>()
  private readonly strategies = new Map<string, InstalledMemoryStrategy>()
  private readonly listeners = new Set<MemoryContributionListener>()
  private revision = 0

  install(value: MemoryContributionInstall): () => void {
    const incomingSources = [...(value.sources ?? [])]
    const incomingStrategies = [...(value.strategies ?? [])]
    if (incomingSources.length + incomingStrategies.length === 0) throw new Error('installMemory requires one Source or Strategy contribution')
    for (const source of incomingSources) {
      if (this.sources.has(source.instanceKey)) throw new Error(`memory Source instance is already installed: ${source.instanceKey}`)
    }
    for (const strategy of incomingStrategies) {
      if (this.strategies.has(strategy.instanceKey)) throw new Error(`memory Strategy instance is already installed: ${strategy.instanceKey}`)
    }
    const candidate = captureMemoryContributionSnapshot({
      revision: this.revision + 1,
      sources: [...this.sources.values(), ...incomingSources],
      strategies: [...this.strategies.values(), ...incomingStrategies],
    })
    const capturedSources = candidate.sources.filter(source => incomingSources.some(incoming => incoming.instanceKey === source.instanceKey))
    const capturedStrategies = candidate.strategies.filter(strategy => incomingStrategies.some(incoming => incoming.instanceKey === strategy.instanceKey))
    for (const source of capturedSources) this.sources.set(source.instanceKey, source)
    for (const strategy of capturedStrategies) this.strategies.set(strategy.instanceKey, strategy)
    this.revision = candidate.revision
    this.notify(candidate)

    let active = true
    return () => {
      if (!active) return
      active = false
      let changed = false
      for (const source of capturedSources) {
        if (this.sources.get(source.instanceKey) !== source) continue
        this.sources.delete(source.instanceKey)
        changed = true
      }
      for (const strategy of capturedStrategies) {
        if (this.strategies.get(strategy.instanceKey) !== strategy) continue
        this.strategies.delete(strategy.instanceKey)
        changed = true
      }
      if (!changed) return
      this.revision += 1
      this.notify(this.snapshot())
    }
  }

  snapshot(): MemoryContributionSnapshot {
    return captureMemoryContributionSnapshot({
      revision: this.revision,
      sources: [...this.sources.values()],
      strategies: [...this.strategies.values()],
    })
  }

  subscribe(listener: MemoryContributionListener): () => void {
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  private notify(snapshot: MemoryContributionSnapshot): void {
    for (const listener of [...this.listeners]) listener(snapshot)
  }
}
