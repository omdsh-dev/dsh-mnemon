import { normalizeEntityKey, type Insight } from './contracts.ts'

export const ENTITY_INDEX_LIST_LIMIT = 100_000

export const ENTITY_RAIL_LIMIT = 5_000

export interface SpaceEntityIndex {
  memories: Insight[]
  byKey: Map<string, number[]>
  spellings: Map<string, Map<string, number>>
  memoryCount: number
  complete: boolean
}

export function buildSpaceEntityIndex(memories: readonly Insight[], memoryCount: number, complete: boolean): SpaceEntityIndex {
  const kept: Insight[] = []
  const byKey = new Map<string, number[]>()
  const spellings = new Map<string, Map<string, number>>()
  for (const memory of memories) {
    const seen = new Set<string>()
    let position: number | undefined
    for (const raw of memory.entities ?? []) {
      if (typeof raw !== 'string') continue
      const key = normalizeEntityKey(raw)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      if (position === undefined) {
        position = kept.length
        kept.push(memory)
      }
      const positions = byKey.get(key)
      if (positions === undefined) byKey.set(key, [position])
      else positions.push(position)
      const name = raw.normalize('NFKC').trim()
      const names = spellings.get(key)
      if (names === undefined) spellings.set(key, new Map([[name, 1]]))
      else names.set(name, (names.get(name) ?? 0) + 1)
    }
  }
  return { memories: kept, byKey, spellings, memoryCount, complete }
}

function preferredSpelling(names: ReadonlyMap<string, number>): string {
  let preferred = ''
  let most = 0
  for (const [name, count] of names) if (count > most) { preferred = name; most = count }
  return preferred
}

export function mergeEntityCounts(indexes: readonly SpaceEntityIndex[]): { items: Array<{ entity: string; count: number }>; names: Map<string, string> } {
  const counts = new Map<string, number>()
  const spellings = new Map<string, Map<string, number>>()
  for (const index of indexes) {
    for (const [key, positions] of index.byKey) {
      counts.set(key, (counts.get(key) ?? 0) + positions.length)
      let totals = spellings.get(key)
      if (totals === undefined) spellings.set(key, totals = new Map())
      for (const [name, count] of index.spellings.get(key) ?? []) totals.set(name, (totals.get(name) ?? 0) + count)
    }
  }
  const names = new Map<string, string>()
  for (const [key, totals] of spellings) names.set(key, preferredSpelling(totals))
  const items = [...counts]
    .map(([key, count]) => ({ entity: names.get(key)!, count }))
    .sort((left, right) => right.count - left.count || left.entity.localeCompare(right.entity))
  return { items, names }
}

export function compareEntityMemories(left: Insight, right: Insight): number {
  return (right.importance ?? 0) - (left.importance ?? 0)
    || (right.createdAt ?? '').localeCompare(left.createdAt ?? '')
    || (left.memoryBodyName ?? '').localeCompare(right.memoryBodyName ?? '')
    || left.id.localeCompare(right.id)
}

export function memoriesWithEntity(indexes: readonly SpaceEntityIndex[], key: string): Insight[] {
  const memories: Insight[] = []
  for (const index of indexes) for (const position of index.byKey.get(key) ?? []) memories.push(index.memories[position]!)
  return memories.sort(compareEntityMemories)
}
