import { useSyncExternalStore } from 'react'

const visible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden'
const subscribe = (listener: () => void): (() => void) => {
  document.addEventListener('visibilitychange', listener)
  return () => { document.removeEventListener('visibilitychange', listener) }
}

/** A selected panel in a background browser tab is still an inactive reader. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, visible, () => true)
}
