// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientConnectionHandle, ClientSettingsScope } from "../src/host/dsh.ts"
import type { Config } from "../src/host/config.ts"
import { MnemonSaveAction } from '../src/client/MnemonSaveAction.tsx'
import { MnemonTurnTail, memoryPageForTool } from '../src/client/MnemonTurnTail.tsx'
import { consumeMnemonAnchor, dispatchMnemonAnchor, subscribeMnemonAnchor } from '../src/client/anchor.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const translate = (key: string): string => key
function createLocaleRuntime() {
  let snapshot = { active: 'zh' as 'zh' | 'en', locales: [], revision: 0 }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    select: (active: 'zh' | 'en') => {
      snapshot = { ...snapshot, active, revision: snapshot.revision + 1 }
      listeners.forEach(listener => listener())
    },
  }
}
const localeRuntime = createLocaleRuntime()
const writableSettingsSnapshot = { status: 'ready' as const, value: {}, writable: true, mode: 'host' as const }
const readOnlySettingsSnapshot = { status: 'unavailable' as const, writable: false, mode: 'host' as const }
const writableSettingsScope = {
  getSnapshot: () => writableSettingsSnapshot,
  subscribe: () => () => {},
  set: async () => {}, unset: async () => {}, setPath: async () => {}, unsetPath: async () => {},
} satisfies ClientSettingsScope<Config>
const readOnlySettingsScope = {
  ...writableSettingsScope,
  getSnapshot: () => readOnlySettingsSnapshot,
} satisfies ClientSettingsScope<Config>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

describe('conversation interaction surfaces', () => {
  it('consumes a delivered anchor instead of replaying it after remount', () => {
    const received: string[] = []
    const unsubscribe = subscribeMnemonAnchor('session-a', anchor => received.push(anchor.page))

    dispatchMnemonAnchor({ page: 'documents/library', sessionId: 'session-a' })

    expect(received).toEqual(['documents/library'])
    expect(consumeMnemonAnchor('session-a')).toBeNull()
    unsubscribe()
  })

  it('keeps an anchor pending when no matching view is mounted', () => {
    dispatchMnemonAnchor({ page: 'memory-spaces/explore', seed: 'sqlite', sessionId: 'session-b' })

    expect(consumeMnemonAnchor('session-b')).toEqual({ page: 'memory-spaces/explore', seed: 'sqlite', sessionId: 'session-b' })
    expect(consumeMnemonAnchor('session-b')).toBeNull()
  })

  it('opens each turn-memory tool on its corresponding workbench page', async () => {
    const rpcCall = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint !== 'turn-activities') throw new Error(`unexpected endpoint: ${endpoint}`)
      return {
        ok: true as const,
        value: {
          cursor: 12,
          activities: [{ turn: 2, count: 2, names: ['mnemon_document_search', 'mnemon_runtime_memory'], recalls: 0, writes: 1, documentSearches: 1, inspections: 0, failures: 0 }],
        },
      }
    })
    const connection = { rpc: { call: rpcCall } } as ClientConnectionHandle
    const received: string[] = []
    const unsubscribe = subscribeMnemonAnchor('session-a', anchor => received.push(anchor.page))
    render(<MnemonTurnTail turn={{ turn: 2, status: 'closed' }} seq={12} openFile={vi.fn()} sessionId="session-a" connection={connection} localeRuntime={localeRuntime} t={translate as never} />)

    fireEvent.click(await screen.findByRole('button', { name: /turnTail\.label/ }))
    fireEvent.click(screen.getAllByRole('button', { name: 'turnTail.openTool' })[0]!)

    expect(received).toEqual(['documents/library'])
    expect(memoryPageForTool('mnemon_runtime_memory')).toBe('runtime/entries')
    unsubscribe()
  })

  it('opens a centered modal and prevents a second supervised write while it is closed', async () => {
    const status = deferred<{ ok: true; value: { writeEnabled: boolean } }>()
    const supervision = deferred<{ ok: true; value: { summary: string; action: string } }>()
    let statusCalls = 0
    const rpcCall = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'status') {
        statusCalls += 1
        return statusCalls === 1 ? status.promise : { ok: true as const, value: { writeEnabled: true } }
      }
      if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'A durable project decision.' } }
      if (endpoint === 'supervise') return supervision.promise
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    const connection = { rpc: { call: rpcCall } } as ClientConnectionHandle

    render(<MnemonSaveAction messageId="message-1" sessionId="session-a" connection={connection} settingsScope={writableSettingsScope} localeRuntime={localeRuntime} t={translate as never} />)
    const action = screen.getByRole('button', { name: 'saveAction.button' })
    expect(action.textContent).toBe('')
    expect(action.getAttribute('aria-haspopup')).toBe('dialog')
    expect(action.getAttribute('title')).toBeNull()
    fireEvent.mouseEnter(action)
    expect(screen.getByRole('tooltip').textContent).toBe('saveAction.tooltip')
    fireEvent.click(action)
    const dialog = screen.getByRole('dialog', { name: 'saveAction.title' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(action.parentElement?.contains(dialog)).toBe(false)
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    expect(rpcCall.mock.calls.filter(call => call[1] === 'supervise')).toHaveLength(0)

    const submit = await screen.findByRole('button', { name: 'saveAction.submit' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    status.resolve({ ok: true, value: { writeEnabled: true } })
    await waitFor(() => expect(submit.disabled).toBe(false))
    fireEvent.click(submit)
    expect(rpcCall.mock.calls.filter(call => call[1] === 'supervise')).toHaveLength(1)
    expect(rpcCall).toHaveBeenCalledWith(expect.anything(), 'supervise', {
      sessionId: 'session-a',
      content: 'A durable project decision.',
      idempotencyKey: 'message-1',
    })

    fireEvent.click(screen.getByRole('button', { name: 'saveAction.close' }))
    fireEvent.click(screen.getByRole('button', { name: 'saveAction.button' }))
    const reopenedSubmit = await screen.findByRole('button', { name: 'saveAction.submitting' }) as HTMLButtonElement
    expect(reopenedSubmit.disabled).toBe(true)
    fireEvent.click(reopenedSubmit)
    expect(rpcCall.mock.calls.filter(call => call[1] === 'supervise')).toHaveLength(1)

    supervision.resolve({ ok: true, value: { summary: 'stored', action: 'remember' } })
    await waitFor(() => expect((screen.getByRole('button', { name: 'saveAction.submit' }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByText('saveAction.result')).toBeNull()
  })

  it('keeps supervised message writes read-only when Host settings are not writable', async () => {
    const rpcCall = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'status') return { ok: true as const, value: { writeEnabled: true } }
      if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'A durable project decision.' } }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    const connection = { rpc: { call: rpcCall }, isLoopback: false } as ClientConnectionHandle

    render(<MnemonSaveAction messageId="message-1" sessionId="session-a" connection={connection} settingsScope={readOnlySettingsScope} localeRuntime={localeRuntime} t={translate as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'saveAction.button' }))

    const submit = await screen.findByRole('button', { name: 'saveAction.submit' }) as HTMLButtonElement
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('saveAction.readOnly'))
    expect(submit.disabled).toBe(true)
    fireEvent.click(submit)
    expect(rpcCall.mock.calls.some(([, endpoint]) => endpoint === 'supervise')).toBe(false)
  })

  it('allows supervised message writes when authenticated Host settings are writable', async () => {
    const rpcCall = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'status') return { ok: true as const, value: { writeEnabled: true } }
      if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'A durable project decision.' } }
      if (endpoint === 'supervise') return { ok: true as const, value: { summary: 'stored', action: 'remember' } }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    const connection = { rpc: { call: rpcCall }, isLoopback: false } as ClientConnectionHandle

    render(<MnemonSaveAction messageId="message-1" sessionId="session-a" connection={connection} settingsScope={writableSettingsScope} localeRuntime={localeRuntime} t={translate as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'saveAction.button' }))

    const submit = await screen.findByRole('button', { name: 'saveAction.submit' }) as HTMLButtonElement
    await waitFor(() => expect(submit.disabled).toBe(false))
    fireEvent.click(submit)
    await waitFor(() => expect(rpcCall.mock.calls.some(([, endpoint]) => endpoint === 'supervise')).toBe(true))
  })

  it('updates the save action on locale changes without remounting an edited candidate', async () => {
    const locale = createLocaleRuntime()
    const t = (key: string) => `${locale.getSnapshot().active}:${key}`
    const rpcCall = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'status') return { ok: true as const, value: { writeEnabled: true } }
      if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'Original candidate.' } }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    render(<MnemonSaveAction messageId="message-1" sessionId="session-a" connection={{ rpc: { call: rpcCall } } as ClientConnectionHandle} settingsScope={writableSettingsScope} localeRuntime={locale} t={t} />)
    expect(screen.getByRole('button', { name: 'zh:saveAction.button' })).toBeTruthy()
    act(() => locale.select('en'))
    fireEvent.click(screen.getByRole('button', { name: 'en:saveAction.button' }))
    const candidate = await screen.findByRole('textbox', { name: 'en:saveAction.candidate' })
    fireEvent.change(candidate, { target: { value: 'Edited candidate.' } })
    const calls = rpcCall.mock.calls.length
    act(() => locale.select('zh'))
    expect(screen.getByRole('dialog', { name: 'zh:saveAction.title' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'zh:saveAction.candidate' }) as HTMLTextAreaElement).value).toBe('Edited candidate.')
    expect(rpcCall).toHaveBeenCalledTimes(calls)
  })

  it('updates an expanded turn activity bar on locale changes without refetching', async () => {
    const locale = createLocaleRuntime()
    const t = (key: string) => `${locale.getSnapshot().active}:${key}`
    const rpcCall = vi.fn(async () => ({ ok: true as const, value: {
      cursor: 12, activities: [{ turn: 2, count: 1, names: ['mnemon_runtime_memory'], recalls: 0, writes: 1, documentSearches: 0, inspections: 0, failures: 0 }],
    } }))
    render(<MnemonTurnTail turn={{ turn: 2, status: 'closed' }} seq={12} openFile={vi.fn()} sessionId="session-a" connection={{ rpc: { call: rpcCall } } as ClientConnectionHandle} localeRuntime={locale} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: /zh:turnTail\.label/ }))
    act(() => locale.select('en'))
    expect(screen.getByRole('button', { name: /en:turnTail\.label/ }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'en:turnTail.openTool' })).toBeTruthy()
    expect(rpcCall).toHaveBeenCalledTimes(1)
  })
})
