// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/host/config.ts'
import type { ClientConnectionHandle, ClientSettingsScope } from '../src/host/dsh.ts'
import { MnemonSettingsCard } from '../src/client/MnemonSettingsCard.tsx'
import { liveSettingsScope, settingsScope } from './helpers/settings-scope.ts'

afterEach(cleanup)

/** The data directory's default or custom choice. */
const directoryChoice = (option: string, group = '数据目录') =>
  within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name: option }) as HTMLInputElement

/** The section of the card that holds the storage row. */
const section = () => screen.getByRole('region', { name: '存储' })

function core(value: Config, writable = true) {
  const snapshot = { status: 'ready' as const, value, base: {}, user: {}, revision: 0, writable, mode: 'host' as const }
  return settingsScope(snapshot) as ClientSettingsScope<Config>
}

/** A connection whose Host answers only the endpoints this page uses. */
function host(handlers: Record<string, (payload: Record<string, unknown>) => unknown>) {
  const call = vi.fn(async (channel: string, endpoint: string, payload: Record<string, unknown>) => {
    const handler = handlers[`${channel} ${endpoint}`]
    if (handler === undefined) return { ok: false as const, error: { code: 'bad-request', message: `unexpected ${channel} ${endpoint}` } }
    try {
      return { ok: true as const, value: await handler(payload ?? {}) }
    } catch (reason) {
      return { ok: false as const, error: { code: 'internal', message: reason instanceof Error ? reason.message : String(reason) } }
    }
  })
  return { call, connection: { rpc: { call }, isLoopback: true } as unknown as ClientConnectionHandle }
}

const target = { root: '/old/data', scope: 'custom', defaultRoot: '/home/me/.mnemon' }

describe('the chosen data directory', () => {
  it('offers the move the chosen directory needs, then moves it only when asked', async () => {
    const { connection, call } = host({
      '/dsh-mnemon-pack target': () => target,
      '/dsh-mnemon-pack storage-plan': () => ({ from: '/old/data', to: '/new/data', source: { files: 4, bytes: 2048 }, targetOccupied: false, sameDevice: true }),
      '/dsh-mnemon-pack storage-migrate': () => ({ from: '/old/data', to: '/new/data', files: 4, bytes: 2048, source: 'rename', removed: true }),
    })
    const pickDirectory = vi.fn(async () => '/new/data')
    const scope = core({ storageScope: 'custom', dataDir: '/old/data' })
    render(<MnemonSettingsCard scope={scope} connection={connection} pickDirectory={pickDirectory} />)
    // The row shows the directory memory uses; the draft's own field holds it until a pick replaces it.
    await waitFor(() => expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/old/data'))

    fireEvent.click(within(section()).getByRole('button', { name: '选择目录…' }))
    await waitFor(() => expect(pickDirectory).toHaveBeenCalledTimes(1))

    // The Host read the source before the user was asked anything.
    expect(call).toHaveBeenCalledWith('/dsh-mnemon-pack', 'storage-plan', expect.objectContaining({ dataDir: '/new/data' }))
    const dialog = await screen.findByRole('dialog', { name: '迁移数据目录' })
    expect(within(dialog).getByText('将迁移 4 个文件，共 2.0 KB。')).toBeTruthy()
    expect(within(dialog).getByText('迁移前不会删除任何数据；全部文件校验通过后才会删除原目录。')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: '只改设置，不迁移' })).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: '迁移' }))
    await waitFor(() => expect(call).toHaveBeenCalledWith('/dsh-mnemon-pack', 'storage-migrate', expect.objectContaining({ dataDir: '/new/data', confirmed: true })))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('status').textContent).toBe('已迁移到 /new/data：4 个文件，2.0 KB。')
    // The chosen directory became the draft's, so Apply saves the new location.
    expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/new/data')
    // The move recorded the new location on the Host, so the page re-reads the root memory now uses.
    const targetReads = () => call.mock.calls.filter(([, endpoint]) => endpoint === 'target').length
    await waitFor(() => expect(targetReads()).toBeGreaterThan(1))
  })

  it('keeps the data where it is when the user declines the move', async () => {
    const { connection, call } = host({
      '/dsh-mnemon-pack target': () => target,
      '/dsh-mnemon-pack storage-plan': () => ({ from: '/old/data', to: '/new/data', source: { files: 4, bytes: 2048 }, targetOccupied: false, sameDevice: true }),
    })
    const scope = core({ storageScope: 'custom', dataDir: '/old/data' })
    render(<MnemonSettingsCard scope={scope} connection={connection} pickDirectory={vi.fn(async () => '/new/data')} />)
    await waitFor(() => expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/old/data'))

    fireEvent.click(within(section()).getByRole('button', { name: '选择目录…' }))
    const dialog = await screen.findByRole('dialog', { name: '迁移数据目录' })
    fireEvent.click(within(dialog).getByRole('button', { name: '只改设置，不迁移' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(call).not.toHaveBeenCalledWith('/dsh-mnemon-pack', 'storage-migrate', expect.anything())
    expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/new/data')
  })

  it('refuses to move onto a directory that already holds data', async () => {
    const { connection, call } = host({
      '/dsh-mnemon-pack target': () => target,
      '/dsh-mnemon-pack storage-plan': () => ({ from: '/old/data', to: '/new/data', source: { files: 4, bytes: 2048 }, targetOccupied: true, sameDevice: true, blocked: 'the target directory already holds data' }),
    })
    const scope = core({ storageScope: 'custom', dataDir: '/old/data' })
    render(<MnemonSettingsCard scope={scope} connection={connection} pickDirectory={vi.fn(async () => '/new/data')} />)
    await waitFor(() => expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/old/data'))

    fireEvent.click(within(section()).getByRole('button', { name: '选择目录…' }))
    const dialog = await screen.findByRole('dialog', { name: '迁移数据目录' })
    expect(within(dialog).getByRole('alert').textContent).toBe('无法迁移：the target directory already holds data')
    expect((within(dialog).getByRole('button', { name: '迁移' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: '只改设置，不迁移' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(call).not.toHaveBeenCalledWith('/dsh-mnemon-pack', 'storage-migrate', expect.anything())
  })

  it('keeps the custom directory when the default one is chosen again', async () => {
    // "Default" means memory stops using the custom directory; it never means
    // forgetting which one was chosen, or the choice could not be taken back.
    const mutate = vi.fn(async () => {})
    const scope = liveSettingsScope<Config>({ status: 'ready' as const, value: { storageScope: 'custom' as const, dataDir: '/old/data' }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const }, mutate)
    render(<MnemonSettingsCard scope={scope} connection={host({ '/dsh-mnemon-pack target': () => target }).connection} />)
    await waitFor(() => expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/old/data'))

    fireEvent.click(directoryChoice('默认'))
    // The field is gone from the page, but the value it held is still the draft's:
    // nothing was typed, so nothing is thrown away.
    expect(screen.queryByRole('textbox', { name: '数据目录' })).toBeNull()

    // Applying records the scope alone. The saved directory stays in the file, which is
    // what lets 自定义 put memory back on it without choosing it a second time.
    fireEvent.click(screen.getByRole('button', { name: '应用' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['storageScope'], value: 'global' }]))

    // The saved configuration publishes the new scope with the directory still in it,
    // so choosing 自定义 again finds the directory already there.
    await waitFor(() => expect(scope.snapshot.value).toEqual({ storageScope: 'global', dataDir: '/old/data' }))
    fireEvent.click(directoryChoice('自定义'))
    await waitFor(() => expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/old/data'))
  })

  it('says so when the picker is dismissed or the Host refuses the move', async () => {
    const { connection } = host({
      '/dsh-mnemon-pack target': () => target,
      '/dsh-mnemon-pack storage-plan': () => { throw new Error('the Mnemon data directory must not be a filesystem root') },
    })
    const scope = core({ storageScope: 'custom', dataDir: '/old/data' })
    render(<MnemonSettingsCard scope={scope} connection={connection} pickDirectory={vi.fn(async () => null)} />)
    await waitFor(() => expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/old/data'))

    // A dismissed picker leaves the draft alone.
    fireEvent.click(within(section()).getByRole('button', { name: '选择目录…' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((screen.getByRole('textbox', { name: '数据目录' }) as HTMLInputElement).value).toBe('/old/data')
  })
})
