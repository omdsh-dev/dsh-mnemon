import { useSyncExternalStore } from 'react'
import { documentVisibilityStore } from './shared/store.ts'

export function useDocumentVisible(): boolean {
  return useSyncExternalStore(documentVisibilityStore.subscribe, documentVisibilityStore.getSnapshot, () => true)
}
