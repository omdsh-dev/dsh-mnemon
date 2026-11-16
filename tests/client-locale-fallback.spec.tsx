// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { I18nContext, useT as useCoreT } from '../src/client/page-kit.tsx'
import { MemorySourcePageFrame } from '../src/client/page-client.tsx'
import { translateEn, type MnemonKey, type MnemonTranslate } from '../src/client/locales.ts'
import { useT as useRuntimeT } from '../plugins/dsh-mnemon-source-runtime/src/client/presentation.ts'
import { useT as useDocumentsT } from '../plugins/dsh-mnemon-source-documents/src/client/presentation.ts'
import { useT as useSpacesT, settingsTranslate } from '../plugins/dsh-mnemon-source-memory-spaces/src/client/presentation.ts'
import { useT as useSkillsT, translate as skillsTranslate } from '../plugins/dsh-mnemon-source-skills/src/client/presentation.ts'

afterEach(cleanup)

// Exercise each Source's real presentation hook under the same shared frame as its page.
function Labels() {
  const core = useCoreT(), runtime = useRuntimeT(), documents = useDocumentsT(), spaces = useSpacesT(), skills = useSkillsT()
  return <>
    <p>{core('common.cancel')}</p><p>{runtime('runtime.title')}</p>
    <p>{documents('documents.title')}</p><p>{spaces('search.title')}</p><p>{skills('page.title')}</p>
    <p>{runtime('runtime.total', { count: 3 })}</p><p>{skills('tabs.trash', { count: 2 })}</p>
    <p>{core('unknown.translation' as MnemonKey)}</p>
  </>
}

describe('Source locale fallback and language packs (#644)', () => {
  it.each(['it', 'it-IT', 'fr', 'en', 'en-GB'])('uses English for missing %s translations', locale => {
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
  })

  it('uses English in standalone settings and keeps a declared Chinese fallback chain', () => {
    const locale = { bind: () => translateEn }
    expect(settingsTranslate(locale, undefined, 'it')('search.title')).toBe('Recall Memory')
    expect(settingsTranslate({ bind: () => key => key }, ['custom', 'zh', 'en'], 'custom')('search.title')).not.toBe('Recall Memory')
    expect(skillsTranslate('it')('tabs.trash', { count: 1 })).toBe('item removed')
  })
})
