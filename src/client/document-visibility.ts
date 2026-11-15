import { useSyncExternalStore } from 'react'
import { documentVisibilityStore } from './shared/store.ts'

/** A selected panel in a background browser tab is still an inactive reader. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(documentVisibilityStore.subscribe, documentVisibilityStore.getSnapshot, () => true)
}
