import type { MemoryPluginEntryView, MemoryViewDashboard } from '../host/view-protocol.ts'

const SHIPPED_SOURCE_PREFIX = 'dsh-mnemon-source-'
const ANY_STRATEGY = '*'

export interface MemoryComponentModel {
  mains: MemoryPluginEntryView[]
  enhancements: MemoryPluginEntryView[]
  selected: MemoryPluginEntryView | undefined
  composing: MemoryPluginEntryView | undefined
  idle: MemoryPluginEntryView[]
  contenders: MemoryPluginEntryView[]
}

const running = (entry: MemoryPluginEntryView): boolean => entry.enabled && entry.active

export function componentModel(dashboard: MemoryViewDashboard): MemoryComponentModel {
  const mains = dashboard.entries.filter(entry => entry.roles.includes('strategy') && entry.typeId !== undefined)
  const enhancements = dashboard.entries.filter(entry => entry.roles.includes('strategy-extension'))
  const selected = mains.find(entry => entry.typeId === dashboard.strategyTypeId)
  const others = mains.filter(entry => entry !== selected && running(entry))
  const composing = selected !== undefined && running(selected) ? selected : others.length === 1 ? others[0] : undefined
  return {
    mains, enhancements, selected, composing,
    idle: composing === selected ? others : [],
    contenders: composing === undefined && others.length > 1 ? others : [],
  }
}

export function layerOf(entry: MemoryPluginEntryView): string | undefined {
  if (!entry.roles.includes('source')) return undefined
  if (entry.typeId !== undefined) return entry.typeId
  return entry.packageName.startsWith(SHIPPED_SOURCE_PREFIX) ? entry.packageName.slice(SHIPPED_SOURCE_PREFIX.length) : undefined
}

export function sourceOf(dashboard: MemoryViewDashboard, layerId: string): MemoryPluginEntryView | undefined {
  const sources = dashboard.entries.filter(entry => entry.roles.includes('source'))
  return sources.find(entry => entry.typeId === layerId) ?? sources.find(entry => layerOf(entry) === layerId)
}

function provides(entry: MemoryPluginEntryView, capability: string): boolean {
  return entry.provides.some(value => value.id === capability)
}

function implicitCapabilities(dashboard: MemoryViewDashboard): Set<string> {
  const managed = new Set(dashboard.entries.map(entry => entry.packageName))
  return new Set(dashboard.sources.filter(source => !managed.has(source.packageName)).flatMap(source => ['source', 'source.' + source.role]))
}

export type SwitchPlan =
  | { changes: SwitchChange[]; blocked?: undefined }
  | { changes?: undefined; blocked: 'last-source' }

export interface SwitchChange {
  entry: MemoryPluginEntryView
  enabled: boolean
  reason?: 'needed' | 'conflict' | 'dependent'
}

export function conflicts(left: MemoryPluginEntryView, right: MemoryPluginEntryView): boolean {
  if (left === right) return false
  const claimed = left.provides.some(capability => right.provides.some(other => other.id === capability.id && (capability.exclusive || other.exclusive)))
  if (claimed) return true
  if (left.slot === undefined || left.slot !== right.slot || !left.roles.includes('strategy-extension') || !right.roles.includes('strategy-extension')) return false
  const [one, two] = [left.strategyTypeId ?? ANY_STRATEGY, right.strategyTypeId ?? ANY_STRATEGY]
  return one === two || one === ANY_STRATEGY || two === ANY_STRATEGY
}

export function planSwitches(dashboard: MemoryViewDashboard, asked: ReadonlyArray<{ entry: MemoryPluginEntryView; enabled: boolean }>): SwitchPlan {
  const state = new Map(dashboard.entries.map(entry => [entry.entryId, entry.enabled]))
  const implicit = implicitCapabilities(dashboard)
  const reasons = new Map<string, SwitchChange['reason']>()
  const wanted = new Map(asked.map(({ entry, enabled }) => [entry.entryId, enabled]))
  const on = (entry: MemoryPluginEntryView): boolean => state.get(entry.entryId) === true
  const set = (entry: MemoryPluginEntryView, enabled: boolean, reason?: SwitchChange['reason']): void => {
    state.set(entry.entryId, enabled)
    if (reason !== undefined && !wanted.has(entry.entryId)) reasons.set(entry.entryId, reason)
  }
  const turnedOn: MemoryPluginEntryView[] = []
  for (const { entry, enabled } of asked) {
    set(entry, enabled)
    if (enabled) turnedOn.push(entry)
  }
  for (let index = 0; index < turnedOn.length; index += 1) {
    const entry = turnedOn[index]!
    for (const other of dashboard.entries) {
      if (on(other) && wanted.get(other.entryId) !== true && conflicts(entry, other)) set(other, false, 'conflict')
    }
    for (const requirement of entry.requires) {
      if (implicit.has(requirement) || dashboard.entries.some(candidate => on(candidate) && provides(candidate, requirement))) continue
      const provider = dashboard.entries.find(candidate => !on(candidate) && candidate.writable && wanted.get(candidate.entryId) !== false
        && provides(candidate, requirement) && !dashboard.entries.some(other => on(other) && conflicts(candidate, other)))
      if (provider === undefined) continue
      set(provider, true, 'needed')
      turnedOn.push(provider)
    }
  }
  const metBefore = (requirement: string): boolean => implicit.has(requirement) || dashboard.entries.some(candidate => candidate.enabled && provides(candidate, requirement))
  const metNow = (requirement: string): boolean => implicit.has(requirement) || dashboard.entries.some(candidate => on(candidate) && provides(candidate, requirement))
  for (let moved = true; moved;) {
    moved = false
    for (const entry of dashboard.entries) {
      if (!on(entry) || !entry.enabled || !entry.requires.some(requirement => metBefore(requirement) && !metNow(requirement))) continue
      if (entry.roles.includes('strategy')) return { blocked: 'last-source' }
      set(entry, false, 'dependent')
      moved = true
    }
  }
  const changes = dashboard.entries.flatMap((entry): SwitchChange[] => {
    const enabled = state.get(entry.entryId)!
    if (enabled === entry.enabled && !wanted.has(entry.entryId)) return []
    const reason = reasons.get(entry.entryId)
    return [{ entry, enabled, ...(reason === undefined ? {} : { reason }) }]
  })
  return { changes }
}

export function switchPlan(dashboard: MemoryViewDashboard, entry: MemoryPluginEntryView, enabled: boolean): SwitchPlan {
  return planSwitches(dashboard, [{ entry, enabled }])
}

export function mainPlan(dashboard: MemoryViewDashboard, entry: MemoryPluginEntryView): SwitchPlan {
  const others = dashboard.entries.filter(other => other !== entry && other.enabled && other.roles.includes('strategy') && other.typeId !== undefined)
  return planSwitches(dashboard, [{ entry, enabled: true }, ...others.map(other => ({ entry: other, enabled: false }))])
}

export interface ComponentRelations {
  needs: Array<{ requirement: string; providers: MemoryPluginEntryView[]; met: boolean }>
  neededBy: MemoryPluginEntryView[]
  conflictsWith: MemoryPluginEntryView[]
}

export function relationsOf(dashboard: MemoryViewDashboard, entry: MemoryPluginEntryView): ComponentRelations {
  const implicit = implicitCapabilities(dashboard)
  return {
    needs: entry.requires.map(requirement => {
      const providers = dashboard.entries.filter(candidate => candidate !== entry && provides(candidate, requirement))
      return { requirement, providers, met: implicit.has(requirement) || providers.some(candidate => candidate.enabled) }
    }),
    neededBy: !entry.enabled ? [] : dashboard.entries.filter(candidate => candidate !== entry && candidate.enabled && candidate.requires.some(requirement => provides(entry, requirement)
      && !implicit.has(requirement) && !dashboard.entries.some(other => other !== entry && other.enabled && provides(other, requirement)))),
    conflictsWith: dashboard.entries.filter(candidate => conflicts(entry, candidate)),
  }
}

export interface UnmetRequirement {
  requirement: string
  providers: MemoryPluginEntryView[]
}

export function unmetRequirements(dashboard: MemoryViewDashboard, entry: MemoryPluginEntryView): UnmetRequirement[] {
  const implicit = implicitCapabilities(dashboard)
  return entry.requires.flatMap(requirement => implicit.has(requirement) || dashboard.entries.some(candidate => candidate.enabled && provides(candidate, requirement))
    ? []
    : [{ requirement, providers: dashboard.entries.filter(candidate => !candidate.enabled && provides(candidate, requirement)) }])
}

export function enhancementApplies(entry: MemoryPluginEntryView, composing: MemoryPluginEntryView | undefined): boolean {
  return composing !== undefined && (entry.strategyTypeId === undefined || entry.strategyTypeId === ANY_STRATEGY || entry.strategyTypeId === composing.typeId)
}
