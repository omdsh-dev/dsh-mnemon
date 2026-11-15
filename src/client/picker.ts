import type { MnemonClientContext } from './dsh-context.ts'
import { isRemoteConnection } from './remote-rpc.ts'

/** The optional legacy public DSH workspace UI service; cancellation returns null. */
interface DirectoryPickerService {
  pickDirectory?(): Promise<string | null>
}

export interface DirectoryPickerListingEntry {
  name: string
  path: string
}

export interface DirectoryPickerListing {
  path: string
  parent?: string | null
  entries?: readonly DirectoryPickerListingEntry[]
  directories?: readonly DirectoryPickerListingEntry[]
  ancestors?: readonly unknown[]
  truncated?: boolean
}

export type DirectoryPickerMode = 'native' | 'browse' | 'disabled' | string

type RemoteCallOutcome<T> =
  | T
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message?: string; readonly code?: string } }

/** Official DSH 0.2.1+ `ctx.remote.directoryPicker` Typert service (plus optional `pickNative` / `mode` helpers). */
export interface RemoteDirectoryPicker {
  mode?(): Promise<RemoteCallOutcome<DirectoryPickerMode>> | DirectoryPickerMode
  pick?(signal?: AbortSignal): Promise<RemoteCallOutcome<string | null | { path?: string | null; cancelled?: boolean }>>
  pickNative?(signal?: AbortSignal): Promise<RemoteCallOutcome<string | null | { path?: string | null; cancelled?: boolean }>>
  list?(path?: string, signal?: AbortSignal): Promise<RemoteCallOutcome<DirectoryPickerListing>>
  createDirectory?(parentPath: string, name: string): Promise<RemoteCallOutcome<{ path: string } | string>>
}

export interface MnemonDirectoryPicker {
  available(): boolean
  pick(): Promise<string | null>
  mode?(): Promise<DirectoryPickerMode>
  list?(path?: string): Promise<DirectoryPickerListing>
  createDirectory?(parentPath: string, name: string): Promise<string>
}

type PickerContext = Pick<MnemonClientContext, 'get' | 'connection'> & {
  remote?: { directoryPicker?: RemoteDirectoryPicker }
}

const MNEMON_PICKER_CHANNEL = 'mnemon/picker'

function isRemoteResultEnvelope<T>(value: RemoteCallOutcome<T>): value is { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message?: string; readonly code?: string } } {
  return typeof value === 'object' && value !== null && 'ok' in value && typeof (value as { ok?: unknown }).ok === 'boolean'
}

function unwrapRemoteOutcome<T>(outcome: RemoteCallOutcome<T>, fallbackError: string): T {
  if (!isRemoteResultEnvelope(outcome)) return outcome
  if (outcome.ok) return outcome.value
  throw new Error(outcome.error?.message ?? fallbackError)
}

function normalizeNativePickResult(result: string | null | { path?: string | null; cancelled?: boolean }): string | null {
  if (result === null || typeof result === 'string') return result
  if (result.cancelled === true) return null
  return typeof result.path === 'string' ? result.path : null
}

/**
 * Resolve DSH 0.2.1+ `remote.directoryPicker` first when present, falling back
 * to `uiWorkspace.pickDirectory` or legacy `mnemon/picker` RPC on `0.2.0-rc.2`.
 */
export function directoryPicker(ctx: PickerContext): MnemonDirectoryPicker {
  const directRemotePicker = (): RemoteDirectoryPicker | undefined => {
    try {
      const fromCtx = ctx.remote?.directoryPicker
      if (fromCtx !== undefined) return fromCtx
    } catch {
      // Cordis 4 context proxies throw when reading un-injected service properties; fall through to ctx.get('remote').
    }
    return (ctx.connection as { remote?: { directoryPicker?: RemoteDirectoryPicker } } | undefined)?.remote?.directoryPicker
  }
  const workspaceService = (): DirectoryPickerService | undefined => ctx.get('uiWorkspace') as DirectoryPickerService | undefined
  const remotePicker = (): RemoteDirectoryPicker | undefined => {
    const direct = directRemotePicker()
    if (direct !== undefined) return direct
    const fromGet = ctx.get('remote') as { directoryPicker?: RemoteDirectoryPicker } | undefined
    return fromGet?.directoryPicker
  }
  const hasRemotePick = (picker: RemoteDirectoryPicker | undefined): boolean =>
    typeof picker?.pickNative === 'function' || typeof picker?.pick === 'function'
  const invokeRemotePick = async (picker: RemoteDirectoryPicker): Promise<string | null> => {
    if (typeof picker.mode === 'function') {
      const currentMode = unwrapRemoteOutcome(await picker.mode(), 'Directory chooser is unavailable')
      if (currentMode !== 'native') throw new Error('Directory chooser is unavailable')
    }
    const raw = typeof picker.pickNative === 'function'
      ? await picker.pickNative()
      : await picker.pick!()
    return normalizeNativePickResult(unwrapRemoteOutcome(raw, 'Directory chooser failed'))
  }
  const callFallbackPickerRpc = async <T>(endpoint: string, payload: Record<string, unknown> = {}): Promise<T> => {
    const call = (ctx.connection as { rpc?: { call?: (channel: string, endpoint: string, payload: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { message?: string } }> } } | undefined)?.rpc?.call
    if (typeof call !== 'function') throw new Error('Directory chooser is unavailable')
    const response = await call(MNEMON_PICKER_CHANNEL, endpoint, payload)
    if (!response.ok) throw new Error(response.error?.message ?? 'Directory chooser failed')
    return response.value as T
  }

  return {
    available: () => {
      try {
        if (isRemoteConnection(ctx.connection)) return false
        if (hasRemotePick(directRemotePicker())) return true
        if (typeof workspaceService()?.pickDirectory === 'function') return true
        return hasRemotePick(remotePicker())
      } catch {
        return false
      }
    },
    pick: async () => {
      if (isRemoteConnection(ctx.connection)) throw new Error('Directory chooser is unavailable')
      const direct = directRemotePicker()
      if (direct !== undefined && hasRemotePick(direct)) {
        return await invokeRemotePick(direct)
      }
      const workspace = workspaceService()
      if (typeof workspace?.pickDirectory === 'function') {
        return await workspace.pickDirectory()
      }
      const viaGetRemote = remotePicker()
      if (viaGetRemote !== undefined && hasRemotePick(viaGetRemote)) {
        return await invokeRemotePick(viaGetRemote)
      }
      const fallback = await callFallbackPickerRpc<string | null | { path?: string | null; cancelled?: boolean }>('pick')
      return normalizeNativePickResult(fallback)
    },
    mode: async () => {
      const remote = remotePicker()
      if (typeof remote?.mode === 'function') {
        return unwrapRemoteOutcome(await remote.mode(), 'Directory chooser is unavailable')
      }
      if (!isRemoteConnection(ctx.connection) && (hasRemotePick(remote) || typeof workspaceService()?.pickDirectory === 'function')) {
        return 'native'
      }
      if (typeof remote?.list === 'function') return 'browse'
      try {
        const fallback = await callFallbackPickerRpc<{ mode?: DirectoryPickerMode } | DirectoryPickerMode>('mode')
        return typeof fallback === 'string' ? fallback : (fallback?.mode ?? 'disabled')
      } catch {
        return 'disabled'
      }
    },
    list: async (path?: string) => {
      const remote = remotePicker()
      if (typeof remote?.list === 'function') {
        return unwrapRemoteOutcome(await remote.list(path), 'Could not list directory')
      }
      return await callFallbackPickerRpc<DirectoryPickerListing>('list', path === undefined ? {} : { path })
    },
    createDirectory: async (parentPath: string, name: string) => {
      const remote = remotePicker()
      if (typeof remote?.createDirectory === 'function') {
        const created = unwrapRemoteOutcome(await remote.createDirectory(parentPath, name), 'Could not create directory')
        return typeof created === 'string' ? created : created.path
      }
      const created = await callFallbackPickerRpc<{ path: string } | string>('mkdir', { parentPath, name })
      return typeof created === 'string' ? created : created.path
    },
  }
}
