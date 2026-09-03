// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memoryStrategyConfiguration as base } from 'dsh-mnemon-strategy-default-three-tier'
import { memoryStrategyConfiguration as scoped } from 'dsh-mnemon-strategy-scoped'
import { memoryStrategyConfiguration as light } from 'dsh-mnemon-strategy-light-context'
import { memoryStrategyConfiguration as capture } from 'dsh-mnemon-strategy-auto-capture'
import type { MemoryViewConfigurationRequest, MemoryViewDashboard } from '../src/host/view-protocol.ts'
import { MemoryPluginDialog } from '../src/client/MemoryPluginDialog.tsx'
import { I18nContext, LocaleContext } from '../src/client/page-kit.tsx'
import { en, translateEn, translateZh, zh } from '../src/client/locales.ts'
import { pluginZh } from '../src/client/plugin-locales.ts'

afterEach(cleanup)

function fixture() {
  let dashboard: MemoryViewDashboard = {
    revision: 'settings-1', writable: true, strategyTypeId: 'default-three-tier', diagnostics: [], currentUnavailable: 'no-session',
    pluginInstallation: { supported: true, profileName: 'web', suggestions: ['dsh-mnemon-strategy-scoped', 'dsh-mnemon-strategy-light-context', 'dsh-mnemon-strategy-auto-capture'] },
    sources: [
      { sourceInstanceKey: 'source:runtime', sourceTypeId: 'runtime', packageName: 'dsh-mnemon-source-runtime', label: 'Runtime', role: 'working-context' },
      { sourceInstanceKey: 'source:documents', sourceTypeId: 'documents', packageName: 'dsh-mnemon-source-documents', label: 'Documents', role: 'narrative' },
      { sourceInstanceKey: 'source:spaces', sourceTypeId: 'memory-spaces', packageName: 'dsh-mnemon-source-memory-spaces', label: 'Memory Spaces', role: 'durable-evidence' },
    ],
    registeredPlugins: [
      { entryId: 'runtime', packageName: 'dsh-mnemon-source-runtime', kind: 'source', enabled: true, active: true, writable: false },
      { entryId: 'documents', packageName: 'dsh-mnemon-source-documents', kind: 'source', enabled: true, active: true, writable: false },
      { entryId: 'spaces', packageName: 'dsh-mnemon-source-memory-spaces', kind: 'source', enabled: true, active: true, writable: false },
      { entryId: 'notion', packageName: 'dsh-mnemon-source-notion', kind: 'source', enabled: false, active: false, writable: true },
      ...[base, scoped, light, capture].map((definition, index) => ({ entryId: definition.typeId, packageName: 'dsh-mnemon-strategy-' + definition.typeId,
        kind: 'strategy' as const, enabled: index === 0, active: index === 0, writable: true })),
    ],
    entries: [base, scoped, light, capture].map((definition, index) => ({ entryId: definition.typeId, packageName: 'dsh-mnemon-strategy-' + definition.typeId,
      typeId: definition.typeId, kind: definition.kind, label: definition.label, description: definition.description, fields: definition.fields,
      enabled: index === 0, active: index === 0, writable: true, config: {}, ...(index === 0 ? {} : { strategyTypeId: 'default-three-tier' }),
    })),
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
    setSourceMemoryPluginEnabled: vi.fn(async (entryId: string, enabled: boolean) => {
      dashboard = { ...dashboard, registeredPlugins: dashboard.registeredPlugins.map(entry => entry.entryId === entryId ? { ...entry, enabled, active: enabled } : entry) }
      return { saved: true as const }
    }),
  }
  const mount = (canConfigure = true) => render(<I18nContext.Provider value={translateEn}><LocaleContext.Provider value="en"><MemoryPluginDialog client={client} canConfigure={canConfigure} onClose={() => {}} /></LocaleContext.Provider></I18nContext.Provider>)
  return { client, mount }
}

describe('Memory plugin dialog', () => {
  it('shows Sources and composes independent Strategy extensions in one save', async () => {
    const f = fixture(); f.mount()
    const dialog = await screen.findByRole('dialog', { name: 'Memory plugins' })
    expect(within(dialog).getByText('3 Sources · 1/4 Strategies enabled')).toBeTruthy()
    expect(within(dialog).getByText('dsh-mnemon-source-runtime')).toBeTruthy()
    expect(within(dialog).getAllByText('dsh-mnemon-source-notion')).toHaveLength(2)
    fireEvent.click(within(dialog).getByRole('switch', { name: scoped.label.en }))
    fireEvent.click(within(dialog).getByRole('switch', { name: light.label.en }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save composition' }))
    await waitFor(() => expect(f.client.applyView).toHaveBeenCalledOnce())
    expect(f.client.applyView.mock.calls[0]![0].entries).toMatchObject({ scoped: { enabled: true }, 'light-context': { enabled: true }, 'auto-capture': { enabled: false } })
    expect(within(dialog).getByText('Composition saved. Future turns will use the new configuration.')).toBeTruthy()
  })

  it('activates a registered Source through its real Entry endpoint', async () => {
    const f = fixture(); f.mount()
    const dialog = await screen.findByRole('dialog', { name: 'Memory plugins' })
    const toggle = within(dialog).getByRole('switch', { name: 'dsh-mnemon-source-notion' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(f.client.setSourceMemoryPluginEnabled).toHaveBeenCalledWith('notion', true))
    expect(within(dialog).getByRole('switch', { name: 'dsh-mnemon-source-notion' }).getAttribute('aria-checked')).toBe('true')
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
    expect((within(dialog).getByRole('switch', { name: 'dsh-mnemon-source-notion' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps every plugin-specific locale key in parity', () => {
    for (const key of Object.keys(pluginZh) as Array<keyof typeof pluginZh>) {
      expect(zh[key]).toBe(pluginZh[key]); expect(en[key]).toBeTruthy()
    }
    expect(translateZh('plugins.open')).toBe('记忆插件')
  })
})
