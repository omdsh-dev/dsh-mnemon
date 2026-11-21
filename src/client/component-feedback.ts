import type { MemoryPluginEntryView, MemoryViewDashboard } from '../host/view-protocol.ts'
import { componentModel, layerOf } from './component-model.ts'
import type { MnemonKey, MnemonTranslate } from './locales.ts'
import { reconfiguredEntries, switchedEntries, type MnemonViewChange } from './view-store.ts'

export interface ChangeSummary {
  text: string
  tone: 'success' | 'warning' | 'info'
  targets: string[]
}

export function targetsOf(entry: MemoryPluginEntryView): string[] {
  if (entry.roles.includes('strategy')) return ['strategy']
  if (entry.roles.includes('strategy-extension')) return ['enhancement:' + entry.entryId]
  const layer = layerOf(entry)
  if (layer === undefined) return []
  return layer === 'memory-spaces' ? ['layer:' + layer, 'providers'] : ['layer:' + layer]
}

export function primaryOf(change: MnemonViewChange): string | undefined {
  const key = change.key ?? ''
  for (const prefix of ['component:', 'strategy:', 'options:']) if (key.startsWith(prefix)) return key.slice(prefix.length)
  return undefined
}

export function announces(change: MnemonViewChange): boolean {
  if (change.origin === 'external' || change.key?.startsWith('revert:') === true) return true
  if (reconfiguredEntries(change.before, change.after).length > 0) return true
  if (change.before.strategyTypeId !== change.after.strategyTypeId || switchedEntries(change.before, change.after).length !== 1) return true
  return componentModel(change.before).composing?.entryId !== componentModel(change.after).composing?.entryId
}

export function describeChange(before: MemoryViewDashboard, after: MemoryViewDashboard, origin: 'own' | 'external', name: (entry: MemoryPluginEntryView) => string, t: MnemonTranslate, primary?: string): ChangeSummary | undefined {
  const switched = switchedEntries(before, after)
  const reconfigured = reconfiguredEntries(before, after)
  if (switched.length === 0 && reconfigured.length === 0 && before.strategyTypeId === after.strategyTypeId) return undefined
  const was = componentModel(before)
  const now = componentModel(after)
  const targets = [...new Set(['overview', ...switched.flatMap(targetsOf), ...reconfigured.flatMap(targetsOf), ...(before.strategyTypeId === after.strategyTypeId ? [] : ['strategy'])])]
  const own = origin === 'own'
  const list = (entries: readonly MemoryPluginEntryView[]): string => entries.map(entry => t('config.quoted', { name: name(entry) })).join(t('config.listSeparator'))
  if (switched.length === 0 && before.strategyTypeId === after.strategyTypeId) {
    const component = reconfigured.length === 1 ? name(reconfigured[0]!) : undefined
    const text = component === undefined ? t(own ? 'feedback.several' : 'feedback.externalSeveral', { count: reconfigured.length })
      : t(own ? 'feedback.optionsSaved' : 'feedback.externalOptions', { component })
    return { text, tone: own ? 'success' : 'info', targets }
  }
  if (was.composing !== undefined && now.composing === undefined) return { text: t('feedback.memoryOff'), tone: 'warning', targets }
  if (was.composing === undefined && now.composing !== undefined) return { text: t('feedback.memoryRestored', { strategy: name(now.composing) }), tone: 'success', targets }
  if (now.composing !== undefined && now.composing !== now.selected && was.composing?.entryId !== now.composing.entryId) {
    return { text: now.selected === undefined ? t('feedback.fallbackMissing', { composing: name(now.composing) }) : t('feedback.fallback', { selected: name(now.selected), composing: name(now.composing) }), tone: 'warning', targets }
  }
  if (was.composing?.entryId !== now.composing?.entryId && now.composing !== undefined) {
    const strategy = name(now.composing)
    if (!own) return { text: t('feedback.externalMain', { strategy }), tone: 'info', targets }
    const others = switched.filter(entry => entry !== now.composing)
    const on = others.filter(entry => entry.enabled)
    const off = others.filter(entry => !entry.enabled)
    const text = on.length === 0 && off.length === 0 ? t('feedback.switchedMain', { strategy })
      : on.length === 0 ? t('feedback.switchedMainOff', { strategy, others: list(off) })
        : off.length === 0 ? t('feedback.switchedMainWith', { strategy, others: list(on) })
          : t('feedback.switchedMainMixed', { strategy, on: list(on), off: list(off) })
    return { text, tone: 'success', targets }
  }
  if (switched.length !== 1) {
    const lead = switched.find(entry => entry.entryId === primary)
    if (own && lead !== undefined) {
      const on = switched.filter(entry => entry !== lead && entry.enabled)
      const off = switched.filter(entry => entry !== lead && !entry.enabled)
      const component = name(lead)
      const text = !lead.enabled ? on.length === 0 ? t('feedback.disabledWith', { component, others: list(off) }) : undefined
        : off.length === 0 ? t('feedback.enabledWith', { component, others: list(on) })
          : on.length === 0 ? t('feedback.enabledReplacing', { component, others: list(off) })
            : t('feedback.enabledMixed', { component, on: list(on), off: list(off) })
      if (text !== undefined) return { text, tone: 'success', targets }
    }
    return { text: t(own ? 'feedback.several' : 'feedback.externalSeveral', { count: switched.length }), tone: own ? 'success' : 'info', targets }
  }
  const entry = switched[0]!
  const component = name(entry)
  if (entry.enabled && now.idle.includes(entry)) return { text: t('feedback.idleMain', { component }), tone: 'warning', targets }
  const source = layerOf(entry) !== undefined
  const key: MnemonKey = own
    ? source ? entry.enabled ? 'feedback.sourceOn' : 'feedback.sourceOff' : entry.enabled ? 'feedback.componentOn' : 'feedback.componentOff'
    : source ? entry.enabled ? 'feedback.externalSourceOn' : 'feedback.externalSourceOff' : entry.enabled ? 'feedback.externalComponentOn' : 'feedback.externalComponentOff'
  return { text: t(key, { component }), tone: own ? 'success' : 'info', targets }
}
