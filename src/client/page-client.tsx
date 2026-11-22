import { useContext, useMemo, type JSX, type ReactNode } from 'react'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'
import type { MnemonSourceManagementClient } from './source-contracts.ts'
import { I18nContext, LocaleContext, useLocalePreference } from './page-kit.tsx'
import { isBuiltInTranslate, translateFor, type MnemonTranslate } from './locales.ts'

export function MemorySourcePageFrame(props: { locale: string; children: ReactNode }): JSX.Element {
  const enclosing = useContext(I18nContext)
  const dictionary = translateFor(useLocalePreference(props.locale))
  const translate = useMemo<MnemonTranslate>(() => isBuiltInTranslate(enclosing) ? dictionary : (key, params) => {
    const text = enclosing(key, params)
    return text === key ? dictionary(key, params) : text
  }, [enclosing, dictionary])
  return <I18nContext.Provider value={translate}><LocaleContext.Provider value={props.locale}>{props.children}</LocaleContext.Provider></I18nContext.Provider>
}

export function createMemorySourcePageClient(management: MnemonSourceManagementClient) {
  let revision = management.revision
  let sequence = 0
  let accepted = 0
  async function request<T>(mode: 'read' | 'mutate' | 'assist', operation: string, input: MemoryJsonValue, confirmed = true, options?: { coalesce?: boolean }): Promise<T> {
    const ticket = ++sequence
    if (mode === 'assist' && !management.assistance?.operations.includes(operation)) throw new Error('Host assistance is unavailable for this Source instance: ' + operation)
    const result = mode === 'assist'
      ? await management.assistance!.execute(operation, input, { expectedRevision: revision, confirmed })
      : mode === 'read'
      ? await (options === undefined ? management.read(operation, input) : management.read(operation, input, options))
      : await management.mutate(operation, input, { confirmed: true, expectedRevision: revision })
    if (ticket >= accepted) { accepted = ticket; revision = result.revision }
    return result.value as T
  }
  return {
    canAssist: (operation: string) => management.assistance?.operations.includes(operation) === true,
    assist: <T,>(operation: string, input: MemoryJsonValue, confirmed: boolean) => request<T>('assist', operation, input, confirmed),
    read: <T,>(operation: string, input: MemoryJsonValue = null, options?: { coalesce?: boolean }) => request<T>('read', operation, input, true, options),
    mutate: <T,>(operation: string, input: MemoryJsonValue, confirmed: true) => {
      if (confirmed !== true) return Promise.reject<T>(new Error('Source page mutation requires explicit confirmation'))
      return request<T>('mutate', operation, input)
    },
  }
}
