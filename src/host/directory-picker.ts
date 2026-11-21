interface DirectoryPickerService {
  capability?(): { kind?: unknown; pick?: unknown }
}

export function hasNativeDirectoryPicker(ctx: { get(name: string): unknown }): boolean {
  try {
    const service = ctx.get('directoryPicker') as DirectoryPickerService | undefined
    const capability = service?.capability?.()
    return capability?.kind === 'native' && typeof capability.pick === 'function'
  } catch {
    return false
  }
}
