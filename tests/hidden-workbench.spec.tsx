// @vitest-environment jsdom
import { useEffect, useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MnemonChangeSignal } from '../src/client/change-signal.ts'
import { MnemonWorkbench } from '../src/client/MnemonWorkbench.tsx'
import type { MemorySourcePageProps, MemorySourcePageDirectory } from '../src/client/source-pages.tsx'
import type { MnemonSourceManagementClient } from '../src/client/source-contracts.ts'
import { DEFAULT_SKILLS_CONFIG } from '../src/host/protocol.ts'
import type { ClientConnectionHandle, Config, SkillsConfig } from '../src/host/protocol.ts'
import { settingsScope } from './helpers/settings-scope.ts'

const scope = settingsScope<Config>({ status: 'ready', value: { storageScope: 'custom' }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' })
const directory: MemorySourcePageDirectory = {
  subscribe: () => () => {},
  getSnapshot: () => pages,
}
const pages = [{ id: 'skills/test', sourceTypeId: 'skills', pageId: 'test', label: 'Skills', order: 1 }]
const focus = { sourceTypeId: 'skills', title: 'Skills' }
let retained: MnemonSourceManagementClient | undefined
function SourcePage(props: MemorySourcePageProps) {
  const [context, setContext] = useState('')
  const [draft, setDraft] = useState('')
  retained = props.management
  useEffect(() => {
    let current = true
    void props.management!.read('context').then(result => { if (current) setContext(String(result.value)) }, () => {})
    return () => { current = false }
  }, [props.management])
  return <><output aria-label="Source context">{context}</output><textarea aria-label="Draft" value={draft} onChange={event => setDraft(event.target.value)} /></>
}
const renderSlot = (() => <></>) as NonNullable<Parameters<typeof MnemonWorkbench>[0]['renderSlot']>
const sourceSlot: typeof renderSlot = (_name, props) => <SourcePage {...props as unknown as MemorySourcePageProps} />
function transport() {
  const call = vi.fn(async (_channel: string, endpoint: string, input: Record<string, unknown> = {}) => {
    if (endpoint === 'source-management-catalog') return { ok: true, value: { generationId: 'test', sources: [{ sourceTypeId: 'skills', sourceInstanceKey: 'source:skills', packageName: 'skills', revision: 'r1', assistance: ['task'], availability: 'ready', role: 'skills', capabilities: ['read', 'write'], management: { label: 'Skills', description: '' } }] } }
    if (endpoint === 'dashboard') return { ok: true, value: { entries: [] } }
    if (endpoint === 'status-summary') return { ok: true, value: { healthy: true, writeEnabled: true, version: 'test', memoryBodies: [] } }
    if (endpoint === 'source-management-read') return { ok: true, value: { revision: 'r1', value: `${input.sessionId}/${input.workspaceId}` } }
    if (endpoint === 'task-agent-models') return { ok: true, value: { models: [] } }
    if (endpoint === 'source-assistance') return { ok: true, value: { revision: 'r2', value: null } }
    if (endpoint === 'source-management-mutate') return { ok: true, value: { revision: 'r2', value: null } }
    throw new Error('Unexpected read: ' + endpoint)
  })
  return { call, connection: { rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle }
}
afterEach(cleanup)
describe('retained hidden workbench', () => {
  it('defers hidden context reads until reopening, then binds the latest context and rejects stale edits', async () => {
    const { connection, call } = transport()
    const props = { connection, settingsScope: scope, sourcePageDirectory: directory, renderSlot: sourceSlot, focus }
    const view = render(<MnemonWorkbench {...props} sessionId="A" workspaceId="one" />)
    await screen.findByText('A/one')
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: 'unsaved A' } })
    const stale = retained!
    const before = call.mock.calls.length
    view.rerender(<MnemonWorkbench {...props} sessionId="B" workspaceId="two" active={false} />)
    view.rerender(<MnemonWorkbench {...props} sessionId="C" workspaceId="three" active={false} />)
    await act(async () => {})
    expect(call.mock.calls).toHaveLength(before)
    expect((screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement).value).toBe('unsaved A')
    view.rerender(<MnemonWorkbench {...props} sessionId="C" workspaceId="three" />)
    await screen.findByText('C/three')
    expect((screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement).value).toBe('')
    await expect(stale.read('context')).rejects.toThrow(/context/iu)
    await expect(stale.models!()).rejects.toThrow(/context/iu)
    await expect(stale.assistance!.execute('task', null, { confirmed: true, expectedRevision: 'r1' })).rejects.toThrow(/context/iu)
    await expect(stale.mutate('save', null, { confirmed: true })).rejects.toThrow(/context/iu)
    await retained!.mutate('save', null, { confirmed: true })
    expect(call.mock.calls.filter(([, endpoint]) => endpoint === 'source-management-mutate')).toEqual([
      ['/dsh-mnemon-write', 'source-management-mutate', expect.objectContaining({ sessionId: 'C', workspaceId: 'three' })],
    ])
    expect(call.mock.calls.slice(before).every(([, , payload]) => payload?.sessionId === 'C')).toBe(true)
  })

  it('lets an existing third-party initial-once workflow finish hidden on its retained context', async () => {
    const { connection, call } = transport()
    const original = call.getMockImplementation()!
    let finish: (() => void) | undefined
    let deferred = false
    call.mockImplementation(async (channel, endpoint, input) => {
      const result = await original(channel, endpoint, input)
      if (endpoint !== 'source-management-read' || input?.operation !== 'seed' || deferred) return result
      deferred = true
      return await new Promise(resolve => { finish = () => resolve(result) })
    })
    const preferencesMutate = vi.fn(async () => {})
    const skillsScope = settingsScope<SkillsConfig>({ status: 'ready', value: DEFAULT_SKILLS_CONFIG, base: {}, user: {}, revision: 0, writable: true, mode: 'host' }, preferencesMutate)
    let bound: MemorySourcePageProps | undefined
    function LegacySource(props: MemorySourcePageProps) {
      bound = props
      const started = useRef(false)
      const [state, setState] = useState('waiting')
      useEffect(() => {
        if (started.current) return
        started.current = true
        void (async () => {
          await props.management!.read('seed')
          await props.management!.read('follow-up')
          await props.management!.models!()
          await props.management!.assistance!.execute('task', null, { confirmed: true, expectedRevision: 'r1' })
          await props.management!.mutate('save', null, { confirmed: true })
          await props.preferences!.replace({ evolution: false })
          setState('done')
        })().catch(reason => setState(String(reason)))
      }, [props.management])
      return <output aria-label="Legacy workflow">{state}:{props.sessionId}</output>
    }
    const legacySlot: typeof sourceSlot = (_name, props) => <LegacySource {...props as unknown as MemorySourcePageProps} />
    const props = { connection, settingsScope: scope, sourcePageDirectory: directory, renderSlot: legacySlot, focus, skillsScope, workspaceId: 'one' }
    const view = render(<MnemonWorkbench {...props} sessionId="A" />)
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    const before = call.mock.calls.length
    view.rerender(<MnemonWorkbench {...props} sessionId="B" active={false} />)
    await act(async () => {})
    expect(call.mock.calls).toHaveLength(before)
    await act(async () => { finish!() })
    await screen.findByText('done:A')
    expect(preferencesMutate).toHaveBeenCalledOnce()
    const continuation = call.mock.calls.slice(before)
    expect(continuation.map(([, endpoint]) => endpoint)).toEqual(['source-management-read', 'task-agent-models', 'source-assistance', 'source-management-mutate'])
    expect(continuation.every(([, endpoint, input]) => input?.workspaceId === 'one' && (endpoint === 'task-agent-models' ? input?.sessionId === undefined : input?.sessionId === 'A'))).toBe(true)
    const stale = bound!
    view.rerender(<MnemonWorkbench {...props} sessionId="B" />)
    await screen.findByText('done:B')
    const writes = call.mock.calls.length
    const preferenceWrites = preferencesMutate.mock.calls.length
    await expect(stale.management!.mutate('save', null, { confirmed: true })).rejects.toThrow(/context/iu)
    await expect(stale.preferences!.replace({ evolution: true })).rejects.toThrow(/context/iu)
    expect(call.mock.calls).toHaveLength(writes)
    expect(preferencesMutate.mock.calls).toHaveLength(preferenceWrites)
    const latest = bound!
    view.unmount()
    await expect(latest.management!.mutate('save', null, { confirmed: true })).rejects.toThrow(/unmounted/iu)
    await expect(latest.preferences!.replace({ evolution: true })).rejects.toThrow(/unmounted/iu)
    expect(call.mock.calls).toHaveLength(writes)
    expect(preferencesMutate.mock.calls).toHaveLength(preferenceWrites)
  })

  it('keeps the same-context draft through hidden A/B/A and refreshes on reopening', async () => {
    const { connection, call } = transport()
    const props = { connection, settingsScope: scope, sourcePageDirectory: directory, renderSlot: sourceSlot, focus }
    const view = render(<MnemonWorkbench {...props} sessionId="A" workspaceId="one" />)
    await screen.findByText('A/one')
    const draft = screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement
    fireEvent.change(draft, { target: { value: 'unsaved A' } })
    const before = call.mock.calls.length
    view.rerender(<MnemonWorkbench {...props} sessionId="B" workspaceId="two" active={false} />)
    view.rerender(<MnemonWorkbench {...props} sessionId="A" workspaceId="one" active={false} />)
    await act(async () => {})
    expect(call.mock.calls).toHaveLength(before)
    view.rerender(<MnemonWorkbench {...props} sessionId="A" workspaceId="one" />)
    await waitFor(() => expect(call.mock.calls.length).toBeGreaterThan(before))
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft)
    expect(draft.value).toBe('unsaved A')
  })

  it('invalidates drafts and callbacks when reopening on another connection', async () => {
    const first = transport()
    const second = transport()
    const props = { settingsScope: scope, sourcePageDirectory: directory, renderSlot: sourceSlot, focus, sessionId: 'A', workspaceId: 'one' }
    const view = render(<MnemonWorkbench {...props} connection={first.connection} />)
    await screen.findByText('A/one')
    const stale = retained!
    const draft = screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement
    fireEvent.change(draft, { target: { value: 'first host draft' } })
    view.rerender(<MnemonWorkbench {...props} connection={second.connection} active={false} />)
    await act(async () => {})
    expect(second.call).not.toHaveBeenCalled()
    view.rerender(<MnemonWorkbench {...props} connection={second.connection} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Draft' })).not.toBe(draft))
    expect((screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement).value).toBe('')
    await expect(stale.mutate('save', null, { confirmed: true })).rejects.toThrow(/inactive|context/iu)
    const latest = retained!
    view.unmount()
    await expect(latest.mutate('save', null, { confirmed: true })).rejects.toThrow(/inactive|context/iu)
    expect([...first.call.mock.calls, ...second.call.mock.calls].some(([, endpoint]) => endpoint === 'source-management-mutate')).toBe(false)
  })

  it('defers external settings and component changes while hidden', async () => {
    const { connection, call } = transport()
    const changes = new MnemonChangeSignal()
    let snapshot = scope.getSnapshot()
    const listeners = new Set<() => void>()
    const settings = { ...scope, getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
    const props = { connection, settingsScope: settings, sourcePageDirectory: directory, renderSlot: sourceSlot, focus, componentChanges: changes, sessionId: 'A', workspaceId: 'one' }
    const view = render(<MnemonWorkbench {...props} />)
    await screen.findByText('A/one')
    view.rerender(<MnemonWorkbench {...props} active={false} />)
    const before = call.mock.calls.length
    act(() => {
      changes.bump()
      snapshot = { ...snapshot, revision: 1, value: { ...snapshot.value, storageScope: 'global' } }
      for (const listener of listeners) listener()
    })
    await act(async () => {})
    expect(call.mock.calls).toHaveLength(before)
    view.rerender(<MnemonWorkbench {...props} />)
    await screen.findByText('A/one')
    await waitFor(() => expect(call.mock.calls.length).toBeGreaterThan(before))
  })

  it('does not start the full status after a pending summary resolves hidden', async () => {
    const { connection, call } = transport()
    const original = call.getMockImplementation()!
    let finish!: (value: any) => void
    call.mockImplementation((channel, endpoint, input) => endpoint === 'status-summary' ? new Promise(resolve => { finish = resolve }) : original(channel, endpoint, input))
    const props = { connection, settingsScope: scope, sourcePageDirectory: directory, renderSlot: sourceSlot, focus, sessionId: 'A', workspaceId: 'one' }
    const view = render(<MnemonWorkbench {...props} />)
    await screen.findByText('A/one')
    view.rerender(<MnemonWorkbench {...props} active={false} />)
    const before = call.mock.calls.length
    await act(async () => { finish({ ok: true, value: { healthy: true, commandFound: true, memoryBodies: [] } }) })
    expect(call.mock.calls).toHaveLength(before)
  })

  it('does not initialize a workbench mounted hidden', async () => {
    const { connection, call } = transport()
    render(<MnemonWorkbench connection={connection} settingsScope={scope} sourcePageDirectory={directory} renderSlot={sourceSlot} focus={focus} sessionId="A" active={false} />)
    await act(async () => {})
    expect(call).not.toHaveBeenCalled()
  })
})
