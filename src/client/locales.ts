import {
  isMnemonLocaleId,
  matchMnemonLocale,
  MNEMON_LOCALE_IDS,
  pickLocalizedText,
  resolveMnemonLocale,
  type LocalePreference,
  type LocalizedTextInput,
  type MnemonLocaleId,
} from './localized-text.ts'
import { coreLocales, type CoreMnemonKey } from './locales/catalog.ts'
import { coreEn } from './locales/en.ts'
import { zh } from './locales/zh.ts'

export {
  isMnemonLocaleId,
  matchMnemonLocale,
  MNEMON_LOCALE_IDS,
  pickLocalizedText,
  resolveMnemonLocale,
  zh,
  type LocalePreference,
  type LocalizedTextInput,
  type MnemonLocaleId,
}

export type MnemonKey = CoreMnemonKey | (string & {})

export const en: Record<MnemonKey, string> = coreEn as unknown as Record<MnemonKey, string>

export const mnemonLocales: Readonly<Record<MnemonLocaleId, Record<MnemonKey, string>>> =
  coreLocales as unknown as Readonly<Record<MnemonLocaleId, Record<MnemonKey, string>>>

export type MnemonTranslate = (key: MnemonKey, params?: Record<string, unknown>) => string

function interpolate(locale: MnemonLocaleId, key: MnemonKey, params?: Record<string, unknown>): string {
  const template = mnemonLocales[locale][key] ?? mnemonLocales.en[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

export function translateZh(key: MnemonKey, params?: Record<string, unknown>): string {
  return interpolate('zh', key, params)
}

export function translateEn(key: MnemonKey, params?: Record<string, unknown>): string {
  return interpolate('en', key, params)
}

const TRANSLATORS: Readonly<Record<MnemonLocaleId, MnemonTranslate>> = {
  en: translateEn,
  zh: translateZh,
  ja: (key, params) => interpolate('ja', key, params),
  es: (key, params) => interpolate('es', key, params),
  fr: (key, params) => interpolate('fr', key, params),
  de: (key, params) => interpolate('de', key, params),
  ru: (key, params) => interpolate('ru', key, params),
  pt: (key, params) => interpolate('pt', key, params),
}

const BUILT_IN_TRANSLATORS: ReadonlySet<MnemonTranslate> = new Set(Object.values(TRANSLATORS))

export function translateFor(preference: LocalePreference): MnemonTranslate {
  return TRANSLATORS[resolveMnemonLocale(preference)]
}

export function isBuiltInTranslate(translate: MnemonTranslate): boolean {
  return BUILT_IN_TRANSLATORS.has(translate)
}
