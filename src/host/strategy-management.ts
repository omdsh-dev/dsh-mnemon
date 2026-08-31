import { createHash } from 'node:crypto'
import z from 'schemastery'
import type { MemoryJsonValue, MemoryOperationScope } from '../core/contracts/index.ts'
import { DEFAULT_MEMORY_VIEW_BUDGET } from '../core/contracts/index.ts'
import { MemoryCompositionGeneration, captureMemoryContributionSnapshot } from '../core/composition.ts'
import { prepareMemoryContributions, type MemoryContributionSnapshot } from '../core/contributions.ts'
import { canonicalMemoryJson } from '../core/definitions.ts'
import type { MemoryRuntime } from '../core/runtime.ts'
import type { MemoryStrategyConfiguration } from '../sdk/strategy-configuration.ts'
import type { HostContextShape, HostSettingsScope } from './dsh.ts'
import type { ResolvedConfig } from './config.ts'
import { memoryGenerationOptions } from './runtime.ts'
import { inspectMemoryView } from './view-presentation.ts'
import { MNEMON_VIEW_SETTINGS_NAMESPACE, type MemoryStrategyEntryView, type MemoryStrategyPreference, type MemoryViewConfigurationRequest, type MemoryViewPreferences } from './view-protocol.ts'

/** Deliberately excludes Loader.write(): package/generated YAML must not be edited. */
export interface StrategyLoaderEntry {
  id: string
  disabled: boolean
  options: { id: string; name: string; disabled?: unknown; config?: unknown; group?: unknown }
  fiber?: { runtime?: { callback?: unknown }; await?(): Promise<unknown> }
  parent: { tree: { import(name: string): Promise<unknown> | unknown }; ctx?: { fiber?: { entry?: { disabled: boolean } } } }
  update(options: { disabled?: boolean | null; config?: unknown }): Promise<void>
}
export interface StrategyLoader { entries(): Iterable<StrategyLoaderEntry>; config?: { baseUrl?: string }; context?: { baseUrl?: string } }
interface ManagedEntry { entry: StrategyLoaderEntry; definition: MemoryStrategyConfiguration; value: MemoryStrategyEntryView }

const schema: z<MemoryViewPreferences> = z.object({
  strategyTypeId: z.string(),
  entries: z.dict(z.object({ enabled: z.boolean(), config: z.dict(z.any()).default({}) })).default({}),
})
const PACKAGE = /^(?:@[a-z0-9._-]+\/)?dsh-mnemon-strategy-[a-z0-9._-]+$/u
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,299}$/u
const hash = (value: unknown) => createHash('sha256').update(canonicalMemoryJson(value)).digest('hex')
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function record(value: unknown): Record<string, MemoryJsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Strategy configuration must be an object')
  const json = JSON.stringify(value)
  if (json.length > 64 * 1024) throw new Error('Strategy configuration exceeds 64 KiB')
  const parsed = JSON.parse(json) as Record<string, MemoryJsonValue>
  for (const key of Object.keys(parsed)) if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe Strategy configuration key')
  return parsed
}

function preferences(value: MemoryViewPreferences): MemoryViewPreferences {
  if (value.strategyTypeId !== undefined && !/^[a-z][a-z0-9-]{0,127}$/u.test(value.strategyTypeId)) throw new Error('Invalid Strategy type id')
  const entries = record(value.entries ?? {})
  if (Object.keys(entries).length > 32) throw new Error('At most 32 Strategy Entries can be configured')
  for (const [id, item] of Object.entries(entries)) {
    if (!ID.test(id)) throw new Error('Invalid Strategy Entry id')
    const candidate = record(item)
    if (typeof candidate.enabled !== 'boolean') throw new Error('Strategy enabled must be boolean')
    record(candidate.config)
  }
  return clone(value)
}

function configuration(definition: MemoryStrategyConfiguration, input: unknown): Record<string, MemoryJsonValue> {
  const config = record(input ?? {})
  const fields = new Map(definition.fields.map(field => [field.key, field]))
  for (const [key, value] of Object.entries(config)) {
    const field = fields.get(key)
    if (!field) throw new Error(`Strategy field is not declared for management: ${key}`)
    if (field.input === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)
        || field.minimum !== undefined && value < field.minimum || field.maximum !== undefined && value > field.maximum) throw new Error(`Invalid numeric Strategy field: ${key}`)
    } else if (field.input === 'source-list' || field.input === 'string-list') {
      if (!Array.isArray(value) || value.length > 32 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 500) || new Set(value).size !== value.length) throw new Error(`Invalid Strategy list: ${key}`)
    } else if (typeof value !== 'string' || value.length > (field.maximum ?? 4000)) throw new Error(`Invalid Strategy text: ${key}`)
  }
  return config
}

function validatePresentation(definition: MemoryStrategyConfiguration): void {
  const text = (value: unknown) => typeof value === 'object' && value !== null && ['en', 'zh-CN'].every(key => {
    const item = (value as Record<string, unknown>)[key]
    return typeof item === 'string' && item.length <= 4000
  })
  if (!text(definition.label) || !text(definition.description) || definition.fields.some(field => !text(field.label)
    || field.description !== undefined && !text(field.description)
    || [field.minimum, field.maximum].some(bound => bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound)))
    || field.sourceRoles !== undefined && (!Array.isArray(field.sourceRoles) || field.sourceRoles.length > 32
      || field.sourceRoles.some(role => typeof role !== 'string' || !role || role.length > 128)))) throw new Error('Invalid Strategy editor presentation metadata')
  // Bound the display payload as well as saved values. One malformed editor
  // must not make the entire dashboard unserializable or crash React.
  const json = canonicalMemoryJson({ label: definition.label, description: definition.description, fields: definition.fields }, 'Strategy editor metadata')
  if (json.length > 64 * 1024) throw new Error('Strategy editor metadata exceeds 64 KiB')
  for (const field of definition.fields) if (field.defaultValue !== undefined) configuration(definition, { [field.key]: field.defaultValue })
}

function prepared(item: ManagedEntry, config: Record<string, MemoryJsonValue>) {
  const contribution = item.definition.create(configuration(item.definition, config))
  if (contribution.sources?.length) throw new Error('A managed Strategy factory cannot register Sources')
  const values = [...(contribution.strategies ?? []), ...(contribution.strategyExtensions ?? [])]
  if (values.length !== 1 || values[0]!.manifest.typeId !== item.definition.typeId || values[0]!.manifest.kind !== item.definition.kind
    || values[0]!.manifest.packageName !== item.entry.options.name) throw new Error('Strategy factory does not match its declared Entry')
  return prepareMemoryContributions(contribution, { instanceId: item.entry.id })
}

/**
 * A Profile-local user overlay, persisted by DSH settings. Loader Entries are
 * the live authority; this class never owns an alternate plugin registry.
 */
export class MemoryStrategyManagement {
  readonly settingsNamespace: string
  private readonly settings: HostSettingsScope<MemoryViewPreferences>
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private restoreError: string | undefined
  private discoveryWarnings: string[] = []
  private changingEntries = false

  constructor(private readonly ctx: HostContextShape, private readonly engine: MemoryRuntime) {
    // DSH's settings document is home-wide; a Loader's resolution anchor is
    // Profile-specific and stable across restarts. Do not share Entry overrides
    // merely because two Profiles use the same short Entry ids.
    const loader = this.loader()
    const anchor = loader?.config?.baseUrl ?? loader?.context?.baseUrl
    this.settingsNamespace = anchor ? `${MNEMON_VIEW_SETTINGS_NAMESPACE}-${hash(anchor).slice(0, 16)}` : MNEMON_VIEW_SETTINGS_NAMESPACE
    this.settings = ctx.settings.register<MemoryViewPreferences>(this.settingsNamespace, schema, {
      base: { entries: {} }, applies: 'live', validate: value => { preferences(value) },
    })
  }

  resolveConfig(config: ResolvedConfig): ResolvedConfig {
    const selected = this.settings.get().strategyTypeId
    return selected === undefined ? config : { ...config, memoryTopology: { ...config.memoryTopology, strategyId: selected } }
  }

  start(): () => void {
    const schedule = () => {
      if (this.closed || this.changingEntries || this.timer || !Object.keys(this.settings.get().entries ?? {}).length) return
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.exclusive(() => this.restore()).catch(error => { this.restoreError = error instanceof Error ? error.message : String(error) })
      }, 0)
    }
    const stops = [this.ctx.on('loader/entry-init', schedule), this.ctx.on('loader/partial-dispose', schedule),
      this.ctx.on('settings/updated', ((namespace: string) => { if (namespace === this.settingsNamespace) schedule() }) as never)]
    schedule()
    return () => { this.closed = true; clearTimeout(this.timer); for (const stop of stops.reverse()) stop() }
  }

  private loader(): StrategyLoader | undefined {
    const candidate = this.ctx.get('loader') as Partial<StrategyLoader> | undefined
    return candidate && typeof candidate.entries === 'function' ? candidate as StrategyLoader : undefined
  }

  private settingsRevision(): number {
    return this.ctx.settings.describe({ redactSecrets: true }).find(value => value.ns === this.settingsNamespace)?.revision ?? 0
  }

  private async managed(): Promise<ManagedEntry[]> {
    const loader = this.loader()
    if (!loader) return []
    const installed = this.engine.contributionSnapshot()
    const result: ManagedEntry[] = []
    const warnings: string[] = []
    for (const entry of loader.entries()) {
      if (entry.options.group || !PACKAGE.test(entry.options.name)) continue
      try {
        let module = entry.fiber?.runtime?.callback as { memoryStrategyConfiguration?: MemoryStrategyConfiguration } | undefined
        if (!module?.memoryStrategyConfiguration) module = await entry.parent.tree.import(entry.options.name) as typeof module
        const definition = module?.memoryStrategyConfiguration
        if (!definition || definition.apiVersion !== 'dsh-mnemon/strategy-configuration/v1' || typeof definition.create !== 'function') continue
        if (installed.sources.some(source => source.provenance.entryId === entry.id)) throw new Error('This Entry also owns Sources; manage its lifecycle through DSH.')
        if (!Array.isArray(definition.fields) || definition.fields.length > 16
          || new Set(definition.fields.map(field => field.key)).size !== definition.fields.length
          || definition.fields.some(field => !/^[a-zA-Z][a-zA-Z0-9]{0,99}$/u.test(field.key) || !['number', 'text', 'textarea', 'string-list', 'source-list'].includes(field.input))) throw new Error('Invalid Strategy configuration descriptor')
        validatePresentation(definition)
        const publicConfig = configuration(definition, entry.options.config)
        const contribution = [...installed.strategies, ...(installed.strategyExtensions ?? [])].find(value => value.provenance.entryId === entry.id)
        const manifest = contribution?.definition.manifest
        const ancestorDisabled = entry.parent.ctx?.fiber?.entry?.disabled === true
        const writable = this.ctx.settings.writable && !ancestorDisabled && (entry.options.disabled === undefined || typeof entry.options.disabled === 'boolean')
        const value: MemoryStrategyEntryView = {
          entryId: entry.id, packageName: entry.options.name, typeId: definition.typeId, kind: definition.kind,
          label: definition.label, description: definition.description, fields: definition.fields, config: publicConfig,
          enabled: !entry.disabled, active: contribution !== undefined, writable,
          ...(manifest?.kind === 'strategy-extension' ? { strategyTypeId: manifest.strategyTypeId, slot: manifest.slot } : {}),
          ...(ancestorDisabled ? { diagnostic: 'This Entry is disabled by its parent.' } : {}),
        }
        const managed = { entry, definition, value }
        // Even disabled Entries have discoverable target/slot metadata, without mounting.
        const candidate = prepared(managed, publicConfig)
        const extension = candidate.strategyExtensions?.[0]?.definition.manifest
        if (extension) { value.strategyTypeId = extension.strategyTypeId; value.slot = extension.slot }
        result.push(managed)
      } catch (error) {
        // A broken optional editor must not hide the real View or other plugins.
        warnings.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.discoveryWarnings = warnings
    return result
  }

  private revision(items: ManagedEntry[]): string {
    return hash({ settings: this.ctx.settings.describe({ redactSecrets: true }).filter(value => value.ns === 'mnemon' || value.ns === this.settingsNamespace).map(value => [value.ns, value.revision]), contribution: this.engine.contributionSnapshot().revision,
      entries: items.map(({ entry, value }) => ({ id: entry.id, name: entry.options.name, enabled: !entry.disabled, config: value.config })) })
  }

  async catalog() {
    await this.queue
    const items = await this.managed()
    const installed = this.engine.contributionSnapshot()
    const values = items.map(item => clone(item.value))
    for (const entry of [...installed.strategies, ...(installed.strategyExtensions ?? [])]) {
      if (values.some(value => value.entryId === entry.provenance.entryId)) continue
      const manifest = entry.definition.manifest
      values.push({ entryId: entry.provenance.entryId, packageName: manifest.packageName, typeId: manifest.typeId, kind: manifest.kind,
        label: { en: manifest.typeId, 'zh-CN': manifest.typeId }, description: { en: '', 'zh-CN': '' }, fields: [], config: {}, enabled: true, active: true, writable: false,
        ...(manifest.kind === 'strategy-extension' ? { strategyTypeId: manifest.strategyTypeId, slot: manifest.slot } : {}),
        diagnostic: 'This plugin has no managed Loader configuration descriptor.',
      })
    }
    return { revision: this.revision(items), writable: this.ctx.settings.writable && this.loader() !== undefined,
      entries: values, diagnostics: [...this.discoveryWarnings, ...(this.restoreError === undefined ? [] : [this.restoreError])] }
  }

  private proposal(items: ManagedEntry[], request: MemoryViewConfigurationRequest, restoring = false): MemoryContributionSnapshot {
    if (request.expectedRevision !== this.revision(items)) throw new Error('Strategy configuration changed; refresh before saving or previewing.')
    const incoming = preferences({ strategyTypeId: request.strategyTypeId, entries: request.entries })
    const snapshot = this.engine.contributionSnapshot()
    const managedIds = new Set(items.map(item => item.entry.id))
    for (const id of Object.keys(incoming.entries)) if (!managedIds.has(id)) throw new Error('Strategy Entry is not managed by this Host: ' + id)
    const candidate: MemoryContributionSnapshot = { ...snapshot,
      strategies: snapshot.strategies.filter(value => !managedIds.has(value.provenance.entryId)),
      strategyExtensions: (snapshot.strategyExtensions ?? []).filter(value => !managedIds.has(value.provenance.entryId)),
    }
    for (const item of items) {
      const chosen = incoming.entries[item.entry.id] ?? { enabled: item.value.enabled, config: item.value.config }
      if (!restoring && !item.value.writable && hash(chosen) !== hash({ enabled: item.value.enabled, config: item.value.config })) throw new Error('Strategy Entry configuration is read-only: ' + item.entry.id)
      const contributions = prepared(item, chosen.config)
      if (!chosen.enabled) continue
      candidate.strategies.push(...contributions.strategies)
      candidate.strategyExtensions!.push(...(contributions.strategyExtensions ?? []))
    }
    return captureMemoryContributionSnapshot(candidate)
  }

  async preview(config: ResolvedConfig, scope: MemoryOperationScope, request: MemoryViewConfigurationRequest, signal?: AbortSignal) {
    await this.queue
    return this.evaluate(await this.managed(), config, scope, request, signal)
  }

  private async evaluate(items: ManagedEntry[], config: ResolvedConfig, scope: MemoryOperationScope, request: MemoryViewConfigurationRequest, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const snapshot = this.proposal(items, request)
    const generation = new MemoryCompositionGeneration(snapshot, { ...memoryGenerationOptions(config, scope.workspaceId), strategyTypeId: request.strategyTypeId })
    try {
      const view = await generation.compose({ scope, scenario: 'agent.root-turn', budget: { ...DEFAULT_MEMORY_VIEW_BUDGET } }, signal)
      signal?.throwIfAborted()
      if (request.expectedRevision !== this.revision(items)) throw new Error('Strategy configuration changed during preview; refresh and retry.')
      return inspectMemoryView(generation, view, 'preview')
    } finally { await generation.dispose() }
  }

  async apply(config: ResolvedConfig, scope: MemoryOperationScope, request: MemoryViewConfigurationRequest, signal?: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      if (!this.ctx.settings.writable || !this.loader()) throw new Error('Strategy configuration is read-only')
      const items = await this.managed()
      await this.evaluate(items, config, scope, request, signal)
      const expected = this.settingsRevision()
      const previous = preferences(this.settings.get())
      const next = preferences({ strategyTypeId: request.strategyTypeId, entries: { ...previous.entries, ...request.entries } })
      await this.updateEntries(items, request.entries, async () => {
        await this.ctx.settings.mutate(this.settingsNamespace, [
            { op: 'set', path: ['strategyTypeId'], value: next.strategyTypeId },
            { op: 'set', path: ['entries'], value: next.entries },
          ], expected)
        this.restoreError = undefined
      }, signal)
    })
  }

  /** Reapply the DSH user overlay at boot/reload, without writing package files. */
  private async restore(): Promise<void> {
    if (this.closed) return
    const desired = this.settings.get().entries ?? {}
    const items = await this.managed()
    // Parent-disabled or expression-controlled Entries remain under their owner.
    const changes = Object.fromEntries(items.filter(item => !item.entry.parent.ctx?.fiber?.entry?.disabled
      && (item.entry.options.disabled === undefined || typeof item.entry.options.disabled === 'boolean') && desired[item.entry.id])
      .map(item => [item.entry.id, desired[item.entry.id]!]))
    this.proposal(items, { expectedRevision: this.revision(items), strategyTypeId: this.settings.get().strategyTypeId ?? 'default-three-tier', entries: changes }, true)
    await this.updateEntries(items, changes)
    this.restoreError = undefined
  }

  private async updateEntries(items: ManagedEntry[], desired: Record<string, MemoryStrategyPreference>, commit?: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    const changed = items.filter(item => desired[item.entry.id] && hash(desired[item.entry.id]) !== hash({ enabled: item.value.enabled, config: item.value.config }))
      .sort((a, b) => Number(desired[a.entry.id]!.enabled) - Number(desired[b.entry.id]!.enabled))
    const restored: Array<{ entry: StrategyLoaderEntry; disabled: boolean | null; config: unknown }> = []
    this.changingEntries = true
    try { await this.engine.batch(async () => {
      try {
        for (const item of changed) {
          signal?.throwIfAborted()
          if (this.closed) throw new Error('Strategy configuration service is disposed')
          const value = desired[item.entry.id]!
          restored.push({ entry: item.entry, disabled: item.entry.options.disabled as boolean | undefined ?? null, config: clone(item.entry.options.config ?? {}) })
          await item.entry.update({ disabled: !value.enabled, config: clone(value.config) })
          await item.entry.fiber?.await?.()
          const installed = this.engine.contributionSnapshot()
          const registered = [...installed.strategies, ...(installed.strategyExtensions ?? [])].filter(entry => entry.provenance.entryId === item.entry.id)
          if (installed.sources.some(source => source.provenance.entryId === item.entry.id) || item.entry.disabled === value.enabled
            || (value.enabled ? registered.length !== 1 || registered[0]!.definition.manifest.typeId !== item.definition.typeId : registered.length !== 0)) {
            throw new Error('Cordis did not register the requested Strategy state: ' + item.entry.id)
          }
        }
        signal?.throwIfAborted()
        if (this.closed) throw new Error('Strategy configuration service is disposed')
        await commit?.()
      } catch (error) {
        const failures: unknown[] = []
        for (const previous of restored.reverse()) {
          try { await previous.entry.update({ disabled: previous.disabled, config: previous.config }); await previous.entry.fiber?.await?.() }
          catch (rollback) { failures.push(rollback) }
        }
        if (failures.length) throw new AggregateError([error, ...failures], 'Strategy change failed and rollback was incomplete; inspect DSH plugin state.')
        throw error
      }
    }) } finally { this.changingEntries = false }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => { if (this.closed) throw new Error('Strategy configuration service is disposed'); return operation() })
    this.queue = next.then(() => {}, () => {})
    return next
  }
}
