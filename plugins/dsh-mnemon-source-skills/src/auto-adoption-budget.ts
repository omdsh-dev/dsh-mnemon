import type { AutoAdoptionQuota } from './contracts.ts'

export interface BudgetEntry {
  id: string
  suggestionId: string
  identity: string
  at: string
}
export function quotaSettings(limit: number, timeZone: string): { limit: number; timeZone: string } {
  if (!Number.isInteger(limit) || limit < 0 || limit > 100) throw new Error('Automatic adoption daily limit must be 0..100')
  const zone = timeZone === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : timeZone
  if (!zone || zone.length > 100) throw new Error('Automatic adoption time zone must be an IANA time zone or local')
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(0) } catch { throw new Error('Automatic adoption time zone must be an IANA time zone or local') }
  return { limit, timeZone: zone }
}
function dateIn(at: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone, calendar: 'iso8601', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at))
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-')
}
export function quota(entries: readonly BudgetEntry[], now: Date, limit: number, timeZone: string): AutoAdoptionQuota {
  const settings = quotaSettings(limit, timeZone)
  const date = dateIn(now, settings.timeZone)
  return { ...settings, date, used: entries.filter(entry => dateIn(entry.at, settings.timeZone) === date).length }
}
export function inQuotaDay(entry: BudgetEntry, value: AutoAdoptionQuota): boolean {
  return dateIn(entry.at, value.timeZone) === value.date
}
/** Three days cover a calendar day even after changing between extreme IANA offsets. */
export function retainedBudget(entries: readonly BudgetEntry[], now: Date): BudgetEntry[] {
  return entries.filter(entry => Date.parse(entry.at) >= now.getTime() - 72 * 60 * 60 * 1_000)
}
export function readBudget(value: unknown): BudgetEntry[] | undefined {
  if (value === undefined) return undefined
  const file = value as { version?: unknown; entries?: unknown }
  if (file?.version !== 1 || !Array.isArray(file.entries) || file.entries.some(entry =>
    entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.suggestionId !== 'string'
      || typeof entry.identity !== 'string' || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at)))) {
    throw new Error('Automatic adoption budget is unreadable; manual review remains available')
  }
  return file.entries as BudgetEntry[]
}
