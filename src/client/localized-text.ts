export const MNEMON_LOCALE_IDS = ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const

export type MnemonLocaleId = typeof MNEMON_LOCALE_IDS[number]

export type LocalePreference = string | readonly string[]

export interface LocaleSelection {
  active: string
  locales: readonly { id: string; fallback?: string }[]
}

const MNEMON_LOCALE_SET: ReadonlySet<string> = new Set(MNEMON_LOCALE_IDS)

function normalizeLocale(language: string): string {
  return language.trim().toLowerCase().replaceAll('_', '-')
}

export function isMnemonLocaleId(value: string): value is MnemonLocaleId {
  return MNEMON_LOCALE_SET.has(value)
}

export function matchMnemonLocale(language: string): MnemonLocaleId | undefined {
  const base = normalizeLocale(language).split('-')[0] ?? ''
  return isMnemonLocaleId(base) ? base : undefined
}

export function resolveMnemonLocale(preference: LocalePreference): MnemonLocaleId {
  return (typeof preference === 'string'
    ? matchMnemonLocale(preference)
    : preference.map(normalizeLocale).find(isMnemonLocaleId)) ?? 'en'
}

export function localeFallbackChain(snapshot: LocaleSelection): readonly string[] {
  const fallbacks = new Map(snapshot.locales.map(({ id, fallback }) => [normalizeLocale(id), fallback]))
  const chain: string[] = []
  const seen = new Set<string>()
  for (let id: string | undefined = snapshot.active; id !== undefined;) {
    const key = normalizeLocale(id)
    if (seen.has(key) || (chain.length > 0 && !fallbacks.has(key))) break
    seen.add(key)
    chain.push(id)
    id = fallbacks.get(key)
  }
  if (!seen.has('en')) chain.push('en')
  return chain
}

export type LocalizedTextInput =
  | string
  | {
    readonly en?: string
    readonly 'zh-CN'?: string
    readonly zh?: string
    readonly ja?: string
    readonly es?: string
    readonly fr?: string
    readonly de?: string
    readonly ru?: string
    readonly pt?: string
  }
  | Readonly<Record<string, string | undefined>>

export function pickLocalizedText(value: LocalizedTextInput | null | undefined, preference: LocalePreference): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  const record = value as Readonly<Record<string, string | undefined>>
  const entries = Object.entries(record)
  const findKey = (target: string): string | undefined => {
    const exact = record[target]
    if (typeof exact === 'string' && exact !== '') return exact
    const match = entries.find(([key, item]) => normalizeLocale(key) === target && typeof item === 'string' && item !== '')
    return match?.[1]
  }
  const candidates = typeof preference === 'string'
    ? [normalizeLocale(preference), normalizeLocale(preference).split('-')[0]!]
    : preference.map(normalizeLocale)
  for (const id of candidates) {
    if (id === '') continue
    const translated = findKey(id) ?? (id === 'zh' ? findKey('zh-cn') : undefined)
    if (translated !== undefined) return translated
  }
  const en = findKey('en')
  if (en !== undefined) return en
  const first = entries.find(([, item]) => typeof item === 'string' && item !== '')
  return first?.[1] ?? ''
}
