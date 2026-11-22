import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from 'react'
import type { MemoryPluginEntryView } from '../host/view-protocol.ts'
import { announces, describeChange, primaryOf } from './component-feedback.ts'
import { componentCopy } from './component-copy.ts'
import { locate, useToast } from './feedback.tsx'
import type { MnemonTranslate } from './locales.ts'
import { useLocalePreference } from './page-kit.tsx'
import type { MnemonViewState, MnemonViewStore } from './view-store.ts'

export function useViewFeedback(view: { store: MnemonViewStore; state: MnemonViewState }, root: RefObject<HTMLElement | null>, t: MnemonTranslate, language: string): ReactNode {
  const localePreference = useLocalePreference(language)
  const toast = useToast()
  const show = toast.show
  const name = useCallback((entry: MemoryPluginEntryView) => componentCopy(entry, localePreference).label, [localePreference])
  const { store, state } = view
  const seenChange = useRef(state.change?.seq ?? 0)
  useEffect(() => {
    const change = state.change
    if (change === null || change.seq === seenChange.current) return
    seenChange.current = change.seq
    if (!announces(change)) return
    const summary = describeChange(change.before, change.after, change.origin, name, t, primaryOf(change))
    if (summary === undefined) return
    locate(root.current, summary.targets.filter(target => target !== 'overview'))
    if (change.key?.startsWith('revert:') === true) {
      show({ text: t('feedback.undone'), tone: 'success' })
      return
    }
    show({
      text: summary.text,
      tone: summary.tone,
      actions: change.origin === 'own'
        ? [{ label: t('feedback.undo'), run: () => { void store.revert(change) } }]
        : [{ label: t('feedback.show'), run: () => locate(root.current, ['overview'], { scroll: true }) }],
    })
  }, [state.change, store, name, root, show, t])
  const seenFailure = useRef(state.failure?.seq ?? 0)
  useEffect(() => {
    const failure = state.failure
    if (failure === null || failure.seq === seenFailure.current) return
    seenFailure.current = failure.seq
    if (failure.kind === 'refresh') {
      show({ text: t('config.enhancementsRefreshFailed'), tone: 'warning' })
      return
    }
    const text = failure.key.startsWith('strategy:') ? t('config.strategyFailed') : t('feedback.failed')
    show({ text, tone: 'warning', actions: [{ label: t('feedback.retry'), run: () => { void store.retry() } }] })
  }, [state.failure, store, show, t])
  return toast.element
}
