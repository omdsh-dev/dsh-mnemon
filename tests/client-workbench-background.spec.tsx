// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/host/config.ts'
import type { ClientConnectionHandle } from '../src/host/dsh.ts'
import { ComposedMnemonWorkbench as MnemonWorkbench } from './fixtures/client.tsx'
import { translateEn } from '../src/client/locales.ts'
import { settingsScope } from './helpers/settings-scope.ts'

afterEach(cleanup)

const snapshot = { status: 'ready' as const, value: {} as Config, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const }

/** The workbench's own page, with a Host that answers only the model directory. */
function workbench(options: { value?: Config; writable?: boolean; catalog?: (payload: Record<string, unknown>) => unknown } = {}) {
  const calls: Array<{ endpoint: string; payload: Record<string, unknown> }> = []
  const call = vi.fn(async (channel: string, endpoint: string, payload: Record<string, unknown>) => {
    calls.push({ endpoint, payload: payload ?? {} })
    if (channel !== '/dsh-mnemon-read' || endpoint !== 'task-agent-models') {
      return { ok: false as const, error: { code: 'unexpected', message: endpoint } }
    }
    return { ok: true as const, value: options.catalog === undefined ? directory : options.catalog(payload ?? {}) }
  })
  const connection = { rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle
  const scope = settingsScope<Config>({ ...snapshot, value: options.value ?? {}, writable: options.writable ?? true })
  render(<MnemonWorkbench connection={connection} settingsScope={scope} sessionId="session-1" t={translateEn} locale="en" />)
  return { calls, scope }
}

const directory = {
  effective: { provider: 'ai', model: 'deepseek-v4.1-flash', source: 'session' as const },
  defaultSelection: { provider: 'ai', model: 'space-bunny' },
  groups: [
    { id: 'ai', name: 'AI', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }, { id: 'space-bunny', name: 'Space Bunny' }] },
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] },
  ],
  failures: [],
}

const row = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-labelledby^="${label}-title "]`)!

describe('the background task card on the status page', () => {
  it('shows the route the conversation background work takes and lets the reader pick a model', async () => {
    const { calls, scope } = workbench()

    const card = await screen.findByRole('region', { name: 'Background tasks' })
    expect(within(card).getByText('Will currently use')).toBeTruthy()
    expect(await within(card).findByText('ai / deepseek-v4.1-flash')).toBeTruthy()
    expect(calls.find(call => call.endpoint === 'task-agent-models')?.payload).toEqual({ includeCatalog: false, sessionId: 'session-1' })

    // Choosing a fixed model reads the whole directory and starts from DSH's default.
    fireEvent.click(row('mnemon-task-agent'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Choose a model/u }))
    await waitFor(() => expect(calls.filter(call => call.payload.includeCatalog === true).length).toBe(1))
    await waitFor(() => expect(scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['taskAgentModel'], value: { mode: 'fixed', provider: 'ai', model: 'space-bunny' } }]))
    await waitFor(() => expect(within(card).getByText('ai / space-bunny')).toBeTruthy())

    // Picking another model of that Provider stores it at once.
    fireEvent.click(row('mnemon-task-agent-model'))
    fireEvent.click(screen.getByRole('menuitem', { name: /DeepSeek V4.1 Flash/u }))
    await waitFor(() => expect(scope.mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['taskAgentModel'], value: { mode: 'fixed', provider: 'ai', model: 'deepseek-v4.1-flash' } }]))
    await waitFor(() => expect(within(card).getByText('ai / deepseek-v4.1-flash')).toBeTruthy())
  })

  it('states a failed directory read instead of quietly falling back, and reads again when asked', async () => {
    const { calls } = workbench({ catalog: () => { throw new Error('the model directory is down') } })

    const card = await screen.findByRole('region', { name: 'Background tasks' })
    expect(await within(card).findByText('Could not load the model directory: the model directory is down')).toBeTruthy()
    // A failed read is a statement, not a control the reader has to dismiss.
    expect(within(card).queryByRole('alert')).toBeNull()

    fireEvent.click(within(card).getByRole('button', { name: 'Read again' }))
    await waitFor(() => expect(calls.filter(call => call.endpoint === 'task-agent-models').length).toBe(2))
  })

  it('keeps the card readable when the reader may not write settings', async () => {
    const { scope } = workbench({ writable: false })

    const card = await screen.findByRole('region', { name: 'Background tasks' })
    expect(await within(card).findByText('ai / deepseek-v4.1-flash')).toBeTruthy()
    expect(row('mnemon-task-agent').disabled).toBe(true)
    expect(scope.mutate).not.toHaveBeenCalled()
  })
})
