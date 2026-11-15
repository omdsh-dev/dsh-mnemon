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

/** Older Core versions open the component page without lending policy/recall settings. */
export function supportsSettingsSection(section: 'policy' | 'recall'): boolean {
  if (!('supportsMemoryComponentSettingsSection' in mnemonClient)) return false
  const supports = (mnemonClient as { supportsMemoryComponentSettingsSection?: (packageName: string, section: string) => boolean }).supportsMemoryComponentSettingsSection
  return typeof supports === 'function' && supports('dsh-mnemon-source-memory-spaces', section)
}

/**
 * Reveal wrapper that falls back to a plain wrapper beside older dsh-mnemon
 * releases (such as 0.5.31) whose client entry predates `Reveal`.
 */
export function SafeReveal(props: { children: ReactNode; className?: string | undefined }): JSX.Element | null {
  const Impl = (mnemonClient as { Reveal?: (p: { children: ReactNode; className?: string | undefined }) => JSX.Element | null }).Reveal
  if (Impl !== undefined) return createElement(Impl, props)
  if (props.children === null || props.children === undefined || props.children === false) return null
  return props.className === undefined ? createElement('div', null, props.children) : createElement('div', { className: props.className }, props.children)
}

type Translate = (key: SourceKey | MnemonKey, params?: Record<string, unknown>) => string

/** DSH's language service, as a client context carries it. */
export interface DshLocale {
  bind(namespace: 'mnemon'): (key: MnemonKey, params?: Record<string, unknown>) => string
  getSnapshot?(): DshLocaleSnapshot
  subscribe?(listener: () => void): () => void
}

/** The part of DSH's locale snapshot a lookup chain needs. */
export interface DshLocaleSnapshot {
  active: string
  locales: readonly { id: string; fallback?: string }[]
}

// A translation for what is drawn under it, in place of the one the page frame sets.
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
    const dictionary = locale.startsWith('en') ? copy.en : copy.zh
    if (!Object.hasOwn(dictionary, key)) return fallback(key as MnemonKey, params)
    return interpolate(dictionary[key as SourceKey], params)
  }), [override, locale, fallback])
}

/** The languages DSH asks for a key: the active one, then each one's fallback. */
export function languageChain(snapshot: DshLocaleSnapshot): string[] {
  const fallbacks = new Map(snapshot.locales.map(locale => [locale.id, locale.fallback]))
  const chain: string[] = []
  for (let id: string | undefined = snapshot.active; id !== undefined && !chain.includes(id); id = fallbacks.get(id)) chain.push(id)
  return chain
}

/**
 * Translate as dsh-mnemon drew these settings, through DSH's language chain
 * and the `mnemon` namespace it registers this copy in. This copy answers in
 * the first of zh and en the chain reaches; a language pack ahead of that one
 * is asked first, through the namespace, as dsh-mnemon asked it; a key this
 * copy lacks goes to the namespace too. Without DSH's chain the page's
 * language picks the copy, as the page frame does.
 */
export function settingsTranslate(locale: DshLocale, chain: readonly string[] | undefined, language: string): Translate {
  const bound = locale.bind('mnemon')
  const head = chain === undefined ? language.startsWith('en') ? 'en' : 'zh' : chain.find(id => id === 'zh' || id === 'en') ?? 'en'
  const own: Readonly<Record<string, string>> = head === 'en' ? copy.en : copy.zh
  const packFirst = chain !== undefined && chain.length > 0 && chain[0] !== head
  return (key, params) => {
    if (packFirst) {
      const text = bound(key as MnemonKey, params)
      // DSH shows the key itself when no dictionary in the chain has it.
      if (text !== key) return text
    }
    return Object.hasOwn(own, key) ? interpolate(own[key]!, params) : bound(key as MnemonKey, params)
  }
}
