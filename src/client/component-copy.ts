import { STARTER_COMPONENT_ROWS } from '../host/protocol.ts'
import type { MemoryPluginEntryView } from '../host/view-protocol.ts'
import type { MnemonTranslate } from './locales.ts'
import { pickLocalizedText, type LocalePreference } from './localized-text.ts'

const SHIPPED_PACKAGES: ReadonlySet<string> = new Set(STARTER_COMPONENT_ROWS.map(row => row.packageName))

const EXPERIMENTAL_PACKAGES: ReadonlySet<string> = new Set(['dsh-mnemon-source-skills'])

export function isExperimental(entry: Pick<MemoryPluginEntryView, 'packageName'>): boolean {
  return EXPERIMENTAL_PACKAGES.has(entry.packageName)
}

export function isShipped(entry: MemoryPluginEntryView): boolean {
  return SHIPPED_PACKAGES.has(entry.packageName)
}

export function componentCopy(entry: Pick<MemoryPluginEntryView, 'label' | 'description'>, preference: LocalePreference): { label: string; hint: string } {
  return {
    label: pickLocalizedText(entry.label, preference),
    hint: pickLocalizedText(entry.description, preference),
  }
}

export function nameList(names: readonly string[], t: MnemonTranslate): string {
  return names.map(name => t('config.quoted', { name })).join(t('config.listSeparator'))
}
