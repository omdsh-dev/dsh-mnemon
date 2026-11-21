export interface ComponentPageRequest {
  packageName: string
  section?: string | undefined
}

let pending: ComponentPageRequest | undefined
const listeners = new Set<() => void>()

export function requestComponentPage(packageName: string, section?: string): void {
  pending = section === undefined || section.trim() === '' ? { packageName } : { packageName, section: section.trim() }
  for (const listener of [...listeners]) listener()
}

export function takeComponentPageRequest(): ComponentPageRequest | undefined {
  const value = pending
  pending = undefined
  return value
}

export function takeComponentPage(): string | undefined {
  return takeComponentPageRequest()?.packageName
}

export function subscribeComponentPage(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
