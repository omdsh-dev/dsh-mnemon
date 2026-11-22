export const MNEMON_LOCALE_IDS = ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const

export type MnemonLocaleId = typeof MNEMON_LOCALE_IDS[number]

const MNEMON_LOCALE_SET: ReadonlySet<string> = new Set(MNEMON_LOCALE_IDS)

export function isMnemonLocaleId(value: string): value is MnemonLocaleId {
  return MNEMON_LOCALE_SET.has(value)
}

export function matchMnemonLocale(language: string): MnemonLocaleId | undefined {
  const normalized = language.trim().toLowerCase().replaceAll('_', '-')
  if (normalized === '') return undefined
  const base = normalized.split('-')[0] ?? ''
  return isMnemonLocaleId(base) ? base : undefined
}

export function resolveMnemonLocale(language: string): MnemonLocaleId {
  return matchMnemonLocale(language) ?? 'en'
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

export function pickLocalizedText(value: LocalizedTextInput | undefined, language: string): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  const record = value as Readonly<Record<string, string | undefined>>
  const normalized = language.trim().toLowerCase().replaceAll('_', '-')
  const entries = Object.entries(record)
  const findKey = (target: string): string | undefined => {
    const exact = record[target]
    if (typeof exact === 'string' && exact !== '') return exact
    const match = entries.find(([key, item]) => key.toLowerCase() === target && typeof item === 'string' && item !== '')
    return match?.[1]
  }
  if (normalized !== '') {
    const exact = findKey(normalized)
    if (exact !== undefined) return exact
    const base = normalized.split('-')[0] ?? ''
    if (base !== '') {
      const fromBase = findKey(base)
      if (fromBase !== undefined) return fromBase
      if (base === 'zh') {
        const zhCn = findKey('zh-cn')
        if (zhCn !== undefined) return zhCn
      }
    }
  }
  const en = findKey('en')
  if (en !== undefined) return en
  const first = entries.find(([, item]) => typeof item === 'string' && item !== '')
  return first?.[1] ?? ''
}
