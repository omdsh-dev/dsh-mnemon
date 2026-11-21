import type { JsonValue } from '../host/protocol.ts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function jsonRecord(value: JsonValue): Record<string, JsonValue> | undefined {
  return isRecord(value) ? value : undefined
}
