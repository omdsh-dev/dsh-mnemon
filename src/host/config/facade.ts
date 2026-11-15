import { existsSync, readFileSync, statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'
import { validateMemoryGraphComposition } from '../../core/composition.ts'
import type { MemoryContributionSnapshot } from '../../core/contributions.ts'
import { canonicalMemoryJson } from '../../core/definitions.ts'
import type { HostConnectionHandle, HostContextShape, HostRpcHandler, HostSettingsScope, HostSettingsService, RpcResult } from '../dsh.ts'
import {
  DEFAULT_SKILLS_CONFIG,
  MNEMON_SETTINGS_CHANNEL,
  MNEMON_SETTINGS_NAMESPACE,
  MNEMON_SKILLS_SETTINGS_NAMESPACE,
  MNEMON_UI_SETTINGS_NAMESPACE,
  type ResolvedConfig,
  type SettingsOperation,
} from '../protocol.ts'
import { memoryGenerationOptions } from '../runtime.ts'
import { plainHostConfig } from './live.ts'
import { migrateLegacyDisplayMode, planLegacySettingsImport } from './migrations.ts'
import { normalizeDisplayMode } from './normalize.ts'
import { createStorageRoot, resolveGlobalDataDir } from './paths.ts'
import { DocumentsSchema, RuntimeMemorySchema } from './schema.ts'
import { prepareEmbeddingSettings, publicEmbeddingSettings, type EmbeddingCredentialStore } from './secrets.ts'

export {
  MNEMON_SETTINGS_CHANNEL,
  MNEMON_SETTINGS_NAMESPACE,
  MNEMON_SKILLS_SETTINGS_NAMESPACE,
  MNEMON_UI_SETTINGS_NAMESPACE,
}

type NativeDescriptor = ReturnType<HostSettingsService['describe']>[number]
type SettingsListener = (namespace: string, value: unknown) => void
type Registration = {
  namespace: string
  field?: 'conversationInteraction' | 'memoryView' | 'skills'
  schema: (value: unknown) => unknown
  base: unknown
  validate?: (value: never) => void
}

interface ProfileEntry {
  id?: string
  options: { id: string; config?: unknown }
}

interface ProfileFiber {
  entry?: ProfileEntry
  config: unknown
}

interface ProfileEditor {
  documentPath: string
  entries(): ProfileEntry[]
  configuration(): Array<{ entry: ProfileEntry; inherited: Record<string, unknown>; override: Record<string, unknown> }>
  edit(entry: ProfileEntry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>
}

interface ProfileForms {
  readonly writable: boolean
  configure(presentation: { auto: boolean }, owner: ProfileFiber): () => void
  describe(options?: { redactSecrets?: boolean }): ReturnType<HostSettingsService['describe']>
  mutate(namespace: string, operations: SettingsOperation[], expectedRevision?: number): Promise<void>
}

// A native import can remount this plugin; only a new host may clear the gate.
const pendingNativeImports = new WeakSet<object>()
const clone = <T>(value: T): T => structuredClone(value)
const objectRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

// Preserve DSH expressions as data; never evaluate or flatten them into strings.
function profileYaml(source: string): unknown {
  const document = parseDocument(source, {
    customTags: [{
      tag: 'tag:yaml.org,2002:js',
      resolve: (value: string) => ({ __jsExpr: value }),
    }],
  })
  if (document.errors.length > 0 || document.warnings.length > 0) throw new Error('Invalid or unsupported legacy/profile YAML; retained backup was not changed')
  return document.toJS({ maxAliasCount: 100 })
}

export interface RuntimeCompositionSource {
  committedContributionSnapshot(): MemoryContributionSnapshot
}

function assertInitializableDirectory(directory: string): void {
  let current = directory
  for (;;) {
    try {
      const stats = statSync(current)
      if (!stats.isDirectory()) {
        throw new Error(`ENOTDIR: storage root is not a directory: ${current}`)
      }
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        const parent = dirname(current)
        if (parent === current) return
        current = parent
        continue
      }
      throw error
    }
  }
}

/**
 * Lightweight composition/topology dry-run validator for `internal/config` preflight.
 * Evaluates plugin contributions, source configurations, and storage root validity
 * without creating directories or instantiating Git sync, review ledgers, or inspectors.
 */
export function validateRuntimeComposition(config: ResolvedConfig, extensions: RuntimeCompositionSource): void {
  assertInitializableDirectory(createStorageRoot(config, undefined).effectiveDataDir())
  if (config.runtimeUserScope === 'global') {
    assertInitializableDirectory(resolveGlobalDataDir())
  }
  validateMemoryGraphComposition(
    extensions.committedContributionSnapshot(),
    memoryGenerationOptions(config, undefined),
  )
}

/** A local facade preserves Mnemon's wire namespaces; DSH owns all persistence. */
export class ProfileMnemonSettings implements HostSettingsService {
  private readonly registrations = new Map<string, Registration>()
  private readonly listeners = new Set<SettingsListener>()
  private readonly revisions = new Map<number, NativeDescriptor>()
  private readonly owner: ProfileFiber | undefined
  private readonly forms: ProfileForms
  private readonly editor: ProfileEditor | undefined
  private closed = false
  private importing: Promise<void> | undefined
  private readonly nativeImportPending: boolean

  constructor(private readonly ctx: HostContextShape, private readonly input: unknown) {
    this.forms = ctx.settings as unknown as ProfileForms
    this.owner = (ctx as unknown as { fiber?: ProfileFiber }).fiber
    this.editor = ctx.get('configEditor') as ProfileEditor | undefined
    const profile = ctx.get('profileContext') as { home?: string } | undefined
    const root = (ctx as unknown as { root?: object }).root ?? ctx
    if (profile?.home !== undefined && existsSync(join(profile.home, 'settings.yaml'))) pendingNativeImports.add(root)
    this.nativeImportPending = pendingNativeImports.has(root)
    const owner = this.owner
    const validate = (candidate: unknown): void => {
      const config = plainHostConfig(candidate)
      for (const registration of this.registrations.values()) {
        const value = this.resolve(registration, config)
        registration.validate?.(value as never)
      }
    }
    // The public Cordis waterfall is also run by ConfigEditor before it writes.
    // Scope by fiber: another plugin's config must never initialize our graph.
    ctx.on('internal/config', function (this: ProfileFiber, _raw: unknown, next: () => unknown) {
      const candidate = next()
      if (this === owner) validate(candidate)
      return candidate
    } as never, { prepend: true })
    ctx.on('loader/volatile-update', ((paths: readonly (readonly string[])[]) => {
      if (this.closed) return
      for (const registration of this.registrations.values()) {
        // A change to a field another namespace owns is that namespace's alone: 技能管理's settings
        // never rebuild the memory runtime.
        const changed = paths.some(path => registration.field === undefined
          ? path.length === 0 || !['memoryView', 'legacySettingsImported', 'skills'].includes(path[0]!)
          : path.length === 0 || path[0] === registration.field)
        if (!changed) continue
        const value = this.resolve(registration)
        for (const listener of this.listeners) {
          try { listener(registration.namespace, value) }
          catch (error) { console.warn('dsh-mnemon: committed settings listener failed', error) }
        }
      }
    }) as never)
    ctx.effect(() => {
      const disposePresentation = owner === undefined ? undefined : this.forms.configure({ auto: false }, owner)
      return () => {
        this.closed = true
        this.listeners.clear()
        this.revisions.clear()
        disposePresentation?.()
      }
    }, 'dsh-mnemon: profile settings')
  }

  get writable(): boolean {
    const entry = this.owner?.entry
    return !this.closed && this.forms.writable && entry !== undefined && this.editor?.entries().includes(entry) === true
  }

  onUpdated(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private resolve(registration: Registration, config = plainHostConfig(this.owner?.config ?? this.input)): unknown {
    const value = registration.field === undefined ? config : config[registration.field]
    return registration.schema(objectRecord(value))
  }

  register<T>(namespace: string, schema: unknown, options: { base?: Partial<T>; applies: 'live' | 'restart'; validate?: (value: T) => void }): HostSettingsScope<T> {
    if (this.registrations.has(namespace)) throw new Error(`Mnemon settings already registered: ${namespace}`)
    if (typeof schema !== 'function') throw new Error('Mnemon settings require a schema')
    const field = namespace === 'mnemon-ui' ? 'conversationInteraction'
      : namespace === 'mnemon-skills' ? 'skills'
      : /^mnemon-view(?:-[a-f0-9]{16})?$/u.test(namespace) ? 'memoryView' : undefined
    if (namespace !== 'mnemon' && field === undefined) throw new Error('Unsupported Mnemon settings namespace')
    const registration: Registration = {
      namespace,
      ...(field === undefined ? {} : { field }),
      schema: schema as Registration['schema'],
      base: clone(options.base ?? {}),
      ...(options.validate === undefined ? {} : { validate: options.validate }),
    }
    const value = this.resolve(registration)
    options.validate?.(value as T)
    this.registrations.set(namespace, registration)
    return { get: () => this.resolve(registration) as T }
  }

  private nativeDescriptor(): NativeDescriptor | undefined {
    if (this.closed || this.owner?.entry === undefined || !this.editor?.entries().includes(this.owner.entry)) return undefined
    const descriptor = this.forms.describe().find(item => item.ns === this.owner?.entry?.options.id)
    if (descriptor !== undefined) {
      this.revisions.set(descriptor.revision, clone({
        ns: descriptor.ns, revision: descriptor.revision, applies: descriptor.applies,
        value: descriptor.value, base: descriptor.base, user: descriptor.user,
      }))
      if (this.revisions.size > 64) this.revisions.delete(this.revisions.keys().next().value!)
    }
    return descriptor
  }

  private unchanged(previous: NativeDescriptor, current: NativeDescriptor, registration: Registration, operations: SettingsOperation[]): boolean {
    const project = (value: unknown): unknown => {
      if (registration.field !== undefined) return objectRecord(value)[registration.field]
      const { memoryView: _view, legacySettingsImported: _imported, skills: _skills, conversationInteraction, ...core } = objectRecord(value)
      return operations.some(operation => operation.path[0] === 'conversationInteraction')
        ? { ...core, conversationInteraction } : core
    }
    const signature = (descriptor: NativeDescriptor) => canonicalMemoryJson(JSON.parse(JSON.stringify([
      project(descriptor.value) ?? null, project(descriptor.base) ?? null, project(descriptor.user) ?? null,
    ])))
    return signature(previous) === signature(current)
  }

  describe(options?: { redactSecrets?: boolean }): ReturnType<HostSettingsService['describe']> {
    const raw = this.nativeDescriptor()
    if (raw === undefined) return []
    const descriptor = options?.redactSecrets
      ? this.forms.describe(options).find(item => item.ns === this.owner?.entry?.options.id) : raw
    if (descriptor === undefined) return []
    return [...this.registrations.values()].map(registration => {
      const project = (value: unknown): unknown => registration.field === undefined ? value : objectRecord(value)[registration.field]
      return {
        ns: registration.namespace,
        value: project(descriptor.value) ?? {},
        base: project(descriptor.base) ?? {},
        user: project(descriptor.user) ?? {},
        revision: descriptor.revision,
        applies: 'live' as const,
      }
    })
  }

  async mutate(namespace: string, operations: SettingsOperation[], expectedRevision?: number): Promise<void> {
    const registration = this.registrations.get(namespace)
    if (registration === undefined) throw new Error('Unsupported Mnemon settings namespace')
    if (!this.writable) throw new Error('DSH settings are read-only')
    const translated = operations.map(operation => ({
      ...operation,
      path: [...(registration.field === undefined ? [] : [registration.field]), ...operation.path],
    }))
    let revision = expectedRevision
    const previous = revision === undefined ? undefined : this.revisions.get(revision)
    for (let attempt = 0; ; attempt += 1) {
      if (!this.writable) throw new Error('DSH settings are read-only')
      try {
        await this.forms.mutate(this.owner!.entry!.options.id, translated, revision)
        return
      } catch (error) {
        // The virtual namespaces were independent on older DSH. The new host
        // gives them one entry revision: rebase only when this namespace's
        // values and overrides still match the snapshot the caller observed.
        if (attempt >= 2 || previous === undefined || typeof error !== 'object' || error === null
          || !('code' in error) || error.code !== 'SETTINGS_CONFLICT') throw error
        if (!this.writable) throw new Error('DSH settings are read-only')
        const current = this.nativeDescriptor()
        if (current === undefined || !this.unchanged(previous, current, registration, operations)) throw error
        revision = current.revision
      }
    }
  }

  /** Read only the retained backup; ConfigEditor preserves all other patch rows. */
  async importLegacy(sourceEntryIds: readonly string[]): Promise<void> {
    if (this.importing !== undefined) return this.importing
    this.importing = this.performImport(sourceEntryIds).finally(() => { this.importing = undefined })
    return this.importing
  }

  private async performImport(sourceEntryIds: readonly string[]): Promise<void> {
    const profile = this.ctx.get('profileContext') as { home?: string } | undefined
    const entry = this.owner?.entry
    if (!this.writable || profile?.home === undefined || entry === undefined) return
    // DSH exposes no completion event for its asynchronous import of the removed settings.yaml.
    // Never race that writer: recover its retained backup on the next startup.
    if (this.nativeImportPending) {
      console.warn('dsh-mnemon: DSH is importing settings.yaml; restart once to recover retained Mnemon UI and plugin preferences')
      return
    }
    if (plainHostConfig(this.owner?.config ?? this.input).legacySettingsImported) return
    const viewNamespace = [...this.registrations.keys()].find(namespace => namespace.startsWith('mnemon-view'))
    if (viewNamespace === undefined) return
    const legacyNamespace = viewNamespace.replace(/^mnemon-view/u, 'mnemon-plugins')
    const backup = join(profile.home, 'settings.yaml.imported')
    let text: string
    try {
      if ((await stat(backup)).size > 1024 * 1024) throw new Error('Legacy settings backup exceeds the import limit')
      text = await readFile(backup, 'utf8')
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    const sections: unknown = profileYaml(text)
    const plan = () => {
      const configuration = this.editor!.configuration().find(item => item.entry === entry)
      if (configuration === undefined) throw new Error('Mnemon profile entry is no longer editable')
      const document: unknown = profileYaml(readFileSync(this.editor!.documentPath, 'utf8'))
      const entryOverrides = Array.isArray(document) ? document.flatMap(value => {
        const row = objectRecord(value)
        if (typeof row.id !== 'string') return []
        const entries = this.editor!.entries().filter(candidate => candidate.options.id === row.id)
        if (entries.length > 1) throw new Error('Legacy settings import requires unambiguous profile Entry ids')
        // Profile patches address local ids, whereas saved Views address the
        // complete Loader id (for example include:mnemon-strategy-scoped).
        return [{ id: entries[0]?.id ?? row.id, ...('disabled' in row ? { disabled: row.disabled } : {}), ...('config' in row ? { config: row.config } : {}) }]
      }) : []
      return planLegacySettingsImport({ entryId: entry.options.id, viewNamespace, legacyNamespace, sections, currentOverride: configuration.override, entryOverrides, sourceEntryIds })
    }
    const preview = plan()
    if (Object.keys(preview.patch).length === 0) {
      if (preview.diagnostics.length > 0) console.warn('dsh-mnemon: legacy settings were not imported; retained backup requires review')
      return
    }
    if (this.closed) return
    await this.editor!.edit(entry, current => {
      if (this.closed) throw new Error('Mnemon settings are disposed')
      // Re-read the explicit overlay inside DSH's revision/file lock.
      const next = plan()
      return { ...current, ...next.patch }
    })
  }
}

function success(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

function failure(error: unknown, namespace: string): RpcResult<unknown> {
  return {
    ok: false,
    error: {
      code: 'settings-rejected',
      message: error instanceof Error ? error.message : String(error),
      details: { ns: namespace },
    },
  }
}

function badRequest(message: string): RpcResult<unknown> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function displayModeOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>).displayMode
    : undefined
}

function requirePayloadObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('payload must be an object')
  return value as Record<string, unknown>
}

function descriptor(settings: HostSettingsService, namespace: string) {
  const view = settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === namespace)
  if (view === undefined) throw new Error(`${namespace} settings namespace is unavailable`)
  const raw = namespace === MNEMON_SETTINGS_NAMESPACE ? settings.describe({ redactSecrets: false }).find(candidate => candidate.ns === namespace) : undefined
  const visible = namespace === MNEMON_SETTINGS_NAMESPACE ? publicEmbeddingSettings(view.value, raw?.value, true) : view.value
  return {
    status: 'ready' as const,
    value: namespace === MNEMON_SETTINGS_NAMESPACE && displayModeOf(view.value) === 'buildin'
      ? { ...requirePayloadObject(visible), displayMode: 'builtin' }
      : visible,
    base: namespace === MNEMON_SETTINGS_NAMESPACE ? publicEmbeddingSettings(view.base, raw?.base) : view.base,
    user: namespace === MNEMON_SETTINGS_NAMESPACE ? publicEmbeddingSettings(view.user, raw?.user) : view.user,
    revision: view.revision,
    writable: settings.writable,
    mode: 'host' as const,
    applies: view.applies,
  }
}

const MUTABLE_FIELDS = [
  'storageScope', 'runtimeUserScope', 'excludedWorkspaces', 'cliPath', 'dataDir', 'customPackId', 'customPacks', 'store', 'timeoutMs', 'defaultRecallLimit',
  'documents', 'runtimeMemory',
  'embedding',
  'recallQuality',
  'routingGuidance', 'lifecycleEnabled', 'recallMode', 'writebackMode', 'idleReviewMs', 'idleReview',
  'displayMode', 'tabEnabled', 'writeEnabled', 'persistenceStrategy', 'taskAgentModel',
  // Git sync is a profile choice the settings page makes, so its switch has to be
  // writable here; everything about a repository stays in the sync state file.
  'syncEnabled',
]
// remoteAccess is intentionally absent: changing the remote management grant
// requires a local configuration edit and a Host restart.

/** Nested paths of the live in-conversation interaction toggles. */
const INTERACTION_PATHS: string[][] = [
  ['conversationInteraction', 'turnBar'],
  ['conversationInteraction', 'saveAction'],
]

const UI_FIELDS = ['turnBar', 'saveAction']
const SKILLS_FIELDS = [...Object.keys(DEFAULT_SKILLS_CONFIG), 'dshHome', 'agentsHome']
const MEMORY_LAYER_ID = /^[a-z][a-z0-9-]{0,127}$/u

function namespaceOf(payload: Record<string, unknown>): string {
  const namespace = payload.namespace === undefined ? MNEMON_SETTINGS_NAMESPACE : String(payload.namespace)
  if (namespace !== MNEMON_SETTINGS_NAMESPACE && namespace !== MNEMON_UI_SETTINGS_NAMESPACE && namespace !== MNEMON_SKILLS_SETTINGS_NAMESPACE) {
    throw new Error(`unsupported Mnemon settings namespace: ${namespace}`)
  }
  return namespace
}

/** Whether one mutation path targets a supported Mnemon settings field. */
function mutablePath(namespace: string, path: string[]): boolean {
  if (namespace === MNEMON_UI_SETTINGS_NAMESPACE) return path.length === 1 && UI_FIELDS.includes(path[0]!)
  if (namespace === MNEMON_SKILLS_SETTINGS_NAMESPACE) return path.length === 1 && SKILLS_FIELDS.includes(path[0]!)
  if (path.length === 1) return MUTABLE_FIELDS.includes(path[0]!)
  if (path.length === 4 && path[0] === 'memoryTopology' && path[1] === 'layers' && path[3] === 'enabled') {
    return MEMORY_LAYER_ID.test(path[2]!)
  }
  // Accepted only for legacy clients; the current UI writes `mnemon-ui`.
  return INTERACTION_PATHS.some(allowed => allowed.length === path.length && allowed.every((segment, index) => segment === path[index]))
}

export function createSettingsHandler(settings: HostSettingsService, credentials?: EmbeddingCredentialStore): HostRpcHandler {
  return async (endpoint, rawPayload) => {
    let namespace = MNEMON_SETTINGS_NAMESPACE
    try {
      const payload = requirePayloadObject(rawPayload)
      namespace = namespaceOf(payload)
      if (endpoint === 'get') return success(descriptor(settings, namespace))
      if (endpoint !== 'mutate') return badRequest(`unknown settings endpoint: ${endpoint}`)
      if (!settings.writable) throw new Error('DSH settings are read-only')
      if (!Array.isArray(payload.ops) || payload.ops.length === 0 || payload.ops.length > 16) throw new Error('ops must contain 1..16 settings edits')
      if (
        payload.expectedRevision !== undefined
        && (typeof payload.expectedRevision !== 'number' || !Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0)
      ) {
        throw new Error('expectedRevision must be a non-negative integer')
      }
      const ops = payload.ops.map((raw) => {
        const op = requirePayloadObject(raw)
        const path = Array.isArray(op.path) && op.path.length > 0 ? op.path.map(segment => String(segment)) : []
        if (!mutablePath(namespace, path)) throw new Error(`unsupported ${namespace} settings field: ${path.join('.')}`)
        if (op.op === 'unset') return { op: 'unset' as const, path }
        if (op.op !== 'set') throw new Error(`unsupported settings operation: ${String(op.op)}`)
        if (path[0] === 'memoryTopology' && typeof op.value !== 'boolean') throw new Error('memory layer enabled must be boolean')
        if (namespace === MNEMON_SETTINGS_NAMESPACE && path[0] === 'documents') {
          requirePayloadObject(op.value)
          DocumentsSchema(op.value as never)
        }
        if (namespace === MNEMON_SETTINGS_NAMESPACE && path[0] === 'runtimeMemory') {
          requirePayloadObject(op.value)
          RuntimeMemorySchema(op.value as never)
        }
        if (namespace === MNEMON_SKILLS_SETTINGS_NAMESPACE && (path[0] === 'dshHome' || path[0] === 'agentsHome')) {
          if (typeof op.value !== 'string') throw new Error(`skills.${path[0]} must be a string`)
          const trimmed = op.value.trim()
          if (trimmed === '') return { op: 'unset' as const, path }
          return { op: 'set' as const, path, value: trimmed }
        }
        return { op: 'set' as const, path, value: namespace === MNEMON_SETTINGS_NAMESPACE && path[0] === 'displayMode' ? normalizeDisplayMode(op.value) : op.value }
      })
      const revision = payload.expectedRevision
      const prepared = await prepareEmbeddingSettings(settings, namespace, ops, revision, credentials)
      try {
        await settings.mutate(namespace, prepared.operations, prepared.revision)
      } catch (error) {
        await prepared.rollback?.().catch(() => {})
        throw error
      }
      await prepared.commit?.().catch(() => {})
      if (namespace === MNEMON_SETTINGS_NAMESPACE) await migrateLegacyDisplayMode(settings)
      return success(descriptor(settings, namespace))
    } catch (error) {
      return failure(error, namespace)
    }
  }
}

export function registerSettingsRpc(connection: HostConnectionHandle, settings: HostSettingsService, credentials?: EmbeddingCredentialStore): HostRpcHandler {
  const handler = createSettingsHandler(settings, credentials)
  connection.rpc.handle(MNEMON_SETTINGS_CHANNEL, handler)
  return handler
}
