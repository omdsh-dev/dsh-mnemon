import type { MemoryPluginChangePlan, MemoryPluginEntryView } from './view-protocol.ts'

/** Plan only from public descriptors. No factories, Source IO or Loader mutations. */
export function planMemoryPluginChange(catalog: { revision: string; writable: boolean; entries: MemoryPluginEntryView[] }, strategyTypeId: string, entryId: string, enabled: boolean): MemoryPluginChangePlan {
  if (!catalog.writable) throw new Error('Memory plugin configuration is read-only')
  const entries = new Map(catalog.entries.map(entry => [entry.entryId, entry]))
  const requested = entries.get(entryId)
  if (!requested) throw new Error('Unknown memory plugin Entry')
  if (!enabled && requested.roles.includes('strategy') && requested.typeId === strategyTypeId) throw new Error('Select another composition Strategy before disabling the current Strategy')
  const choices = new Map(catalog.entries.map(entry => [entry.entryId, entry.enabled]))
  const reasons = new Map<string, MemoryPluginChangePlan['changes'][number]['reason']>()
  const added = new Set<string>()
  function set(entry: MemoryPluginEntryView, value: boolean, reason: MemoryPluginChangePlan['changes'][number]['reason']) {
    if (choices.get(entry.entryId) === value) return
    if (!entry.writable) throw new Error('Required plugin change is read-only: ' + entry.packageName)
    choices.set(entry.entryId, value)
    reasons.set(entry.entryId, reason)
  }
  function ensure(entry: MemoryPluginEntryView, reason: MemoryPluginChangePlan['changes'][number]['reason'], path: Set<string>) {
    if (path.has(entry.entryId)) throw new Error('Circular plugin requirements: ' + entry.packageName)
    const nextPath = new Set([...path, entry.entryId])
    set(entry, true, reason); added.add(entry.entryId)
    if (entry.roles.includes('strategy')) {
      if (!entry.typeId) throw new Error('Plugin does not expose a composition Strategy identifier')
      strategyTypeId = entry.typeId
      for (const other of catalog.entries) {
        if (other.entryId !== entry.entryId && (other.roles.includes('strategy') || other.roles.includes('strategy-extension') && other.strategyTypeId !== entry.typeId)) set(other, false, 'strategy-change')
      }
    }
    for (const requirement of entry.requires) {
      const providers = catalog.entries.filter(candidate => candidate.provides.some(capability => capability.id === requirement))
      const present = providers.find(provider => choices.get(provider.entryId))
      if (present) {
        if (requirement !== 'strategy' && present.roles.includes('strategy') && present.typeId !== strategyTypeId) ensure(present, 'requirement', nextPath)
        continue
      }
      if (providers.length !== 1) throw new Error(providers.length ? 'Choose a provider for the ambiguous requirement: ' + requirement : 'Install a plugin that provides: ' + requirement)
      ensure(providers[0]!, 'requirement', nextPath)
    }
  }
  if (enabled) ensure(requested, 'requested', new Set())
  else set(requested, false, 'requested')
  for (let pass = 0; pass <= catalog.entries.length; pass++) {
    let changed = false
    for (const entry of catalog.entries) {
      if (!choices.get(entry.entryId)) continue
      const missing = entry.requires.find(requirement => !catalog.entries.some(provider => choices.get(provider.entryId) && provider.provides.some(capability => capability.id === requirement)))
      if (!missing) continue
      if (added.has(entry.entryId) || entry.roles.includes('strategy') && entry.typeId === strategyTypeId) throw new Error('The selected composition requires: ' + missing)
      set(entry, false, 'dependent'); changed = true
    }
    if (!changed) break
  }
  const changes = catalog.entries.filter(entry => entry.enabled !== choices.get(entry.entryId)).map(entry => ({ entryId: entry.entryId, label: entry.label, enabled: choices.get(entry.entryId)!, reason: reasons.get(entry.entryId)! }))
  return { configuration: { expectedRevision: catalog.revision, strategyTypeId, entries: Object.fromEntries(changes.map(change => [change.entryId, { enabled: change.enabled, config: structuredClone(entries.get(change.entryId)!.config) }])) }, changes }
}
