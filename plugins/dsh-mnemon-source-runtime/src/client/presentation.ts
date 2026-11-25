import { createElement, useMemo, type JSX } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import * as mnemonClient from 'dsh-mnemon/client'
import { memoryPageStyles, memorySidebarStyles, useT as useSharedT, useLocale, type MnemonKey, type MnemonTooltipProps } from 'dsh-mnemon/client'
import type labels from 'dsh-mnemon-source-runtime/presentation/locales.json'
import copy from '../../presentation/locales.json' with { type: 'json' }
import page from '../../presentation/page.module.css'
import sidebar from '../../presentation/sidebar.module.css'

export type SourceKey = keyof typeof labels.zh
export const css: Readonly<Record<string, string>> = { ...memoryPageStyles, ...page }
export const sidebarCss: Readonly<Record<string, string>> = { ...memorySidebarStyles, ...sidebar }

export function MnemonTooltip(props: MnemonTooltipProps): JSX.Element {
  const Impl = 'MnemonTooltip' in mnemonClient
    ? (mnemonClient as { MnemonTooltip?: (value: MnemonTooltipProps) => JSX.Element }).MnemonTooltip
    : undefined
  if (Impl !== undefined) return createElement(Impl, props)
  const label = props.label?.trim() ?? ''
  return createElement(Tooltip, {
    label,
    side: props.side ?? 'top',
    ...(props.align === undefined ? {} : { align: props.align }),
    ...(props.delayMs === undefined ? {} : { delayMs: props.delayMs }),
    ...(props.focusDelayMs === undefined ? {} : { focusDelayMs: props.focusDelayMs }),
    ...(props.maxWidth === undefined ? {} : { maxWidth: props.maxWidth }),
    disabled: props.disabled === true || label === '' || typeof ResizeObserver !== 'function',
    portal: props.portal !== false,
    children: props.children,
  })
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
