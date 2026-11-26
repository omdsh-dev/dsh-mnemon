import { cloneElement, createElement, useMemo, type JSX, type ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import * as mnemonClient from 'dsh-mnemon/client'
import { memoryPageStyles, memorySidebarStyles, useLocale, useT as useSharedT, type MnemonKey, type MnemonTooltipProps } from 'dsh-mnemon/client'
import copy from '../../presentation/locales.json' with { type: 'json' }
import page from '../../presentation/page.module.css'

export type SkillsKey = keyof typeof copy.zh
export type SkillsTranslate = (key: SkillsKey, params?: Record<string, unknown>) => string

export const css: Readonly<Record<string, string>> = { ...memoryPageStyles, ...page }
export const sidebarCss: Readonly<Record<string, string>> = memorySidebarStyles

export function MnemonTooltip(props: MnemonTooltipProps): JSX.Element {
  const Impl = 'MnemonTooltip' in mnemonClient
    ? (mnemonClient as { MnemonTooltip?: (value: MnemonTooltipProps) => JSX.Element }).MnemonTooltip
    : undefined
  if (Impl !== undefined) return createElement(Impl, props)
  const label = props.label?.trim() ?? ''
  if (props.onlyWhenClipped === true) {
    return cloneElement(props.children as ReactElement<{ title?: string | undefined }>, {
      title: props.disabled === true || label === '' ? undefined : label,
    })
  }
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

export function supportsSettingsSection(section: 'models' | 'market'): boolean {
  if (!('supportsMemoryComponentSettingsSection' in mnemonClient)) return false
  const supports = (mnemonClient as { supportsMemoryComponentSettingsSection?: (packageName: string, section: string) => boolean }).supportsMemoryComponentSettingsSection
  return typeof supports === 'function' && supports('dsh-mnemon-source-skills', section)
}

const SHIPPED_LOCALES = ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const
type ShippedLocale = typeof SHIPPED_LOCALES[number]
type LocalePreference = string | readonly string[]
const SHIPPED_LOCALE_SET: ReadonlySet<string> = new Set(SHIPPED_LOCALES)

export const useLocalePreference: (language: string) => LocalePreference = 'useLocalePreference' in mnemonClient
  ? mnemonClient.useLocalePreference
  : language => language

function shippedLocale(preference: LocalePreference): ShippedLocale {
  const candidates = typeof preference === 'string' ? [preference.trim().replaceAll('_', '-').split('-')[0]!] : preference
  return candidates.map(id => id.toLowerCase()).find((id): id is ShippedLocale => SHIPPED_LOCALE_SET.has(id)) ?? 'en'
}

function selectPlural(locale: ShippedLocale, count: number, forms: readonly string[]): string {
  if (forms.length === 3) {
    const category = new Intl.PluralRules(locale).select(count)
    return category === 'one' ? forms[0]! : category === 'few' ? forms[1]! : forms[2]!
  }
  return count === 1 ? forms[0]! : forms[1]!
}

export function translate(preference: LocalePreference): SkillsTranslate {
  const resolved = shippedLocale(preference)
  const dictionaries = copy as Record<ShippedLocale, Readonly<Record<string, string>>>
  const dictionary: Readonly<Record<string, string>> = dictionaries[resolved] ?? copy.en
  return (key, params) => {
    const text = dictionary[key] ?? copy.en[key] ?? key
    if (params === undefined) return text
    return text
      .replace(/\{(\w+):([^{}]+)\}/gu, (match, name: string, spec: string) => {
        if (!(name in params)) return match
        const forms = spec.split('|')
        if (forms.length !== 2 && forms.length !== 3) return match
        return selectPlural(resolved, Number(params[name]), forms)
      })
      .replace(/\{(\w+)\}/gu, (match, name: string) => name in params ? String(params[name]) : match)
  }
}

export function useT(): SkillsTranslate {
  const preference = useLocalePreference(useLocale())
  const shared = useSharedT()
  return useMemo(() => {
    const fallback = translate(preference)
    const packFirst = typeof preference === 'string'
      ? !/^(en|zh)([-_]|$)/i.test(preference)
      : preference[0] !== 'en' && preference[0] !== 'zh'
    if (!packFirst) return fallback
    return (key: SkillsKey, params?: Record<string, unknown>) => {
      const text = shared(key as MnemonKey, params)
      return text === key ? fallback(key, params) : text
    }
  }, [preference, shared])
}

export function percent(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value * 100)}%`
}

export function compactCount(count: number, language: string): string {
  const normalized = language.trim().replaceAll('_', '-')
  const tag = normalized.toLowerCase().startsWith('zh') ? 'zh-CN' : normalized || 'en'
  try {
    return new Intl.NumberFormat(tag, { notation: 'compact', maximumSignificantDigits: 3 }).format(count)
  } catch {
    return new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 }).format(count)
  }
}

export function points(value: number | undefined): string {
  return value === undefined ? '—' : String(Math.round(value * 100))
}

export function relative(t: SkillsTranslate, iso: string | undefined, now = Date.now()): string {
  if (iso === undefined) return '—'
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return '—'
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 60) return t('time.justNow')
  if (seconds < 3600) return t('time.minutes', { count: Math.floor(seconds / 60) })
  if (seconds < 86_400) return t('time.hours', { count: Math.floor(seconds / 3600) })
  if (seconds < 7 * 86_400) return t('time.days', { count: Math.floor(seconds / 86_400) })
  return new Date(time).toLocaleDateString()
}

export function stamp(iso: string | undefined): string {
  if (iso === undefined) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
