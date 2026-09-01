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
const editor = () => {
  const open = screen.queryByRole('form', { name: 'Strategy composition' })
  if (open) return within(open)
  fireEvent.click(screen.getByRole('button', { name: 'Strategy settings' }))
  return within(screen.getByRole('form', { name: 'Strategy composition' }))
}
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
    expect(screen.queryByRole('form', { name: 'Strategy composition' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Resident context' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'On-demand capabilities' })).toBeTruthy()
    expect(screen.getByRole('complementary', { name: 'View details' })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Choose base strategy' })).toBeNull()
    expect(screen.getByText('Search records')).toBeTruthy()
    expect(screen.getByText('Original Strategy instructions')).toBeTruthy()
    expect(screen.getByText('Exact original Host memory text')).toBeTruthy()
    expect(f.client.previewView).not.toHaveBeenCalled()
    expect(f.client.applyView).not.toHaveBeenCalled()
  })

  it('keeps a backup-shaped multi-Source View legible without duplicating long resident content', async () => {
    const f = fixture()
    const sources: MemoryViewDashboard['sources'] = [
      { sourceInstanceKey: 'source:runtime', sourceTypeId: 'runtime', label: 'Runtime', role: 'working-context' },
      { sourceInstanceKey: 'source:documents', sourceTypeId: 'documents', label: 'Documents', role: 'narrative' },
      { sourceInstanceKey: 'source:spaces', sourceTypeId: 'memory-spaces', label: 'Memory Spaces', role: 'durable-evidence' },
      { sourceInstanceKey: 'source:notion', sourceTypeId: 'notion', label: 'Notion Reference', role: 'external' },
    ]
    const longDocument = `DOC-11-LONG\n${'A durable project record with decisions, exceptions, and verification evidence. '.repeat(190)}`
    const projection = Array.from({ length: 20 }, (_, index) => {
      const sourceInstanceKey = index < 5 ? 'source:runtime' : index < 16 ? 'source:documents' : 'source:spaces'
      return { id: `fragment-${index}`, sourceInstanceKey, mode: index % 4 === 0 ? 'routed' : 'eager', text: index === 15 ? longDocument : `SANITIZED-${index} · synthetic backup-shaped memory fragment`, revision: `r${index + 1}` }
    })
    const routes = Array.from({ length: 12 }, (_, index) => ({ id: `route-${index}`, sourceInstanceKey: index < 6 ? 'source:documents' : index < 10 ? 'source:spaces' : 'source:notion', operationId: `read-${index}`, description: `Route ${index} evidence`, maxCalls: index + 1 }))
    const actions = Array.from({ length: 8 }, (_, index) => ({ id: `action-${index}`, sourceInstanceKey: index < 5 ? 'source:runtime' : 'source:spaces', operationId: `write-${index}`, description: `Action ${index} memory` }))
    f.update({ sources, current: { ...snapshot(), id: 'view:complex', digest: 'digest:complex', projection, routes, actions, memoryText: `SANITIZED VIEW\n${'bounded memory text '.repeat(500)}` } })
    const rendered = f.mount()
    await screen.findByText('SANITIZED-0 · synthetic backup-shaped memory fragment')

    const resident = screen.getByRole('region', { name: 'Resident context' })
    const callable = screen.getByRole('region', { name: 'On-demand capabilities' })
    const inspector = screen.getByRole('complementary', { name: 'View details' })
    expect(within(resident).getAllByRole('button')).toHaveLength(20)
    expect(within(callable).getAllByRole('article')).toHaveLength(4)
    expect(within(callable).getAllByRole('button')).toHaveLength(24)

    const longCard = within(resident).getAllByRole('button')[15]!
    expect(longCard.textContent?.length).toBeLessThan(220)
    fireEvent.click(longCard)
    expect(inspector.querySelector('pre')?.textContent).toBe(longDocument)

    fireEvent.click(within(callable).getByRole('button', { name: 'Notion Reference external' }))
    expect(within(inspector).getByText('0 content fragments')).toBeTruthy()
    expect(within(inspector).getByText('2 read routes')).toBeTruthy()
    fireEvent.click(within(callable).getByRole('button', { name: '↙ Route 11 evidence read-11' }))
    expect(within(inspector).getByRole('heading', { name: 'Route 11 evidence' })).toBeTruthy()
    expect(within(inspector).getByText('12')).toBeTruthy()
    rendered.unmount()
  })

  it('keeps draft, read-only preview and pinned current View distinct until an explicit save', async () => {
    const f = fixture(); f.mount(); await ready()
    editor()
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

  it('selects an installed complete Strategy without disabling other Entries or applying before confirmation', async () => {
    const f = fixture()
    const entries = f.dashboard().entries.map(entry => entry.typeId === 'light-context' ? { ...entry, enabled: true, active: true } : entry)
    f.update({ entries: [...entries, { ...entries[0]!, entryId: 'alternate', typeId: 'alternate', packageName: 'dsh-mnemon-strategy-alternate', label: { en: 'Alternate', 'zh-CN': '其他策略' }, enabled: false, active: false }] })
    f.mount(); await ready()
    editor()
    fireEvent.change(screen.getByRole('combobox', { name: 'Choose base strategy' }), { target: { value: 'alternate' } })
    expect(screen.getByText('Original session context')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Light context' }).getAttribute('aria-checked')).toBe('true')
    expect(f.client.applyView).not.toHaveBeenCalled()
    fireEvent.click(editor().getByRole('button', { name: 'Apply to future turns' }))
    await waitFor(() => expect(f.client.applyView).toHaveBeenCalledWith(expect.objectContaining({ strategyTypeId: 'alternate', entries: expect.objectContaining({
      alternate: { enabled: true, config: {} }, 'default-three-tier': { enabled: true, config: {} }, 'light-context': { enabled: true, config: {} },
    }) })))
  })

  it('edits declared numeric fields and restores omission rather than persisting a synthetic default', async () => {
    const f = fixture(); f.mount(); await ready()
    editor()
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
    editor()
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
    editor()
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
    editor()
    const card = configure('Light context')
    fireEvent.click(card.getByRole('checkbox', { name: 'Resident character ceiling · Use plugin default' }))
    fireEvent.change(card.getByRole('spinbutton'), { target: { value: '0' } })
    fireEvent.click(editor().getByRole('button', { name: 'Generate preview' }))
    expect(f.client.previewView).not.toHaveBeenCalled()
    expect(f.client.applyView).not.toHaveBeenCalled()
  })

  it('preserves unsaved work on refresh, then explicitly discards a stale draft', async () => {
    const f = fixture(); f.mount(); await ready()
    editor()
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
    editor()
    fireEvent.click(screen.getByRole('switch', { name: 'Light context' }))
    fireEvent.click(editor().getByRole('button', { name: 'Apply to future turns' }))
    await screen.findByRole('alert')
    expect(screen.getByText('Plugin activation rejected')).toBeTruthy()
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    expect(screen.getByText('Original session context')).toBeTruthy()
    expect(screen.queryByText(/^Saved\./)).toBeNull()
  })

  it('refreshes the actual snapshot when a retained sidebar reopens without discarding its draft', async () => {
    const f = fixture()
    const page = (active: boolean) => <I18nContext.Provider value={translateEn}><LocaleContext.Provider value="en"><MemoryViewPage client={f.client} active={active} /></LocaleContext.Provider></I18nContext.Provider>
    const mounted = render(page(true)); await ready()
    editor()
    fireEvent.click(screen.getByRole('switch', { name: 'Light context' }))
    mounted.rerender(page(false))
    const requests = f.client.viewDashboard.mock.calls.length
    f.update({ current: { ...snapshot('recent'), turn: 2, memoryText: 'Second turn memory', projection: [{ id: 'second', sourceInstanceKey: 'source:runtime', mode: 'eager', text: 'Second turn context', revision: 'r2' }] } })
    expect(f.client.viewDashboard).toHaveBeenCalledTimes(requests)
    mounted.rerender(page(true))
    await screen.findByText('Second turn context')
    expect(screen.getByRole('switch', { name: 'Light context' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    expect(f.client.viewDashboard).toHaveBeenCalledTimes(requests + 1)
    expect(f.client.applyView).not.toHaveBeenCalled()
  })

  it('allows inspection and preview while configuration is read-only', async () => {
    const f = fixture(); f.mount('en', false); await ready()
    editor()
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
    const navigation = await screen.findByRole('tablist', { name: locale === 'zh' ? 'Mnemon 页面' : 'Mnemon pages' })
    fireEvent.click(within(navigation).getByRole('tab', { name: title }))
    await screen.findByRole('heading', { name: title })
    await ready()
    fireEvent.click(screen.getByRole('button', { name: locale === 'zh' ? '策略配置' : 'Strategy settings' }))
    expect(screen.getByRole('switch', { name: locale === 'zh' ? '轻量上下文' : 'Light context' })).toBeTruthy()
  })

  it('keeps all View copy translated with matching interpolation fields', () => {
    for (const key of Object.keys(viewZh) as Array<keyof typeof viewZh>) {
      expect(typeof en[key]).toBe('string')
      expect([...zh[key].matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()).toEqual([...en[key].matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort())
    }
  })
})
