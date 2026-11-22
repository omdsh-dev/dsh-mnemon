import { useMemo } from 'react'
import { memoryPageStyles, memorySidebarStyles, useT as useSharedT, useLocale, type MnemonKey } from 'dsh-mnemon/client'
import type labels from 'dsh-mnemon-source-documents/presentation/locales.json'
import copy from '../../presentation/locales.json' with { type: 'json' }
import page from '../../presentation/page.module.css'
import sidebar from '../../presentation/sidebar.module.css'

export type SourceKey = keyof typeof labels.zh
export const css: Readonly<Record<string, string>> = { ...memoryPageStyles, ...page }
export const sidebarCss: Readonly<Record<string, string>> = { ...memorySidebarStyles, ...sidebar }

const SHIPPED_LOCALES = ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const
type ShippedLocale = typeof SHIPPED_LOCALES[number]
const SHIPPED_LOCALE_SET: ReadonlySet<string> = new Set(SHIPPED_LOCALES)

function matchShippedLocale(locale: string): ShippedLocale | undefined {
  const base = locale.trim().toLowerCase().replaceAll('_', '-').split('-')[0] ?? ''
  return SHIPPED_LOCALE_SET.has(base) ? base as ShippedLocale : undefined
}

export function useT(): (key: SourceKey | MnemonKey, params?: Record<string, unknown>) => string {
  const fallback = useSharedT()
  const locale = useLocale()
  return useMemo(() => (key: SourceKey | MnemonKey, params?: Record<string, unknown>) => {
    const matched = matchShippedLocale(locale)
    const dictionaries = copy as Record<ShippedLocale, Readonly<Record<SourceKey, string>>>
    const dictionary = dictionaries[matched ?? 'en'] ?? copy.en
    if (matched === undefined) {
      const translated = fallback(key as MnemonKey, params)
      if (translated !== key) return translated
    }
    if (!Object.hasOwn(dictionary, key)) return fallback(key as MnemonKey, params)
    const text = dictionary[key as SourceKey]
    return params === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
  }, [locale, fallback])
}
