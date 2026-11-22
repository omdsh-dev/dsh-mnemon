import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { mnemonLocales, type MnemonKey } from './locales.ts'
import { localeFallbackChain, resolveMnemonLocale } from './localized-text.ts'

export function registerMnemonLocales(locale: Pick<LocaleRuntime, 'register' | 'getSnapshot'>): () => void {
  let snapshot: ReturnType<LocaleRuntime['getSnapshot']> | undefined
  let fallback: Record<MnemonKey, string> | undefined
  const withBundledFallback = (dictionary: Record<MnemonKey, string>) => new Proxy(dictionary, {
    get(legacy, key) {
      if (typeof key !== 'string' || !Object.hasOwn(legacy, key)) return Reflect.get(legacy, key)
      const current = locale.getSnapshot()
      if (snapshot !== current) {
        snapshot = current
        const bundled = resolveMnemonLocale(localeFallbackChain(current))
        fallback = bundled === 'en' || bundled === 'zh' ? undefined : mnemonLocales[bundled]
      }
      return fallback?.[key] ?? legacy[key]
    },
  })
  return locale.register('mnemon', { en: withBundledFallback(mnemonLocales.en), zh: withBundledFallback(mnemonLocales.zh) })
}
