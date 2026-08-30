/** Validate external mutation receipts before retiring or compacting local data. */

const COMMITTED_MUTATION_STATES = new Set([
  'added',
  'committed',
  'completed',
  'created',
  'deleted',
  'forgotten',
  'imported',
  'invalidated',
  'linked',
  'merged',
  'removed',
  'replaced',
  'stored',
  'succeeded',
  'success',
  'updated',
])
const UNCOMMITTED_MUTATION_STATES = new Set([
  'accepted',
  'canceled',
  'cancelled',
  'error',
  'failed',
  'pending',
  'processing',
  'queued',
  'running',
  'skipped',
])
const COMMITTED_MUTATION_COUNTS = ['created', 'deleted', 'edges_inserted', 'imported', 'removed', 'stored', 'updated'] as const

/** A provider mutation is authoritative only after it reports an explicit durable terminal state. */
export function mutationResultCommitted(result: unknown): boolean {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return false
  const value = result as Record<string, unknown>
  const states = [value.action, value.status]
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim().toLocaleLowerCase())
  if (value.success === false || value.ok === false || value.committed === false || value.durable === false) return false
  if (states.some(state => UNCOMMITTED_MUTATION_STATES.has(state))) return false
  if (value.success === true || value.ok === true || value.committed === true || value.durable === true) return true
  if (states.some(state => COMMITTED_MUTATION_STATES.has(state))) return true
  return COMMITTED_MUTATION_COUNTS.some(key => typeof value[key] === 'number' && value[key] > 0)
}
