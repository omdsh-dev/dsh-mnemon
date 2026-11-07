import type { MemorySourceFacts, MemoryViewSpec } from '../core/contracts/index.ts'

/** Reserve complete Source-declared resident data inside the existing View ceiling. */
export function reserveMemoryProjection(spec: MemoryViewSpec, sources: readonly MemorySourceFacts[], budget: number): MemoryViewSpec {
  const minimums = spec.sources.map(selected => {
    const source = sources.find(item => item.sourceInstanceKey === selected.sourceInstanceKey)
    const hints = source?.hints
    const value = source?.capabilities.includes('project') && hints !== null && typeof hints === 'object' && !Array.isArray(hints) ? hints?.minimumProjectionCharacters : undefined
    if (value === undefined) return 0
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid minimum projection hint')
    return value
  })
  if (minimums.every(value => value === 0)) return spec
  const minimum = minimums.reduce((sum, value) => sum + value, 0)
  if (minimum > budget) throw new Error(`Pinned memory requires ${minimum} projection characters but the View budget is ${budget}. Unpin entries or increase the View budget.`)
  const allocation = spec.sources.map((selected, index) => Math.max(minimums[index]!, selected.projection?.maxCharacters ?? 0))
  let excess = allocation.reduce((sum, value) => sum + value, 0) - budget
  // The existing priority order remains authoritative; borrow only non-reserved room.
  for (let index = allocation.length - 1; index >= 0 && excess > 0; index--) {
    const reclaimed = Math.min(excess, allocation[index]! - minimums[index]!)
    allocation[index]! -= reclaimed
    excess -= reclaimed
  }
  return { ...spec, sources: spec.sources.map((selected, index) => {
    const { projection, ...rest } = selected
    const characters = allocation[index]!
    return { ...rest, ...(minimums[index]! > 0 ? { required: true } : {}),
      ...(characters === 0 ? {} : { projection: { mode: projection?.mode ?? 'eager', maxCharacters: characters } }),
    }
  }) }
}
