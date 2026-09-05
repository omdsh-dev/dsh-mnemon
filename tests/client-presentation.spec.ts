import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { presentationNamespace } from '../tsdown.config.ts'
import { copyFingerprint, presentationFingerprint } from './helpers/presentation.ts'
import baseline from './fixtures/presentation-baseline.json' with { type: 'json' }
import { memoryPageStyles, memorySidebarStyles } from '../src/client/page-kit.tsx'

const sources = ['runtime', 'documents', 'memory-spaces']
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

describe('default Source presentation migration', () => {
  it('uses real class maps rather than non-enumerable test proxies', () => {
    expect(Object.keys(memoryPageStyles)).toHaveLength(baseline.page.classes)
    expect(Object.keys(memorySidebarStyles)).toHaveLength(baseline.sidebar.classes)
    expect(memoryPageStyles.primaryButton).toContain('primaryButton')
  })

  it.each(['page', 'sidebar'] as const)('preserves the %s migration and public class map, with the explicit compact-header fix', kind => {
    const filename = kind === 'page' ? 'src/client/MnemonView.module.css' : 'src/client/MnemonSidebarView.module.css'
    const files = [filename, ...sources.map(source => `plugins/dsh-mnemon-source-${source}/presentation/${kind}.module.css`)]
    // Rules include their container/media conditions. Browser checks cover cascade and layout.
    const expected = { ...baseline[kind], ...(kind === 'sidebar' ? baseline.compactHeaderFix : {}) }
    expect(presentationFingerprint(files.map(path => ({ filename: presentationNamespace(path), text: read(path) })))).toEqual(expected)
  })

  it('preserves every public bilingual key and value while Sources own their copy', () => {
    expect(copyFingerprint(zh)).toEqual(baseline.zh)
    expect(copyFingerprint(en)).toEqual(baseline.en)
    for (const source of sources) {
      const copy = JSON.parse(read(`plugins/dsh-mnemon-source-${source}/presentation/locales.json`))
      expect(Object.keys(copy.en).sort()).toEqual(Object.keys(copy.zh).sort())
      expect(Object.keys(copy.en).length).toBeGreaterThan(0)
    }
  })

  it('keeps Source layout knowledge out of the workbench skin', () => {
    expect(read('src/client/MnemonSidebarView.module.css')).not.toMatch(/runtimeEntry|bodyGrid|documentWorkspace/)
  })
})
