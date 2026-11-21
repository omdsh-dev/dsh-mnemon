import { useCallback, useSyncExternalStore } from 'react'
import type { SlotScopeAdapter } from '@deepseek-ai/dsh-client-ui-slots'

export type MnemonSessionBinding = SlotScopeAdapter['current']

export function useMnemonSessionId(binding: MnemonSessionBinding): string | undefined {
  const subscribe = useCallback((listener: () => void) => binding.subscribe(listener), [binding])
  const getSnapshot = useCallback(() => binding.getSnapshot().key, [binding])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
