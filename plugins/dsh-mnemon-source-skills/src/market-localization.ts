import type { LocalizedText } from './contracts.ts'

export type MarketLocalePreference = string | readonly string[]

function localeKey(id: string): string {
  return id.trim().toLowerCase().replaceAll('_', '-')
}

export function localized(value: LocalizedText | undefined, preference: MarketLocalePreference): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  const entries = Object.entries(value)
  const findKey = (target: string): string | undefined => {
    const exact = value[target]
    if (typeof exact === 'string' && exact !== '') return exact
    const match = entries.find(([key, item]) => localeKey(key) === target && typeof item === 'string' && item !== '')
    return match?.[1]
  }
  const candidates = typeof preference === 'string'
    ? [localeKey(preference), localeKey(preference).split('-')[0]!]
    : preference.map(localeKey)
  for (const id of candidates) {
    if (id === '') continue
    const translated = findKey(id) ?? (id === 'zh' ? findKey('zh-cn') : undefined)
    if (translated !== undefined) return translated
  }
  return findKey('en') ?? entries.find(([, item]) => typeof item === 'string' && item !== '')?.[1] ?? ''
}
