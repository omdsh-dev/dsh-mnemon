// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createDshHostRequire } from '../scripts/dsh-host-packages.ts'
import { componentCopy } from '../src/client/component-copy.ts'
import { registerMnemonLocales } from '../src/client/locale-registration.ts'
import { localeFallbackChain } from '../src/client/localized-text.ts'
import { I18nContext, LocaleFallbackContext, useT as useCoreT } from '../src/client/page-kit.tsx'
import { MemorySourcePageFrame } from '../src/client/page-client.tsx'
import {
  MNEMON_LOCALE_IDS,
  mnemonLocales,
  pickLocalizedText,
  resolveMnemonLocale,
  translateEn,
  translateFor,
  type MnemonKey,
  type MnemonTranslate,
} from '../src/client/locales.ts'
import { useT as useRuntimeT } from '../plugins/dsh-mnemon-source-runtime/src/client/presentation.ts'
import { useT as useDocumentsT } from '../plugins/dsh-mnemon-source-documents/src/client/presentation.ts'
import { languageChain as spacesLanguageChain, useT as useSpacesT, settingsTranslate } from '../plugins/dsh-mnemon-source-memory-spaces/src/client/presentation.ts'
import { compactCount, useT as useSkillsT, translate as skillsTranslate } from '../plugins/dsh-mnemon-source-skills/src/client/presentation.ts'
import { localized as marketLocalized, parseRegistry } from '../plugins/dsh-mnemon-source-skills/src/market.ts'
import { defineMemoryPlugin } from '../src/core/definitions.ts'
import { defineMemoryStrategyConfiguration } from '../src/sdk/strategy-configuration.ts'

afterEach(cleanup)

const ROOT = process.cwd()
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u
const HAN_PATTERN = /[\u4e00-\u9fff]/u

function createLocaleRuntime(): LocaleRuntime {
  const require = createRequire(import.meta.url)
  const host = process.env.DSH_HOST_ROOT
  const hostRequire = createDshHostRequire(host === undefined
    ? require.resolve('@deepseek-ai/dsh/package.json')
    : resolve(host, 'package.json'))
  const bundle = resolve(dirname(hostRequire.resolve('@deepseek-ai/dsh-client-locale/package.json')), 'lib/client.js')
  let Runtime: typeof LocaleRuntime | undefined
  new Function('window', readFileSync(bundle, 'utf8'))({
    __ModuleLoader__: {
      load(entry: { factory(require: (id: string) => unknown): { LocaleRuntime: typeof LocaleRuntime } }) {
        Runtime = entry.factory(() => ({})).LocaleRuntime
      },
    },
  })
  return new Runtime!({ emit() {} } as never, undefined, { languages: ['en'], preference: null })
}

function addLanguage(locale: LocaleRuntime, id: string, fallback = 'en'): void {
  if (!locale.getSnapshot().locales.some(entry => entry.id === id)) locale.addLanguage({ id, label: id, fallback })
}

function placeholdersOf(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(/\{(\w+)(?::[^{}]*)?\}/gu)) names.add(match[1]!)
  return [...names].sort()
}

function Labels() {
  const core = useCoreT(), runtime = useRuntimeT(), documents = useDocumentsT(), spaces = useSpacesT(), skills = useSkillsT()
  return <>
    <p data-testid="core">{core('common.cancel')}</p>
    <p data-testid="runtime">{runtime('runtime.title')}</p>
    <p data-testid="documents">{documents('documents.title')}</p>
    <p data-testid="spaces">{spaces('search.title')}</p>
    <p data-testid="skills">{skills('page.title')}</p>
    <p data-testid="runtime-total">{runtime('runtime.total', { count: 3 })}</p>
    <p data-testid="skills-trash">{skills('tabs.trash', { count: 2 })}</p>
    <p data-testid="unknown">{core('unknown.translation' as MnemonKey)}</p>
  </>
}

describe('Source locale fallback, built-in 8 languages, and language packs', () => {
  it.each(['it', 'it-IT', 'ko', 'en', 'en-GB'])('uses English for missing or English %s translations', locale => {
    render(<MemorySourcePageFrame locale={locale}><Labels /></MemorySourcePageFrame>)
    for (const text of ['Cancel', 'Runtime Memory', 'Project Documents', 'Recall Memory', 'Skills', '3 entries', 'items removed', 'unknown.translation']) expect(screen.getByText(text)).toBeTruthy()
  })

  it.each(['zh', 'zh-CN', 'zh-TW', 'ZH-cn'])('preserves Chinese for %s', locale => {
    render(<MemorySourcePageFrame locale={locale}><Labels /></MemorySourcePageFrame>)
    expect(screen.getByText('取消')).toBeTruthy()
    expect(screen.queryByText('Runtime Memory')).toBeNull()
    expect(screen.queryByText('Project Documents')).toBeNull()
    expect(screen.queryByText('Recall Memory')).toBeNull()
    expect(screen.queryByText('Skills')).toBeNull()
  })

  it.each([
    ['ja', 'ja-JP'],
    ['es', 'es-MX'],
    ['fr', 'fr-CA'],
    ['de', 'de-AT'],
    ['ru', 'ru-RU'],
    ['pt', 'pt-BR'],
  ] as const)('renders native %s translations including regional tag %s across Core and all 4 Sources', (base, regional) => {
    for (const tag of [base, regional]) {
      cleanup()
      render(<MemorySourcePageFrame locale={tag}><Labels /></MemorySourcePageFrame>)
      expect(screen.getByTestId('core').textContent).toBe(mnemonLocales[base]['common.cancel'])
      expect(screen.getByTestId('runtime').textContent).not.toBe('Runtime Memory')
      expect(screen.getByTestId('documents').textContent).not.toBe('Project Documents')
      expect(screen.getByTestId('spaces').textContent).not.toBe('Recall Memory')
      expect(screen.getByTestId('unknown').textContent).toBe('unknown.translation')
    }
  })

  it('retains a partial enclosing language pack and updates when the locale changes', () => {
    let active = 'it'
    const pack: Record<string, string> = {
      'common.cancel': 'Annulla', 'runtime.title': 'Memoria runtime',
      'documents.title': 'Documenti del progetto', 'search.title': 'Ricorda', 'page.title': 'Competenze',
      'runtime.total': '{count} voci',
    }
    const bound: MnemonTranslate = (key, params) => {
      const text = active === 'it' ? pack[key] : undefined
      return text === undefined ? key : text.replace(/\{(\w+)\}/g, (match, name: string) => params?.[name] === undefined ? match : String(params[name]))
    }
    const page = () => <I18nContext.Provider value={bound}><MemorySourcePageFrame locale={active}><Labels /></MemorySourcePageFrame></I18nContext.Provider>
    const view = render(page())
    for (const text of ['Annulla', 'Memoria runtime', 'Documenti del progetto', 'Ricorda', 'Competenze', '3 voci', 'items removed']) expect(screen.getByText(text)).toBeTruthy()
    active = 'en'
    view.rerender(page())
    expect(screen.getByText('Runtime Memory')).toBeTruthy()
    expect(screen.getByText('Cancel')).toBeTruthy()
    expect(screen.queryByText('Memoria runtime')).toBeNull()
    active = 'zh'
    view.rerender(page())
    expect(screen.getByText('取消')).toBeTruthy()
    active = 'ja'
    view.rerender(page())
    expect(screen.getByTestId('core').textContent).toBe(mnemonLocales.ja['common.cancel'])
  })

  it('resolves standalone settings fallback chains and Skills plurals including Russian 3-form plurals', () => {
    const locale = { bind: () => translateEn }
    expect(settingsTranslate(locale, undefined, 'it')('search.title')).toBe('Recall Memory')
    expect(settingsTranslate({ bind: () => key => key }, ['custom', 'zh', 'en'], 'custom')('search.title')).not.toBe('Recall Memory')
    expect(settingsTranslate({ bind: () => key => key }, ['custom', 'ja', 'en'], 'custom')('search.title')).not.toBe('Recall Memory')
    expect(skillsTranslate('it')('tabs.trash', { count: 1 })).toBe('item removed')
    const ru = skillsTranslate('ru')
    const ruOne = ru('sources.entries', { count: 1 })
    const ruFew = ru('sources.entries', { count: 2 })
    const ruMany = ru('sources.entries', { count: 5 })
    expect(new Set([ruOne, ruFew, ruMany]).size).toBe(3)
    expect(compactCount(12_300, 'ja')).not.toBe('')
    expect(compactCount(12_300, 'de')).not.toBe('')
    expect(compactCount(12_300, 'invalid_locale_tag')).toBe('12.3K')
  })

  it('resolves localized text maps across all 8 locales with regional and fallback behavior', () => {
    const text = { en: 'Hello', 'zh-CN': '你好', ja: 'こんにちは', fr: 'Bonjour', pt: 'Olá' }
    expect(pickLocalizedText(text, 'ja-JP')).toBe('こんにちは')
    expect(pickLocalizedText(text, 'fr')).toBe('Bonjour')
    expect(pickLocalizedText(text, 'pt-BR')).toBe('Olá')
    expect(pickLocalizedText(text, 'zh')).toBe('你好')
    expect(pickLocalizedText(text, 'zh-TW')).toBe('你好')
    expect(pickLocalizedText(text, 'ko')).toBe('Hello')
    expect(resolveMnemonLocale('pt_BR')).toBe('pt')
    expect(resolveMnemonLocale('de-CH')).toBe('de')
    expect(resolveMnemonLocale('unknown')).toBe('en')
    expect(translateFor('zh')('common.cancel')).toBe('取消')
    expect(translateFor('ja')('common.cancel')).toBe(mnemonLocales.ja['common.cancel'])
  })

  it('preserves optional 8-language labels in defineMemoryPlugin and defineMemoryStrategyConfiguration', () => {
    const label = { en: 'Sample', 'zh-CN': '示例', ja: 'サンプル', es: 'Ejemplo', fr: 'Exemple', de: 'Beispiel', ru: 'Пример', pt: 'Exemplo' }
    const plugin = defineMemoryPlugin({
      packageName: 'dsh-mnemon-strategy-sample',
      label,
      description: label,
      roles: ['strategy'],
      provides: [{ id: 'strategy' }],
    })
    expect(plugin.label).toEqual(label)
    const editor = defineMemoryStrategyConfiguration({
      kind: 'strategy',
      typeId: 'sample',
      label,
      description: label,
      fields: [{ key: 'note', input: 'text', label, description: label }],
      create: () => ({ plugin, strategies: [] }),
    })
    expect(editor.label).toEqual(label)
    expect(editor.fields[0]?.label).toEqual(label)
    expect(editor.fields[0]?.description).toEqual(label)
  })

  it('accepts bilingual plugin descriptors with legacy extension metadata', () => {
    const label = { en: 'Sample', 'zh-CN': '示例', fr: 'Exemple', 'x-metadata': { legacy: true } }
    const plugin = defineMemoryPlugin({
      packageName: 'dsh-mnemon-strategy-sample',
      label,
      description: label,
      roles: ['strategy'],
      provides: [{ id: 'strategy' }],
    })
    expect(plugin.label).toEqual({ en: 'Sample', 'zh-CN': '示例', fr: 'Exemple' })
    const editor = defineMemoryStrategyConfiguration({
      kind: 'strategy',
      typeId: 'sample',
      label,
      description: label,
      fields: [{ key: 'note', input: 'text', label }],
      create: () => ({ plugin, strategies: [] }),
    })
    expect(pickLocalizedText(editor.fields[0]?.label, 'fr')).toBe('Exemple')
  })
})

describe('Official DSH LocaleRuntime integration', () => {
  it.each(['language pack', 'Mnemon'] as const)('keeps both registrations when %s loads first', first => {
    const locale = createLocaleRuntime()
    addLanguage(locale, 'fr')
    const installPack = () => locale.register('mnemon', 'fr', { 'config.storageTitle': 'Storage' })
    const removeEarlyPack = first === 'language pack' ? installPack() : undefined
    const removeStarter = registerMnemonLocales(locale)
    const removePack = removeEarlyPack ?? installPack()
    const t = locale.bind('mnemon')

    locale.setLocale('fr')
    expect(t('config.storageTitle')).toBe('Storage')
    expect(t('common.cancel')).toBe(mnemonLocales.fr['common.cancel'])
    removePack()
    expect(t('config.storageTitle')).toBe(mnemonLocales.fr['config.storageTitle'])
    locale.setLocale('zh')
    expect(t('config.storageTitle')).toBe(mnemonLocales.zh['config.storageTitle'])
    locale.setLocale('en')
    expect(t('config.storageTitle')).toBe(mnemonLocales.en['config.storageTitle'])
    removeStarter()
    expect(t('config.storageTitle')).toBe('config.storageTitle')
  })

  it.each(['fr', 'fr-CA'] as const)('uses the registered %s pack in all four Source pages', language => {
    const locale = createLocaleRuntime()
    addLanguage(locale, 'fr')
    addLanguage(locale, 'fr-CA', 'fr')
    registerMnemonLocales(locale)
    const removePack = locale.register('mnemon', language, {
      'runtime.title': 'Mémoire du pack',
      'documents.title': 'Documents du pack',
      'search.title': 'Recherche du pack',
      'page.title': 'Compétences du pack',
    })
    locale.setLocale(language)
    const page = () => <LocaleFallbackContext.Provider value={localeFallbackChain(locale.getSnapshot())}>
      <I18nContext.Provider value={locale.bind('mnemon')}>
        <MemorySourcePageFrame locale={language}><Labels /></MemorySourcePageFrame>
      </I18nContext.Provider>
    </LocaleFallbackContext.Provider>
    const view = render(page())
    for (const value of ['Mémoire du pack', 'Documents du pack', 'Recherche du pack', 'Compétences du pack']) {
      expect(screen.getByText(value)).toBeTruthy()
    }
    removePack()
    view.rerender(page())
    expect(screen.queryByText('Mémoire du pack')).toBeNull()
    expect(screen.getByTestId('runtime').textContent).not.toBe('Runtime Memory')
  })

  it('follows a declared language chain for bundled UI and localized names', () => {
    const locale = createLocaleRuntime()
    const removeFrench = locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' })
    addLanguage(locale, 'it', 'fr')
    addLanguage(locale, 'fr-CA', 'en')
    registerMnemonLocales(locale)
    const t = locale.bind('mnemon')
    const label = { en: 'Project Documents', 'zh-CN': '项目档案', fr: 'Documents du projet' }
    locale.setLocale('it')
    const chain = localeFallbackChain(locale.getSnapshot())
    expect(chain).toEqual(['it', 'fr', 'en'])
    expect(t('config.storageTitle')).toBe(mnemonLocales.fr['config.storageTitle'])
    expect(componentCopy({ label, description: label }, chain)).toEqual({
      label: 'Documents du projet',
      hint: 'Documents du projet',
    })
    expect(marketLocalized(label, chain)).toBe('Documents du projet')
    render(<LocaleFallbackContext.Provider value={chain}><I18nContext.Provider value={t}>
      <MemorySourcePageFrame locale="it"><Labels /></MemorySourcePageFrame>
    </I18nContext.Provider></LocaleFallbackContext.Provider>)
    expect(screen.getByTestId('documents').textContent).toBe('Documents du projet')

    locale.setLocale('fr-CA')
    expect(localeFallbackChain(locale.getSnapshot())).toEqual(['fr-CA', 'en'])
    expect(t('config.storageTitle')).toBe(mnemonLocales.en['config.storageTitle'])
    expect(pickLocalizedText(label, localeFallbackChain(locale.getSnapshot()))).toBe('Project Documents')

    locale.setLocale('it')
    removeFrench()
    const snapshot = locale.getSnapshot()
    const remainingChain = localeFallbackChain(snapshot)
    expect(remainingChain).toEqual(['it', 'en'])
    expect(spacesLanguageChain(snapshot)).toEqual(remainingChain)
    expect(t('config.storageTitle')).toBe(mnemonLocales.en['config.storageTitle'])
    expect(pickLocalizedText(label, remainingChain)).toBe(locale.resolveText(label))
  })
})

describe('Multi-language dictionary completeness, placeholder parity, and package metadata', () => {
  it('maintains 100% key and placeholder parity across all 8 languages in Core and every Source dictionary', () => {
    const dictionaries: Array<{ name: string; data: Record<string, Record<string, string>> }> = [
      { name: 'dsh-mnemon', data: mnemonLocales as unknown as Record<string, Record<string, string>> },
      ...['runtime', 'documents', 'skills', 'memory-spaces'].map(source => ({
        name: `dsh-mnemon-source-${source}`,
        data: JSON.parse(readFileSync(resolve(ROOT, `plugins/dsh-mnemon-source-${source}/presentation/locales.json`), 'utf8')) as Record<string, Record<string, string>>,
      })),
    ]

    for (const { name, data } of dictionaries) {
      const enKeys = Object.keys(data.en!).sort()
      for (const locale of MNEMON_LOCALE_IDS) {
        const dict = data[locale]
        expect(dict, `${name} missing ${locale}`).toBeDefined()
        expect(Object.keys(dict!).sort(), `${name}.${locale} key parity`).toEqual(enKeys)
        for (const key of enKeys) {
          const value = dict![key]!
          expect(typeof value, `${name}.${locale}.${key}`).toBe('string')
          if (key !== 'config.sentenceGap') expect(value.trim().length, `${name}.${locale}.${key} empty`).toBeGreaterThan(0)
          expect(EMOJI_PATTERN.test(value), `${name}.${locale}.${key} emoji`).toBe(false)
          if (locale !== 'zh' && locale !== 'ja') expect(HAN_PATTERN.test(value), `${name}.${locale}.${key} leaked Han`).toBe(false)
          expect(placeholdersOf(value), `${name}.${locale}.${key} placeholders`).toEqual(placeholdersOf(data.en![key]!))
        }
      }
    }
  })

  it('ships all 8 DSH package locale JSON files and root detail documents', () => {
    const packages = [
      ROOT,
      ...[
        'dsh-mnemon-source-documents',
        'dsh-mnemon-source-memory-spaces',
        'dsh-mnemon-source-runtime',
        'dsh-mnemon-source-skills',
        'dsh-mnemon-strategy-auto-capture',
        'dsh-mnemon-strategy-default-three-tier',
        'dsh-mnemon-strategy-general',
        'dsh-mnemon-strategy-light-context',
        'dsh-mnemon-strategy-scoped',
      ].map(name => resolve(ROOT, 'plugins', name)),
    ]
    const expectedFiles = [...MNEMON_LOCALE_IDS].map(id => `${id}.json`).sort()
    for (const directory of packages) {
      const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as { name: string }
      const files = readdirSync(resolve(directory, 'locale')).filter(name => name.endsWith('.json')).sort()
      expect(files, manifest.name).toEqual(expectedFiles)
      for (const file of files) {
        const dictionary = JSON.parse(readFileSync(resolve(directory, 'locale', file), 'utf8')) as { meta?: { title?: string; description?: string; detail?: string } }
        if (directory === ROOT) {
          const detail = dictionary.meta?.detail
          expect(typeof detail, `${manifest.name}/${file}`).toBe('string')
          expect(readFileSync(resolve(ROOT, detail!), 'utf8').trim().length, detail).toBeGreaterThan(0)
        } else {
          expect(dictionary.meta?.title?.trim().length ?? 0, `${manifest.name}/${file} title`).toBeGreaterThan(0)
          expect(dictionary.meta?.description?.trim().length ?? 0, `${manifest.name}/${file} description`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('preserves and resolves all 8 languages in Skills official market catalog', () => {
    const raw = JSON.parse(readFileSync(resolve(ROOT, 'plugins/dsh-mnemon-source-skills/market/official.json'), 'utf8'))
    const { registry, skipped } = parseRegistry(raw)
    expect(skipped).toBe(0)
    for (const locale of MNEMON_LOCALE_IDS) {
      const tag = locale === 'zh' ? 'zh-CN' : locale
      expect(marketLocalized(registry.name, locale), `registry.name.${locale}`).toBe((raw.name as Record<string, string>)[tag])
      expect(marketLocalized(registry.description, locale), `registry.description.${locale}`).toBe((raw.description as Record<string, string>)[tag])
      for (const category of registry.categories ?? []) {
        expect(marketLocalized(category.label, locale).length, `category.${category.id}.${locale}`).toBeGreaterThan(0)
      }
      for (const skill of registry.skills) {
        expect(marketLocalized(skill.description, locale).length, `skill.${skill.name}.description.${locale}`).toBeGreaterThan(0)
      }
    }
  })
})
