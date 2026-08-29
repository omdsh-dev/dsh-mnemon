import { randomUUID } from 'node:crypto'
import type { MemoryJsonValue, MemoryMutationReceipt } from '../../packages/contracts/src/index.ts'

export function record(value: MemoryJsonValue, label: string): Record<string, MemoryJsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

export function text(value: MemoryJsonValue | undefined, label: string, maximum: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const normalized = value.trim()
  if (required && normalized === '') throw new Error(`${label} is required`)
  if (normalized.length > maximum) throw new Error(`${label} is too long (max ${maximum} characters)`)
  return normalized === '' ? undefined : normalized
}

export function integer(value: MemoryJsonValue | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`value must be an integer within ${minimum}..${maximum}`)
  }
  return value
}

export function stringArray(value: MemoryJsonValue | undefined, label: string, maximum = 50): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > maximum || value.some(item => typeof item !== 'string')) throw new Error(`${label} must be a string array`)
  return value.map(item => (item as string).trim()).filter(Boolean)
}

export function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`
}

export function receipt(
  viewId: string,
  offerId: string,
  sourceInstanceKey: string,
  revision: string | undefined,
  details: MemoryJsonValue,
): MemoryMutationReceipt {
  return {
    id: `receipt:${randomUUID()}`,
    viewId,
    offerId,
    sourceInstanceKey,
    status: 'succeeded',
    committedAt: new Date().toISOString(),
    ...(revision === undefined ? {} : { revision }),
    details,
  }
}
