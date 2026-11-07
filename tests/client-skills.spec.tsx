// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientConnectionHandle } from '../src/host/dsh.ts'
import type { SkillActivitySnapshot, SkillsConfig } from '../src/host/protocol.ts'
import { subscribeMnemonAnchor } from '../src/client/anchor.ts'
import { translateEn as t } from '../src/client/locales.ts'
import { SKILLS_PAGE, SkillTurnTail, invalidateSkillActivity } from '../src/client/SkillTurnTail.tsx'
import { SKILLS_PACKAGE, SkillsSettings } from '../src/client/skills-settings.tsx'
import { MnemonChangeSignal } from '../src/client/change-signal.ts'
import { liveSettingsScope } from './helpers/settings-scope.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const page = { component: { packageName: SKILLS_PACKAGE, label: 'Skills', enabled: true }, writable: true, language: 'en' }
const locale = { active: 'en' as const, locales: [], revision: 0 }
const localeRuntime = { getSnapshot: () => locale, subscribe: () => () => {} }

describe('技能管理 settings under Plugins', () => {
  it('stages both draft budgets while evolution is off and rejects invalid values', async () => {
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: {}, revision: 1, writable: true, mode: 'host' })
    const view = render(<SkillsSettings scope={scope} page={page} t={t} />)
    fireEvent.click(screen.getByText('Draft generation'))
    const first = screen.getByLabelText('Draft output token limit')
    const retry = screen.getByLabelText('Retry output token limit')
    expect(first).toHaveProperty('value', '32768')
    expect(retry).toHaveProperty('value', '65536')
    fireEvent.change(first, { target: { value: '49152' } })
    fireEvent.change(retry, { target: { value: '131073' } })
    expect(screen.getByRole('button', { name: t('options.apply') })).toHaveProperty('disabled', true)
    expect(scope.getSnapshot().value?.draftMaxTokens).toBeUndefined()
    fireEvent.change(retry, { target: { value: '49152' } })
    fireEvent.click(screen.getByRole('button', { name: t('options.apply') }))
    await waitFor(() => expect(scope.getSnapshot().value).toMatchObject({ draftMaxTokens: 49152, draftRetryMaxTokens: 49152 }))
    view.unmount()
    render(<SkillsSettings scope={scope} page={page} t={t} />)
    expect(screen.getByLabelText('Draft output token limit')).toHaveProperty('value', '49152')
    expect(screen.getByLabelText('Retry output token limit')).toHaveProperty('value', '49152')
  })

  it('stages the new-skill destination until Apply and restores it on Discard', async () => {
    const writes = vi.fn(async () => {})
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: { evolution: true }, revision: 1, writable: true, mode: 'host' }, writes)
    render(<SkillsSettings scope={scope} page={page} t={t} />)
    const destination = screen.getByRole('button', { name: `${t('skills.targetScope')} ${t('skills.targetScope.user')}` })
    expect(destination.textContent).toContain(t('skills.targetScope.user'))
    fireEvent.click(destination)
    fireEvent.click(screen.getByRole('menuitem', { name: t('skills.targetScope.project') }))
    expect(writes).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: t('config.discard') }))
    expect(destination.textContent).toContain(t('skills.targetScope.user'))
    fireEvent.click(destination)
    fireEvent.click(screen.getByRole('menuitem', { name: t('skills.targetScope.storage') }))
    fireEvent.click(screen.getByRole('button', { name: t('options.apply') }))
    await waitFor(() => expect(scope.getSnapshot().value?.targetScope).toBe('storage'))
  })

  it.each(['page', 'scope'] as const)('keeps the destination read-only when %s refuses writes', blocked => {
    const writes = vi.fn(async () => {})
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: { evolution: true }, revision: 1, writable: blocked !== 'scope', mode: 'host' }, writes)
    render(<SkillsSettings scope={scope} page={{ ...page, writable: blocked !== 'page' }} t={t} />)
    expect(screen.getByRole('button', { name: `${t('skills.targetScope')} ${t('skills.targetScope.user')}` })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('Draft output token limit')).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('Retry output token limit')).toHaveProperty('disabled', true)
    expect(writes).not.toHaveBeenCalled()
  })

  it('shows self-evolution\'s own settings only while it is on, and applies each switch at once', async () => {
    const writes = vi.fn(async () => {})
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: {}, revision: 1, writable: true, mode: 'host' }, writes)
    render(<SkillsSettings scope={scope} page={page} t={t} />)
    expect(screen.queryByRole('switch', { name: t('skills.autoBacktest') })).toBeNull()
    expect(screen.queryByRole('switch', { name: t('skills.allowCreate') })).toBeNull()
    expect(screen.queryByRole('switch', { name: t('skills.allowUpdate') })).toBeNull()
    expect(screen.queryByText(t('skills.parameters'))).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: t('skills.evolution') }))
    await waitFor(() => expect(writes).toHaveBeenCalledWith([{ op: 'set', path: ['evolution'], value: true }]))
    expect(await screen.findByRole('switch', { name: t('skills.autoBacktest') })).not.toBeNull()
    expect(screen.getByRole('switch', { name: t('skills.autoAdopt') }).getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('switch', { name: t('skills.autoAdopt') }))
    await waitFor(() => expect(writes).toHaveBeenLastCalledWith([{ op: 'set', path: ['autoAdopt'], value: true }]))
    expect(screen.getByRole('switch', { name: t('skills.allowCreate') }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: t('skills.allowUpdate') }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('switch', { name: t('skills.allowCreate') }))
    await waitFor(() => expect(writes).toHaveBeenLastCalledWith([{ op: 'set', path: ['allowCreate'], value: false }]))
    expect(screen.getByRole('switch', { name: t('skills.allowUpdate') }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('switch', { name: t('skills.allowUpdate') }))
    await waitFor(() => expect(writes).toHaveBeenLastCalledWith([{ op: 'set', path: ['allowUpdate'], value: false }]))
    expect(screen.getByText(t('skills.parameters'))).not.toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: t('skills.hints') }))
    await waitFor(() => expect(writes).toHaveBeenLastCalledWith([{ op: 'set', path: ['hints'], value: false }]))
    fireEvent.click(screen.getByRole('switch', { name: t('skills.sidebar') }))
    await waitFor(() => expect(writes).toHaveBeenLastCalledWith([{ op: 'set', path: ['sidebar'], value: true }]))
  })

  it.each(['page', 'scope'] as const)('keeps both suggestion switches read-only when %s refuses writes', async blocked => {
    const writes = vi.fn(async () => {})
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: { evolution: true, allowCreate: false, allowUpdate: true }, revision: 1, writable: blocked !== 'scope', mode: 'host' }, writes)
    render(<SkillsSettings scope={scope} page={{ ...page, writable: blocked !== 'page' }} t={t} />)
    for (const key of ['allowCreate', 'allowUpdate'] as const) {
      const toggle = screen.getByRole('switch', { name: t(`skills.${key}`) })
      expect(toggle).toHaveProperty('disabled', true)
      fireEvent.click(toggle)
    }
    expect(writes).not.toHaveBeenCalled()
  })

  it('applies the review parameters together and holds back one out of range', async () => {
    const writes = vi.fn(async () => {})
    const scope = liveSettingsScope<SkillsConfig>({ status: 'ready', value: { evolution: true }, revision: 1, writable: true, mode: 'host' }, writes)
    render(<SkillsSettings scope={scope} page={page} t={t} />)
    fireEvent.click(screen.getByText(t('skills.parameters')))
    fireEvent.change(screen.getByLabelText(t('skills.idleSeconds')), { target: { value: '45' } })
    fireEvent.change(screen.getByLabelText(t('skills.minConfidence')), { target: { value: '2' } })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', t('skills.invalid', { field: t('skills.minConfidence'), min: 0, max: 1 }))
    expect((screen.getByRole('button', { name: t('options.apply') }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(t('skills.minConfidence')), { target: { value: '0.7' } })
    fireEvent.click(screen.getByRole('button', { name: t('options.apply') }))
    await waitFor(() => expect(writes).toHaveBeenCalledWith([
      { op: 'set', path: ['idleSeconds'], value: 45 },
      { op: 'set', path: ['minConfidence'], value: 0.7 },
    ]))
  })
})

describe('the skills line under a turn', () => {
  function connection(read: () => SkillActivitySnapshot) {
    const call = vi.fn(async (_channel: string, endpoint: string, _payload: { sessionId?: string }) => endpoint === 'skill-activity'
      ? { ok: true as const, value: read() }
      : { ok: false as const, error: { message: 'unexpected' } })
    return { call, handle: { rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle }
  }

  it('remembers an empty activity result across A/B/A at the same closing cursor', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { call, handle } = connection(() => ({ available: true, turns: [], reviews: [] }))
    const tail = (sessionId: string, seq = 10) => <SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={seq} sessionId={sessionId} connection={handle} localeRuntime={localeRuntime} t={t} />
    const view = render(tail('A'))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    view.rerender(tail('B'))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    const before = call.mock.calls.length
    view.rerender(tail('A'))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(call).toHaveBeenCalledTimes(before)
    view.rerender(tail('A', 20))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(call.mock.calls.length).toBeGreaterThan(before)
  })

  it.each([false, true])('retries temporarily unavailable history on return after settling (previous success=%s)', async succeeded => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let snapshot: SkillActivitySnapshot = { available: succeeded, turns: [], reviews: [] }
    const { call, handle } = connection(() => snapshot)
    const tail = <SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={10} sessionId="A" connection={handle} localeRuntime={localeRuntime} t={t} />
    const view = render(tail)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    snapshot = { available: false, turns: [], reviews: [] }
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    const before = call.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(call).toHaveBeenCalledTimes(before)
    view.rerender(<></>)
    snapshot = { available: true, turns: [{ turn: 1, skills: [{ name: 'recovered', by: 'model' }] }], reviews: [] }
    view.rerender(tail)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(await screen.findByRole('button', { name: 'recovered' })).not.toBeNull()
  })

  it('ignores a pending history result from before a skill write while preserving other connections', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { call, handle } = connection(() => ({ available: true, turns: [], reviews: [] }))
    const finishes: Array<(value: any) => void> = []
    call.mockImplementation(() => new Promise(resolve => { finishes.push(resolve) }))
    const other = connection(() => ({ available: true, turns: [], reviews: [] }))
    render(<>
      <SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={10} sessionId="A" connection={handle} localeRuntime={localeRuntime} t={t} />
      <SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={10} sessionId="A" connection={other.handle} localeRuntime={localeRuntime} t={t} />
    </>)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    const otherReads = other.call.mock.calls.length
    act(() => invalidateSkillActivity(handle))
    await act(async () => { finishes[0]!({ ok: true, value: { available: true, turns: [{ turn: 1, skills: [{ name: 'obsolete', by: 'model' }] }], reviews: [] } }) })
    expect(screen.queryByRole('button', { name: 'obsolete' })).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(finishes).toHaveLength(2)
    await act(async () => { finishes[1]!({ ok: true, value: { available: true, turns: [{ turn: 1, skills: [{ name: 'latest', by: 'model' }] }], reviews: [] } }) })
    expect(screen.getByRole('button', { name: 'latest' })).not.toBeNull()
    expect(other.call).toHaveBeenCalledTimes(otherReads)
  })

  it('defers the first activity read until idle and cancels it if its conversation leaves first', async () => {
    const idle = new Map<number, IdleRequestCallback>()
    let next = 0
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => { idle.set(++next, callback); return next })
    vi.stubGlobal('cancelIdleCallback', (id: number) => idle.delete(id))
    const { call, handle } = connection(() => ({ available: true, turns: [], reviews: [] }))
    const tail = (sessionId: string) => <SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={10} sessionId={sessionId} connection={handle} localeRuntime={localeRuntime} t={t} />
    const view = render(tail('A'))
    await act(async () => {})
    expect(call).not.toHaveBeenCalled()
    view.rerender(tail('B'))
    expect(idle.size).toBe(1)
    await act(async () => { for (const callback of idle.values()) callback({ didTimeout: false, timeRemaining: () => 20 }) })
    expect(call.mock.calls).toEqual([['/dsh-mnemon-read', 'skill-activity', { sessionId: 'B' }]])
  })

  it('keeps the settling cadence during fast A/B/A switches instead of restarting a read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { call, handle } = connection(() => ({ available: true, turns: [], reviews: [] }))
    const tail = (sessionId: string) => <SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={10} sessionId={sessionId} connection={handle} localeRuntime={localeRuntime} t={t} />
    const view = render(tail('A'))
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    view.rerender(tail('B'))
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    view.rerender(tail('A'))
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(call.mock.calls.filter(([, , payload]) => payload.sessionId === 'A')).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(call.mock.calls.filter(([, , payload]) => payload.sessionId === 'A')).toHaveLength(2)
  })

  it('refreshes an empty cached result after a component switch or reconnect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const changes = new MnemonChangeSignal()
    let snapshot: SkillActivitySnapshot = { available: false, turns: [], reviews: [] }
    const { handle } = connection(() => snapshot)
    render(<SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={10} sessionId="A" connection={handle} localeRuntime={localeRuntime} t={t} componentChanges={changes} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    snapshot = { available: true, turns: [{ turn: 1, skills: [{ name: 'newly-enabled', by: 'model' }] }], reviews: [] }
    act(() => changes.bump())
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(await screen.findByRole('button', { name: 'newly-enabled' })).not.toBeNull()
  })

  it('reads one snapshot for all newly rendered history tails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { call, handle } = connection(() => ({ available: true, turns: [], reviews: [] }))
    render(<>{[1, 2, 3, 4, 5].map(turn => <SkillTurnTail key={turn} turn={{ turn, status: 'closed' }} seq={turn * 10} sessionId="A" connection={handle} localeRuntime={localeRuntime} t={t} />)}</>)
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(call).toHaveBeenCalledOnce()
  })

  it('pauses activity reads while the browser document is hidden and resumes pending reviews', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const { call, handle } = connection(() => ({ available: true, turns: [], reviews: [{ turn: 1, state: 'reviewing', suggestions: [] }] }))
    render(<SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={10} sessionId="A" connection={handle} localeRuntime={localeRuntime} t={t} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(call).not.toHaveBeenCalled()
    await act(async () => { visible.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(await screen.findByText(t('skillTail.reviewing'))).not.toBeNull()
    await act(async () => { visible.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')) })
    const before = call.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(call).toHaveBeenCalledTimes(before)
    await act(async () => { visible.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(call.mock.calls.length).toBeGreaterThan(before)
  })

  it('names the skills a turn used, follows its review, and opens what it left on the Skills page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let snapshot: SkillActivitySnapshot = { available: true, turns: [{ turn: 3, skills: [{ name: 'release-notes', by: 'model' }] }], reviews: [{ turn: 3, state: 'reviewing', suggestions: [] }] }
    const { call, handle } = connection(() => snapshot)
    const opened = vi.fn()
    const stop = subscribeMnemonAnchor('session-a', opened)
    render(<SkillTurnTail turn={{ turn: 3, status: 'closed' }} seq={1} sessionId="session-a" connection={handle} localeRuntime={localeRuntime} t={t} />)
    expect(await screen.findByRole('button', { name: 'release-notes' })).not.toBeNull()
    expect(screen.getByText(t('skillTail.reviewing'))).not.toBeNull()
    expect(call).toHaveBeenCalledWith(expect.any(String), 'skill-activity', { sessionId: 'session-a' })
    snapshot = { ...snapshot, reviews: [{ turn: 3, state: 'suggested', suggestions: [{ id: 's1', skillName: 'release-notes', action: 'update', status: 'pending' }] }] }
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    fireEvent.click(await screen.findByRole('button', { name: t('skillTail.suggested', { count: 1 }) }))
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ page: SKILLS_PAGE, seed: 'suggestion:s1', sessionId: 'session-a' }))
    fireEvent.click(screen.getByRole('button', { name: 'release-notes' }))
    expect(opened).toHaveBeenLastCalledWith(expect.objectContaining({ page: SKILLS_PAGE, seed: 'name:release-notes' }))
    // Once the review has settled, the line stops reading.
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    const settled = call.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(call).toHaveBeenCalledTimes(settled)
    stop()
  })

  it('stays out of a turn with nothing to say about skills, and out of an open turn', async () => {
    const quiet = connection(() => ({ available: true, turns: [], reviews: [{ turn: 1, state: 'nothing', suggestions: [] }] }))
    const { container } = render(<SkillTurnTail turn={{ turn: 1, status: 'closed' }} seq={1} sessionId="session-b" connection={quiet.handle} localeRuntime={localeRuntime} t={t} />)
    await waitFor(() => expect(quiet.call).toHaveBeenCalled())
    expect(container.textContent).toBe('')
    const open = connection(() => ({ available: true, turns: [], reviews: [] }))
    render(<SkillTurnTail turn={{ turn: 2, status: 'open' }} seq={2} sessionId="session-c" connection={open.handle} localeRuntime={localeRuntime} t={t} />)
    expect(open.call).not.toHaveBeenCalled()
  })
})
