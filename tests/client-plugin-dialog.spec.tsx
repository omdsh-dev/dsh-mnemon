// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memoryPlugin as basePlugin, memoryStrategyConfiguration as base } from 'dsh-mnemon-strategy-default-three-tier'
import { memoryPlugin as scopedPlugin, memoryStrategyConfiguration as scoped } from 'dsh-mnemon-strategy-scoped'
import { memoryPlugin as lightPlugin, memoryStrategyConfiguration as light } from 'dsh-mnemon-strategy-light-context'
import { memoryPlugin as capturePlugin, memoryStrategyConfiguration as capture } from 'dsh-mnemon-strategy-auto-capture'
import type { MemoryViewConfigurationRequest, MemoryViewDashboard } from '../src/host/view-protocol.ts'
import { MemoryPluginDialog } from '../src/client/MemoryPluginDialog.tsx'
import { I18nContext, LocaleContext } from '../src/client/page-kit.tsx'
import { en, translateEn, translateZh, zh } from '../src/client/locales.ts'
import { pluginZh } from '../src/client/plugin-locales.ts'
import type { MemoryPluginDescriptor } from '../src/core/contracts/index.ts'
import type { MemoryStrategyConfiguration } from '../src/sdk/strategy-configuration.ts'

afterEach(cleanup)

function fixture() {
  const sourceEntry = (entryId: string, packageName: string, en: string, zhCN: string, capability: string, enabled: boolean, writable: boolean) => ({
    entryId, packageName, roles: ['source' as const], label: { en, 'zh-CN': zhCN }, description: { en: 'Memory source.', 'zh-CN': '记忆来源。' },
    fields: [], provides: [{ id: 'source', exclusive: false }, { id: capability, exclusive: false }], requires: [], requiredBy: [],
    enabled, active: enabled, writable, config: {},
  })
  const strategyEntry = (definition: MemoryStrategyConfiguration, plugin: MemoryPluginDescriptor, index: number) => ({
    entryId: definition.typeId, packageName: plugin.packageName, typeId: definition.typeId, roles: plugin.roles,
    label: plugin.label, description: plugin.description, fields: definition.fields,
    provides: plugin.provides.map(value => ({ id: value.id, exclusive: value.exclusive === true })), requires: [...plugin.requires ?? []], requiredBy: [],
    enabled: index === 0, active: index === 0, writable: true, config: {}, ...(index === 0 ? {} : { strategyTypeId: 'default-three-tier' }),
  })
  const densePlugin: MemoryPluginDescriptor = { ...lightPlugin, packageName: 'dsh-mnemon-strategy-dense-context',
    label: { en: 'Dense context', 'zh-CN': '密集上下文' }, description: { en: 'Alternative projection policy.', 'zh-CN': '另一种投影策略。' } }
  let dashboard: MemoryViewDashboard = {
    revision: 'settings-1', writable: true, strategyTypeId: 'default-three-tier', diagnostics: [], currentUnavailable: 'no-session',
    pluginInstallation: { supported: true, profileName: 'web', suggestions: ['dsh-mnemon-strategy-scoped', 'dsh-mnemon-strategy-light-context', 'dsh-mnemon-strategy-auto-capture'] },
    sources: [
      { sourceInstanceKey: 'source:runtime', sourceTypeId: 'runtime', packageName: 'dsh-mnemon-source-runtime', label: 'Runtime', role: 'working-context' },
      { sourceInstanceKey: 'source:documents', sourceTypeId: 'documents', packageName: 'dsh-mnemon-source-documents', label: 'Documents', role: 'narrative' },
      { sourceInstanceKey: 'source:spaces', sourceTypeId: 'memory-spaces', packageName: 'dsh-mnemon-source-memory-spaces', label: 'Memory Spaces', role: 'durable-evidence' },
    ],
    entries: [
      sourceEntry('runtime', 'dsh-mnemon-source-runtime', 'Runtime memory', '运行时记忆', 'source.working-context', true, true),
      sourceEntry('documents', 'dsh-mnemon-source-documents', 'Documents', '档案', 'source.narrative', true, true),
      sourceEntry('spaces', 'dsh-mnemon-source-memory-spaces', 'Memory Spaces', '记忆空间', 'source.durable-evidence', true, true),
      sourceEntry('notion', 'dsh-mnemon-source-notion', 'Notion', 'Notion', 'source.narrative', false, true),
      strategyEntry(base, basePlugin, 0), strategyEntry(scoped, scopedPlugin, 1), strategyEntry(light, lightPlugin, 2),
      { ...strategyEntry(light, densePlugin, 3), entryId: 'dense-context', typeId: 'dense-context' }, strategyEntry(capture, capturePlugin, 4),
    ],
  }
  const client = {
    viewDashboard: vi.fn(async () => structuredClone(dashboard)),
    applyView: vi.fn(async (request: MemoryViewConfigurationRequest) => {
      dashboard = { ...dashboard, revision: 'settings-2', strategyTypeId: request.strategyTypeId,
        entries: dashboard.entries.map(entry => ({ ...entry, ...request.entries[entry.entryId], active: request.entries[entry.entryId]?.enabled ?? entry.active })) }
      return { saved: true as const }
    }),
    inspectMemoryPlugin: vi.fn(async (packageName: string) => ({ packageName, version: '0.5.0-beta.4', kind: packageName.includes('-source-') ? 'source' as const : 'strategy' as const,
      description: 'Notion memory Source.', mnemonPeerRange: '^0.5.0-beta.1', installed: false })),
    installMemoryPlugin: vi.fn(async (packageName: string, version: string) => ({ packageName, version, profileName: 'web', installed: true as const, restartRequired: true as const })),
  }
  const mount = (canConfigure = true) => render(<I18nContext.Provider value={translateEn}><LocaleContext.Provider value="en"><MemoryPluginDialog client={client} canConfigure={canConfigure} onClose={() => {}} /></LocaleContext.Provider></I18nContext.Provider>)
  return { client, mount }
}

describe('Memory plugin dialog', () => {
  it('shows peer plugins and composes independent contributions in one save', async () => {
    const f = fixture(); f.mount()
    const dialog = await screen.findByRole('dialog', { name: 'Memory plugins' })
    expect(within(dialog).getByText('4/9 plugins enabled')).toBeTruthy()
    expect(within(dialog).getByText('dsh-mnemon-source-runtime')).toBeTruthy()
    expect(within(dialog).getByText('Notion')).toBeTruthy()
    expect(within(dialog).getByText('dsh-mnemon-source-notion')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('switch', { name: scoped.label.en }))
    fireEvent.click(within(dialog).getByRole('switch', { name: light.label.en }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save composition' }))
    await waitFor(() => expect(f.client.applyView).toHaveBeenCalledOnce())
    expect(f.client.applyView.mock.calls[0]![0].entries).toMatchObject({ scoped: { enabled: true }, 'light-context': { enabled: true }, 'auto-capture': { enabled: false } })
    expect(within(dialog).getByText('Composition saved. Future turns will use the new configuration.')).toBeTruthy()
  })

  it('stages a Source through the same graph save as every Strategy', async () => {
    const f = fixture(); f.mount()
    const dialog = await screen.findByRole('dialog', { name: 'Memory plugins' })
    const toggle = within(dialog).getByRole('switch', { name: 'Notion' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(within(dialog).getByRole('switch', { name: 'Notion' }).getAttribute('aria-checked')).toBe('true')
    expect(f.client.applyView).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save composition' }))
    await waitFor(() => expect(f.client.applyView).toHaveBeenCalledOnce())
    expect(f.client.applyView.mock.calls[0]![0].entries.notion).toMatchObject({ enabled: true })
  })

  it('fills a unique dependency and removes a dependent when its provider is disabled', async () => {
    const f = fixture(); f.mount()
    const dialog = await screen.findByRole('dialog', { name: 'Memory plugins' })
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Memory Spaces' }))
    expect(within(dialog).getByRole('switch', { name: 'Memory Spaces' }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(within(dialog).getByRole('switch', { name: capture.label.en }))
    expect(within(dialog).getByRole('switch', { name: 'Memory Spaces' }).getAttribute('aria-checked')).toBe('true')
    expect(within(dialog).getByRole('switch', { name: capture.label.en }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Memory Spaces' }))
    expect(within(dialog).getByRole('switch', { name: capture.label.en }).getAttribute('aria-checked')).toBe('false')
  })

  it('replaces an enabled peer when two plugins provide the same exclusive capability', async () => {
    const f = fixture(); f.mount()
    const dialog = await screen.findByRole('dialog', { name: 'Memory plugins' })
    fireEvent.click(within(dialog).getByRole('switch', { name: light.label.en }))
    expect(within(dialog).getByRole('switch', { name: light.label.en }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Dense context' }))
    expect(within(dialog).getByRole('switch', { name: light.label.en }).getAttribute('aria-checked')).toBe('false')
    expect(within(dialog).getByRole('switch', { name: 'Dense context' }).getAttribute('aria-checked')).toBe('true')
  })

  it('inspects an exact package and requires a second explicit install action', async () => {
    const f = fixture(); f.mount()
    const dialog = await screen.findByRole('dialog', { name: 'Memory plugins' })
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Discover' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'npm package name' }), { target: { value: 'dsh-mnemon-source-notion' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Inspect' }))
    await within(dialog).findByText('Notion memory Source.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install to web' }))
    expect(f.client.installMemoryPlugin).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm installation of dsh-mnemon-source-notion@0.5.0-beta.4' }))
    await waitFor(() => expect(f.client.installMemoryPlugin).toHaveBeenCalledWith('dsh-mnemon-source-notion', '0.5.0-beta.4'))
    expect(within(dialog).getByText('Installed. Restart DSH to register the plugin in its disabled state.')).toBeTruthy()
  })

  it('keeps configuration and installation controls read-only when authority is absent', async () => {
    const f = fixture(); f.mount(false)
    const dialog = await screen.findByRole('dialog', { name: 'Memory plugins' })
    expect((within(dialog).getByRole('switch', { name: scoped.label.en }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(dialog).getByRole('switch', { name: 'Notion' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps every plugin-specific locale key in parity', () => {
    for (const key of Object.keys(pluginZh) as Array<keyof typeof pluginZh>) {
      expect(zh[key]).toBe(pluginZh[key]); expect(en[key]).toBeTruthy()
    }
    expect(translateZh('plugins.open')).toBe('记忆插件')
  })
})
