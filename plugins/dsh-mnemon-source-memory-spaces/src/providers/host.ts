import { createHash } from 'node:crypto'
import type { Context, Plugin } from '@deepseek-ai/cordis'
import type {
  MemoryProviderCapabilities,
  MemoryProviderConfigField,
  MemoryProviderDescriptor,
  MemoryProviderIcon,
} from '../contracts.ts'
import type { MemoryProviderAdapter } from './adapter.ts'
import {
  MemoryProviderAdapterRegistry,
  type MemoryProviderAdapterFactoryContext,
} from './registry.ts'

export const MEMORY_SPACE_PROVIDER_API_VERSION = 'dsh-mnemon.memory-space-provider/v1' as const

const STABLE_ID = /^[a-z][a-z0-9-]{0,127}$/u
const SOURCE_INSTANCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,299}$/u
const FIELD_KEY = /^[a-z][a-zA-Z0-9_-]{0,127}$/u

export type MemorySpaceProviderScoreSemantics = 'normalized-relevance' | 'provider-native' | 'none'

/**
 * Complete, JSON-safe definition metadata owned by the Memory Spaces Source.
 * It is deliberately not a Mnemon-wide contribution manifest.
 */
export interface MemorySpaceProviderManifest {
  apiVersion: typeof MEMORY_SPACE_PROVIDER_API_VERSION
  kind: 'provider'
  typeId: string
  packageName: string
  version: string
  label: string
  icon?: MemoryProviderIcon | undefined
  summary: string
  summaryI18nKey?: string
  origin: 'native' | 'third-party'
  locality: 'local' | 'remote'
  workspaceBinding: MemoryProviderDescriptor['workspaceBinding']
  capabilities: MemoryProviderCapabilities
  fields: MemoryProviderConfigField[]
  secrets: string[]
  scoreSemantics: MemorySpaceProviderScoreSemantics
}

export interface MemorySpaceProviderRuntimeContext extends MemoryProviderAdapterFactoryContext {
  /** Stable identity of this child mount inside one Memory Spaces Source. */
  providerInstanceId: string
  manifest: MemorySpaceProviderManifest
}

export interface MemorySpaceProviderDefinition {
  manifest: MemorySpaceProviderManifest
  create(context: MemorySpaceProviderRuntimeContext): MemoryProviderAdapter
}

export type MemorySpaceProviderDisposer = () => void | Promise<void>

/** Capability handed directly to one child Fiber through a lexical closure. */
export interface MemorySpaceProviderHost {
  install(owner: Context, definition: MemorySpaceProviderDefinition): MemorySpaceProviderDisposer
}

/** Typed child module mounted only by a Memory Spaces parent Fiber. */
export interface MemorySpaceProviderModule<Config = undefined> {
  readonly id: string
  /** Optional Cordis-compatible Standard Schema used for this child config. */
  readonly Config?: Plugin.Base<Config>['Config']
  apply(ctx: Context, host: MemorySpaceProviderHost, config: Config): void | Promise<void>
}

export interface MemorySpaceProviderEntry<Config = unknown> {
  instanceId: string
  module: MemorySpaceProviderModule<Config>
  config: Config
}

export interface MemorySpaceProviderSnapshotEntry {
  childKey: string
  instanceId: string
  configDigest: string
  definition: MemorySpaceProviderDefinition
}

function requiredId(value: string, label: string): string {
  const normalized = value.trim()
  if (!STABLE_ID.test(normalized)) throw new Error(`${label} must match [a-z][a-z0-9-]{0,127}`)
  return normalized
}

function requiredSourceInstanceId(value: string): string {
  const normalized = value.trim()
  if (!SOURCE_INSTANCE_ID.test(normalized)) {
    throw new Error('Memory Spaces Source instanceId must start with a letter or digit and contain only letters, digits, ., _, :, / or -')
  }
  return normalized
}

function requiredText(value: string, label: string, max = 500): string {
  const normalized = value.trim()
  if (normalized === '') throw new Error(`${label} is required`)
  if (normalized.length > max) throw new Error(`${label} is too long (max ${max} characters)`)
  return normalized
}

function requiredFieldKey(value: string, label: string): string {
  const normalized = value.trim()
  if (!FIELD_KEY.test(normalized)) throw new Error(`${label} must start with a letter and contain only letters, digits, _ or -`)
  return normalized
}

function captureIcon(value: MemoryProviderIcon | undefined): MemoryProviderIcon | undefined {
  if (value === undefined) return undefined
  const icon = structuredClone(value)
  if (icon.kind === 'brand') icon.value = requiredId(icon.value, 'Memory Space Provider icon brand')
  else if (icon.kind === 'glyph') icon.value = requiredText(icon.value, 'Memory Space Provider icon glyph', 16)
  else if (icon.kind === 'data-url') {
    icon.value = requiredText(icon.value, 'Memory Space Provider icon data URL', 200_000)
    if (!/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[a-zA-Z0-9+/=]+$/u.test(icon.value)) {
      throw new Error('Memory Space Provider icon must be a base64 image data URL')
    }
  } else {
    throw new Error(`unsupported Memory Space Provider icon kind: ${String(icon.kind)}`)
  }
  return icon
}

function captureCapabilities(value: MemoryProviderCapabilities): MemoryProviderCapabilities {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Memory Space Provider capabilities must be an object')
  const capabilities = structuredClone(value)
  for (const key of ['search', 'browse', 'graph', 'entities', 'related', 'remember', 'link', 'forget'] as const) {
    if (typeof capabilities[key] !== 'boolean') throw new Error(`Memory Space Provider capability ${key} must be boolean`)
  }
  if (capabilities.writeMode !== 'exact' && capabilities.writeMode !== 'async-extracting') throw new Error('unsupported Memory Space Provider write mode')
  if (!['soft', 'hard', 'unsupported'].includes(capabilities.deletionMode)) throw new Error('unsupported Memory Space Provider deletion mode')
  return capabilities
}

function captureFields(value: MemoryProviderConfigField[]): MemoryProviderConfigField[] {
  if (!Array.isArray(value)) throw new Error('Memory Space Provider fields must be an array')
  const fields = structuredClone(value)
  const fieldKeys = new Set<string>()
  for (const field of fields) {
    const key = requiredFieldKey(field.key, 'Memory Space Provider field key')
    if (fieldKeys.has(key)) throw new Error(`duplicate Memory Space Provider field: ${key}`)
    fieldKeys.add(key)
    field.key = key
    field.label = requiredText(field.label, `Memory Space Provider field ${key} label`, 100)
    if (field.i18nKey !== undefined) field.i18nKey = requiredText(field.i18nKey, `Memory Space Provider field ${key} i18nKey`, 200)
    if (field.scope !== 'service' && field.scope !== 'memory') throw new Error(`unsupported Memory Space Provider field scope: ${String(field.scope)}`)
    if (!['text', 'url', 'secret', 'number', 'boolean', 'select', 'path'].includes(field.input)) throw new Error(`unsupported Memory Space Provider field input: ${String(field.input)}`)
    if (typeof field.required !== 'boolean') throw new Error(`Memory Space Provider field ${key} required must be boolean`)
    if (field.role !== undefined && field.role !== 'global-location') throw new Error(`unsupported Memory Space Provider field role: ${String(field.role)}`)
    if (field.role === 'global-location' && (field.scope !== 'service' || field.input !== 'path')) throw new Error(`Memory Space Provider field ${key} global-location must be a service path`)
    if (field.placeholder !== undefined) field.placeholder = requiredText(field.placeholder, `Memory Space Provider field ${key} placeholder`, 2_000)
    if (field.help !== undefined) field.help = requiredText(field.help, `Memory Space Provider field ${key} help`, 2_000)
    if (field.min !== undefined && (!Number.isFinite(field.min) || field.input !== 'number')) throw new Error(`Memory Space Provider field ${key} min requires a finite number field`)
    if (field.max !== undefined && (!Number.isFinite(field.max) || field.input !== 'number')) throw new Error(`Memory Space Provider field ${key} max requires a finite number field`)
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) throw new Error(`Memory Space Provider field ${key} min exceeds max`)
    if (field.maxLength !== undefined && (
      !['text', 'url', 'secret', 'select', 'path'].includes(field.input)
      || !Number.isInteger(field.maxLength) || field.maxLength < 1 || field.maxLength > 8_000
    )) throw new Error(`Memory Space Provider field ${key} maxLength is invalid`)
    if (field.pattern !== undefined) {
      if (!['text', 'url', 'secret', 'path'].includes(field.input)) throw new Error(`Memory Space Provider field ${key} pattern requires a textual field`)
      field.pattern = requiredText(field.pattern, `Memory Space Provider field ${key} pattern`, 1_000)
      try { new RegExp(field.pattern, 'u') } catch { throw new Error(`Memory Space Provider field ${key} pattern is invalid`) }
    }
    if (field.validationMessage !== undefined) {
      if (field.pattern === undefined) throw new Error(`Memory Space Provider field ${key} validationMessage requires a pattern`)
      field.validationMessage = requiredText(field.validationMessage, `Memory Space Provider field ${key} validationMessage`, 500)
    }
    if (field.normalize !== undefined && (field.normalize !== 'trim-trailing-slash' || !['text', 'url', 'path'].includes(field.input))) {
      throw new Error(`unsupported Memory Space Provider field normalization: ${String(field.normalize)}`)
    }
    if (field.options !== undefined) {
      if (field.input !== 'select' || field.options.length === 0) throw new Error(`Memory Space Provider field ${key} options require a non-empty select field`)
      const optionValues = new Set<string>()
      for (const option of field.options) {
        option.value = requiredText(option.value, `Memory Space Provider field ${key} option value`, 200)
        option.label = requiredText(option.label, `Memory Space Provider field ${key} option label`, 200)
        if (option.i18nKey !== undefined) option.i18nKey = requiredText(option.i18nKey, `Memory Space Provider field ${key} option i18nKey`, 200)
        if (optionValues.has(option.value)) throw new Error(`duplicate Memory Space Provider field ${key} option: ${option.value}`)
        optionValues.add(option.value)
      }
    } else if (field.input === 'select') throw new Error(`Memory Space Provider select field ${key} requires options`)
    if (field.defaultValue !== undefined) {
      const valid = field.input === 'boolean'
        ? typeof field.defaultValue === 'boolean'
        : field.input === 'number'
          ? typeof field.defaultValue === 'number' && Number.isFinite(field.defaultValue)
          : typeof field.defaultValue === 'string'
      if (!valid || field.input === 'select' && !field.options?.some(option => option.value === field.defaultValue)) {
        throw new Error(`Memory Space Provider field ${key} default is invalid`)
      }
    }
  }
  for (const field of fields) {
    if (field.discoveryDefaultFrom === undefined) continue
    field.discoveryDefaultFrom = requiredFieldKey(field.discoveryDefaultFrom, `Memory Space Provider field ${field.key} discoveryDefaultFrom`)
    const source = fields.find(candidate => candidate.key === field.discoveryDefaultFrom)
    if (field.scope !== 'service' || source?.scope !== 'memory' || source.input === 'secret') {
      throw new Error(`Memory Space Provider field ${field.key} discovery default must reference a memory field`)
    }
  }
  return fields
}

function canonical(value: unknown, label: string, ancestors = new Set<object>(), depth = 0): string {
  if (depth > 64) throw new Error(`${label} exceeds the maximum nesting depth`)
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`)
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new Error(`${label} must be JSON-safe`)
  if (ancestors.has(value)) throw new Error(`${label} contains a cycle`)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return `[${value.map(item => canonical(item, label, ancestors, depth + 1)).join(',')}]`
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error(`${label} contains a non-plain object`)
    }
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, label, ancestors, depth + 1)}`)
      .join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function digest(value: unknown, label: string): string {
  return createHash('sha256').update(canonical(value, label)).digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

function captureManifest(value: MemorySpaceProviderManifest): MemorySpaceProviderManifest {
  canonical(value, 'Memory Space Provider manifest')
  const manifest = structuredClone(value)
  if (manifest.apiVersion !== MEMORY_SPACE_PROVIDER_API_VERSION) throw new Error(`unsupported Memory Space Provider API: ${String(manifest.apiVersion)}`)
  if (manifest.kind !== 'provider') throw new Error('Memory Space Provider manifest kind must be provider')
  manifest.typeId = requiredId(manifest.typeId, 'Memory Space Provider typeId')
  manifest.packageName = requiredText(manifest.packageName, 'Memory Space Provider packageName')
  manifest.version = requiredText(manifest.version, 'Memory Space Provider version', 100)
  manifest.label = requiredText(manifest.label, 'Memory Space Provider label', 100)
  manifest.icon = captureIcon(manifest.icon)
  manifest.summary = requiredText(manifest.summary, 'Memory Space Provider summary', 1_000)
  if (manifest.summaryI18nKey !== undefined) manifest.summaryI18nKey = requiredText(manifest.summaryI18nKey, 'Memory Space Provider summaryI18nKey', 200)
  if (manifest.locality !== 'local' && manifest.locality !== 'remote') throw new Error('Memory Space Provider locality must be local or remote')
  if (manifest.origin !== 'native' && manifest.origin !== 'third-party') throw new Error('Memory Space Provider origin must be native or third-party')
  if (!['automatic', 'optional-override', 'provider-global'].includes(manifest.workspaceBinding)) {
    throw new Error(`unsupported Memory Space Provider workspace binding: ${String(manifest.workspaceBinding)}`)
  }
  if (!['normalized-relevance', 'provider-native', 'none'].includes(manifest.scoreSemantics)) {
    throw new Error(`unsupported Memory Space Provider score semantics: ${String(manifest.scoreSemantics)}`)
  }
  manifest.capabilities = captureCapabilities(manifest.capabilities)
  manifest.fields = captureFields(manifest.fields)
  if (!Array.isArray(manifest.secrets)) throw new Error('Memory Space Provider secrets must be an array')
  const secretFields = manifest.fields.filter(field => field.input === 'secret').map(field => field.key).sort()
  const secrets = [...new Set(manifest.secrets.map(secret => requiredFieldKey(secret, 'Memory Space Provider secret')))].sort()
  if (canonical(secretFields, 'Memory Space Provider secret fields') !== canonical(secrets, 'Memory Space Provider secrets')) {
    throw new Error('Memory Space Provider secrets must exactly match secret config fields')
  }
  manifest.secrets = secrets
  return deepFreeze(manifest)
}

/** Presentation labels/icons do not change the semantic Generation digest. */
function semanticManifest(manifest: MemorySpaceProviderManifest): unknown {
  return {
    apiVersion: manifest.apiVersion,
    kind: manifest.kind,
    typeId: manifest.typeId,
    packageName: manifest.packageName,
    version: manifest.version,
    origin: manifest.origin,
    locality: manifest.locality,
    workspaceBinding: manifest.workspaceBinding,
    capabilities: manifest.capabilities,
    fields: manifest.fields.map(field => ({
      key: field.key, scope: field.scope, role: field.role, input: field.input, required: field.required,
      defaultValue: field.defaultValue, min: field.min, max: field.max, maxLength: field.maxLength,
      pattern: field.pattern, normalize: field.normalize,
      discoveryDefaultFrom: field.discoveryDefaultFrom,
      options: field.options?.map(option => option.value),
    })),
    secrets: manifest.secrets,
    scoreSemantics: manifest.scoreSemantics,
  }
}

function captureDefinition(value: MemorySpaceProviderDefinition): MemorySpaceProviderDefinition {
  if (typeof value?.create !== 'function') throw new Error('Memory Space Provider definition requires a create factory')
  return Object.freeze({ manifest: captureManifest(value.manifest), create: value.create })
}

function assertRuntime(definition: MemorySpaceProviderDefinition, adapter: MemoryProviderAdapter): void {
  const { manifest } = definition
  if (adapter.id !== manifest.typeId) {
    throw new Error(`Memory Space Provider ${manifest.typeId} factory returned ${String(adapter.id)}`)
  }
  const requiredMethods: Array<[boolean, keyof MemoryProviderAdapter]> = [
    [manifest.capabilities.search, 'search'],
    [manifest.capabilities.browse, 'list'],
    [manifest.capabilities.graph, 'graph'],
    [manifest.capabilities.related, 'related'],
    [manifest.capabilities.remember, 'remember'],
    [manifest.capabilities.link, 'link'],
    [manifest.capabilities.forget, 'forget'],
  ]
  for (const [required, method] of requiredMethods) {
    if (required && typeof adapter[method] !== 'function') {
      throw new Error(`Memory Space Provider ${manifest.typeId} declares ${String(method)} but its runtime does not implement it`)
    }
  }
  if (manifest.scoreSemantics === 'normalized-relevance' && adapter.scoreSemantics?.kind !== 'normalized-relevance') {
    throw new Error(`Memory Space Provider ${manifest.typeId} declares normalized scores but its runtime does not`)
  }
}

/** Keep legacy drivers unaware of child instance aliases while routing by the alias. */
function instanceAdapter(adapter: MemoryProviderAdapter, instanceId: string): MemoryProviderAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'id') return instanceId
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export class MemorySpaceProviderSnapshot {
  readonly digest: string
  readonly entries: readonly MemorySpaceProviderSnapshotEntry[]

  constructor(entries: readonly MemorySpaceProviderSnapshotEntry[]) {
    const sorted = [...entries].sort((left, right) => left.childKey.localeCompare(right.childKey))
    this.entries = Object.freeze(sorted.map(entry => Object.freeze({ ...entry })))
    this.digest = digest(sorted.map(entry => ({
      childKey: entry.childKey,
      instanceId: entry.instanceId,
      configDigest: entry.configDigest,
      manifest: semanticManifest(entry.definition.manifest),
    })), 'Memory Space Provider snapshot')
    Object.freeze(this)
  }

  descriptors(): MemoryProviderDescriptor[] {
    return this.entries.map(({ instanceId, definition }) => ({
      id: instanceId,
      ...(instanceId === definition.manifest.typeId ? {} : { typeId: definition.manifest.typeId }),
      label: definition.manifest.label,
      ...(definition.manifest.icon === undefined ? {} : { icon: structuredClone(definition.manifest.icon) }),
      kind: definition.manifest.locality,
      workspaceBinding: definition.manifest.workspaceBinding,
      summary: definition.manifest.summary,
      ...(definition.manifest.summaryI18nKey === undefined ? {} : { summaryI18nKey: definition.manifest.summaryI18nKey }),
      origin: definition.manifest.origin,
      capabilities: structuredClone(definition.manifest.capabilities),
      fields: structuredClone(definition.manifest.fields),
    }))
  }

  adapterRegistry(): MemoryProviderAdapterRegistry {
    return new MemoryProviderAdapterRegistry(this.entries.map(({ instanceId, definition }) => ({
      id: instanceId,
      create: context => {
        const adapter = definition.create({
          ...context,
          providerInstanceId: instanceId,
          manifest: definition.manifest,
        })
        assertRuntime(definition, adapter)
        return instanceAdapter(adapter, instanceId)
      },
    })))
  }
}

interface ProviderRegistration {
  childKey: string
  instanceId: string
  configDigest: string
  definition: MemorySpaceProviderDefinition
}

/**
 * Source-private definition host. It is a plain closure-owned object, never a
 * Cordis Context service and never a Mnemon contribution registry.
 */
export class PrivateMemorySpaceProviderHost {
  private readonly registrations = new Map<string, ProviderRegistration>()

  constructor(private readonly sourceInstanceId: string) {
    this.sourceInstanceId = requiredSourceInstanceId(sourceInstanceId)
  }

  bind(instanceIdValue: string, moduleTypeIdValue: string, config: unknown): MemorySpaceProviderHost {
    const instanceId = requiredId(instanceIdValue, 'Memory Space Provider instanceId')
    const moduleTypeId = requiredId(moduleTypeIdValue, 'Memory Space Provider module id')
    const childKey = `${this.sourceInstanceId}/provider:${instanceId}`
    const configDigest = digest(config ?? null, `Memory Space Provider ${instanceId} config`)
    let installed = false
    return Object.freeze({
      install: (owner: Context, definitionValue: MemorySpaceProviderDefinition): MemorySpaceProviderDisposer => {
        if (installed) throw new Error(`Memory Space Provider child already installed a definition: ${childKey}`)
        const definition = captureDefinition(definitionValue)
        if (definition.manifest.typeId !== moduleTypeId) {
          throw new Error(`Memory Space Provider module ${moduleTypeId} installed definition ${definition.manifest.typeId}`)
        }
        installed = true
        return owner.effect(() => {
          if (this.registrations.has(childKey)) throw new Error(`Memory Space Provider child is already installed: ${childKey}`)
          const registration = Object.freeze({ childKey, instanceId, configDigest, definition })
          this.registrations.set(childKey, registration)
          let active = true
          return () => {
            if (!active) return
            active = false
            if (this.registrations.get(childKey) === registration) this.registrations.delete(childKey)
          }
        }, `dsh-mnemon: install private Provider ${childKey}`)
      },
    })
  }

  has(instanceId: string): boolean {
    return this.registrations.has(`${this.sourceInstanceId}/provider:${instanceId}`)
  }

  snapshot(): MemorySpaceProviderSnapshot {
    return new MemorySpaceProviderSnapshot([...this.registrations.values()])
  }
}

export function defineMemorySpaceProvider<Config>(module: MemorySpaceProviderModule<Config>): MemorySpaceProviderModule<Config> {
  const id = requiredId(module.id, 'Memory Space Provider module id')
  if (typeof module.apply !== 'function') throw new Error(`Memory Space Provider module ${id} requires apply()`)
  return Object.freeze({ ...module, id })
}

export function defineMemorySpaceProviderDefinition(definition: MemorySpaceProviderDefinition): MemorySpaceProviderDefinition {
  return captureDefinition(definition)
}
