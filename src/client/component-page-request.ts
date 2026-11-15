/**
 * A request to open one component's page on the dsh-mnemon configuration
 * under Plugins, such as 技能管理's gear asking for its own settings. DSH opens
 * the bundle page; the configuration takes the request once it can name the
 * component, or at once when it is already on screen.
 */
export interface ComponentPageRequest {
  packageName: string
  section?: string | undefined
}

let pending: ComponentPageRequest | undefined
const listeners = new Set<() => void>()

/** Ask the configuration to open this component's page, by its package name, optionally targeting a section. */
export function requestComponentPage(packageName: string, section?: string): void {
  pending = section === undefined || section.trim() === '' ? { packageName } : { packageName, section: section.trim() }
  for (const listener of [...listeners]) listener()
}

/** The component page request asked for, taken once. */
export function takeComponentPageRequest(): ComponentPageRequest | undefined {
  const value = pending
  pending = undefined
  return value
}

/** The package whose page was asked for, taken once. */
export function takeComponentPage(): string | undefined {
  return takeComponentPageRequest()?.packageName
}

export function subscribeComponentPage(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
