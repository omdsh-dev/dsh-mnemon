import type { MnemonActionSeat } from './action-seat.ts'
import { isRecord } from './is-record.ts'

export interface StarterUpdateRecord {
  at: number
  from?: string
  to?: string
}

const STORAGE_KEY = 'dsh-mnemon.starter-update'
const FRESH_MS = 10 * 60_000

function sessionStore(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage
  } catch {
    return undefined
  }
}

export function recordStarterUpdate(update: { from?: string | undefined; to?: string | undefined }, now = Date.now()): void {
  const record: StarterUpdateRecord = { at: now, ...(update.from === undefined ? {} : { from: update.from }), ...(update.to === undefined ? {} : { to: update.to }) }
  try {
    sessionStore()?.setItem(STORAGE_KEY, JSON.stringify(record))
  } catch {
  }
}

export function clearStarterUpdate(): void {
  try {
    sessionStore()?.removeItem(STORAGE_KEY)
  } catch {
  }
}

export function pendingStarterUpdate(now = Date.now()): StarterUpdateRecord | undefined {
  let raw: string | null | undefined
  try {
    raw = sessionStore()?.getItem(STORAGE_KEY)
  } catch {
    return undefined
  }
  if (raw === null || raw === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    value = undefined
  }
  if (!isRecord(value) || typeof value.at !== 'number' || now - value.at > FRESH_MS || value.at > now + 60_000) {
    clearStarterUpdate()
    return undefined
  }
  return {
    at: value.at,
    ...(typeof value.from === 'string' ? { from: value.from } : {}),
    ...(typeof value.to === 'string' ? { to: value.to } : {}),
  }
}

export function reopenAfterStarterUpdate(workspace: MnemonActionSeat): () => void {
  if (pendingStarterUpdate() === undefined) return () => {}
  let unsubscribe: (() => void) | undefined
  const attempt = (): void => {
    const open = workspace.getSnapshot()
    if (open === undefined) return
    unsubscribe?.()
    unsubscribe = undefined
    if (pendingStarterUpdate() !== undefined) open()
  }
  unsubscribe = workspace.subscribe(attempt)
  attempt()
  return () => { unsubscribe?.() }
}
