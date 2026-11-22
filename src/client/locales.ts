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
import { coreDe } from './locales/de.ts'
import { coreEn } from './locales/en.ts'
import { coreEs } from './locales/es.ts'
import { coreFr } from './locales/fr.ts'
import { coreJa } from './locales/ja.ts'
import { corePt } from './locales/pt.ts'
import { coreRu } from './locales/ru.ts'
import { zh, type CoreMnemonKey } from './locales/zh.ts'

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

export const mnemonLocales: Readonly<Record<MnemonLocaleId, Record<MnemonKey, string>>> = {
  en,
  zh: zh as unknown as Record<MnemonKey, string>,
  ja: coreJa as unknown as Record<MnemonKey, string>,
  es: coreEs as unknown as Record<MnemonKey, string>,
  fr: coreFr as unknown as Record<MnemonKey, string>,
  de: coreDe as unknown as Record<MnemonKey, string>,
  ru: coreRu as unknown as Record<MnemonKey, string>,
  pt: corePt as unknown as Record<MnemonKey, string>,
}

export type MnemonTranslate = (key: MnemonKey, params?: Record<string, unknown>) => string

function interpolate(dictionary: Record<string, string>, key: MnemonKey, params?: Record<string, unknown>): string {
  const template = dictionary[key] ?? en[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

export function translateZh(key: MnemonKey, params?: Record<string, unknown>): string {
  return interpolate(zh, key, params)
}

export function translateEn(key: MnemonKey, params?: Record<string, unknown>): string {
  return interpolate(en, key, params)
}

const TRANSLATORS: Readonly<Record<MnemonLocaleId, MnemonTranslate>> = {
  en: translateEn,
  zh: translateZh,
  ja: (key, params) => interpolate(mnemonLocales.ja, key, params),
  es: (key, params) => interpolate(mnemonLocales.es, key, params),
  fr: (key, params) => interpolate(mnemonLocales.fr, key, params),
  de: (key, params) => interpolate(mnemonLocales.de, key, params),
  ru: (key, params) => interpolate(mnemonLocales.ru, key, params),
  pt: (key, params) => interpolate(mnemonLocales.pt, key, params),
}

const BUILT_IN_TRANSLATORS: ReadonlySet<MnemonTranslate> = new Set(Object.values(TRANSLATORS))

export function translateFor(preference: LocalePreference): MnemonTranslate {
  return TRANSLATORS[resolveMnemonLocale(preference)]
}

export function isBuiltInTranslate(translate: MnemonTranslate): boolean {
  return BUILT_IN_TRANSLATORS.has(translate)
}
