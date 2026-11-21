import { createContext, createElement, useContext, useMemo, type JSX, type ReactNode } from 'react'
import * as mnemonClient from 'dsh-mnemon/client'
import { memoryPageStyles, memorySidebarStyles, useT as useSharedT, useLocale, type MnemonKey } from 'dsh-mnemon/client'
import type labels from 'dsh-mnemon-source-memory-spaces/presentation/locales.json'
import copy from '../../presentation/locales.json' with { type: 'json' }
import page from '../../presentation/page.module.css'
import sidebar from '../../presentation/sidebar.module.css'

export type SourceKey = keyof typeof labels.zh
export const css: Readonly<Record<string, string>> = { ...memoryPageStyles, ...page }
export const sidebarCss: Readonly<Record<string, string>> = { ...memorySidebarStyles, ...sidebar }

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

export function useT(): Translate {
  const override = useContext(TranslationOverride)
  const fallback = useSharedT()
  const locale = useLocale()
  return useMemo(() => override ?? ((key: SourceKey | MnemonKey, params?: Record<string, unknown>) => {
    const dictionary = locale.toLowerCase().startsWith('zh') ? copy.zh : copy.en
    if (!/^(en|zh)(-|$)/i.test(locale)) {
      const translated = fallback(key as MnemonKey, params)
      if (translated !== key) return translated
    }
    if (!Object.hasOwn(dictionary, key)) return fallback(key as MnemonKey, params)
    return interpolate(dictionary[key as SourceKey], params)
  }), [override, locale, fallback])
}

export function languageChain(snapshot: DshLocaleSnapshot): string[] {
  const fallbacks = new Map(snapshot.locales.map(locale => [locale.id, locale.fallback]))
  const chain: string[] = []
  for (let id: string | undefined = snapshot.active; id !== undefined && !chain.includes(id); id = fallbacks.get(id)) chain.push(id)
  return chain
}

export function settingsTranslate(locale: DshLocale, chain: readonly string[] | undefined, language: string): Translate {
  const bound = locale.bind('mnemon')
  const head = chain === undefined ? language.toLowerCase().startsWith('zh') ? 'zh' : 'en' : chain.find(id => id === 'zh' || id === 'en') ?? 'en'
  const own: Readonly<Record<string, string>> = head === 'en' ? copy.en : copy.zh
  const packFirst = chain !== undefined && chain.length > 0 && chain[0] !== head
  return (key, params) => {
    if (packFirst) {
      const text = bound(key as MnemonKey, params)
      if (text !== key) return text
    }
    return Object.hasOwn(own, key) ? interpolate(own[key]!, params) : bound(key as MnemonKey, params)
  }
}
