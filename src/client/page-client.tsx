import type { JSX, ReactNode } from 'react'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import type { MnemonSourceManagementClient } from './source-contracts.ts'
import { I18nContext, LocaleContext } from './page-kit.tsx'
import { translateEn, translateZh } from './locales.ts'

/** Optional default presentation kit; custom pages may use their own UI. */
export function MemorySourcePageFrame(props: { locale: string; children: ReactNode }): JSX.Element {
  const translate = props.locale.startsWith('en') ? translateEn : translateZh
  return <I18nContext.Provider value={translate}><LocaleContext.Provider value={props.locale}>{props.children}</LocaleContext.Provider></I18nContext.Provider>
}

/** Track revisions returned by reads as well as writes; never retry a conflict. */
export function createMemorySourcePageClient(management: MnemonSourceManagementClient) {
  let revision = management.revision
  let sequence = 0
  let accepted = 0
  async function request<T>(mode: 'read' | 'mutate', operation: string, input: MemoryJsonValue): Promise<T> {
    const ticket = ++sequence
    const result = mode === 'read'
      ? await management.read(operation, input)
      : await management.mutate(operation, input, { confirmed: true, expectedRevision: revision })
    if (ticket >= accepted) { accepted = ticket; revision = result.revision }
    return result.value as T
  }
  return {
    read: <T,>(operation: string, input: MemoryJsonValue = null) => request<T>('read', operation, input),
    mutate: <T,>(operation: string, input: MemoryJsonValue, confirmed: true) => {
      if (confirmed !== true) return Promise.reject<T>(new Error('Source page mutation requires explicit confirmation'))
      return request<T>('mutate', operation, input)
    },
  }
}
