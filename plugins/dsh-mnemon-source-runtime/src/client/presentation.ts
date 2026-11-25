import { useMemo } from 'react'
import * as mnemonClient from 'dsh-mnemon/client'
import { memoryPageStyles, memorySidebarStyles, useT as useSharedT, useLocale, type MnemonKey } from 'dsh-mnemon/client'
import type labels from 'dsh-mnemon-source-runtime/presentation/locales.json'
import copy from '../../presentation/locales.json' with { type: 'json' }
import page from '../../presentation/page.module.css'
import sidebar from '../../presentation/sidebar.module.css'

function mergeStyleMap(
  base: Readonly<Record<string, string>>,
  own: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  let ownAnchor: string | null | undefined
  return /* @__PURE__ */ new Proxy<Record<string, string>>({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      if (ownAnchor === undefined) ownAnchor = Object.keys(own)[0] ?? null
      if (ownAnchor !== null) void own[ownAnchor]
      if (Object.hasOwn(own, prop)) {
        if (Object.hasOwn(base, prop)) void base[prop]
        return own[prop]
      }
      return base[prop]
    },
    has(_target, prop) {
      return typeof prop === 'string' && (Object.hasOwn(own, prop) || prop in base)
    },
    ownKeys() {
      return Array.from(new Set([...Reflect.ownKeys(base), ...Reflect.ownKeys(own)]))
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== 'string') return undefined
      const descriptor = Object.getOwnPropertyDescriptor(own, prop) ?? Object.getOwnPropertyDescriptor(base, prop)
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true }
    },
  })
}

export type SourceKey = keyof typeof labels.zh
export const css: Readonly<Record<string, string>> = /* @__PURE__ */ mergeStyleMap(memoryPageStyles, page)
export const sidebarCss: Readonly<Record<string, string>> = /* @__PURE__ */ mergeStyleMap(memorySidebarStyles, sidebar)

const SHIPPED_LOCALES = ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const
type ShippedLocale = typeof SHIPPED_LOCALES[number]
type LocalePreference = string | readonly string[]
const SHIPPED_LOCALE_SET: ReadonlySet<string> = new Set(SHIPPED_LOCALES)

const useLocalePreference: (language: string) => LocalePreference = 'useLocalePreference' in mnemonClient
  ? mnemonClient.useLocalePreference
  : language => language

function shippedLocale(preference: LocalePreference): ShippedLocale {
  const candidates = typeof preference === 'string' ? [preference.trim().replaceAll('_', '-').split('-')[0]!] : preference
  return candidates.map(id => id.toLowerCase()).find((id): id is ShippedLocale => SHIPPED_LOCALE_SET.has(id)) ?? 'en'
}

export function useT(): (key: SourceKey | MnemonKey, params?: Record<string, unknown>) => string {
  const fallback = useSharedT()
  const preference = useLocalePreference(useLocale())
  return useMemo(() => {
    const dictionaries = copy as Record<ShippedLocale, Readonly<Record<SourceKey, string>>>
    const dictionary = dictionaries[shippedLocale(preference)]
    const packFirst = typeof preference === 'string'
      ? !/^(en|zh)([-_]|$)/i.test(preference)
      : preference[0] !== 'en' && preference[0] !== 'zh'
    return (key: SourceKey | MnemonKey, params?: Record<string, unknown>) => {
      if (packFirst) {
        const translated = fallback(key, params)
        if (translated !== key) return translated
      }
      if (!Object.hasOwn(dictionary, key)) return fallback(key, params)
      const text = dictionary[key as SourceKey]
      return params === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
    }
  }, [preference, fallback])
}
