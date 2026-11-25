import { createContext, createElement, useContext, useMemo, type JSX, type ReactNode } from 'react'
import * as mnemonClient from 'dsh-mnemon/client'
import { memoryPageStyles, memorySidebarStyles, useT as useSharedT, useLocale, type MnemonKey } from 'dsh-mnemon/client'
import type labels from 'dsh-mnemon-source-memory-spaces/presentation/locales.json'
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

export function supportsSettingsSection(section: 'policy' | 'recall'): boolean {
  if (!('supportsMemoryComponentSettingsSection' in mnemonClient)) return false
  const supports = (mnemonClient as { supportsMemoryComponentSettingsSection?: (packageName: string, section: string) => boolean }).supportsMemoryComponentSettingsSection
  return typeof supports === 'function' && supports('dsh-mnemon-source-memory-spaces', section)
}

export function SafeReveal(props: { children: ReactNode; className?: string | undefined }): JSX.Element | null {
  const Impl = (mnemonClient as { Reveal?: (p: { children: ReactNode; className?: string | undefined }) => JSX.Element | null }).Reveal
  if (Impl !== undefined) return createElement(Impl, props)
  if (props.children === null || props.children === undefined || props.children === false) return null
  return props.className === undefined ? createElement('div', null, props.children) : createElement('div', { className: props.className }, props.children)
}

type Translate = (key: SourceKey | MnemonKey, params?: Record<string, unknown>) => string

export interface DshLocale {
  bind(namespace: 'mnemon'): (key: MnemonKey, params?: Record<string, unknown>) => string
  getSnapshot?(): DshLocaleSnapshot
  subscribe?(listener: () => void): () => void
}

export interface DshLocaleSnapshot {
  active: string
  locales: readonly { id: string; fallback?: string }[]
}

const TranslationOverride = createContext<Translate | undefined>(undefined)
export const SourceTranslation = TranslationOverride.Provider

function interpolate(text: string, params?: Record<string, unknown>): string {
  return params === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

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

function sourceTranslate(bound: Translate, preference: LocalePreference): Translate {
  const dictionaries = copy as Record<ShippedLocale, Readonly<Record<SourceKey, string>>>
  const dictionary = dictionaries[shippedLocale(preference)]
  const packFirst = typeof preference === 'string'
    ? !/^(en|zh)([-_]|$)/i.test(preference)
    : preference[0] !== 'en' && preference[0] !== 'zh'
  return (key, params) => {
    if (packFirst) {
      const text = bound(key, params)
      if (text !== key) return text
    }
    return Object.hasOwn(dictionary, key) ? interpolate(dictionary[key as SourceKey], params) : bound(key, params)
  }
}

export function useT(): Translate {
  const override = useContext(TranslationOverride)
  const fallback = useSharedT()
  const preference = useLocalePreference(useLocale())
  return useMemo(() => override ?? sourceTranslate(fallback, preference), [override, preference, fallback])
}

export function languageChain(snapshot: DshLocaleSnapshot): string[] {
  const fallbacks = new Map(snapshot.locales.map(locale => [locale.id, locale.fallback]))
  const chain: string[] = []
  for (let id: string | undefined = snapshot.active; id !== undefined; id = fallbacks.get(id)) {
    if (chain.includes(id) || (chain.length > 0 && !fallbacks.has(id))) break
    chain.push(id)
  }
  if (!chain.includes('en')) chain.push('en')
  return chain
}

export function settingsTranslate(locale: DshLocale, chain: readonly string[] | undefined, language: string): Translate {
  return sourceTranslate(locale.bind('mnemon'), chain ?? language)
}
