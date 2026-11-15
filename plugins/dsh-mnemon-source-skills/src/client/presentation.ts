import { useMemo } from 'react'
import * as mnemonClient from 'dsh-mnemon/client'
import { memoryPageStyles, memorySidebarStyles, useLocale } from 'dsh-mnemon/client'
import copy from '../../presentation/locales.json' with { type: 'json' }
import page from '../../presentation/page.module.css'

export type SkillsKey = keyof typeof copy.zh
export type SkillsTranslate = (key: SkillsKey, params?: Record<string, unknown>) => string

export const css: Readonly<Record<string, string>> = { ...memoryPageStyles, ...page }
export const sidebarCss: Readonly<Record<string, string>> = memorySidebarStyles

/** Older Core versions have generic settings navigation but no model or market section. */
export function supportsSettingsSection(section: 'models' | 'market'): boolean {
  if (!('supportsMemoryComponentSettingsSection' in mnemonClient)) return false
  const supports = (mnemonClient as { supportsMemoryComponentSettingsSection?: (packageName: string, section: string) => boolean }).supportsMemoryComponentSettingsSection
  return typeof supports === 'function' && supports('dsh-mnemon-source-skills', section)
}

export function translate(locale: string): SkillsTranslate {
  const dictionary: Record<string, string> = locale.startsWith('en') ? copy.en : copy.zh
  return (key, params) => {
    const text = dictionary[key] ?? copy.zh[key] ?? key
    if (params === undefined) return text
    // English words after a count: {count:case|cases} follows the parameter it names.
    return text
      .replace(/\{(\w+):([^|{}]*)\|([^{}]*)\}/gu, (match, name: string, one: string, other: string) => name in params ? (Number(params[name]) === 1 ? one : other) : match)
      .replace(/\{(\w+)\}/gu, (match, name: string) => name in params ? String(params[name]) : match)
  }
}

export function useT(): SkillsTranslate {
  const locale = useLocale()
  return useMemo(() => translate(locale), [locale])
}

export function percent(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value * 100)}%`
}

/** A large count the way the language says it short: 21.4万, 214K. */
export function compactCount(count: number, language: string): string {
  return new Intl.NumberFormat(language.startsWith('zh') ? 'zh-CN' : 'en', { notation: 'compact', maximumSignificantDigits: 3 }).format(count)
}

export function points(value: number | undefined): string {
  return value === undefined ? '—' : String(Math.round(value * 100))
}

/** "3 min ago" in the page's language; older than a week shows the date. */
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
