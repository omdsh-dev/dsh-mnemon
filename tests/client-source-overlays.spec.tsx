// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SourceOverlaysHost } from '../src/client/source-overlays.tsx'
const mock = vi.hoisted(() => ({ catalog: vi.fn(), read: vi.fn(), mutate: vi.fn() }))
vi.mock('../src/client/api.ts', () => ({ MnemonClient: class {
  constructor(_connection: unknown, readonly session?: string) {}
  sourceManagementCatalog() { return mock.catalog(this.session) }
  readSourceManagement(...args: unknown[]) { return mock.read(this.session, ...args) }
  mutateSourceManagement(...args: unknown[]) { return mock.mutate(this.session, ...args) }
} }))
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })
const instance = (revision: string) => ({ sourceInstanceKey: 'source:inbox', sourceTypeId: 'inbox', availability: 'ready', capabilities: ['write'], revision })
function harness() {
  let sessions = { current: 'first' }, changed = () => {}
  const entries = [{ id: 'inbox/bell', sourceTypeId: 'inbox' }], locale = { active: 'en' }, settings = { status: 'ready', writable: true, value: { writeEnabled: true } }
  const rendered: any[] = []
  const props = {
    connection: {}, directory: { getSnapshot: () => entries, subscribe: () => () => {} },
    sessions: { list: { getSnapshot: () => sessions, subscribe: (listener: () => void) => { changed = listener; return () => {} } } },
    localeRuntime: { getSnapshot: () => locale, subscribe: () => () => {} }, settingsScope: { getSnapshot: () => settings, subscribe: () => () => {} },
    renderSlot: (_name: string, props: unknown) => { rendered.push(props); return null },
  }
  render(<SourceOverlaysHost {...props as any} />)
  return { rendered, session(id: string) { sessions = { current: id }; changed() } }
}
it('retains widget client identity during revision refresh and uses the latest revision', async () => {
  mock.catalog.mockResolvedValue({ sources: [instance('one')] })
  const value = harness()
  await waitFor(() => expect(value.rendered.length).toBeGreaterThan(0))
  const first = value.rendered.at(-1).management
  mock.catalog.mockResolvedValue({ sources: [instance('two')] })
  await act(async () => { value.rendered.at(-1).onRefresh() })
  expect(value.rendered.at(-1).management).toBe(first)
  expect(first.revision).toBe('two')
  await first.mutate('save', { title: 'Kept form' }, { confirmed: true })
  expect(mock.mutate).toHaveBeenLastCalledWith('first', 'source:inbox', 'save', { title: 'Kept form' }, 'two', true)
})
it('rejects a late catalog from an old session and binds new operations to the selected session', async () => {
  const old = Promise.withResolvers<{ sources: ReturnType<typeof instance>[] }>()
  mock.catalog.mockImplementation((session: string) => session === 'first' ? old.promise : Promise.resolve({ sources: [instance('new')] }))
  const value = harness()
  await act(async () => { value.session('second') })
  await waitFor(() => expect(value.rendered.at(-1)?.sessionId).toBe('second'))
  await act(async () => { old.resolve({ sources: [instance('stale')] }) })
  const current = value.rendered.at(-1)
  expect(current.management.revision).toBe('new')
  await current.management.read('detail', { id: 'sample' })
  expect(mock.read).toHaveBeenLastCalledWith('second', 'source:inbox', 'detail', { id: 'sample' })
})
