import type {
  MemoryCompositionDiagnostic,
  MemoryCompositionEvaluationReport,
  MemoryContributionSnapshot,
} from '../../contracts/src/index.ts'
import {
  MemoryCompositionGeneration,
  type CompileMemoryGenerationOptions,
} from './composition.ts'

interface GenerationRecord {
  generation: MemoryCompositionGeneration
  leases: number
  state: 'serving' | 'draining'
}

export interface MemoryGenerationLease {
  readonly id: string
  readonly generation: MemoryCompositionGeneration
  release(): void
}

export interface MemoryGenerationHostSnapshot {
  servingGenerationId?: string
  drainingGenerationIds: string[]
  evaluation: MemoryCompositionEvaluationReport
}

function report(
  state: 'incomplete' | 'rejected',
  snapshot: MemoryContributionSnapshot,
  diagnostics: MemoryCompositionDiagnostic[],
): MemoryCompositionEvaluationReport {
  return Object.freeze({
    state,
    contributionRevision: snapshot.revision,
    sourceInstanceKeys: snapshot.sources.map(source => source.instanceKey),
    diagnostics: Object.freeze(diagnostics.map(diagnostic => Object.freeze({ ...diagnostic }))) as unknown as MemoryCompositionDiagnostic[],
  })
}

/**
 * Owns candidate → serving → draining generation transitions.
 * Cordis owns definition registrations; this host owns factory-created runtime
 * objects and keeps a retired generation alive only while turn leases exist.
 */
export class MemoryGenerationHost {
  private readonly records = new Map<string, GenerationRecord>()
  private serving: GenerationRecord | undefined
  private evaluation: MemoryCompositionEvaluationReport = Object.freeze({
    state: 'incomplete',
    contributionRevision: 0,
    sourceInstanceKeys: [],
    diagnostics: [{ code: 'not-composed', message: 'Memory contributions have not been composed.' }],
  })
  private closed = false

  constructor(private readonly options: CompileMemoryGenerationOptions = {}) {}

  reconcile(snapshot: MemoryContributionSnapshot): MemoryCompositionEvaluationReport {
    this.assertOpen()
    if (snapshot.sources.length === 0 || snapshot.strategies.length === 0) {
      const diagnostics: MemoryCompositionDiagnostic[] = []
      if (snapshot.sources.length === 0) diagnostics.push({ code: 'missing-source', message: 'No Memory Source contribution is installed.' })
      if (snapshot.strategies.length === 0) diagnostics.push({ code: 'missing-strategy', message: 'No Memory Strategy contribution is installed.' })
      this.evaluation = report('incomplete', snapshot, diagnostics)
      if (this.removesServingContribution(snapshot)) this.retireServing()
      return this.evaluation
    }

    if (this.removesServingContribution(snapshot)) {
      this.evaluation = report('rejected', snapshot, [{
        code: 'serving-contribution-removed',
        message: 'A Source or Strategy required by the Serving generation was explicitly removed.',
      }])
      this.retireServing()
      return this.evaluation
    }

    let candidate: MemoryCompositionGeneration
    try {
      candidate = new MemoryCompositionGeneration(snapshot, this.options)
    } catch (error) {
      this.evaluation = report('rejected', snapshot, [{
        code: 'composition-rejected',
        message: error instanceof Error ? error.message : String(error),
      }])
      if (this.removesServingContribution(snapshot)) this.retireServing()
      return this.evaluation
    }

    const previous = this.serving
    const existing = this.records.get(candidate.id)
    if (existing !== undefined) {
      void candidate.dispose()
      existing.state = 'serving'
      this.serving = existing
      this.evaluation = existing.generation.report
      if (previous !== undefined && previous !== existing) this.retire(previous)
      return this.evaluation
    }
    const record: GenerationRecord = { generation: candidate, leases: 0, state: 'serving' }
    this.records.set(candidate.id, record)
    this.serving = record
    this.evaluation = candidate.report
    if (previous !== undefined) this.retire(previous)
    return this.evaluation
  }

  acquire(): MemoryGenerationLease {
    this.assertOpen()
    const record = this.serving
    if (record === undefined || record.state !== 'serving') {
      const reason = this.evaluation.diagnostics.map(diagnostic => diagnostic.message).join('; ')
      throw new Error(`no Serving memory generation is available${reason === '' ? '' : `: ${reason}`}`)
    }
    record.leases += 1
    let active = true
    return Object.freeze({
      id: record.generation.id,
      generation: record.generation,
      release: () => {
        if (!active) return
        active = false
        record.leases -= 1
        this.collect(record)
      },
    })
  }

  current(): MemoryCompositionGeneration | undefined {
    return this.serving?.state === 'serving' ? this.serving.generation : undefined
  }

  generation(id: string): MemoryCompositionGeneration | undefined {
    return this.records.get(id)?.generation
  }

  inspect(): MemoryGenerationHostSnapshot {
    return Object.freeze({
      ...(this.serving?.state === 'serving' ? { servingGenerationId: this.serving.generation.id } : {}),
      drainingGenerationIds: Object.freeze([...this.records.values()]
        .filter(record => record.state === 'draining')
        .map(record => record.generation.id)) as unknown as string[],
      evaluation: this.evaluation,
    })
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.serving = undefined
    const records = [...this.records.values()]
    this.records.clear()
    const failures: unknown[] = []
    for (const record of records.reverse()) {
      try {
        await record.generation.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'memory generation host disposal failed')
  }

  private removesServingContribution(snapshot: MemoryContributionSnapshot): boolean {
    if (this.serving === undefined) return false
    const available = new Set([
      ...snapshot.sources.map(source => source.instanceKey),
      ...snapshot.strategies.map(strategy => strategy.instanceKey),
    ])
    const required = [
      ...this.serving.generation.report.sourceInstanceKeys,
      ...(this.serving.generation.report.strategyInstanceKey === undefined ? [] : [this.serving.generation.report.strategyInstanceKey]),
    ]
    return required.some(key => !available.has(key))
  }

  private retireServing(): void {
    if (this.serving === undefined) return
    const previous = this.serving
    this.serving = undefined
    this.retire(previous)
  }

  private retire(record: GenerationRecord): void {
    record.state = 'draining'
    this.collect(record)
  }

  private collect(record: GenerationRecord): void {
    if (record.state !== 'draining' || record.leases !== 0) return
    if (this.records.get(record.generation.id) !== record) return
    this.records.delete(record.generation.id)
    void record.generation.dispose()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('memory generation host is disposed')
  }
}
