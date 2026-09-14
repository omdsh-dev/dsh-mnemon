import type { MemoryResourceReference } from '../../core/contracts/index.ts'
import { memoryOperationPlanDigest } from './operations.ts'

/** A cursor fixes the query and snapshot; it grants no access beyond its owning route. */
export function memoryReadCursor(identity: unknown, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new Error('Invalid read cursor offset')
  return Buffer.from(JSON.stringify({ version: 1, identity: memoryOperationPlanDigest(identity), offset })).toString('base64url')
}
export function memoryReadOffset(cursor: unknown, identity: unknown): number {
  if (cursor === undefined) return 0
  if (typeof cursor !== 'string' || cursor.length > 500 || !/^[a-zA-Z0-9_-]+$/u.test(cursor)) throw new Error('Invalid read cursor')
  let value: { version?: unknown; identity?: unknown; offset?: unknown }
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { throw new Error('Invalid read cursor') }
  if (!value || value.version !== 1 || value.identity !== memoryOperationPlanDigest(identity) || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 || (value.offset as number) > 1_000_000) throw new Error('Read cursor belongs to a different query or snapshot')
  return value.offset as number
}

/** Source-owned coverage for progressive reads of one exact resource version. */
export class MemoryReadCoverage {
  private readonly views = new Map<string, Map<string, { total: number; ranges: Array<[number, number]> }>>()
  constructor(private readonly maxViews = 128, private readonly maxResources = 256) {
    if (![maxViews, maxResources].every(value => Number.isSafeInteger(value) && value > 0 && value <= 1024)) throw new Error('Invalid read coverage limits')
  }
  observe(viewId: string, reference: MemoryResourceReference, range: { start: number; end: number; total: number }): boolean {
    if (!reference.revision || !reference.id || !viewId || ![range.start, range.end, range.total].every(value => Number.isSafeInteger(value) && value >= 0) || range.start > range.end || range.end > range.total) throw new Error('Read coverage needs an exact version and valid range')
    const resources = this.views.get(viewId) ?? new Map()
    this.views.set(viewId, resources)
    while (this.views.size > this.maxViews) this.views.delete(this.views.keys().next().value!)
    const key = JSON.stringify([reference.id, reference.revision, reference.path ?? null])
    const previous = resources.get(key)
    if (previous && previous.total !== range.total) throw new Error('Resource length changed within the same revision')
    const ranges: Array<[number, number]> = [...(previous?.ranges ?? []), [range.start, range.end]]
    ranges.sort((a, b) => a[0] - b[0])
    const merged: Array<[number, number]> = []
    for (const [start, end] of ranges) {
      const last = merged.at(-1)
      if (last && start <= last[1]) last[1] = Math.max(last[1], end)
      else merged.push([start, end])
    }
    if (merged.length > 256) throw new Error('Read coverage fragment limit exceeded')
    resources.set(key, { total: range.total, ranges: merged })
    while (resources.size > this.maxResources) resources.delete(resources.keys().next().value!)
    return merged.length === 1 && merged[0]![0] === 0 && merged[0]![1] === range.total
  }
  release(viewId: string): void { this.views.delete(viewId) }
}
