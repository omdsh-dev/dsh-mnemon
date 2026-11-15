// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ComponentType, ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginPackageRef, PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SlotCore, type StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'

const RUNTIME = 'dsh-mnemon-source-runtime'

vi.mock('../src/client/MnemonSettingsCard.tsx', () => ({
  // The card's composition board shows a component's gear and page from what it is given.
  MnemonSettingsCard: ({ language, componentSettings }: { language?: string; componentSettings?: { has(name: string): boolean; render(entry: unknown, page: unknown): ReactNode } }) => (
    <section aria-label="configuration" data-language={language}>
      {componentSettings?.has(RUNTIME) === true
        ? componentSettings.render({ packageName: RUNTIME }, { enabled: true, label: 'Runtime Memory', writable: true, language: language ?? 'en' })
        : <p>No component settings</p>}
    </section>
  ),
}))

import { descriptor as hindsight } from 'dsh-mnemon-provider-hindsight'
import { descriptor as holographic } from 'dsh-mnemon-provider-holographic'
import { descriptor as mem0 } from 'dsh-mnemon-provider-mem0'
import { descriptor as openviking } from 'dsh-mnemon-provider-openviking'
import spacesCopy from 'dsh-mnemon-source-memory-spaces/presentation/locales.json' with { type: 'json' }
import { MemorySpacesSettings } from 'dsh-mnemon-source-memory-spaces/client'
import { MnemonActionSeat } from '../src/client/action-seat.ts'
import { createComponentHosts } from '../src/client/component-host.ts'
import { MnemonComponentListSeat } from '../src/client/component-list-seat.ts'
import { ComponentOptions } from '../src/client/component-options.tsx'
import { installShippedComponentSettings, MEMORY_SPACES_PACKAGE, RUNTIME_PACKAGE, THREE_TIER_PACKAGE } from '../src/client/component-settings.tsx'
import { DOCUMENTS_PACKAGE, installShippedComponentStatus } from '../src/client/component-status.tsx'
import {
  createComponentRegionDirectory,
  createComponentSettingsDirectory,
  installMemoryComponentUI,
  MNEMON_COMPONENT_FALLBACK_PRIORITY,
  MNEMON_COMPONENT_SETTINGS_SLOT,
  MNEMON_COMPONENT_STATUS_SLOT,
  renderComponentRegion,
  type MemoryComponentSettingsComponent,
  type MemoryComponentSettingsProps,
} from '../src/client/component-ui.tsx'
import { translateEn, translateZh, type MnemonKey } from '../src/client/locales.ts'
import { MnemonPluginActions } from '../src/client/MnemonPluginActions.tsx'
import { MnemonSettingsHost } from '../src/client/MnemonSettingsHost.tsx'
import { MEMORY_SETTINGS_CLASS_NAMES } from '../src/client/settings-controls.tsx'
import { SKILLS_PACKAGE } from '../src/client/skills-settings.tsx'
import type { ClientConnectionHandle, Config } from '../src/host/protocol.ts'
import type { MemoryPluginEntryView, MemoryViewDashboard } from '../src/host/view-protocol.ts'
import { loadMemoryClientArtifact } from '../src/sdk/testing.ts'
import { liveSettingsScope, settingsScope } from './helpers/settings-scope.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('dsh-mnemon page under DSH Plugins', () => {
  function store<T>(value: T) {
    return { getSnapshot: () => value, subscribe: () => () => {} }
  }

  const pkg: PluginPackageRef = { name: 'dsh-mnemon', installed: true, availability: 'profile', official: false, enabled: true, rows: [{ rowId: 'mnemon', moduleName: 'dsh-mnemon', enabled: true }] }
  const bundle = (overrides: Partial<PluginPackageRef> = {}): PluginsSubject => ({ kind: 'bundle', pkg: { ...pkg, ...overrides } })

  it('renders the configuration only for the page view the Plugins page asks for', () => {
    const props = {
      scope: settingsScope<Config>({ status: 'ready', value: {}, writable: true, mode: 'host' }),
      currentSession: store<StandardSourceBinding>({ key: undefined, hooks: {}, keyedHooks: {}, props: {} }),
      sessions: { list: store({ byId: {} }) } as never,
      workspaces: { list: store({ items: [] }) } as never,
      localeRuntime: { ...store({ active: 'en', locales: [], revision: 0 }) } as never,
      t: translateEn,
    }
    const { rerender } = render(<MnemonSettingsHost {...props} view="summary" />)
    expect(screen.queryByRole('region', { name: 'configuration' })).toBeNull()
    rerender(<MnemonSettingsHost {...props} view="page" />)
    expect(screen.getByRole('region', { name: 'configuration' }).dataset.language).toBe('en')
  })

  it('renders the settings components contributed, also where the page is drawn outside DSH\'s slot renderer', () => {
    const props = {
      scope: settingsScope<Config>({ status: 'ready', value: {}, writable: true, mode: 'host' }),
      currentSession: store<StandardSourceBinding>({ key: undefined, hooks: {}, keyedHooks: {}, props: {} }),
      sessions: { list: store({ byId: {} }) } as never,
      workspaces: { list: store({ items: [] }) } as never,
      localeRuntime: { ...store({ active: 'en', locales: [], revision: 0 }) } as never,
      componentSettingsDirectory: store<ReadonlySet<string>>(new Set([RUNTIME])),
      t: translateEn,
    }
    const renderContributed = vi.fn((packageName: string) => <p>{packageName} contributed</p>)
    const renderSlot = vi.fn((_slot: string, _owner: unknown, options: { entryKey: string }) => <p>{options.entryKey} through DSH</p>)

    const { rerender } = render(<MnemonSettingsHost {...props} view="page" renderSlot={renderSlot as never} renderContributed={renderContributed} />)
    expect(screen.getByText(`${RUNTIME} through DSH`)).toBeTruthy()
    expect(renderContributed).not.toHaveBeenCalled()

    rerender(<MnemonSettingsHost {...props} view="page" renderContributed={renderContributed} />)
    expect(screen.getByText(`${RUNTIME} contributed`)).toBeTruthy()
    expect(renderContributed).toHaveBeenCalledWith(RUNTIME, expect.objectContaining({ component: { packageName: RUNTIME, label: 'Runtime Memory', enabled: true }, writable: true, language: 'en' }))

    rerender(<MnemonSettingsHost {...props} view="page" />)
    expect(screen.getByText('No component settings')).toBeTruthy()
  })

  it('offers the memory workspace from the dsh-mnemon page only while a placement can show it', () => {
    const workspace = new MnemonActionSeat()
    const { rerender } = render(<MnemonPluginActions subject={bundle()} workspace={workspace} t={translateEn} />)
    expect(screen.queryByRole('button')).toBeNull()

    const open = vi.fn()
    let withdraw = (): void => {}
    act(() => { withdraw = workspace.provide(open) })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(open).toHaveBeenCalledOnce()

    for (const subject of [
      bundle({ enabled: false }),
      bundle({ name: 'dsh-mnemon-strategy-general' }),
      { kind: 'row', pkg, row: pkg.rows[0]! },
      { kind: 'item', id: 'web-search' },
    ] satisfies PluginsSubject[]) {
      rerender(<MnemonPluginActions subject={subject} workspace={workspace} t={translateEn} />)
      expect(screen.queryByRole('button')).toBeNull()
    }

    rerender(<MnemonPluginActions subject={bundle()} workspace={workspace} t={translateEn} />)
    act(() => withdraw())
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('reports whether DSH lists the Starter\'s grouping row below the configuration', () => {
    const workspace = new MnemonActionSeat()
    const componentList = new MnemonComponentListSeat()
    const listener = vi.fn()
    componentList.subscribe(listener)
    const groupRows = [{ rowId: 'mnemon-bundle', moduleName: 'dsh-mnemon/bundle', enabled: false }, ...pkg.rows]
    const grouped = bundle({ rows: groupRows })
    const { rerender, unmount } = render(<MnemonPluginActions subject={grouped} workspace={workspace} componentList={componentList} t={translateEn} />)
    expect(componentList.getSnapshot()).toBe(true)
    rerender(<MnemonPluginActions subject={bundle()} workspace={workspace} componentList={componentList} t={translateEn} />)
    expect(componentList.getSnapshot()).toBe(false)
    rerender(<MnemonPluginActions subject={bundle({ rows: groupRows, enabled: false })} workspace={workspace} componentList={componentList} t={translateEn} />)
    expect(componentList.getSnapshot()).toBe(true)
    rerender(<MnemonPluginActions subject={{ kind: 'item', id: 'web-search' }} workspace={workspace} componentList={componentList} t={translateEn} />)
    expect(componentList.getSnapshot()).toBeUndefined()
    rerender(<MnemonPluginActions subject={grouped} workspace={workspace} componentList={componentList} t={translateEn} />)
    unmount()
    expect(componentList.getSnapshot()).toBeUndefined()
    expect(listener.mock.calls.length).toBeGreaterThan(0)
  })

  it('keeps the newest component list report when an older page withdraws late', () => {
    const seat = new MnemonComponentListSeat()
    const listener = vi.fn()
    seat.subscribe(listener)
    const older = seat.report(true)
    const newer = seat.report(false)
    older()
    expect(seat.getSnapshot()).toBe(false)
    newer()
    expect(seat.getSnapshot()).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('keeps the newest offer when an older owner withdraws late', () => {
    const seat = new MnemonActionSeat()
    const listener = vi.fn()
    seat.subscribe(listener)
    const first = vi.fn()
    const second = vi.fn()
    const withdrawFirst = seat.provide(first)
    const withdrawSecond = seat.provide(second)
    withdrawFirst()
    expect(seat.getSnapshot()).toBe(second)
    withdrawSecond()
    expect(seat.getSnapshot()).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(3)
  })
})

describe('Configuration classes another package\'s settings look up', () => {
  it('keeps every class Memory Spaces\' own settings use, which an installed Memory Spaces finds by name', () => {
    const settingsCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/client/MnemonSettingsCard.module.css'), 'utf8')
    const missing = MEMORY_SETTINGS_CLASS_NAMES.filter(name => !new RegExp(`\\.${name}(?![\\w-])`, 'u').test(settingsCss))
    expect(missing).toEqual([])
  })
})

describe('component regions', () => {
  function slots() {
    const registered: Array<{ options: { name: string; key?: string }; component: MemoryComponentSettingsComponent }> = []
    const listeners = new Set<() => void>()
    let version = 0
    const waiting = new Set<() => void>()
    let declared = false
    const context = {
      slots: {
        inject(_name: string, setup: () => () => void) {
          let release: (() => void) | undefined
          const run = () => { release = setup() }
          if (declared) run()
          else waiting.add(run)
          return () => { waiting.delete(run); release?.(); release = undefined }
        },
        register(options: { name: string; key: string }, component: MemoryComponentSettingsComponent) {
          const entry = { options, component }
          registered.push(entry)
          version += 1
          for (const listener of listeners) listener()
          return () => {
            registered.splice(registered.indexOf(entry), 1)
            version += 1
            for (const listener of listeners) listener()
          }
        },
        getVersion: () => version,
        entriesOfSlot: () => registered,
        subscribe(_name: string, listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
    }
    return {
      context, registered,
      declare() { declared = true; for (const run of waiting) run(); waiting.clear() },
    }
  }

  it('registers a component\'s settings under its package name once the region exists', () => {
    const { context, registered, declare } = slots()
    const settings: MemoryComponentSettingsComponent = () => null
    const dispose = installMemoryComponentUI(context, { packageName: '@acme/memory-notes', settings })
    expect(registered).toHaveLength(0)
    declare()
    expect(registered.map(entry => entry.options)).toEqual([{ name: MNEMON_COMPONENT_SETTINGS_SLOT, key: '@acme/memory-notes' }])
    const directory = createComponentSettingsDirectory(context)
    const changed = vi.fn()
    directory.subscribe(changed)
    expect(directory.getSnapshot().has('@acme/memory-notes')).toBe(true)
    dispose()
    expect(changed).toHaveBeenCalled()
    expect(directory.getSnapshot().has('@acme/memory-notes')).toBe(false)
  })

  it('registers a component\'s Status card and settings into their own regions', () => {
    const { context, registered, declare } = slots()
    declare()
    const dispose = installMemoryComponentUI(context, { packageName: '@acme/memory-notes', settings: () => null, status: () => null })
    expect(registered.map(entry => entry.options)).toEqual([
      { name: MNEMON_COMPONENT_SETTINGS_SLOT, key: '@acme/memory-notes' },
      { name: MNEMON_COMPONENT_STATUS_SLOT, key: '@acme/memory-notes' },
    ])
    dispose()
    expect(registered).toEqual([])
  })

  it('registers the shipped Sources\' Status cards the way an installed component does', () => {
    const { context, registered, declare } = slots()
    declare()
    const dispose = installShippedComponentStatus(context)
    expect(registered.map(entry => [entry.options.name, entry.options.key])).toEqual([
      [MNEMON_COMPONENT_STATUS_SLOT, RUNTIME_PACKAGE], [MNEMON_COMPONENT_STATUS_SLOT, DOCUMENTS_PACKAGE], [MNEMON_COMPONENT_STATUS_SLOT, MEMORY_SPACES_PACKAGE],
      [MNEMON_COMPONENT_STATUS_SLOT, SKILLS_PACKAGE],
    ])
    dispose()
    expect(registered).toEqual([])
    expect(createComponentRegionDirectory(context, MNEMON_COMPONENT_STATUS_SLOT).getSnapshot().size).toBe(0)
  })

  it('refuses a contribution without a package name or without anything to add', () => {
    const { context } = slots()
    expect(() => installMemoryComponentUI(context, { packageName: 'Not A Package', settings: () => null })).toThrow(/package name/u)
    expect(() => installMemoryComponentUI(context, { packageName: 'acme-memory-notes' })).toThrow(/contributes nothing/u)
  })

  it('registers the shipped components\' settings the way an installed component does', () => {
    const { context, registered, declare } = slots()
    declare()
    const dispose = installShippedComponentSettings(context, { scope: settingsScope<Config>({ status: 'ready', value: {}, writable: true, mode: 'host' }), t: translateZh })
    expect(registered.map(entry => entry.options.key)).toEqual([RUNTIME_PACKAGE, DOCUMENTS_PACKAGE, MEMORY_SPACES_PACKAGE, THREE_TIER_PACKAGE])
    dispose()
    expect(registered).toEqual([])
    const withSkills = installShippedComponentSettings(context, {
      scope: settingsScope<Config>({ status: 'ready', value: {}, writable: true, mode: 'host' }),
      skillsScope: settingsScope({ status: 'ready', value: {}, writable: true, mode: 'host' }),
      t: translateZh,
    })
    expect(registered.map(entry => entry.options.key)).toContain(SKILLS_PACKAGE)
    withSkills()
    expect(registered).toEqual([])
  })
})

describe('reads the settings make across a configuration change', () => {
  const settle = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
  const t = (key: string, params?: Record<string, unknown>) => {
    const pluginTemplate = (spacesCopy.en as Record<string, string>)[key]
    if (pluginTemplate !== undefined) {
      return params === undefined ? pluginTemplate : pluginTemplate.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
    }
    return translateEn(key as MnemonKey, params)
  }
  const embedding = (endpoint: string) => ({ enabled: true, endpoint, model: 'nomic-embed-text', protocol: 'auto', apiKey: '' })
  const catalog = (provider: typeof mem0) => ({ providers: [provider], items: [{ providerId: provider.id, enabled: true, configured: true, settings: {}, configuredSecrets: [] }], generatedAt: 'now' })

  function host(held: readonly string[], answer: (endpoint: string, index: number) => unknown) {
    const sent: Array<{ endpoint: string; answer: () => void }> = []
    const call = vi.fn((_channel: string, endpoint: string) => {
      const index = sent.filter(entry => entry.endpoint === endpoint).length
      const value = { ok: true, value: answer(endpoint, index) }
      if (!held.includes(endpoint)) { sent.push({ endpoint, answer: () => {} }); return Promise.resolve(value) }
      return new Promise(resolve => { sent.push({ endpoint, answer: () => resolve(value) }) })
    })
    const scope = liveSettingsScope<Config>({ status: 'ready', revision: 1, writable: true, mode: 'host', base: {}, user: {},
      value: { storageScope: 'global', embedding: embedding('http://old-host:11434') } } as never)
    const lent = createComponentHosts({ scope, connection: { isLoopback: true, rpc: { call } } as unknown as ClientConnectionHandle })(MEMORY_SPACES_PACKAGE)!
    const view = render(<MemorySpacesSettings component={{ packageName: MEMORY_SPACES_PACKAGE, label: 'Memory Spaces', enabled: true }} writable language="en" host={lent} />)
    return { sent, scope, lent, view, ui: within(view.container), requests: (endpoint: string) => sent.filter(entry => entry.endpoint === endpoint) }
  }

  it('asks the Host again for an embedding test after the connection changed, and shows that answer', async () => {
    const page = host(['embedding-status'], (endpoint, index) => endpoint === 'status-summary' ? { commandFound: true }
      : endpoint === 'provider-services' ? { providers: [], items: [], generatedAt: 'now' }
      : index === 0 ? { available: false, model: 'old-endpoint-answer', totalInsights: 1, embedded: 0, coverage: '0%' }
      : { available: true, model: 'nomic-embed-text', totalInsights: 1, embedded: 1, coverage: '100%' })
    await settle()
    fireEvent.click(page.ui.getByRole('button', { name: t('config.embeddingTest') }))
    await settle()
    fireEvent.change(page.ui.getByLabelText(t('config.embeddingEndpoint')), { target: { value: 'http://new-host:11434' } })
    fireEvent.click(page.ui.getByRole('button', { name: t('options.apply') }))
    await settle()
    fireEvent.click(page.ui.getByRole('button', { name: t('config.embeddingTest') }))
    await settle()
    expect(page.requests('embedding-status')).toHaveLength(2)
    page.requests('embedding-status')[1]!.answer()
    page.requests('embedding-status')[0]!.answer()
    await settle()
    expect(page.view.container.textContent).not.toContain('old-endpoint-answer')
  })

  it('reads the Providers again for a storage scope applied while the first list loads, and keeps that list', async () => {
    const page = host(['provider-services'], (endpoint, index) => endpoint === 'status-summary' ? { commandFound: true }
      : endpoint === 'provider-services' ? catalog(index === 0 ? mem0 : openviking) : {})
    await settle()
    expect(page.requests('provider-services')).toHaveLength(1)
    await act(async () => { await page.scope.mutate([{ op: 'set', path: ['storageScope'], value: 'workspace' }]) })
    await settle()
    expect(page.requests('provider-services')).toHaveLength(2)
    page.requests('provider-services')[1]!.answer()
    await settle()
    page.requests('provider-services')[0]!.answer()
    await settle()
    expect(page.ui.queryByRole('group', { name: `OpenViking ${t('config.providerServiceTitle')}` })).not.toBeNull()
    expect(page.ui.queryByRole('group', { name: `Mem0 ${t('config.providerServiceTitle')}` })).toBeNull()
    expect((page.lent.retained.get('provider-services') as { providers: { id: string }[] }).providers.map(provider => provider.id)).toEqual(['openviking'])
  })
})

describe('scoped component options', () => {
  function fixture(config: MemoryPluginEntryView['config'] = {}, options: { reverseSources?: boolean; disabled?: boolean } = {}) {
    const entry: MemoryPluginEntryView = {
      entryId: 'include:scoped', packageName: 'dsh-mnemon-strategy-scoped', typeId: 'scoped', roles: ['strategy-extension'],
      label: { en: 'Scoped composition', 'zh-CN': '范围组合' }, description: { en: '', 'zh-CN': '' },
      provides: [], requires: [], requiredBy: [], enabled: true, active: true, writable: true, config,
      fields: ['sourceKeys', 'writableSourceKeys'].map(key => ({ key, input: 'source-list', label: { en: key, 'zh-CN': key } })),
    }
    const sources: MemoryViewDashboard['sources'] = [
      ['runtime', 'working-context'], ['documents', 'narrative'], ['spaces', 'durable-evidence'], ['skills', 'capability'],
    ].map(([id, role]) => ({ sourceInstanceKey: `source:${id}`, sourceTypeId: id!, packageName: `test-${id}`, role: role!, label: id! }))
    if (options.reverseSources) sources.reverse()
    const onApply = vi.fn().mockResolvedValue(true)
    render(<ComponentOptions entry={entry} name="Scoped composition" dashboard={{ sources, entries: [] }} language="en" t={translateEn}
      disabled={options.disabled ?? false} pending={false} onApply={onApply} />)
    const group = screen.getByRole('group', { name: 'sourceKeys' })
    return { onApply, group, boxes: within(group).getAllByRole('checkbox') }
  }

  it('shows effective defaults and starts the first edit from them', () => {
    const { boxes, onApply } = fixture()
    expect(boxes).toHaveLength(4)
    expect(boxes.map(box => (box as HTMLInputElement).checked)).toEqual([true, true, true, false])
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
    fireEvent.click(boxes[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onApply).toHaveBeenCalledWith({ sourceKeys: ['source:documents', 'source:spaces'] })
  })

  it('does not write a cancelled empty selection, but preserves an explicitly confirmed one', () => {
    const { boxes, onApply } = fixture()
    const confirm = vi.spyOn(window, 'confirm')
    boxes.filter(box => (box as HTMLInputElement).checked).forEach(box => fireEvent.click(box))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(confirm).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: 'No memory sources selected' })
    expect(within(dialog).getByText(/No memory sources are selected/u)).toBeTruthy()
    expect(onApply).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'No memory sources selected' })).toBeNull()
    expect(onApply).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const reopened = screen.getByRole('dialog', { name: 'No memory sources selected' })
    fireEvent.click(within(reopened).getByRole('button', { name: 'Apply' }))
    expect(screen.queryByRole('dialog', { name: 'No memory sources selected' })).toBeNull()
    expect(onApply).toHaveBeenCalledWith({ sourceKeys: [] })
  })

  it('reset removes the override while preserving a separate read-only restriction', () => {
    const { boxes, onApply } = fixture({ sourceKeys: [], writableSourceKeys: [] })
    expect(boxes.every(box => !(box as HTMLInputElement).checked)).toBe(true)
    fireEvent.click(screen.getAllByRole('button', { name: 'Reset to default' })[0]!)
    expect(boxes.map(box => (box as HTMLInputElement).checked)).toEqual([true, true, true, false])
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onApply).toHaveBeenCalledWith({ writableSourceKeys: [] })
  })

  it('saving another option leaves inherited source selection unset', () => {
    const { onApply } = fixture({ writableSourceKeys: [] })
    fireEvent.click(within(screen.getByRole('group', { name: 'writableSourceKeys' })).getAllByRole('checkbox')[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onApply).toHaveBeenCalledWith({ writableSourceKeys: ['source:runtime'] })
  })

  it('keeps a capability Source available for an explicit General strategy selection', () => {
    const { onApply, group } = fixture({ sourceKeys: ['source:skills'], writableSourceKeys: [] })
    expect((within(group).getByRole('checkbox', { name: 'skills' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(within(group).getByRole('checkbox', { name: 'runtime' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onApply).toHaveBeenCalledWith({ sourceKeys: ['source:skills', 'source:runtime'], writableSourceKeys: [] })
  })

  it('uses the scoped runtime priority order on the first edit regardless of catalog order', () => {
    const { onApply, group } = fixture({}, { reverseSources: true })
    fireEvent.click(within(group).getByRole('checkbox', { name: 'spaces' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onApply).toHaveBeenCalledWith({ sourceKeys: ['source:runtime', 'source:documents'] })
  })

  it('keeps inherited and explicit source selections locked without management authority', () => {
    const { boxes, onApply } = fixture({ writableSourceKeys: [] }, { disabled: true })
    expect(boxes.every(box => (box as HTMLInputElement).disabled)).toBe(true)
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
    expect(onApply).not.toHaveBeenCalled()
  })
})

describe('component fallback across Starter and Memory Spaces versions', () => {
  afterEach(() => {
    vi.doUnmock('dsh-mnemon/client')
    vi.resetModules()
  })

  class TestSlots {
    readonly core = new SlotCore()
    register(options: unknown, component: unknown): () => void {
      return (this.core.register as (options: unknown, component: unknown) => () => void)(options, component)
    }
    inject(name: string, setup: () => () => void): () => void {
      let active: (() => void) | undefined
      const reconcile = (): void => {
        if (this.core.specDynamic(name) === undefined) { active?.(); active = undefined } else if (active === undefined) active = setup()
      }
      const unsubscribe = this.core.subscribeDeclaration(name, reconcile)
      reconcile()
      return () => { unsubscribe(); active?.(); active = undefined }
    }
    getVersion(key: string): number { return this.core.getVersion(key) }
    entriesOfSlot(key: string) { return this.core.entriesOfSlot(key) }
    subscribe(key: string, listener: () => void): () => void { return this.core.subscribe(key, listener) }
  }

  function page(t = translateZh) {
    const slots = new TestSlots()
    const declaration = slots.register({ name: 'root', children: { [MNEMON_COMPONENT_SETTINGS_SLOT]: { kind: 'keyed', scope: 'root' } } }, () => null)
    const ctx = { slots, locale: { bind: () => t } }
    const spaces = () => slots.entriesOfSlot(MNEMON_COMPONENT_SETTINGS_SLOT).filter(entry => entry.options.key === MEMORY_SPACES_PACKAGE)
    return { slots, ctx, declaration, spaces }
  }

  const scope = settingsScope<Config>({ status: 'ready', value: { storageScope: 'global' }, revision: 1, writable: true, mode: 'host' })
  const owner = (withHost = true): MemoryComponentSettingsProps => ({
    component: { packageName: MEMORY_SPACES_PACKAGE, label: '记忆空间', enabled: true }, writable: true, language: 'zh-CN',
    ...(withHost ? { host: createComponentHosts({ scope })(MEMORY_SPACES_PACKAGE)! } : {}),
  })
  const services = { scope, t: translateZh }

  const oldBuiltIn = () => <p>0.5.31 built-in settings</p>
  const installOldStarter = (ctx: ReturnType<typeof page>['ctx']) => installMemoryComponentUI(ctx as never, { packageName: MEMORY_SPACES_PACKAGE, settings: oldBuiltIn })

  async function spacesClient(starterYields: boolean) {
    if (!starterYields) {
      vi.doMock('dsh-mnemon/client', async () => ({ ...await vi.importActual<object>('dsh-mnemon/client'), MNEMON_COMPONENT_FALLBACK_PRIORITY: undefined }))
    }
    vi.resetModules()
    return {
      ...await import('dsh-mnemon-source-memory-spaces/client'),
      installMemorySpacesSettings: (await import('../plugins/dsh-mnemon-source-memory-spaces/src/client/settings.tsx')).installMemorySpacesSettings,
    }
  }

  function rendered(slots: TestSlots, props = owner()) {
    return render(<>{renderComponentRegion({ slots }, MNEMON_COMPONENT_SETTINGS_SLOT, MEMORY_SPACES_PACKAGE, props)}</>)
  }

  describe('Memory Spaces\' settings across Starter and Memory Spaces versions', () => {
    it('new Starter and new Memory Spaces: Memory Spaces\' own registration shows', async () => {
      const { ctx, slots, spaces } = page()
      installShippedComponentSettings(ctx as never, services)
      const client = await spacesClient(true)
      const errors = vi.spyOn(console, 'error')
      client.apply(ctx as never)
      expect(slots.core.entries(MNEMON_COMPONENT_SETTINGS_SLOT).filter(entry => entry.options.key === MEMORY_SPACES_PACKAGE).map(entry => entry.options.priority)).toEqual([undefined, MNEMON_COMPONENT_FALLBACK_PRIORITY])
      expect(spaces()).toHaveLength(1)
      expect(spaces()[0]!.options.priority).toBeUndefined()
      rendered(slots)
      expect(screen.getAllByRole('heading', { name: '记忆 Provider' })).toHaveLength(1)
      expect(within(screen.getByRole('region', { name: '记忆 Provider' })).getByText('Mnemon Native')).toBeTruthy()
      expect(errors).not.toHaveBeenCalled()
    })

    it('a Memory Spaces whose own settings go leaves the Starter\'s fallback, and one that comes back replaces it again', async () => {
      const { ctx, spaces } = page()
      installShippedComponentSettings(ctx as never, services)
      const client = await spacesClient(true)
      const own = client.installMemorySpacesSettings(ctx as never)
      expect(spaces().map(entry => entry.options.priority)).toEqual([undefined])
      own()
      expect(spaces().map(entry => entry.options.priority)).toEqual([MNEMON_COMPONENT_FALLBACK_PRIORITY])
      client.installMemorySpacesSettings(ctx as never)
      expect(spaces().map(entry => entry.options.priority)).toEqual([undefined])
    })

    it('new Starter and Memory Spaces 0.5.21, which registers none: the Starter\'s fallback shows', () => {
      const { ctx, slots, spaces } = page()
      installShippedComponentSettings(ctx as never, services)
      expect(spaces()).toHaveLength(1)
      expect(spaces()[0]!.options.priority).toBe(MNEMON_COMPONENT_FALLBACK_PRIORITY)
      rendered(slots)
      expect(screen.getAllByRole('heading', { name: '记忆 Provider' })).toHaveLength(1)
      expect(within(screen.getByRole('region', { name: '记忆 Provider' })).getByText('Mnemon Native')).toBeTruthy()
    })

    it('dsh-mnemon 0.5.31 and new Memory Spaces: Memory Spaces registers nothing, so the old built-in shows alone', async () => {
      const { ctx, slots, spaces } = page()
      installOldStarter(ctx)
      const client = await spacesClient(false)
      expect(() => client.apply(ctx as never)).not.toThrow()
      expect(slots.core.entries(MNEMON_COMPONENT_SETTINGS_SLOT)).toHaveLength(1)
      expect(spaces()).toHaveLength(1)
      rendered(slots, owner(false))
      expect(screen.getByText('0.5.31 built-in settings')).toBeTruthy()
      expect(screen.queryByRole('heading', { name: '记忆 Provider' })).toBeNull()
    })

    it('dsh-mnemon 0.5.31 and Memory Spaces 0.5.21: the old built-in shows, as before', () => {
      const { ctx, slots, spaces } = page()
      installOldStarter(ctx)
      expect(spaces()).toHaveLength(1)
      rendered(slots, owner(false))
      expect(screen.getByText('0.5.31 built-in settings')).toBeTruthy()
    })

    it('needs the check: DSH refuses a second registration for the package at the same priority', async () => {
      const { ctx } = page()
      installOldStarter(ctx)
      const client = await spacesClient(false)
      expect(() => client.installMemorySpacesSettings(ctx as never)).toThrow(/already has an entry for key "dsh-mnemon-source-memory-spaces"/u)
    })

    it('shows nothing from Memory Spaces\' own settings without what dsh-mnemon lends them', async () => {
      const client = await spacesClient(true)
      const view = render(<>{client.MemorySpacesSettings(owner(false))}</>)
      expect(view.container.textContent).toBe('')
    })
  })

  function host(options: { held?: boolean } = {}) {
    const endpoints: string[] = []
    const held: Array<() => void> = []
    const answer = (endpoint: string) => {
      if (endpoint === 'status-summary') return { ok: true, value: { commandFound: false } }
      if (endpoint === 'provider-services') return { ok: true, value: { providers: [openviking], items: [{ providerId: 'openviking', enabled: true, configured: true, settings: {}, configuredSecrets: [] }], generatedAt: 'now' } }
      return { ok: false, error: { code: 'bad-request', message: endpoint, details: {} } }
    }
    const connection = { isLoopback: true, rpc: { call: vi.fn(async (_channel: string, endpoint: string) => {
      endpoints.push(endpoint)
      if (options.held === true) await new Promise<void>(resolve => { held.push(resolve) })
      return answer(endpoint)
    }) } } as unknown as ClientConnectionHandle
    const lent = createComponentHosts({ scope, connection })(MEMORY_SPACES_PACKAGE)!
    return { lent, endpoints, release: () => { for (const resolve of held.splice(0)) resolve() } }
  }

  const settle = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }

  describe('turning Memory Spaces on from its page', () => {
    async function swap(options: { held?: boolean }) {
      const { ctx, slots } = page(translateEn)
      const { lent, endpoints, release } = host(options)
      const props: MemoryComponentSettingsProps = { component: { packageName: MEMORY_SPACES_PACKAGE, label: 'Memory Spaces', enabled: true }, writable: true, language: 'en', host: lent }
      const region = () => <>{renderComponentRegion({ slots }, MNEMON_COMPONENT_SETTINGS_SLOT, MEMORY_SPACES_PACKAGE, props)}</>
      installShippedComponentSettings(ctx as never, { scope, t: translateEn })
      const view = render(region())
      const card = () => within(view.container).queryByRole('group', { name: `OpenViking ${(spacesCopy.en as Record<string, string>)['config.providerServiceTitle']}` })
      const native = () => within(view.container).queryByText((spacesCopy.en as Record<string, string>)['config.nativeCliMissing']!)
      return { ctx, view, region, card, native, endpoints, release, replace: async () => {
        const client = await spacesClient(true)
        client.installMemorySpacesSettings(ctx as never)
        view.rerender(region())
      } }
    }

    it('keeps the Providers and the Native card as they were when Memory Spaces\' own settings replace the fallback', async () => {
      const settings = await swap({})
      await settle()
      expect(settings.card()).not.toBeNull()
      expect(settings.native()).not.toBeNull()
      const fallback = settings.view.container.querySelector('section')
      await settings.replace()
      expect(settings.view.container.querySelector('section')).not.toBe(fallback)
      expect(settings.card()).not.toBeNull()
      expect(settings.native()).not.toBeNull()
      expect(within(settings.view.container).queryByText((spacesCopy.en as Record<string, string>)['config.loadingProviders']!)).toBeNull()
      await settle()
      expect(settings.card()).not.toBeNull()
      expect(settings.native()).not.toBeNull()
      expect(settings.endpoints).toEqual(['provider-services', 'status-summary', 'provider-services', 'status-summary'])
    })

    it('joins the reads the fallback started when Memory Spaces\' own settings replace it while they load', async () => {
      const settings = await swap({ held: true })
      await settle()
      expect(settings.endpoints).toEqual(['provider-services', 'status-summary'])
      await settings.replace()
      await settle()
      settings.release()
      await settle()
      expect(settings.card()).not.toBeNull()
      expect(settings.native()).not.toBeNull()
      expect(settings.endpoints).toEqual(['provider-services', 'status-summary'])
    })
  })

  describe('the built Memory Spaces client beside dsh-mnemon 0.5.31', () => {
    const require = createRequire(import.meta.url)
    const bundle = (entry: string) => {
      const path = require.resolve(entry)
      if (!existsSync(path)) throw new Error(`Build ${entry} first`)
      return path
    }
    const names = (require('./fixtures/dsh-mnemon-client-0.5.31-exports.json') as { exports: string[] }).exports

    async function load() {
      const react = { react: await import('react'), 'react/jsx-runtime': await import('react/jsx-runtime'), 'react-dom': await import('react-dom'),
        '@deepseek-ai/dsh-client-ui-primitives': await import('@deepseek-ai/dsh-client-ui-primitives') }
      const current = loadMemoryClientArtifact<Record<string, unknown>>(bundle('dsh-mnemon/client'), react)
      const old = Object.fromEntries(names.map(name => [name, current[name]]))
      expect(names.every(name => current[name] !== undefined)).toBe(true)
      return loadMemoryClientArtifact<Record<string, unknown>>(bundle('dsh-mnemon-source-memory-spaces/client'), { ...react, 'dsh-mnemon/client': old })
    }

    it('registers its pages and no settings', async () => {
      const spaces = await load()
      const registered: string[] = []
      const ctx = {
        locale: { bind: () => translateEn },
        slots: { inject: (_name: string, setup: () => () => void) => setup(), register: (options: { name: string }) => { registered.push(options.name); return () => {} } },
      }
      ;(spaces.apply as (ctx: unknown) => void)(ctx)
      expect(registered.filter(name => name === 'mnemon.source.page')).toHaveLength(5)
      expect(registered.filter(name => name === MNEMON_COMPONENT_SETTINGS_SLOT)).toEqual([])
    })

    it('draws the dialogs that share the Provider field', async () => {
      const spaces = await load()
      const providers = [mem0, hindsight, holographic].map(descriptor => ({ ...descriptor, serviceConfigured: true }))
      const read = vi.fn(async (operation: string) => ({ revision: 'r1', value: operation === 'status-summary'
        ? { writeEnabled: true, memoryBodies: [], defaultRecallLimit: 12 }
        : operation === 'body-directory' || operation === 'bodies' ? { items: [], providers, total: 0, activeCount: 0, directory: '', generatedAt: '2026-10-17T00:00:00.000Z' }
        : operation === 'graph' ? { nodes: [], edges: [], generatedAt: '2026-10-17T00:00:00.000Z' }
        : [] }))
      const Page = spaces.MemorySpacesSourcePage as ComponentType<Record<string, unknown>>
      render(<Page page="spaces" sourceTypeId="memory-spaces" sourceInstanceKey="source:spaces" sourceInstances={[]} locale="en" writable management={{ sourceInstanceKey: 'source:spaces', revision: 'r1', read, mutate: vi.fn() }} />)
      fireEvent.click(await screen.findByRole('button', { name: 'New' }))
      const dialog = screen.getByRole('dialog', { name: 'Create Memory Space' })
      for (const [descriptor, control] of [[mem0, 'input[type="checkbox"]'], [hindsight, 'button'], [holographic, 'input[type="number"]']] as const) {
        fireEvent.click(within(dialog).getByRole('radio', { name: new RegExp(descriptor.label, 'u') }))
        expect(dialog.querySelector(`[data-provider="${descriptor.id}"] ${control}`)).not.toBeNull()
      }
    })
  })
})
