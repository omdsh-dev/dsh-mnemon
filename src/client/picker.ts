import type { MnemonClientContext } from './dsh-context.ts'

/** Opens the directory chooser the shell itself uses; a cancelled chooser answers `null`. */
export type MnemonDirectoryPicker = () => Promise<string | null>

interface DirectoryPickerService {
  pickDirectory(): Promise<string | null>
}

interface DesktopDirectoryPicker {
  pick?: () => Promise<string | null>
}

/**
 * The shell's own directory chooser, so a path is picked rather than typed.
 * The desktop build puts it on the global, the web build behind the
 * `uiWorkspace` service. That service stays a soft dependency: a shell without
 * the package must still load this client, so it is read on demand and never
 * declared in `inject`.
 */
export function directoryPicker(ctx: MnemonClientContext): MnemonDirectoryPicker {
  return async () => {
    const desktop = (globalThis as { __DSH_DIRECTORY_PICKER__?: DesktopDirectoryPicker }).__DSH_DIRECTORY_PICKER__
    if (desktop?.pick !== undefined) return await desktop.pick()
    const service = ctx.get('uiWorkspace') as DirectoryPickerService | undefined
    if (service !== undefined) return await service.pickDirectory()
    throw new Error('this interface has no directory chooser')
  }
}
