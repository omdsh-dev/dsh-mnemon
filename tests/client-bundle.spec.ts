// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { createElement, type ComponentType } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { loadMemoryClientArtifact } from '../src/sdk/testing.ts'
import { mnemonLocales, MNEMON_LOCALE_IDS, type MnemonLocaleId } from '../src/client/locales.ts'
import skillsLocales from '../plugins/dsh-mnemon-source-skills/presentation/locales.json' with { type: 'json' }
import documentsLocales from '../plugins/dsh-mnemon-source-documents/presentation/locales.json' with { type: 'json' }
import runtimeLocales from '../plugins/dsh-mnemon-source-runtime/presentation/locales.json' with { type: 'json' }
import spacesLocales from '../plugins/dsh-mnemon-source-memory-spaces/presentation/locales.json' with { type: 'json' }

const root = process.cwd()

const CLIENT_BUNDLES = [
  { id: 'dsh-mnemon', path: join(root, 'lib/client.js'), requiredExports: ['apply', 'inject', 'installMemorySourceUI', 'installMemoryComponentUI'] },
  { id: 'dsh-mnemon-source-memory-spaces', path: join(root, 'plugins/dsh-mnemon-source-memory-spaces/lib/client.js'), requiredExports: ['apply', 'inject', 'MemorySpacesSourcePage', 'MemorySpacesSettings', 'OverviewPage', 'ProviderIcon', 'NATIVE_PROVIDER_ID'] },
  { id: 'dsh-mnemon-source-skills', path: join(root, 'plugins/dsh-mnemon-source-skills/lib/client.js'), requiredExports: ['apply', 'inject'] },
  { id: 'dsh-mnemon-source-documents', path: join(root, 'plugins/dsh-mnemon-source-documents/lib/client.js'), requiredExports: ['apply', 'inject'] },
  { id: 'dsh-mnemon-source-runtime', path: join(root, 'plugins/dsh-mnemon-source-runtime/lib/client.js'), requiredExports: ['apply', 'inject'] },
] as const

const UNUSED_STARTER_GRAPH_MARKERS = [
  'data-source-kind',
  'data-ds-dark-theme',
  'getContext("2d")',
  "getContext('2d')",
  'memory-graph-3d',
] as const

const HOST_LEAK_MARKERS = [
  'require("node:',
  "require('node:",
  'https://registry.npmjs.org',
  'dsh-mnemon-update-backup-',
  'unsupported Source assistance operation',
  'login/device/code',
  'login/oauth/access_token',
  'api.github.com',
  'Ov23liq4i7n8UsylGRfb',
] as const

const COMPACT_LOCALE_KEY_CHECKS = [
  { id: 'dsh-mnemon', path: CLIENT_BUNDLES[0].path, key: 'config.storageTitle', maxOccurrences: 3 },
  { id: 'dsh-mnemon', path: CLIENT_BUNDLES[0].path, key: 'category.insight', maxOccurrences: 2 },
  { id: 'dsh-mnemon-source-memory-spaces', path: CLIENT_BUNDLES[1].path, key: 'category.insight', maxOccurrences: 3 },
  { id: 'dsh-mnemon-source-skills', path: CLIENT_BUNDLES[2].path, key: 'evolution.reviewNow', maxOccurrences: 4 },
  { id: 'dsh-mnemon-source-documents', path: CLIENT_BUNDLES[3].path, key: 'documents.title', maxOccurrences: 3 },
  { id: 'dsh-mnemon-source-runtime', path: CLIENT_BUNDLES[4].path, key: 'runtime.addButton', maxOccurrences: 3 },
] as const

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function injectedCssIds(): string[] {
  return [...document.head.querySelectorAll<HTMLStyleElement>('style[data-plugin-css]')]
    .map(tag => tag.dataset.pluginCss ?? '')
}

function clearPluginStyles(): void {
  for (const tag of document.head.querySelectorAll('style[data-plugin-css]')) tag.remove()
}

function readBuiltBundle(path: string): string {
  if (!existsSync(path)) throw new Error(`Build client bundle first: ${path}`)
  return readFileSync(path, 'utf8')
}

describe('built browser client bundles', () => {
  afterEach(() => {
    cleanup()
    clearPluginStyles()
  })

  it('omits unused Memory Spaces graph components from the Starter client bundle while keeping them in Memory Spaces', () => {
    const starter = readBuiltBundle(CLIENT_BUNDLES[0].path)
    for (const marker of UNUSED_STARTER_GRAPH_MARKERS) expect(starter).not.toContain(marker)

    const spaces = readBuiltBundle(CLIENT_BUNDLES[1].path)
    expect(spaces).toContain('data-source-kind')
    expect(spaces).toContain('data-ds-dark-theme')
  })

  it.each(CLIENT_BUNDLES)('minifies $id without region banners or host leaks', ({ path }) => {
    const code = readBuiltBundle(path)
    expect(code).not.toContain('//#region ')
    expect(code.split('\n').length).toBeLessThan(100)
    for (const marker of HOST_LEAK_MARKERS) expect(code).not.toContain(marker)
  })

  it.each(COMPACT_LOCALE_KEY_CHECKS)('deduplicates repeated locale keys in $id ($key)', ({ path, key, maxOccurrences }) => {
    const code = readBuiltBundle(path)
    const count = countOccurrences(code, key)
    expect(count).toBeGreaterThanOrEqual(1)
    expect(count).toBeLessThanOrEqual(maxOccurrences)
  })

  it('loads the minified Starter and Source client bundles with their public exports intact and zero eager style tags', async () => {
    clearPluginStyles()
    const sharedDependencies = {
      react: await import('react'),
      'react/jsx-runtime': await import('react/jsx-runtime'),
      'react-dom': await import('react-dom'),
      '@deepseek-ai/dsh-client-ui-primitives': await import('@deepseek-ai/dsh-client-ui-primitives'),
    }
    const starterExports = (JSON.parse(readFileSync(join(root, 'tests/fixtures/dsh-mnemon-client-0.5.31-exports.json'), 'utf8')) as { exports: string[] }).exports
    const starter = loadMemoryClientArtifact<Record<string, unknown>>(CLIENT_BUNDLES[0].path, sharedDependencies)
    for (const name of [...CLIENT_BUNDLES[0].requiredExports, ...starterExports]) {
      expect(starter[name], `dsh-mnemon/client.${name}`).toBeDefined()
    }
    expect(injectedCssIds()).toEqual([])

    const sourceDependencies = { ...sharedDependencies, 'dsh-mnemon/client': starter }
    const loadedSources = new Map<string, Record<string, unknown>>()
    for (const entry of CLIENT_BUNDLES.slice(1)) {
      const loaded = loadMemoryClientArtifact<Record<string, unknown>>(entry.path, sourceDependencies)
      loadedSources.set(entry.id, loaded)
      for (const name of entry.requiredExports) {
        expect(loaded[name], `${entry.id}/client.${name}`).toBeDefined()
      }
    }
    expect(injectedCssIds()).toEqual([])

    const translateFor = starter.translateFor as (locale: MnemonLocaleId) => (key: string, params?: Record<string, unknown>) => string
    for (const locale of MNEMON_LOCALE_IDS) {
      expect(translateFor(locale)('config.storageTitle')).toBe(mnemonLocales[locale]['config.storageTitle'])
      expect(translateFor(locale)('common.showing', { visible: 2, total: 5 })).toBe(
        mnemonLocales[locale]['common.showing'].replace('{visible}', '2').replace('{total}', '5'),
      )
    }

    const skills = loadedSources.get('dsh-mnemon-source-skills') as {
      installSkillsMemoryUI: (ctx: {
        slots: {
          inject: (_slot: string, register: () => () => void) => () => void
          register: (entry: { label: () => string }, _component: unknown) => () => void
        }
      }, locale?: string) => () => void
    }
    for (const locale of MNEMON_LOCALE_IDS) {
      let label: (() => string) | undefined
      const dispose = skills.installSkillsMemoryUI({
        slots: {
          inject: (_slot, register) => register(),
          register: (entry) => {
            label = entry.label
            return () => {}
          },
        },
      }, locale)
      expect(label?.()).toBe(skillsLocales[locale]['page.title'])
      dispose()
    }
    expect(injectedCssIds()).toEqual([])
  })

  it('injects client CSS lazily on first class access while preserving cascade order and reconnect safety', async () => {
    clearPluginStyles()
    const sharedDependencies = {
      react: await import('react'),
      'react/jsx-runtime': await import('react/jsx-runtime'),
      'react-dom': await import('react-dom'),
      '@deepseek-ai/dsh-client-ui-primitives': await import('@deepseek-ai/dsh-client-ui-primitives'),
    }
    const starter = loadMemoryClientArtifact<{
      memoryPageStyles: Readonly<Record<string, string>>
      memorySidebarStyles: Readonly<Record<string, string>>
      memorySettingsStyles: Readonly<Record<string, string>>
    }>(CLIENT_BUNDLES[0].path, sharedDependencies)
    expect(injectedCssIds()).toEqual([])

    expect(Object.keys(starter.memoryPageStyles)).toContain('pageHeader')
    expect(Object.keys(starter.memoryPageStyles)).toContain('runtimeSummaryCard')
    expect(injectedCssIds()).toEqual([])

    expect(starter.memorySidebarStyles.pageHeader).toEqual(expect.any(String))
    expect(injectedCssIds()).toEqual(['dsh-mnemon/src/client/MnemonSidebarView.module.css'])

    expect(starter.memoryPageStyles.runtimeSummaryCard).toEqual(expect.any(String))
    expect(injectedCssIds()).toEqual([
      'dsh-mnemon-source-runtime/presentation/page.module.css',
      'dsh-mnemon/src/client/MnemonSidebarView.module.css',
    ])

    expect(starter.memoryPageStyles.pageHeader).toEqual(expect.any(String))
    expect(starter.memorySettingsStyles.page).toEqual(expect.any(String))
    expect(injectedCssIds()).toEqual([
      'dsh-mnemon/src/client/MnemonSettingsCard.module.css',
      'dsh-mnemon/src/client/MnemonView.module.css',
      'dsh-mnemon-source-runtime/presentation/page.module.css',
      'dsh-mnemon/src/client/MnemonSidebarView.module.css',
    ])

    document.head.querySelector('style[data-plugin-css="dsh-mnemon/src/client/MnemonView.module.css"]')?.remove()
    expect(starter.memoryPageStyles.pageHeader).toEqual(expect.any(String))
    expect(injectedCssIds()).toEqual([
      'dsh-mnemon/src/client/MnemonSettingsCard.module.css',
      'dsh-mnemon/src/client/MnemonView.module.css',
      'dsh-mnemon-source-runtime/presentation/page.module.css',
      'dsh-mnemon/src/client/MnemonSidebarView.module.css',
    ])

    clearPluginStyles()
    const runtime = loadMemoryClientArtifact<{
      RuntimePage: ComponentType<{
        client: {
          listRuntimeMemory: () => Promise<{ entries: []; targets: { user: { used: number; limit: number; entryCount: number }; project: { used: number; limit: number; entryCount: number } } }>
          mutateRuntimeMemory: () => Promise<never>
        }
        writeEnabled: boolean
        revision: number
      }>
    }>(CLIENT_BUNDLES[4].path, { ...sharedDependencies, 'dsh-mnemon/client': starter })
    expect(injectedCssIds()).toEqual([])

    const runtimeView = render(createElement(runtime.RuntimePage, {
      client: {
        listRuntimeMemory: () => new Promise<never>(() => {}),
        mutateRuntimeMemory: () => Promise.reject(new Error('unused')),
      },
      writeEnabled: true,
      revision: 0,
    }))
    expect(runtimeView.container.textContent).toContain(runtimeLocales.zh['runtime.title'])
    const runtimeCss = injectedCssIds()
    expect(runtimeCss.slice(0, 4)).toEqual([
      'dsh-mnemon/src/client/MnemonView.module.css',
      'dsh-mnemon-source-runtime/presentation/page.module.css',
      'dsh-mnemon/src/client/MnemonSidebarView.module.css',
      'dsh-mnemon-source-runtime/presentation/sidebar.module.css',
    ])
    expect(runtimeCss).toHaveLength(6)
    expect(runtimeCss.slice(4)).toEqual(expect.arrayContaining([
      'dsh-mnemon/src/client/MnemonFeedback.module.css',
      'dsh-mnemon/src/client/PageControls.module.css',
    ]))
    cleanup()

    clearPluginStyles()
    const documents = loadMemoryClientArtifact<{
      DocumentsPage: ComponentType<{
        client: {
          listDocuments: () => Promise<never>
          getDocument: () => Promise<never>
          mutateDocument: () => Promise<never>
        }
        writeEnabled: boolean
        revision: number
      }>
    }>(CLIENT_BUNDLES[3].path, { ...sharedDependencies, 'dsh-mnemon/client': starter })
    expect(injectedCssIds()).toEqual([])

    const documentsView = render(createElement(documents.DocumentsPage, {
      client: {
        listDocuments: () => new Promise<never>(() => {}),
        getDocument: () => Promise.reject(new Error('unused')),
        mutateDocument: () => Promise.reject(new Error('unused')),
      },
      writeEnabled: true,
      revision: 0,
    }))
    expect(documentsView.container.textContent).toContain(documentsLocales.zh['documents.title'])
    const documentsCss = injectedCssIds()
    expect(documentsCss.slice(0, 4)).toEqual([
      'dsh-mnemon/src/client/MnemonView.module.css',
      'dsh-mnemon-source-documents/presentation/page.module.css',
      'dsh-mnemon/src/client/MnemonSidebarView.module.css',
      'dsh-mnemon-source-documents/presentation/sidebar.module.css',
    ])
    expect(documentsCss).toHaveLength(6)
    expect(documentsCss.slice(4)).toEqual(expect.arrayContaining([
      'dsh-mnemon/src/client/MnemonFeedback.module.css',
      'dsh-mnemon/src/client/PageControls.module.css',
    ]))
    cleanup()

    clearPluginStyles()
    const spaces = loadMemoryClientArtifact<{
      OverviewPage: ComponentType<{
        active: boolean
        client: Record<string, unknown>
        metadataClient: Record<string, unknown>
        revision: number
        reloadKey: number
        activationEnabled: boolean
        writeEnabled: boolean
        agentAvailable: boolean
        fallbackBodies: readonly []
        catalogKnown: boolean
        onMutate: () => void
        onAgentRefresh: () => void
        onBodyReconnect: () => void
        onBodyMetadata: () => void
        onExplore: () => void
      }>
    }>(CLIENT_BUNDLES[1].path, { ...sharedDependencies, 'dsh-mnemon/client': starter })
    expect(injectedCssIds()).toEqual([])

    const spacesView = render(createElement(spaces.OverviewPage, {
      active: false,
      client: { bodyDirectory: () => new Promise(() => {}) },
      metadataClient: {},
      revision: 0,
      reloadKey: 0,
      activationEnabled: false,
      writeEnabled: false,
      agentAvailable: false,
      fallbackBodies: [],
      catalogKnown: true,
      onMutate: () => {},
      onAgentRefresh: () => {},
      onBodyReconnect: () => {},
      onBodyMetadata: () => {},
      onExplore: () => {},
    }))
    expect(spacesView.container.textContent).toContain(spacesLocales.zh['overview.directory'])
    const spacesCss = injectedCssIds()
    expect(spacesCss.slice(0, 4)).toEqual([
      'dsh-mnemon/src/client/MnemonView.module.css',
      'dsh-mnemon-source-memory-spaces/presentation/page.module.css',
      'dsh-mnemon/src/client/MnemonSidebarView.module.css',
      'dsh-mnemon-source-memory-spaces/presentation/sidebar.module.css',
    ])
  })
})
