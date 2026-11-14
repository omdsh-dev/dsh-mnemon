// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientConnectionHandle } from "../src/host/dsh.ts"
import type { TurnMemoryActivitySnapshot } from '../src/host/protocol.ts'
import type { Config } from "../src/host/config.ts"
import { apply } from '../src/client/index.ts'
import { translateEn, translateZh } from '../src/client/locales.ts'
import { MnemonSaveAction } from '../src/client/MnemonSaveAction.tsx'
import { SkillTurnTail } from '../src/client/SkillTurnTail.tsx'
import { MnemonTurnTail, memoryPageForTool, turnItems, turnTools } from '../src/client/MnemonTurnTail.tsx'
import { consumeMnemonAnchor, dispatchMnemonAnchor, subscribeMnemonAnchor } from '../src/client/anchor.ts'
import { WriteReceipt } from '../src/client/page-controls.tsx'
import { settingsScope } from './helpers/settings-scope.ts'

// DSH's Modal and Tooltip measure their surfaces before showing them; jsdom
// has no layout engine, so report an empty box as soon as one is observed.
globalThis.ResizeObserver ??= class {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.callback([{ target, borderBoxSize: [{ inlineSize: 0, blockSize: 0 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver

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
const writableSettingsScope = settingsScope<Config>({ status: 'ready', value: {}, writable: true, mode: 'host' })
const readOnlySettingsScope = settingsScope<Config>({ status: 'unavailable', writable: false, mode: 'host' })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function remoteRpc(domain: (endpoint: string, payload: Record<string, unknown>) => unknown | Promise<unknown>) {
  return vi.fn(async (channel: string, remoteEndpoint: string, rawArgs: unknown) => {
    if (channel !== '/api' || !remoteEndpoint.startsWith('dshMnemon/')) throw new Error(`unexpected remote endpoint: ${channel} ${remoteEndpoint}`)
    const args = (rawArgs as { args: { endpoint: string; payload: Record<string, unknown> } }).args
    return { ok: true as const, value: await domain(args.endpoint, args.payload) }
  })
}

function calledRemote(call: ReturnType<typeof remoteRpc>, endpoint: string): boolean {
  return call.mock.calls.some(([, , rawArgs]) => (rawArgs as { args?: { endpoint?: string } }).args?.endpoint === endpoint)
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

  it.each([
    null,
    undefined,
    {},
    { turn: 2 },
    { turn: 2, status: 'open' },
    { status: 'closed' },
    { turn: '2', status: 'closed' },
  ])('does not request or display activity for an open or invalid turn: %j', async turn => {
    const rpcCall = vi.fn(async () => ({ ok: true as const, value: { cursor: 12, activities: [] } }))
    render(<MnemonTurnTail turn={turn} seq={12} openFile={vi.fn()} sessionId="session-a" connection={{ rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle} localeRuntime={localeRuntime} t={translate} />)

    await act(async () => {})
    expect(rpcCall).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /turnTail\.label/ })).toBeNull()
  })

  it('loads activity when the same turn number and sequence close without final assistant text', async () => {
    const rpcCall = vi.fn(async () => ({ ok: true as const, value: {
      cursor: 12, activities: [{ turn: 2, count: 1, names: ['mnemon_runtime_memory'], recalls: 0, writes: 1, documentSearches: 0, inspections: 0, failures: 0 }],
    } }))
    const props = { seq: 12, openFile: vi.fn(), sessionId: 'session-a', connection: { rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle, localeRuntime, t: translate }
    const view = render(<MnemonTurnTail {...props} turn={{ turn: 2, status: 'open', closing: null }} />)
    await act(async () => {})
    expect(rpcCall).not.toHaveBeenCalled()

    view.rerender(<MnemonTurnTail {...props} turn={{ turn: 2, status: 'closed', closing: null }} />)

    expect(await screen.findByRole('button', { name: /turnTail\.label/ })).toBeTruthy()
    expect(rpcCall).toHaveBeenCalledTimes(1)
    expect(rpcCall).toHaveBeenCalledWith('/dsh-mnemon-read', 'turn-activities', { sessionId: 'session-a' })
  })

  it('hides a completed turn with no memory activity', async () => {
    const rpcCall = vi.fn(async () => ({ ok: true as const, value: { cursor: 12, activities: [] } }))
    render(<MnemonTurnTail turn={{ turn: 2, status: 'closed' }} seq={12} openFile={vi.fn()} sessionId="session-a" connection={{ rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle} localeRuntime={localeRuntime} t={translate} />)

    await act(async () => {})
    expect(rpcCall).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /turnTail\.label/ })).toBeNull()
  })

  it('ignores an in-flight activity result after its turn becomes open', async () => {
    const request = deferred<{ ok: true; value: TurnMemoryActivitySnapshot }>()
    const rpcCall = vi.fn(() => request.promise)
    const props = { seq: 12, openFile: vi.fn(), sessionId: 'session-a', connection: { rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle, localeRuntime, t: translate }
    const view = render(<MnemonTurnTail {...props} turn={{ turn: 2, status: 'closed' }} />)
    expect(rpcCall).toHaveBeenCalledTimes(1)
    view.rerender(<MnemonTurnTail {...props} turn={{ turn: 2, status: 'open' }} />)

    await act(async () => request.resolve({ ok: true, value: {
      cursor: 12, activities: [{ turn: 2, count: 1, names: ['mnemon_runtime_memory'], recalls: 0, writes: 1, documentSearches: 0, inspections: 0, failures: 0, retrieved: [], writebacks: [] }],
    } }))

    expect(rpcCall).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /turnTail\.label/ })).toBeNull()
  })

  it('hides already loaded activity when its turn becomes open', async () => {
    const rpcCall = vi.fn(async () => ({ ok: true as const, value: {
      cursor: 12, activities: [{ turn: 2, count: 1, names: ['mnemon_runtime_memory'], recalls: 0, writes: 1, documentSearches: 0, inspections: 0, failures: 0 }],
    } }))
    const props = { seq: 12, openFile: vi.fn(), sessionId: 'session-a', connection: { rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle, localeRuntime, t: translate }
    const view = render(<MnemonTurnTail {...props} turn={{ turn: 2, status: 'closed' }} />)
    await screen.findByRole('button', { name: /turnTail\.label/ })

    view.rerender(<MnemonTurnTail {...props} turn={{ turn: 2, status: 'open' }} />)

    expect(rpcCall).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /turnTail\.label/ })).toBeNull()
  })

  it.each(['mnemon_document_search', 'mnemon_document_create'])('opens %s from turn activity on the Documents page', async toolName => {
    const rpcCall = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint !== 'turn-activities') throw new Error(`unexpected endpoint: ${endpoint}`)
      return {
        ok: true as const,
        value: {
          cursor: 12,
          activities: [{ turn: 2, count: 2, names: [toolName, 'mnemon_runtime_memory'], recalls: 0, writes: 1, documentSearches: 1, inspections: 0, failures: 0 }],
        },
      }
    })
    const connection = { rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle
    const received: string[] = []
    const unsubscribe = subscribeMnemonAnchor('session-a', anchor => received.push(anchor.page))
    render(<MnemonTurnTail turn={{ turn: 2, status: 'closed' }} seq={12} openFile={vi.fn()} sessionId="session-a" connection={connection} localeRuntime={localeRuntime} t={translate as never} />)

    fireEvent.click(await screen.findByRole('button', { name: /turnTail\.label/ }))
    fireEvent.click(screen.getAllByRole('button', { name: 'turnTail.openTool' })[0]!)

    expect(received).toEqual(['documents/library'])
    expect(memoryPageForTool('mnemon_runtime_memory')).toBe('runtime/entries')
    unsubscribe()
  })

  it('names each memory tool once with how often the turn used it, and keeps the tool name on hover', async () => {
    const rpcCall = vi.fn(async () => ({ ok: true as const, value: {
      cursor: 12,
      activities: [{ turn: 2, count: 3, names: ['mnemon_document_search', 'mnemon_recall', 'mnemon_recall'], recalls: 2, writes: 0, documentSearches: 1, inspections: 0, failures: 0 }],
    } }))
    render(<MnemonTurnTail turn={{ turn: 2, status: 'closed' }} seq={12} openFile={vi.fn()} sessionId="session-a" connection={{ rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle} localeRuntime={localeRuntime} t={translate as never} />)
    const bar = await screen.findByRole('button', { name: /turnTail\.label/ })
    expect(bar.querySelector('svg path')).not.toBeNull()
    fireEvent.click(bar)
    const chips = screen.getAllByRole('button', { name: 'turnTail.openTool' })
    expect(chips.map(chip => chip.textContent)).toEqual(['turnTail.tool.documentSearch', 'turnTail.tool.recall×2'])
    fireEvent.pointerEnter(chips[1]!)
    fireEvent.mouseEnter(chips[1]!)
    expect(screen.getByRole('tooltip').textContent).toBe('mnemon_recall')
    expect(turnTools(['a', 'b', 'a', 'c'])).toEqual([{ name: 'a', count: 2 }, { name: 'b', count: 1 }, { name: 'c', count: 1 }])
  })

  it('lists what each tool read or wrote and opens each item where it lives', async () => {
    const activity = {
      turn: 2, count: 3, names: ['mnemon_document_search', 'mnemon_recall', 'mnemon_runtime_memory', 'mnemon_forget'],
      recalls: 1, writes: 2, documentSearches: 1, inspections: 0, failures: 0,
      retrieved: [
        { callId: 'read-1', toolName: 'mnemon_document_search', operationId: 'search', sourceTypeId: 'documents',
          items: [{ id: 'doc-1', title: 'Decision: queue event ingestion', excerpt: 'Events go through Kafka first.' }] },
        { callId: 'read-2', toolName: 'mnemon_recall', operationId: 'recall', sourceTypeId: 'memory-spaces',
          items: [{ id: 'memory-1', title: 'Lumen', excerpt: 'Consumers dedupe by event_id.' }, { id: 'memory-2', title: 'Lumen', excerpt: 'Consumers dedupe by event_id.' }] },
      ],
      writebacks: [
        { callId: 'write-1', toolName: 'mnemon_runtime_memory', operationId: 'mutate', sourceTypeId: 'runtime', item: { id: 'mutate', title: 'Checkout p75 LCP is 2.4 s.' } },
        { callId: 'write-2', toolName: 'mnemon_forget', operationId: 'forget', sourceTypeId: 'memory-spaces', item: { id: 'memory-9', title: 'memory-9' } },
      ],
    }
    const rpcCall = vi.fn(async () => ({ ok: true as const, value: { cursor: 12, activities: [activity] } }))
    const received: Array<{ page: string; seed?: string }> = []
    const unsubscribe = subscribeMnemonAnchor('session-a', anchor => received.push({ page: anchor.page, ...(anchor.seed === undefined ? {} : { seed: anchor.seed }) }))
    render(<MnemonTurnTail turn={{ turn: 2, status: 'closed' }} seq={12} openFile={vi.fn()} sessionId="session-a" connection={{ rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle} localeRuntime={localeRuntime} t={translate as never} />)
    fireEvent.click(await screen.findByRole('button', { name: /turnTail\.label/ }))

    const list = screen.getByRole('list', { name: 'turnTail.toolList' })
    expect([...list.querySelectorAll('li')].map(row => row.textContent)).toEqual([
      'turnTail.tool.documentSearchDecision: queue event ingestion',
      'turnTail.tool.recallConsumers dedupe by event_id.Lumen',
      'turnTail.tool.runtimeCheckout p75 LCP is 2.4 s.',
      'turnTail.tool.forget',
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Decision: queue event ingestion' }))
    fireEvent.click(screen.getByRole('button', { name: 'Consumers dedupe by event_id. Lumen' }))
    fireEvent.click(screen.getByRole('button', { name: 'Checkout p75 LCP is 2.4 s.' }))
    expect(received).toEqual([
      { page: 'documents/library', seed: 'doc-1' },
      { page: 'memory-spaces/explore', seed: 'Consumers dedupe by event_id.' },
      { page: 'runtime/entries', seed: 'Checkout p75 LCP is 2.4 s.' },
    ])
    unsubscribe()
  })

  it('names and opens every memory tool chip as it always did', async () => {
    const expected: Record<string, [string, string]> = {
      mnemon_view_route: ['turnTail.tool.viewRoute', 'memory-spaces/spaces'],
      mnemon_view_action: ['turnTail.tool.viewAction', 'memory-spaces/spaces'],
      mnemon_memory_bodies: ['turnTail.tool.spaces', 'memory-spaces/spaces'],
      mnemon_recall: ['turnTail.tool.recall', 'memory-spaces/explore'],
      mnemon_related: ['turnTail.tool.related', 'memory-spaces/explore'],
      mnemon_status: ['turnTail.tool.status', 'status'],
      mnemon_document_search: ['turnTail.tool.documentSearch', 'documents/library'],
      mnemon_document_create: ['turnTail.tool.documentCreate', 'documents/library'],
      mnemon_document_manage: ['turnTail.tool.documentManage', 'documents/library'],
      mnemon_runtime_memory: ['turnTail.tool.runtime', 'runtime/entries'],
      mnemon_remember: ['turnTail.tool.remember', 'memory-spaces/spaces'],
      mnemon_link: ['turnTail.tool.link', 'memory-spaces/spaces'],
      mnemon_forget: ['turnTail.tool.forget', 'memory-spaces/spaces'],
      mnemon_memory_body_create: ['turnTail.tool.spaceCreate', 'memory-spaces/spaces'],
      mnemon_memory_body_update: ['turnTail.tool.spaceUpdate', 'memory-spaces/spaces'],
      mnemon_memory_body_merge: ['turnTail.tool.spaceMerge', 'memory-spaces/spaces'],
      // Another tool keeps its own name.
      mnemon_notes_digest: ['mnemon_notes_digest', 'memory-spaces/spaces'],
    }
    const names = Object.keys(expected)
    const rpcCall = vi.fn(async () => ({ ok: true as const, value: { cursor: 12, activities: [{
      turn: 2, count: names.length, names, recalls: 0, writes: 0, documentSearches: 0, inspections: 0, failures: 0, retrieved: [], writebacks: [],
    }] } }))
    const received: string[] = []
    const unsubscribe = subscribeMnemonAnchor('session-a', anchor => received.push(anchor.page))
    render(<MnemonTurnTail turn={{ turn: 2, status: 'closed' }} seq={12} openFile={vi.fn()} sessionId="session-a" connection={{ rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle} localeRuntime={localeRuntime} t={translate as never} />)
    fireEvent.click(await screen.findByRole('button', { name: /turnTail\.label/ }))
    const chips = screen.getAllByRole('button', { name: 'turnTail.openTool' })
    for (const chip of chips) fireEvent.click(chip)
    expect(Object.fromEntries(chips.map((chip, index) => [names[index], [chip.textContent, received[index]]]))).toEqual(expected)
    unsubscribe()
  })

  it('shows at most three items per tool and counts the rest', async () => {
    const items = Array.from({ length: 5 }, (_, index) => ({ id: `doc-${index}`, title: `Document ${index}` }))
    const retrieved = [{ callId: 'read', toolName: 'mnemon_document_search', operationId: 'search', sourceTypeId: 'documents', items }]
    expect(turnItems({ retrieved }).get('mnemon_document_search')).toHaveLength(5)
    expect(turnItems({})).toEqual(new Map())
    const rpcCall = vi.fn(async () => ({ ok: true as const, value: { cursor: 12, activities: [{
      turn: 2, count: 1, names: ['mnemon_document_search'], recalls: 0, writes: 0, documentSearches: 1, inspections: 0, failures: 0, retrieved, writebacks: [],
    }] } }))
    const t = (key: string, params?: Record<string, unknown>) => params?.count === undefined ? key : `${key}:${String(params.count)}`
    render(<MnemonTurnTail turn={{ turn: 2, status: 'closed' }} seq={12} openFile={vi.fn()} sessionId="session-a" connection={{ rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle} localeRuntime={localeRuntime} t={t as never} />)
    fireEvent.click(await screen.findByRole('button', { name: /turnTail\.label/ }))
    const row = screen.getByRole('list', { name: 'turnTail.toolList' }).querySelector('li')!
    expect([...row.querySelectorAll('button')].map(button => button.textContent)).toEqual(['turnTail.tool.documentSearch', 'Document 0', 'Document 1', 'Document 2'])
    expect(row.textContent).toContain('turnTail.more:2')
  })

  it('shows the task Agent receipt, leads to what was written, and waits for an edit before sending again', async () => {
    const rpcCall = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'status') return { ok: true as const, value: { writeEnabled: true, lifecycle: { taskAgentAvailable: true } } }
      if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'Checkout loads the payment SDK after interaction.' } }
      if (endpoint === 'supervise') return { ok: true as const, value: { summary: 'Saved to Lumen project.', action: 'stored', memoryBodyIds: ['lumen'] } }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    const received: string[] = []
    const unsubscribe = subscribeMnemonAnchor('session-a', anchor => received.push(anchor.page))
    render(<MnemonSaveAction messageId="message-1" sessionId="session-a" connection={{ rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle} settingsScope={writableSettingsScope} localeRuntime={localeRuntime} t={translate as never} />)
    const action = screen.getByRole('button', { name: 'saveAction.button' })
    expect(action.querySelector('svg path')).not.toBeNull()
    fireEvent.click(action)
    await screen.findByText('taskAgent.ready')
    const submit = screen.getByRole('button', { name: 'saveAction.submit' }) as HTMLButtonElement
    await waitFor(() => expect(submit.disabled).toBe(false))
    fireEvent.click(submit)

    await screen.findByText('receipt.written')
    expect(screen.getByText('Saved to Lumen project.')).toBeTruthy()
    const footerClose = screen.getAllByRole('button', { name: 'saveAction.close' })
    expect(footerClose.length).toBeGreaterThan(1)
    expect((screen.getByRole('button', { name: 'saveAction.submit' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'saveAction.candidate' }), { target: { value: 'Checkout loads the payment SDK after interaction; p75 LCP is 2.4 s.' } })
    expect((screen.getByRole('button', { name: 'saveAction.submit' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'receipt.view' }))
    expect(received).toEqual(['memory-spaces/content'])
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'saveAction.title' })).toBeNull())
    expect(rpcCall.mock.calls.filter(call => call[1] === 'supervise')).toHaveLength(1)
    unsubscribe()
  })

  it('saves to working memory directly while no task Agent can take the write', async () => {
    const rpcCall = vi.fn(async (_channel: string, endpoint: string, input?: unknown) => {
      if (endpoint === 'status') return { ok: true as const, value: { writeEnabled: true, lifecycle: { taskAgentAvailable: false } } }
      if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'A durable project decision.' } }
      if (endpoint === 'source-management-catalog') return { ok: true as const, value: { generationId: 'g1', sources: [{ sourceInstanceKey: 'source:mnemon-source-runtime', sourceTypeId: 'runtime', revision: 'r1' }] } }
      if (endpoint === 'source-management-mutate') return { ok: true as const, value: { revision: 'r2', value: { success: true, message: 'Entry added.', target: 'memory', entryCount: 4, added: (input as { input: { content: string } }).input.content } } }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    render(<MnemonSaveAction messageId="message-1" sessionId="session-a" connection={{ rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle} settingsScope={writableSettingsScope} localeRuntime={localeRuntime} t={translate as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'saveAction.button' }))
    // Without a task Agent the dialog still saves, to working memory, as written.
    const save = await screen.findByRole('button', { name: 'saveAction.save' }) as HTMLButtonElement
    expect(screen.getByRole('dialog', { name: 'saveAction.title' }).textContent).toContain('saveAction.hintDirect')
    expect(screen.queryByText('taskAgent.unavailable')).toBeNull()
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    await screen.findByText('receipt.written')
    expect(screen.getByText('saveAction.saved.runtime')).toBeTruthy()
    // The receipt leads to where the text went: Runtime Memory.
    expect(screen.getByRole('button', { name: 'receipt.viewRuntime' })).toBeTruthy()
    expect(rpcCall).toHaveBeenCalledWith(expect.anything(), 'source-management-mutate', expect.objectContaining({
      sourceInstanceKey: 'source:mnemon-source-runtime', operation: 'mutate', expectedRevision: 'r1', confirmed: true,
      input: { action: 'add', target: 'memory', content: 'A durable project decision.' },
    }))
    expect(rpcCall.mock.calls.filter(call => call[1] === 'supervise')).toHaveLength(0)
    // The Agent choice stays listed, closed.
    fireEvent.click(screen.getByRole('button', { name: /saveAction\.to/ }))
    expect((screen.getByRole('menuitem', { name: /saveAction\.to\.agent/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('writes the text as it is to the place the user picks, and sends a failure again as it is', async () => {
    let remembered = 0
    const rpcCall = vi.fn(async (_channel: string, endpoint: string, input?: unknown) => {
      if (endpoint === 'status') return { ok: true as const, value: { writeEnabled: true, commandFound: false, lifecycle: { taskAgentAvailable: true },
        providerServices: [{ providerId: 'holographic', label: 'Holographic', enabled: true, configured: true, status: 'idle', memoryBodyCount: 1, activeMemoryBodyCount: 1 }],
        memoryBodies: [
          { id: 'lumen', name: 'Lumen project', active: true, providerEnabled: true, provider: { id: 'holographic', label: 'Holographic', capabilities: { remember: true } } },
          { id: 'native', name: 'Native space', active: true, providerEnabled: true, provider: { id: 'mnemon-native', label: 'Mnemon Native', capabilities: { remember: true } } },
        ] } }
      if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'Checkout loads the payment SDK after interaction.' } }
      if (endpoint === 'source-management-catalog') return { ok: true as const, value: { generationId: 'g1', sources: [
        { sourceInstanceKey: 'source:mnemon-source-runtime', sourceTypeId: 'runtime', revision: 'r1' },
        { sourceInstanceKey: 'source:mnemon-source-memory-spaces', sourceTypeId: 'memory-spaces', revision: 's1' },
      ] } }
      if (endpoint === 'source-management-mutate') {
        if ((input as { operation: string }).operation !== 'remember') throw new Error('unexpected write')
        remembered += 1
        if (remembered === 1) return { ok: false as const, error: { message: 'Memory Spaces management revision changed' } }
        return { ok: true as const, value: { revision: 's2', value: { action: 'added', id: 'm1', memoryBodyId: 'lumen' } } }
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    const received: string[] = []
    const unsubscribe = subscribeMnemonAnchor('session-a', anchor => received.push(anchor.page))
    render(<MnemonSaveAction messageId="message-1" sessionId="session-a" connection={{ rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle} settingsScope={writableSettingsScope} localeRuntime={localeRuntime} t={translate as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'saveAction.button' }))
    // The task Agent stays the default while it can write.
    await screen.findByText('taskAgent.ready')
    fireEvent.click(screen.getByRole('button', { name: /saveAction\.to/ }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'saveAction.to.agentsaveAction.to.agentDetail', 'saveAction.to.memory', 'saveAction.to.user', 'Lumen projectsaveAction.to.space',
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: /^Lumen project/ }))
    const save = screen.getByRole('button', { name: 'saveAction.save' }) as HTMLButtonElement
    fireEvent.click(save)
    await screen.findByText('receipt.failed')
    // A failure answers nothing: the same text can be sent again without an edit.
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    await screen.findByText('receipt.written')
    expect(rpcCall).toHaveBeenLastCalledWith(expect.anything(), 'source-management-mutate', expect.objectContaining({
      sourceInstanceKey: 'source:mnemon-source-memory-spaces', operation: 'remember', expectedRevision: 's1',
      input: { content: 'Checkout loads the payment SDK after interaction.', memoryBodyId: 'lumen', source: 'user' },
    }))
    // A receipt answers one text in one place: another place takes it again.
    expect(save.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /saveAction\.to/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'saveAction.to.user' }))
    expect((screen.getByRole('button', { name: 'saveAction.save' }) as HTMLButtonElement).disabled).toBe(false)
    // The receipt still leads to what it answers.
    fireEvent.click(screen.getByRole('button', { name: 'receipt.view' }))
    expect(received).toEqual(['memory-spaces/content'])
    expect(rpcCall.mock.calls.filter(call => call[1] === 'supervise')).toHaveLength(0)
    unsubscribe()
  })

  // A status with Runtime Memory, Project Documents and Memory Spaces on, running and taking writes, unless a test says otherwise.
  const memorySystem = (overrides: { layers?: Record<string, unknown>; sources?: string[] } = {}) => ({
    serving: true,
    sources: (overrides.sources ?? ['runtime', 'documents', 'memory-spaces']).map(type => ({ sourceInstanceKey: `source:mnemon-source-${type}`, sourceTypeId: type, revision: 'r1' })),
    configuration: { layers: {
      runtime: { enabled: true, participation: { write: 'automatic' } },
      'memory-spaces': { enabled: true, participation: { write: 'automatic' } },
      ...overrides.layers,
    } },
  })
  const lumen = { id: 'lumen', name: 'Lumen project', active: true, providerEnabled: true, provider: { id: 'holographic', label: 'Holographic', capabilities: { remember: true } } }
  const runtimeCatalog = (revision = 'r1') => ({ ok: true as const, value: { generationId: 'g1', sources: [
    // Another Runtime instance comes first; the dialog writes to the default one, as the workbench does.
    { sourceInstanceKey: 'source:extra:runtime-copy', sourceTypeId: 'runtime', revision: 'x1' },
    { sourceInstanceKey: 'source:mnemon-source-runtime', sourceTypeId: 'runtime', revision, assistance: ['mutate'] },
    { sourceInstanceKey: 'source:mnemon-source-memory-spaces', sourceTypeId: 'memory-spaces', revision: 's1' },
  ] } })
  const emptyRuntime = { ok: true as const, value: { revision: 'r1', value: { targets: { memory: { used: 0, limit: 10_240 }, user: { used: 0, limit: 4_096 } } } } }
  const openSaveAction = (rpcCall: (...args: never[]) => unknown, scope = writableSettingsScope) => {
    render(<MnemonSaveAction messageId="message-1" sessionId="session-a" connection={{ rpc: { call: rpcCall }, isLoopback: true } as unknown as ClientConnectionHandle} settingsScope={scope} localeRuntime={localeRuntime} t={translate as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'saveAction.button' }))
  }
  const choose = (label: RegExp) => {
    fireEvent.click(screen.getByRole('button', { name: /saveAction\.to/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: label }))
  }

  it('starts on working memory when the task Agent has no Memory Space to write to, through the Runtime page\'s own path', async () => {
    const rpcCall = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'status') return { ok: true as const, value: { writeEnabled: true, commandFound: false, providerServices: [], memoryBodies: [], lifecycle: { taskAgentAvailable: true }, memorySystem: memorySystem() } }
      if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'Release  gates close\nat 18:00.' } }
      if (endpoint === 'source-management-read') return emptyRuntime
      if (endpoint === 'source-management-catalog') return runtimeCatalog()
      if (endpoint === 'source-assistance') return { ok: true as const, value: { revision: 'r2', value: { success: true, message: 'Entry added.', target: 'memory', entryCount: 1 } } }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    const received: Array<{ page: string; seed?: string }> = []
    const unsubscribe = subscribeMnemonAnchor('session-a', anchor => received.push({ page: anchor.page, ...(anchor.seed === undefined ? {} : { seed: anchor.seed }) }))
    openSaveAction(rpcCall)
    const save = await screen.findByRole('button', { name: 'saveAction.save' }) as HTMLButtonElement
    // The task Agent is there, but it has no Memory Space and no Provider to make one.
    expect(screen.queryByText('taskAgent.ready')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /saveAction\.to/ }))
    expect((screen.getByRole('menuitem', { name: /saveAction\.to\.agent/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: 'saveAction.to.memory' }))
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    await screen.findByText('receipt.written')
    expect(rpcCall).toHaveBeenCalledWith(expect.anything(), 'source-assistance', expect.objectContaining({
      sourceInstanceKey: 'source:mnemon-source-runtime', operation: 'mutate', expectedRevision: 'r1', confirmed: true,
      input: { action: 'add', target: 'memory', content: 'Release  gates close\nat 18:00.' },
    }))
    expect(rpcCall.mock.calls.filter(call => call[1] === 'source-management-mutate' || call[1] === 'supervise')).toHaveLength(0)
    // The receipt opens Runtime Memory on the entry, which Runtime Memory keeps as one line.
    fireEvent.click(screen.getByRole('button', { name: 'receipt.viewRuntime' }))
    expect(received).toEqual([{ page: 'runtime/entries', seed: 'Release gates close at 18:00.' }])
    unsubscribe()
  })

  it('lists a place only while its layer is on, its Source runs and it takes writes', async () => {
    const dormant = { ...lumen, id: 'dormant', name: 'Dormant space', active: false }
    const cases: Array<{ system: ReturnType<typeof memorySystem>; taskAgent: boolean; places: string[] }> = [
      { system: memorySystem(), taskAgent: true, places: ['agent', 'memory', 'user', 'Lumen project'] },
      // Runtime Memory switched off by its old layer flag, or its component stopped.
      { system: memorySystem({ layers: { runtime: { enabled: false, participation: { write: 'automatic' } } } }), taskAgent: true, places: ['agent', 'Lumen project'] },
      { system: memorySystem({ sources: ['documents', 'memory-spaces'] }), taskAgent: true, places: ['agent', 'Lumen project'] },
      { system: memorySystem({ layers: { runtime: { enabled: true, participation: { write: 'off' } } } }), taskAgent: true, places: ['agent', 'Lumen project'] },
      // Memory Spaces taking no writes, or stopped: no space, and nothing for the task Agent to write to.
      { system: memorySystem({ layers: { 'memory-spaces': { enabled: true, participation: { write: 'off' } } } }), taskAgent: true, places: ['agent (closed)', 'memory', 'user'] },
      { system: memorySystem({ sources: ['runtime', 'documents'] }), taskAgent: true, places: ['agent (closed)', 'memory', 'user'] },
    ]
    for (const { system, taskAgent, places } of cases) {
      const rpcCall = vi.fn(async (_channel: string, endpoint: string) => {
        if (endpoint === 'status') return { ok: true as const, value: { writeEnabled: true, commandFound: true, memoryBodies: [lumen, dormant], lifecycle: { taskAgentAvailable: taskAgent }, memorySystem: system } }
        if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'A durable project decision.' } }
        if (endpoint === 'source-management-read') return emptyRuntime
        throw new Error(`unexpected endpoint: ${endpoint}`)
      })
      openSaveAction(rpcCall)
      await screen.findByRole('button', { name: /saveAction\.to/ })
      fireEvent.click(screen.getByRole('button', { name: /saveAction\.to/ }))
      const listed = screen.getAllByRole('menuitem').map(item => {
        const text = item.textContent ?? ''
        const name = text.startsWith('saveAction.to.agent') ? 'agent' : text.startsWith('saveAction.to.memory') ? 'memory' : text.startsWith('saveAction.to.user') ? 'user' : text.replace('saveAction.to.space', '')
        return (item as HTMLButtonElement).disabled ? `${name} (closed)` : name
      })
      expect(listed).toEqual(places)
      cleanup()
    }
  })

  it.each([false, true])('keeps sending closed while no place can take the text, with a task Agent: %s', async taskAgent => {
    const rpcCall = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'status') return { ok: true as const, value: { writeEnabled: true, commandFound: false, memoryBodies: [], lifecycle: { taskAgentAvailable: taskAgent }, memorySystem: memorySystem({ sources: ['documents', 'memory-spaces'] }) } }
      if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'A durable project decision.' } }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    openSaveAction(rpcCall)
    // The note says why; no tag claims the task Agent is ready or missing.
    await screen.findByText('saveAction.noPlace')
    expect(screen.queryByText('taskAgent.ready')).toBeNull()
    expect(screen.queryByText('taskAgent.unavailable')).toBeNull()
    expect((screen.getByRole('button', { name: 'saveAction.submit' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('saveAction.hint')).toBeTruthy()
  })

  it('names a queued Provider write as submitted, and a duplicate entry as skipped', async () => {
    const rpcCall = vi.fn(async (_channel: string, endpoint: string, input?: unknown) => {
      if (endpoint === 'status') return { ok: true as const, value: { writeEnabled: true, commandFound: true, memoryBodies: [lumen], lifecycle: { taskAgentAvailable: true }, memorySystem: memorySystem() } }
      if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'Checkout loads the payment SDK after interaction.' } }
      if (endpoint === 'source-management-read') return emptyRuntime
      if (endpoint === 'source-management-catalog') return runtimeCatalog()
      if (endpoint === 'source-management-mutate') return { ok: true as const, value: { revision: 's2', value: { action: 'queued', operationId: 'op-1', memoryBodyId: 'lumen' } } }
      if (endpoint === 'source-assistance') {
        const target = (input as { input: { target: string } }).input.target
        return target === 'memory'
          ? { ok: true as const, value: { revision: 'r1', value: { success: true, message: 'Entry already exists; no duplicate added.', target, entryCount: 3 } } }
          : { ok: true as const, value: { revision: 'r2', value: { success: true, message: 'Entry added.', target, entryCount: 2, maintenance: { kind: 'local-compaction' } } } }
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    openSaveAction(rpcCall)
    await screen.findByText('taskAgent.ready')
    choose(/^Lumen project/)
    fireEvent.click(screen.getByRole('button', { name: 'saveAction.save' }))
    // Mem0, Supermemory and Hindsight queue their writes and confirm them later.
    await screen.findByText('receipt.pending')
    expect(screen.getByText('saveAction.saved.spacePending')).toBeTruthy()
    // A working-memory place saves once its usage is read.
    const saveWhenReady = async () => {
      const save = screen.getByRole('button', { name: 'saveAction.save' }) as HTMLButtonElement
      await waitFor(() => expect(save.disabled).toBe(false))
      fireEvent.click(save)
    }
    choose(/^saveAction\.to\.memory/)
    await saveWhenReady()
    await screen.findByText('receipt.skipped')
    expect(screen.getByText('saveAction.saved.duplicate')).toBeTruthy()
    // A save that made room says so.
    choose(/^saveAction\.to\.user/)
    await saveWhenReady()
    await screen.findByText('saveAction.saved.runtimeMaintained')
    // Working memory and the user profile keep no vectors, so their receipts never mention one.
    expect(screen.queryByText('receipt.unembedded')).toBeNull()
    expect(screen.queryByText('receipt.unembeddedNoService')).toBeNull()
  })

  it('says nothing about a vector when the write put no memory anywhere (#388)', async () => {
    const rpcCall = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'status') return { ok: true as const, value: { writeEnabled: true, lifecycle: { taskAgentAvailable: true } } }
      if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'Checkout loads the payment SDK after interaction.' } }
      // An earlier write in the run had no vector; the run itself ended as a skipped duplicate.
      if (endpoint === 'supervise') return { ok: true as const, value: { summary: 'Already saved.', action: 'skipped', memoryBodyIds: [], unembedded: [{ memoryBodyId: 'lumen', id: 'm1' }] } }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    render(<MnemonSaveAction messageId="message-1" sessionId="session-a" connection={{ rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle} settingsScope={writableSettingsScope} localeRuntime={localeRuntime} t={translate as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'saveAction.button' }))
    await screen.findByText('taskAgent.ready')
    const submit = screen.getByRole('button', { name: 'saveAction.submit' }) as HTMLButtonElement
    await waitFor(() => expect(submit.disabled).toBe(false))
    fireEvent.click(submit)
    await screen.findByText('receipt.skipped')
    expect(screen.queryByText('receipt.unembedded')).toBeNull()
    expect(screen.queryByText('receipt.unembeddedNoService')).toBeNull()
  })

  // With the embedding settings at their default no embedding service is set up, so a missing vector is expected and
  // gets a neutral note; once DSH manages them, a configured service did not answer, which keeps the caution.
  it.each([
    [false, 'receipt.unembeddedNoService', 'neutral'],
    [true, 'receipt.unembedded', 'caution'],
  ] as const)('says when a memory was saved without a vector, through the task Agent or written directly, DSH managing the embedding: %s (#388)', async (managed, note, tone) => {
    const native = { id: 'native', name: 'Native space', active: true, providerEnabled: true, provider: { id: 'mnemon-native', label: 'Mnemon Native', capabilities: { remember: true } } }
    let embedded = false
    const rpcCall = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'status') return { ok: true as const, value: { writeEnabled: true, commandFound: true, memoryBodies: [native], lifecycle: { taskAgentAvailable: true }, memorySystem: memorySystem() } }
      if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'Grafana on the staging cluster listens on port 3300.' } }
      if (endpoint === 'source-management-read') return emptyRuntime
      if (endpoint === 'source-management-catalog') return runtimeCatalog()
      if (endpoint === 'supervise') return { ok: true as const, value: { summary: 'Saved to Native space.', action: 'added', memoryBodyIds: ['native'], unembedded: [{ memoryBodyId: 'native', id: 'm1' }] } }
      if (endpoint === 'source-management-mutate') return { ok: true as const, value: { revision: 's2', value: { action: 'added', id: 'm2', memoryBodyId: 'native', embedded } } }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    const other = managed ? 'receipt.unembeddedNoService' : 'receipt.unembedded'
    openSaveAction(rpcCall, settingsScope<Config>({ status: 'ready', value: managed ? { embedding: { enabled: true, endpoint: 'http://127.0.0.1:9' } } : {}, writable: true, mode: 'host' }))
    await screen.findByText('taskAgent.ready')
    const submit = screen.getByRole('button', { name: 'saveAction.submit' }) as HTMLButtonElement
    await waitFor(() => expect(submit.disabled).toBe(false))
    fireEvent.click(submit)
    // The task Agent's result lists the memory; its own summary may leave that out.
    await screen.findByText('Saved to Native space.')
    expect(screen.getByText(note).getAttribute('data-tone')).toBe(tone)
    expect(screen.queryByText(other)).toBeNull()
    // Written directly, Mnemon Native's receipt says embedded: false.
    choose(/^Native space/)
    fireEvent.click(screen.getByRole('button', { name: 'saveAction.save' }))
    await screen.findByText('saveAction.saved.space')
    expect(screen.getByText(note).getAttribute('data-tone')).toBe(tone)
    expect(screen.queryByText(other)).toBeNull()
    // A memory saved with its vector reads as before.
    embedded = true
    fireEvent.change(screen.getByRole('textbox', { name: 'saveAction.candidate' }), { target: { value: 'Grafana on the staging cluster listens on port 3301.' } })
    fireEvent.click(screen.getByRole('button', { name: 'saveAction.save' }))
    await screen.findByText('saveAction.saved.space')
    expect(screen.queryByText(note)).toBeNull()
    expect(screen.queryByText(other)).toBeNull()
  })

  it('says before saving when working memory cannot take the text, or will make room first', async () => {
    let taskAgent = true
    const rpcCall = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'status') return { ok: true as const, value: { writeEnabled: true, commandFound: false, memoryBodies: [], lifecycle: { taskAgentAvailable: taskAgent }, memorySystem: memorySystem() } }
      if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'Release gates close at 18:00.' } }
      if (endpoint === 'source-management-read') return { ok: true as const, value: { revision: 'r1', value: { targets: { memory: { used: 10_230, limit: 10_240 }, user: { used: 4_090, limit: 4_096 } } } } }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    openSaveAction(rpcCall)
    const save = await screen.findByRole('button', { name: 'saveAction.save' }) as HTMLButtonElement
    // Full: it still saves, after making room.
    await screen.findByText('saveAction.place.full')
    expect(save.disabled).toBe(false)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Two entries § in one' } })
    await screen.findByText('saveAction.place.delimiter')
    expect(save.disabled).toBe(true)
    fireEvent.change(textarea, { target: { value: 'x'.repeat(8 * 1024 + 1) } })
    await screen.findByText('saveAction.place.tooLong')
    expect(save.disabled).toBe(true)
    // A text that fills the file leaves every existing entry to move out; it still saves.
    fireEvent.change(textarea, { target: { value: 'y'.repeat(7_200) } })
    await screen.findByText('saveAction.place.fullAll')
    expect(save.disabled).toBe(false)
    cleanup()
    // A full user profile makes room only through a task Agent.
    taskAgent = false
    openSaveAction(rpcCall)
    await screen.findByRole('button', { name: 'saveAction.save' })
    choose(/^saveAction\.to\.user/)
    await screen.findByText('saveAction.place.userFull')
    expect((screen.getByRole('button', { name: 'saveAction.save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('holds the user profile to its own limit, and says when a task Agent will condense it', async () => {
    let user = { used: 0, limit: 4_096 }
    const snapshot = deferred<{ ok: true; value: { revision: string; value: Record<string, unknown> } }>()
    let reads = 0
    const rpcCall = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'status') return { ok: true as const, value: { writeEnabled: true, commandFound: false, memoryBodies: [], lifecycle: { taskAgentAvailable: true }, memorySystem: memorySystem() } }
      if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'z'.repeat(4_200) } }
      if (endpoint === 'source-management-read') {
        reads += 1
        const value = { revision: 'r1', value: { targets: { memory: { used: 0, limit: 10_240 }, user } } }
        return reads === 1 ? snapshot.promise : { ok: true as const, value }
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    openSaveAction(rpcCall)
    const save = await screen.findByRole('button', { name: 'saveAction.save' }) as HTMLButtonElement
    // The save waits for the usage, so its note comes first.
    await waitFor(() => expect(reads).toBe(1))
    expect(save.disabled).toBe(true)
    await act(async () => { snapshot.resolve({ ok: true, value: { revision: 'r1', value: { targets: { memory: { used: 0, limit: 10_240 }, user } } } }) })
    await waitFor(() => expect(save.disabled).toBe(false))
    cleanup()
    // 4.2 KB fits one entry but not a 4 KB user profile.
    openSaveAction(rpcCall)
    await screen.findByRole('button', { name: 'saveAction.save' })
    choose(/^saveAction\.to\.user/)
    await screen.findByText('saveAction.place.tooLong')
    expect((screen.getByRole('button', { name: 'saveAction.save' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    // A profile at 3 KB: a short text is condensed in; a long one cannot fit after making room.
    user = { used: 3_000, limit: 4_096 }
    openSaveAction(rpcCall)
    await screen.findByRole('button', { name: 'saveAction.save' })
    choose(/^saveAction\.to\.user/)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'u'.repeat(1_200) } })
    await screen.findByText('saveAction.place.userCondense')
    expect((screen.getByRole('button', { name: 'saveAction.save' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(textarea, { target: { value: 'u'.repeat(2_900) } })
    await screen.findByText('saveAction.place.userTooLong')
    expect((screen.getByRole('button', { name: 'saveAction.save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('reads a fresh revision for every save, and keeps a direct save\'s receipt when the dialog closes meanwhile', async () => {
    let catalogs = 0
    const writes: Array<ReturnType<typeof deferred<{ ok: true; value: { revision: string; value: Record<string, unknown> } }>>> = []
    const rpcCall = vi.fn(async (_channel: string, endpoint: string, _input?: unknown) => {
      if (endpoint === 'status') return { ok: true as const, value: { writeEnabled: true, commandFound: false, memoryBodies: [], lifecycle: { taskAgentAvailable: false }, memorySystem: memorySystem() } }
      if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'Release gates close at 18:00.' } }
      if (endpoint === 'source-management-read') return emptyRuntime
      if (endpoint === 'source-management-catalog') return runtimeCatalog(`r${++catalogs}`)
      if (endpoint === 'source-assistance') { const write = deferred<{ ok: true; value: { revision: string; value: Record<string, unknown> } }>(); writes.push(write); return write.promise }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    openSaveAction(rpcCall)
    const first = await screen.findByRole('button', { name: 'saveAction.save' }) as HTMLButtonElement
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Release gates close at 18:00 sharp.' } })
    await waitFor(() => expect(first.disabled).toBe(false))
    fireEvent.click(first)
    await waitFor(() => expect(writes).toHaveLength(1))
    // Closed and opened again while the write runs: the dialog still shows it, on its text and place.
    fireEvent.click(screen.getByRole('button', { name: 'saveAction.close' }))
    fireEvent.click(screen.getByRole('button', { name: 'saveAction.button' }))
    expect((await screen.findByRole('button', { name: 'saveAction.saving' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: /saveAction\.to/ }).textContent).toContain('saveAction.to.memory')
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Release gates close at 18:00 sharp.'))
    await act(async () => { writes[0]!.resolve({ ok: true, value: { revision: 'r9', value: { success: true, message: 'Entry added.', target: 'memory', entryCount: 1 } } }) })
    await screen.findByText('receipt.written')
    expect((screen.getByRole('button', { name: 'saveAction.save' }) as HTMLButtonElement).disabled).toBe(true)
    // A second place reads the catalog again.
    choose(/^saveAction\.to\.user/)
    fireEvent.click(screen.getByRole('button', { name: 'saveAction.save' }))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(rpcCall.mock.calls.filter(call => call[1] === 'source-assistance').map(call => (call[2] as { expectedRevision: string }).expectedRevision)).toEqual(['r1', 'r2'])
    // Closed while it runs and opened after it ends: its receipt is there, and the same text cannot go twice.
    fireEvent.click(screen.getByRole('button', { name: 'saveAction.close' }))
    await act(async () => { writes[1]!.resolve({ ok: true, value: { revision: 'r10', value: { success: true, message: 'Entry added.', target: 'user', entryCount: 1 } } }) })
    fireEvent.click(screen.getByRole('button', { name: 'saveAction.button' }))
    await screen.findByText('receipt.written')
    expect(screen.getByRole('button', { name: /saveAction\.to/ }).textContent).toContain('saveAction.to.user')
    await waitFor(() => expect((screen.getByRole('button', { name: 'saveAction.save' }) as HTMLButtonElement).disabled).toBe(true))
    expect(writes).toHaveLength(2)
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
    const connection = { rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle

    render(<MnemonSaveAction messageId="message-1" sessionId="session-a" connection={connection} settingsScope={writableSettingsScope} localeRuntime={localeRuntime} t={translate as never} />)
    const action = screen.getByRole('button', { name: 'saveAction.button' })
    expect(action.textContent).toBe('')
    expect(action.getAttribute('aria-haspopup')).toBe('dialog')
    expect(action.getAttribute('title')).toBeNull()
    fireEvent.pointerEnter(action)
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
    const rpcCall = remoteRpc(async (endpoint: string) => {
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
    expect(calledRemote(rpcCall, 'supervise')).toBe(false)
  })

  it('allows supervised message writes when authenticated Host settings are writable', async () => {
    const rpcCall = remoteRpc(async (endpoint: string) => {
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
    await waitFor(() => expect(calledRemote(rpcCall, 'supervise')).toBe(true))
  })

  it('updates the save action on locale changes without remounting an edited candidate', async () => {
    const locale = createLocaleRuntime()
    const t = (key: string) => `${locale.getSnapshot().active}:${key}`
    const rpcCall = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'status') return { ok: true as const, value: { writeEnabled: true } }
      if (endpoint === 'assistant-message') return { ok: true as const, value: { messageId: 'message-1', text: 'Original candidate.' } }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })
    render(<MnemonSaveAction messageId="message-1" sessionId="session-a" connection={{ rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle} settingsScope={writableSettingsScope} localeRuntime={locale} t={t} />)
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
    render(<MnemonTurnTail turn={{ turn: 2, status: 'closed' }} seq={12} openFile={vi.fn()} sessionId="session-a" connection={{ rpc: { call: rpcCall }, isLoopback: true } as ClientConnectionHandle} localeRuntime={locale} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: /zh:turnTail\.label/ }))
    act(() => locale.select('en'))
    expect(screen.getByRole('button', { name: /en:turnTail\.label/ }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'en:turnTail.openTool' })).toBeTruthy()
    expect(rpcCall).toHaveBeenCalledTimes(1)
  })
})

describe('interaction surfaces binding', () => {
  const mountedEffects: Array<() => void> = []

  interface SlotOptions {
    name: string
    key?: string
    id?: string
    order?: number
    priority?: number
    label?: unknown
    locale?: string
    children?: Record<string, unknown>
    inject?: (...args: unknown[]) => Record<string, unknown>
  }

  function makeCtx(initialValue: unknown, coreValue: Record<string, unknown> = {}) {
    const core = new SlotCore()
    const registerSlot = (options: SlotOptions, component: unknown = () => null): (() => void) =>
      (core.register as (options: SlotOptions, component: unknown) => () => void)(options, component)
    const disposeOwner = registerSlot({
      name: 'root',
      children: {
        'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
        'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
        'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
        'conversation.view': { kind: 'list', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
        'plugins.detail.actions': { kind: 'list', scope: 'root' },
      },
    })
    const injects: string[] = []
    const active = new Set<SlotOptions>()
    const registeredOptions: SlotOptions[] = []
    let uiValue = initialValue as Record<string, unknown>
    let revision = 1
    const localeSnapshot = { active: 'zh' as const, locales: [] as const, revision: 0 }
    let sessionList = { current: 'session-a', byId: { 'session-a': { id: 'session-a' } } as Record<string, unknown> }
    const sessionListeners = new Set<() => void>()
    const setSessions = (byId: Record<string, unknown>): void => {
      sessionList = { ...sessionList, byId }
      for (const listener of [...sessionListeners]) listener()
    }

    const injectDisposers = new Map<string, () => void>()
    const effectDisposers: Array<() => void> = []

    const ctx = {
      get: vi.fn(() => undefined),
      on: vi.fn(() => () => {}),
      inject: vi.fn(),
      sessions: { list: {
        getSnapshot: () => sessionList,
        subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } },
      } },
      uiSession: { adapter: { current: { getSnapshot: () => ({ key: 'session-a' }), subscribe: () => () => {} } } },
      layout: { selectPanel: vi.fn() },
      slots: {
        inject: (slot: string, factory: () => unknown) => {
          injects.push(slot)
          let dispose = core.specDynamic(slot) === undefined ? undefined : factory() as (() => void) | undefined
          const disposer = () => { dispose?.(); dispose = undefined }
          injectDisposers.set(slot, disposer)
          return disposer
        },
        entries: (slot: string) => core.entries(slot),
        subscribe: (slot: string, listener: () => void) => core.subscribe(slot, listener),
        register: (options: SlotOptions, component: unknown) => {
          const dispose = registerSlot(options, component)
          registeredOptions.push(options)
          active.add(options)
          return () => { dispose(); active.delete(options) }
        },
      },
      connection: {
        rpc: {
          call: vi.fn(async (channel: string, endpoint: string, rawPayload: unknown) => {
            if (channel === '/dsh-mnemon-settings') {
              const payload = rawPayload as { namespace?: string; ops?: Array<{ op: string; path: string[]; value?: unknown }> }
              const namespace = payload.namespace
              if (endpoint === 'mutate' && namespace === 'mnemon-ui') {
                for (const op of payload.ops ?? []) {
                  if (op.op === 'set') uiValue = { ...uiValue, [op.path[0]!]: op.value }
                  else {
                    uiValue = { ...uiValue }
                    delete uiValue[op.path[0]!]
                  }
                }
                revision += 1
              }
              return { ok: true, value: { status: 'ready', value: namespace === 'mnemon-ui' ? uiValue : coreValue, base: {}, user: namespace === 'mnemon-ui' ? uiValue : coreValue, revision, writable: true, mode: 'host' } }
            }
            return { ok: false, error: { code: 'internal', message: 'unexpected', details: {} } }
          }),
        },
        isLoopback: true,
      },
      locale: {
        register: vi.fn(() => () => {}),
        bind: vi.fn(() => (key: string) => key),
        getSnapshot: vi.fn(() => localeSnapshot),
        subscribe: vi.fn(() => () => {}),
      },
      effect: vi.fn((callback: () => unknown) => {
        const dispose = callback()
        if (typeof dispose === 'function') effectDisposers.push(dispose as () => void)
        return () => {}
      }),
    }

    const activeRegistrations = () => [...active].map(options => options.key ?? options.id ?? options.name)
    const dispose = () => {
      for (const stop of effectDisposers.splice(0).reverse()) stop()
      for (const stop of [...injectDisposers.values()].reverse()) stop()
      injectDisposers.clear()
    }
    mountedEffects.push(() => { dispose(); disposeOwner() })
    return { ctx, core, registerSlot, dispose, injects, injectDisposers, registeredOptions, activeRegistrations, effectDisposers, setSessions }
  }

  afterEach(() => {
    for (const dispose of mountedEffects.splice(0).reverse()) dispose()
    document.documentElement.removeAttribute('data-dsh-mnemon-active')
    document.body.replaceChildren()
  })

  it('keeps a stable turn-tail list registration across settings and client reload', async () => {
    const { ctx, core, registerSlot, registeredOptions, dispose } = makeCtx({})
    const slot = 'conversation.chat.turnTail'
    const peerIds = ['other-plugin/first-tail', 'other-plugin/second-tail']
    for (const id of peerIds) registerSlot({ name: slot, id, priority: 1 })
    const peers = [...core.entriesOfSlot(slot)]
    const ids = () => core.entriesOfSlot(slot).map(entry => entry.options.id)
    const tails = ['dsh-mnemon/turn-tail', 'dsh-mnemon/skill-tail']

    apply(ctx)
    expect(core.entriesOfSlot(slot)).toEqual(peers)
    await waitFor(() => expect(ids()).toEqual([...tails, ...peerIds]))
    expect(core.entriesOfSlot(slot)[0]!.select).toBeUndefined()

    const settings = registeredOptions.find(options => options.name === 'plugins.bundle.config')?.inject?.() as {
      interactionScope: { mutate: (ops: unknown[]) => Promise<void> }
    }
    await settings.interactionScope.mutate([{ op: 'set', path: ['turnBar'], value: false }])
    expect(ids()).toEqual(['dsh-mnemon/skill-tail', ...peerIds])
    await settings.interactionScope.mutate([{ op: 'set', path: ['turnBar'], value: true }])
    expect(ids()).toEqual([...tails, ...peerIds])
    expect(core.entries(slot)).toHaveLength(4)

    dispose()
    expect(core.entriesOfSlot(slot)).toEqual(peers)
    apply(ctx)
    await waitFor(() => expect(ids()).toEqual([...tails, ...peerIds]))
    expect(core.entries(slot)).toHaveLength(4)
    dispose()
    expect(core.entriesOfSlot(slot)).toEqual(peers)
  })

  it('registers both remaining interaction surfaces by default', async () => {
    const { ctx, injects, activeRegistrations } = makeCtx({})
    apply(ctx)
    expect(injects).toContain('plugins.bundle.config')
    await waitFor(() => expect(injects).toContain('shell.overlay'))
    await waitFor(() => expect(activeRegistrations()).toEqual(expect.arrayContaining(['dsh-mnemon/turn-tail', 'mnemon-save'])))
  })

  it('registers explicitly enabled surfaces after settings load', async () => {
    const { ctx, activeRegistrations } = makeCtx({ toolviews: true, turnBar: true, saveAction: true })
    apply(ctx)
    await waitFor(() => expect(activeRegistrations()).toEqual(expect.arrayContaining(['dsh-mnemon/turn-tail', 'mnemon-save'])))
    expect(activeRegistrations()).toEqual(expect.arrayContaining(['dsh-mnemon/turn-tail', 'mnemon-save']))
  })

  it('registers only the enabled surfaces when toggles are mixed', async () => {
    const { ctx, activeRegistrations } = makeCtx({ toolviews: true, turnBar: false, saveAction: true })
    apply(ctx)
    await waitFor(() => expect(activeRegistrations()).toEqual(expect.arrayContaining(['mnemon-save'])))
    expect(activeRegistrations()).toEqual(expect.arrayContaining(['mnemon-save']))
    expect(activeRegistrations()).not.toContain('dsh-mnemon/turn-tail')
  })

  it('opens the default sidebar for a conversation anchor', async () => {
    const { ctx, injects } = makeCtx({})
    const tab = document.createElement('button')
    tab.setAttribute('role', 'tab')
    tab.textContent = 'tab.label'
    const clicked = vi.fn()
    tab.addEventListener('click', clicked)
    const conversation = document.createElement('div')
    conversation.dataset.slot = 'main.conversation'
    conversation.append(tab)
    document.body.append(conversation)

    apply(ctx)
    await waitFor(() => expect(injects).toContain('shell.overlay'))
    dispatchMnemonAnchor({ page: 'documents/library', sessionId: 'session-a' })

    expect(clicked).not.toHaveBeenCalled()
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(true)
    expect(injects).not.toContain('conversation.view')
    expect(consumeMnemonAnchor('session-a')).toMatchObject({ page: 'documents/library' })
  })

  it('opens the Builtin tab only for the current session, follows locale labels, and removes its listener on disposal', async () => {
    const { ctx, injects, activeRegistrations, effectDisposers } = makeCtx({}, { displayMode: 'builtin' })
    let label = '记忆系统'
    ctx.locale.bind.mockImplementation(() => () => label)
    const tab = document.createElement('button')
    tab.setAttribute('role', 'tab')
    tab.textContent = label
    const clicked = vi.fn()
    tab.addEventListener('click', clicked)
    const conversation = document.createElement('div')
    conversation.dataset.slot = 'main.conversation'
    conversation.append(tab)
    document.body.append(conversation)
    apply(ctx)
    await waitFor(() => expect(injects).toContain('conversation.view'))
    expect(activeRegistrations().filter(id => id === 'mnemon')).toHaveLength(1)
    expect(activeRegistrations()).toContain('dsh-mnemon')

    dispatchMnemonAnchor({ page: 'documents/library', sessionId: 'session-b' })
    expect(clicked).not.toHaveBeenCalled()
    expect(consumeMnemonAnchor('session-b')).toMatchObject({ page: 'documents/library' })
    dispatchMnemonAnchor({ page: 'memory-spaces/remember', seed: 'Scoped candidate', sessionId: 'session-a' })
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(consumeMnemonAnchor('session-a')).toMatchObject({ page: 'memory-spaces/remember', seed: 'Scoped candidate' })
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(false)

    label = 'Memory System'
    tab.textContent = label
    dispatchMnemonAnchor({ page: 'runtime/entries', sessionId: 'session-a' })
    expect(clicked).toHaveBeenCalledTimes(2)
    consumeMnemonAnchor('session-a')
    for (const dispose of effectDisposers) dispose()
    dispatchMnemonAnchor({ page: 'status', sessionId: 'session-a' })
    expect(clicked).toHaveBeenCalledTimes(2)
    expect(consumeMnemonAnchor('session-a')).toMatchObject({ page: 'status' })
  })

  it('offers the Builtin workspace from the Plugins page only for a listed conversation', async () => {
    const { ctx, injects, registeredOptions, setSessions } = makeCtx({}, { displayMode: 'builtin' })
    setSessions({})
    apply(ctx)
    await waitFor(() => expect(injects).toContain('conversation.view'))
    const actions = registeredOptions.find(options => options.id === 'dsh-mnemon/open-workspace')!
    const workspace = actions.inject!().workspace as { getSnapshot(): (() => void) | undefined }
    expect(workspace.getSnapshot()).toBeUndefined()
    setSessions({ 'session-a': { id: 'session-a' } })
    expect(workspace.getSnapshot()).toBeTypeOf('function')
    setSessions({})
    expect(workspace.getSnapshot()).toBeUndefined()
  })

  it('keeps Builtin anchors pending without mounting or opening a hidden entry', async () => {
    const { ctx, activeRegistrations } = makeCtx({}, { displayMode: 'builtin', tabEnabled: false })
    apply(ctx)
    await waitFor(() => expect(activeRegistrations()).toContain('mnemon-save'))
    expect(activeRegistrations().filter(id => id === 'mnemon')).toHaveLength(0)
    expect(activeRegistrations()).toContain('dsh-mnemon')
    dispatchMnemonAnchor({ page: 'documents/library', sessionId: 'session-a' })
    expect(document.documentElement.hasAttribute('data-dsh-mnemon-active')).toBe(false)
    expect(consumeMnemonAnchor('session-a')).toMatchObject({ page: 'documents/library' })
  })

  it('registers and disposes interaction surfaces when mnemon-ui changes live', async () => {
    const { ctx, registeredOptions, activeRegistrations } = makeCtx({})
    apply(ctx)
    await waitFor(() => expect(registeredOptions.some(options => options.name === 'plugins.bundle.config')).toBe(true))
    const settingsEntry = registeredOptions.find(options => options.name === 'plugins.bundle.config')
    const injected = settingsEntry?.inject?.() as { interactionScope?: { mutate: (ops: unknown[]) => Promise<void> } } | undefined
    if (injected?.interactionScope === undefined) throw new Error('mnemon-ui settings scope was not injected')

    await injected.interactionScope.mutate([{ op: 'set', path: ['turnBar'], value: true }])
    await waitFor(() => expect(activeRegistrations()).toContain('dsh-mnemon/turn-tail'))

    await injected.interactionScope.mutate([{ op: 'set', path: ['turnBar'], value: false }])
    await waitFor(() => expect(activeRegistrations()).not.toContain('dsh-mnemon/turn-tail'))
  })
})

describe('the receipt of a memory saved without a vector', () => {
  const controlsCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/client/PageControls.module.css'), 'utf8')

  function vectorNote(container: HTMLElement): { text: string | null; tone: string | null } | null {
    const note = container.querySelector('[role=status] > p[data-tone]')
    return note === null ? null : { text: note.textContent, tone: note.getAttribute('data-tone') }
  }

  it.each([['zh', translateZh], ['en', translateEn]] as const)('words it by whether DSH manages the embedding settings (%s)', (_language, t) => {
    const { container, rerender } = render(<WriteReceipt t={t} action="added" summary="Saved to Release notes." unembedded embeddingManaged={false} />)
    expect(vectorNote(container)).toEqual({ text: t('receipt.unembeddedNoService'), tone: 'neutral' })
    rerender(<WriteReceipt t={t} action="added" summary="Saved to Release notes." unembedded embeddingManaged />)
    expect(vectorNote(container)).toEqual({ text: t('receipt.unembedded'), tone: 'caution' })
    rerender(<WriteReceipt t={t} action="updated" unembedded />)
    expect(vectorNote(container)).toEqual({ text: t('receipt.unembedded'), tone: 'caution' })
    rerender(<WriteReceipt t={t} action="partial" unembedded embeddingManaged={false} />)
    expect(vectorNote(container)?.tone).toBe('neutral')
  })

  it.each([false, true, undefined])('says nothing about a vector when the memory has one or nothing was written (managed: %s)', managed => {
    const cases = [
      { action: 'added' },
      { action: 'added', unembedded: false },
      { action: 'skipped', unembedded: true },
      { action: 'accepted', unembedded: true },
      { action: 'unknown', unembedded: true },
      { error: 'The task Agent failed.', unembedded: true },
    ]
    for (const props of cases) {
      const { container } = render(<WriteReceipt t={translateEn} {...props} {...(managed === undefined ? {} : { embeddingManaged: managed })} />)
      expect(vectorNote(container)).toBeNull()
      cleanup()
    }
  })

  it('draws the neutral note in the hint colour and only the caution in the warning colour', () => {
    expect(controlsCss).toMatch(/\.receipt > \.receiptNote \{[^}]*color: var\(--dsw-alias-label-tertiary\);/u)
    expect(controlsCss).toMatch(/\.receipt > \.receiptNote\[data-tone='caution'\] \{\s*color: var\(--dsw-alias-state-warn-label, var\(--dsw-alias-label-secondary\)\);\s*\}/u)
    expect(controlsCss.match(/--dsw-alias-state-warn-label/gu)).toHaveLength(1)
  })
})

describe('O(N) turn scaling and bounded LRU caches', () => {
  it('keeps closed MnemonSaveAction buttons unsubscribed from settingsScope until opened', async () => {
    let subscribers = 0
    const readySettingsSnapshot = { status: 'ready' as const, value: {}, writable: true, mode: 'host' as const }
    const trackedSettings = {
      getSnapshot: () => readySettingsSnapshot,
      subscribe: (_listener: () => void) => {
        subscribers += 1
        return () => { subscribers -= 1 }
      },
      mutate: async () => {},
    }
    const call = vi.fn(async (_channel: string, endpoint: string) => {
      if (endpoint === 'assistant-message') return { ok: true as const, value: { text: 'Saved note', truncated: false } }
      return { ok: true as const, value: { writeEnabled: true, memoryBodies: [] } }
    })
    const connection = { rpc: { call }, isLoopback: true } as ClientConnectionHandle

    render(<>
      {Array.from({ length: 10 }, (_, index) => (
        <MnemonSaveAction
          key={index}
          messageId={`msg-${index}`}
          sessionId="session-scale"
          connection={connection}
          settingsScope={trackedSettings as never}
          localeRuntime={localeRuntime}
          t={translate}
        />
      ))}
    </>)

    expect(subscribers).toBe(0)
    expect(call).not.toHaveBeenCalled()

    fireEvent.click(screen.getAllByLabelText('saveAction.button')[0]!)
    await waitFor(() => expect(subscribers).toBe(1))
  })

  it('caps SkillTurnTail session cache to 32 sessions with LRU eviction', async () => {
    const call = vi.fn(async () => ({
      ok: true as const,
      value: { available: false, turns: [], reviews: [] },
    }))
    const connection = { rpc: { call }, isLoopback: true } as ClientConnectionHandle
    const view = render(<div />)

    for (let index = 0; index < 33; index += 1) {
      view.rerender(
        <SkillTurnTail
          turn={{ turn: 1, status: 'closed' }}
          seq={5}
          sessionId={`skill-session-${index}`}
          connection={connection}
          localeRuntime={localeRuntime}
          t={translate}
        />,
      )
      await waitFor(() => expect(call).toHaveBeenCalledTimes(index + 1))
    }

    // Most recent session (32) stays cached; oldest session (0) was evicted after 32 entries.
    view.rerender(
      <SkillTurnTail
        turn={{ turn: 1, status: 'closed' }}
        seq={5}
        sessionId="skill-session-32"
        connection={connection}
        localeRuntime={localeRuntime}
        t={translate}
      />,
    )
    await act(async () => {})
    expect(call).toHaveBeenCalledTimes(33)

    view.rerender(
      <SkillTurnTail
        turn={{ turn: 1, status: 'closed' }}
        seq={5}
        sessionId="skill-session-0"
        connection={connection}
        localeRuntime={localeRuntime}
        t={translate}
      />,
    )
    await waitFor(() => expect(call).toHaveBeenCalledTimes(34))
  })
})
