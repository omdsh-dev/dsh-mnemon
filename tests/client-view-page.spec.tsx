// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memoryStrategyConfiguration as base } from 'dsh-mnemon-strategy-default-three-tier'
import { memoryStrategyConfiguration as scoped } from 'dsh-mnemon-strategy-scoped'
import { memoryStrategyConfiguration as light } from 'dsh-mnemon-strategy-light-context'
import { memoryStrategyConfiguration as capture } from 'dsh-mnemon-strategy-auto-capture'
import type { MemoryViewConfigurationRequest, MemoryViewDashboard, MemoryViewInspection } from '../src/host/view-protocol.ts'
import type { ClientSettingsScope, Config } from '../src/host/protocol.ts'
import { MemoryViewPage } from '../src/client/MemoryViewPage.tsx'
import { MnemonView } from '../src/client/MnemonView.tsx'
import { I18nContext, LocaleContext } from '../src/client/page-kit.tsx'
import { translateEn, translateZh, zh, en } from '../src/client/locales.ts'
import { viewZh } from '../src/client/view-locales.ts'

afterEach(cleanup)

function snapshot(state: MemoryViewInspection['state'] = 'active'): MemoryViewInspection {
  return { state, id: 'view:original', digest: 'digest:original', generationId: 'generation:original', createdAt: '2026-09-01T00:00:00Z', turn: 1,
    strategyTypeId: 'default-three-tier', strategyInstanceKey: 'strategy:base', extensions: [],
    projection: [{ id: 'fragment-1', sourceInstanceKey: 'source:runtime', mode: 'eager', text: 'Original session context', revision: 'r1' }],
    routes: [{ id: 'route:1', sourceInstanceKey: 'source:documents', operationId: 'search', description: 'Search records', maxCalls: 2 }],
    actions: [{ id: 'action:1', sourceInstanceKey: 'source:runtime', operationId: 'mutate', description: 'Write runtime' }],
    memoryText: 'Exact original Host memory text', guidance: { system: 'Original Strategy instructions' }, diagnostics: [],
  }
}
function fixture() {
  let dashboard: MemoryViewDashboard = { revision: 'settings-1', writable: true, strategyTypeId: 'default-three-tier', current: snapshot(), diagnostics: [],
    sources: [
      { sourceInstanceKey: 'source:runtime', sourceTypeId: 'runtime', label: 'Runtime', role: 'working-context' },
      { sourceInstanceKey: 'source:documents', sourceTypeId: 'documents', label: 'Documents', role: 'narrative' },
      { sourceInstanceKey: 'source:spaces', sourceTypeId: 'memory-spaces', label: 'Memory Spaces', role: 'durable-evidence' },
    ],
    entries: [base, scoped, light, capture].map((definition, index) => ({ entryId: definition.typeId, packageName: 'dsh-mnemon-strategy-' + definition.typeId,
      typeId: definition.typeId, kind: definition.kind, label: definition.label, description: definition.description, fields: definition.fields,
      enabled: index === 0, active: index === 0, writable: true, config: {}, ...(index === 0 ? {} : { strategyTypeId: 'default-three-tier' }),
    })),
  }
  const client = {
    viewDashboard: vi.fn(async () => structuredClone(dashboard)),
    previewView: vi.fn(async (_request: MemoryViewConfigurationRequest): Promise<MemoryViewInspection> => ({ ...snapshot('preview'), id: 'view:preview',
      projection: [{ id: 'preview-fragment', sourceInstanceKey: 'source:runtime', mode: 'eager', text: 'Preview-only context', revision: 'r1' }],
      memoryText: 'Preview-only Host text',
    })),
    applyView: vi.fn(async (request: MemoryViewConfigurationRequest): Promise<{ saved: true }> => {
      dashboard = { ...dashboard, revision: 'settings-2', strategyTypeId: request.strategyTypeId,
        entries: dashboard.entries.map(entry => ({ ...entry, ...request.entries[entry.entryId], active: request.entries[entry.entryId]?.enabled ?? entry.active })) }
      return { saved: true }
    }),
  }
  const mount = (locale = 'en', canConfigure = true) => render(<I18nContext.Provider value={locale === 'en' ? translateEn : translateZh}><LocaleContext.Provider value={locale}><MemoryViewPage client={client} canConfigure={canConfigure} /></LocaleContext.Provider></I18nContext.Provider>)
  return { client, mount, dashboard: () => dashboard, update: (value: Partial<MemoryViewDashboard>) => { dashboard = { ...dashboard, ...value } } }
}
const editor = () => within(screen.getByRole('form', { name: 'Strategy composition' }))
async function ready() { await screen.findByText('Original session context') }
function configure(name: string) {
  const card = within(screen.getByRole('region', { name }))
  fireEvent.click(card.getByText('Configure'))
  return card
}

describe('View page interaction and localization', () => {
  it('renders real snapshot content, operations, guidance and raw memory without adding demo metrics', async () => {
    const f = fixture(); f.mount(); await ready()
    expect(screen.getByText('Pinned for this turn')).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Choose base strategy' })).toBeNull()
    expect(screen.getByText('Search records')).toBeTruthy()
    expect(screen.getByText('Original Strategy instructions')).toBeTruthy()
    expect(screen.getByText('Exact original Host memory text')).toBeTruthy()
    expect(f.client.previewView).not.toHaveBeenCalled()
    expect(f.client.applyView).not.toHaveBeenCalled()
  })

  it('keeps draft, read-only preview and pinned current View distinct until an explicit save', async () => {
    const f = fixture(); f.mount(); await ready()
    fireEvent.click(screen.getByRole('switch', { name: 'Light context' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Active capture' }))
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    expect(screen.getByText('Original session context')).toBeTruthy()
    expect(f.client.applyView).not.toHaveBeenCalled()
    fireEvent.click(editor().getByRole('button', { name: 'Generate preview' }))
    await screen.findByText('Preview-only context')
    expect(screen.getByText('Read-only preview · not injected')).toBeTruthy()
    expect(f.client.previewView).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 'settings-1', entries: expect.objectContaining({
      'light-context': { enabled: true, config: {} }, 'auto-capture': { enabled: true, config: {} },
    }) }))
    fireEvent.click(screen.getByRole('tab', { name: 'Actual View' }))
    expect(screen.getByText('Original session context')).toBeTruthy()
    fireEvent.click(editor().getByRole('button', { name: 'Apply to future turns' }))
    await screen.findByText('Saved. Future turns use the new composition; this turn’s snapshot is unchanged.')
    expect(screen.getByText('Original session context')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Active capture' }).getAttribute('aria-checked')).toBe('true')
    expect(f.client.applyView).toHaveBeenCalledOnce()
  })

  it('edits declared numeric fields and restores omission rather than persisting a synthetic default', async () => {
    const f = fixture(); f.mount(); await ready()
    fireEvent.click(screen.getByRole('switch', { name: 'Light context' }))
    const card = configure('Light context')
    const inherit = card.getByRole('checkbox', { name: 'Resident character ceiling · Use plugin default' })
    fireEvent.click(inherit)
    fireEvent.change(card.getByRole('spinbutton'), { target: { value: '1024' } })
    fireEvent.click(editor().getByRole('button', { name: 'Generate preview' }))
    await waitFor(() => expect(f.client.previewView).toHaveBeenLastCalledWith(expect.objectContaining({ entries: expect.objectContaining({ 'light-context': { enabled: true, config: { maxProjectionCharacters: 1024 } } }) })))
    await screen.findByText('Preview-only context')
    fireEvent.click(inherit)
    fireEvent.click(editor().getByRole('button', { name: 'Apply to future turns' }))
    await waitFor(() => expect(f.client.applyView).toHaveBeenCalledWith(expect.objectContaining({ entries: expect.objectContaining({ 'light-context': { enabled: true, config: {} } }) })))
  })

  it('retains explicit empty writable selection and source priority order', async () => {
    const f = fixture(); f.mount(); await ready()
    fireEvent.click(screen.getByRole('switch', { name: 'Scoped composition' }))
    const card = configure('Scoped composition')
    fireEvent.click(card.getByRole('checkbox', { name: 'Writable Sources · Use plugin default' }))
    fireEvent.click(card.getByRole('checkbox', { name: 'Sources, in priority order · Use plugin default' }))
    fireEvent.click(card.getByRole('checkbox', { name: 'Sources, in priority order · Runtime' }))
    fireEvent.click(card.getByRole('checkbox', { name: 'Sources, in priority order · Documents' }))
    fireEvent.click(card.getByRole('button', { name: 'Move Documents up' }))
    fireEvent.click(editor().getByRole('button', { name: 'Apply to future turns' }))
    await waitFor(() => expect(f.client.applyView).toHaveBeenCalledWith(expect.objectContaining({ entries: expect.objectContaining({ scoped: {
      enabled: true, config: { sourceKeys: ['source:documents', 'source:runtime'], writableSourceKeys: [] },
    } }) })))
  })

  it('supports multiline operation IDs without eating a typed newline', async () => {
    const f = fixture(); f.mount(); await ready()
    fireEvent.click(screen.getByRole('switch', { name: 'Active capture' }))
    const card = configure('Active capture')
    fireEvent.click(card.getByRole('checkbox', { name: 'Recording operation IDs · Use plugin default' }))
    const input = card.getByRole('textbox', { name: 'Recording operation IDs' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'remember\n' } })
    expect(input.value).toBe('remember\n')
    fireEvent.change(input, { target: { value: 'remember\nappend' } })
    fireEvent.click(editor().getByRole('button', { name: 'Apply to future turns' }))
    await waitFor(() => expect(f.client.applyView).toHaveBeenCalledWith(expect.objectContaining({ entries: expect.objectContaining({ 'auto-capture': { enabled: true, config: { actionIds: ['remember', 'append'] } } }) })))
  })

  it('rejects invalid number input before sending preview or apply', async () => {
    const f = fixture(); f.mount(); await ready()
    const card = configure('Light context')
    fireEvent.click(card.getByRole('checkbox', { name: 'Resident character ceiling · Use plugin default' }))
    fireEvent.change(card.getByRole('spinbutton'), { target: { value: '0' } })
    fireEvent.click(editor().getByRole('button', { name: 'Generate preview' }))
    expect(f.client.previewView).not.toHaveBeenCalled()
    expect(f.client.applyView).not.toHaveBeenCalled()
  })

  it('preserves unsaved work on refresh, then explicitly discards a stale draft', async () => {
    const f = fixture(); f.mount(); await ready()
    fireEvent.click(screen.getByRole('switch', { name: 'Light context' }))
    f.update({ revision: 'external-revision' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh view status' }))
    await screen.findByText('Configuration changed elsewhere. Discard this draft and refresh before editing again.')
    expect(screen.getByRole('switch', { name: 'Light context' }).getAttribute('aria-checked')).toBe('true')
    expect((editor().getByRole('button', { name: 'Apply to future turns' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(editor().getByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Light context' }).getAttribute('aria-checked')).toBe('false'))
    expect(f.client.applyView).not.toHaveBeenCalled()
  })

  it('shows save failure without claiming success or replacing the actual snapshot', async () => {
    const f = fixture(); f.client.applyView.mockRejectedValueOnce(new Error('Plugin activation rejected'))
    f.mount(); await ready()
    fireEvent.click(screen.getByRole('switch', { name: 'Light context' }))
    fireEvent.click(editor().getByRole('button', { name: 'Apply to future turns' }))
    await screen.findByRole('alert')
    expect(screen.getByText('Plugin activation rejected')).toBeTruthy()
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    expect(screen.getByText('Original session context')).toBeTruthy()
    expect(screen.queryByText(/^Saved\./)).toBeNull()
  })

  it('allows inspection and preview while configuration is read-only', async () => {
    const f = fixture(); f.mount('en', false); await ready()
    expect((screen.getByRole('switch', { name: 'Light context' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(editor().getByRole('button', { name: 'Generate preview' }))
    await screen.findByText('Preview-only context')
    expect(f.client.applyView).not.toHaveBeenCalled()
  })

  it('does not invent a turn for no-session or mismatched workspace states', async () => {
    const f = fixture()
    const { current: _current, ...withoutCurrent } = f.dashboard()
    f.update({ ...withoutCurrent, current: undefined, currentUnavailable: 'unaligned' } as unknown as Partial<MemoryViewDashboard>)
    f.mount()
    await screen.findByText('This workspace differs from the conversation. Align them to inspect its snapshot, or preview configuration for this directory.')
    expect(screen.queryByText('Original session context')).toBeNull()
    fireEvent.click(editor().getByRole('button', { name: 'Generate preview' }))
    await screen.findByText('Preview-only context')
  })

  it('ignores a late preview response after the workspace component unmounts', async () => {
    const f = fixture()
    let complete!: (value: MemoryViewInspection) => void
    f.client.previewView.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const ui = f.mount(); await ready()
    fireEvent.click(editor().getByRole('button', { name: 'Generate preview' }))
    ui.unmount()
    await act(async () => { complete({ ...snapshot('preview'), memoryText: 'Late data' }) })
    expect(screen.queryByText('Late data')).toBeNull()
    expect(f.client.applyView).not.toHaveBeenCalled()
  })

  it.each(['zh', 'en'])('exposes the actual top-level tab as 视图 / View (%s)', async locale => {
    const f = fixture()
    const settingsSnapshot = { status: 'ready' as const, value: {}, revision: 0, writable: true, mode: 'host' as const }
    const settings: ClientSettingsScope<Config> = { getSnapshot: () => settingsSnapshot, subscribe: () => () => {}, set: async () => {}, unset: async () => {}, setPath: async () => {}, unsetPath: async () => {} }
    const connection = { rpc: { call: vi.fn(async (_channel: string, endpoint: string) => ({ ok: true as const, value: endpoint === 'dashboard' ? f.dashboard() : endpoint === 'source-management-catalog' ? { generationId: 'g', sources: [] } : { healthy: true, writeEnabled: true, memoryBodies: [] } })) } }
    render(<MnemonView connection={connection as never} settingsScope={settings} t={locale === 'zh' ? translateZh : translateEn} locale={locale} />)
    const title = locale === 'zh' ? '视图' : 'View'
    fireEvent.click(await screen.findByRole('tab', { name: title }))
    await screen.findByRole('heading', { name: title })
    await ready()
    expect(screen.getByRole('switch', { name: locale === 'zh' ? '轻量上下文' : 'Light context' })).toBeTruthy()
  })

  it('keeps all View copy translated with matching interpolation fields', () => {
    for (const key of Object.keys(viewZh) as Array<keyof typeof viewZh>) {
      expect(typeof en[key]).toBe('string')
      expect([...zh[key].matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()).toEqual([...en[key].matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort())
    }
  })
})
