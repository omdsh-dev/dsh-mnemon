import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from 'schemastery'
import type { HostContextShape, HostSettingsScope } from './dsh.ts'
import type { MemoryRuntime } from '../core/runtime.ts'
import { runProcess, type ProcessRunner } from './process.ts'
import type { StrategyLoader, StrategyLoaderEntry } from './strategy-management.ts'
import { parseSemver, resolveExecutable } from './version-updates.ts'
import type { MemoryPluginInstallResult, MemoryPluginInstallationEnvironment, MemoryPluginInspection, MemoryPluginKind, MemoryRegisteredPluginView } from './view-protocol.ts'

const PACKAGE = /^(?:@[a-z0-9._-]+\/)?dsh-mnemon-(source|strategy)-[a-z0-9][a-z0-9._-]*$/u
const SUGGESTIONS = [
  'dsh-mnemon-strategy-scoped',
  'dsh-mnemon-strategy-light-context',
  'dsh-mnemon-strategy-auto-capture',
] as const
const FETCH_TIMEOUT_MS = 10_000
const INSTALL_TIMEOUT_MS = 10 * 60_000

interface PackageManifest {
  name?: string
  version?: string
  description?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: unknown }; profile?: { bundles?: unknown } }
}

interface Profile {
  name: string
  directory: string
  dshHome: string
}

interface DshCommand { command: string; prefix: string[] }
interface MemoryPluginPreferences { sources: Record<string, { enabled: boolean }> }

export interface MemoryPluginInstallationDependencies {
  engine?: MemoryRuntime
  processRunner?: ProcessRunner
  fetchPackage?: (packageName: string, tag: string) => Promise<unknown>
  resolveDshCommand?: () => DshCommand | undefined
  currentVersion?: string
}

function manifest(path: string): PackageManifest | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof value === 'object' && value !== null ? value as PackageManifest : undefined
  } catch {
    return undefined
  }
}

const PACKAGE_MANIFEST = [new URL('../package.json', import.meta.url), new URL('../../package.json', import.meta.url)]
  .map(url => fileURLToPath(url)).map(manifest).find(value => value?.name === 'dsh-mnemon')
const SOURCE_ENTRY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,299}$/u
const preferencesSchema: z<MemoryPluginPreferences> = z.object({
  sources: z.dict(z.object({ enabled: z.boolean() })).default({}),
})

function preferences(value: MemoryPluginPreferences): MemoryPluginPreferences {
  const sources = value.sources ?? {}
  if (Object.keys(sources).length > 64) throw new Error('At most 64 Source Entries can be configured')
  for (const [entryId, item] of Object.entries(sources)) {
    if (!SOURCE_ENTRY_ID.test(entryId) || typeof item?.enabled !== 'boolean') throw new Error('Invalid Source Entry preference')
  }
  return structuredClone({ sources })
}

function dshCommand(): DshCommand | undefined {
  const script = process.argv[1]
  if (script !== undefined && existsSync(script)) {
    let directory = dirname(resolve(script))
    for (let depth = 0; depth < 8; depth++) {
      if (manifest(join(directory, 'package.json'))?.name === '@deepseek-ai/dsh') return { command: process.execPath, prefix: [resolve(script)] }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  const command = resolveExecutable('dsh')
  return command === undefined ? undefined : { command, prefix: [] }
}

function packageKind(name: string): MemoryPluginKind {
  const match = PACKAGE.exec(name)
  if (match === null) throw new Error('Use an exact dsh-mnemon-source-* or dsh-mnemon-strategy-* package name')
  return match[1] as MemoryPluginKind
}

function safeBundlePatch(value: unknown): boolean {
  if (typeof value !== 'string' || value === '' || isAbsolute(value)) return false
  const path = normalize(value.replace(/^\.\//u, ''))
  return path !== '..' && !path.startsWith('../') && !path.startsWith('..\\')
}

function registryBase(): string {
  return (process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/u, '')
}

async function fetchPackage(packageName: string, tag: string): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(`${registryBase()}/${encodeURIComponent(packageName)}/${encodeURIComponent(tag)}`, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'dsh-mnemon-plugin-discovery' },
    })
    if (!response.ok) throw new Error(response.status === 404 ? 'Package or compatible release channel was not found' : `Registry returned HTTP ${response.status}`)
    return await response.json()
  } finally { clearTimeout(timeout) }
}

function profileFrom(ctx: HostContextShape): Profile | undefined {
  const loader = ctx.get('loader') as Partial<StrategyLoader> | undefined
  const anchor = loader?.config?.baseUrl ?? loader?.context?.baseUrl
  if (anchor === undefined) return undefined
  let anchorPath: string
  try { anchorPath = anchor.startsWith('file:') ? fileURLToPath(anchor) : resolve(anchor) } catch { return undefined }
  const directory = manifest(join(anchorPath, 'package.json'))?.name?.startsWith('dsh-profile-') === true ? anchorPath : dirname(anchorPath)
  const value = manifest(join(directory, 'package.json'))
  if (!value?.name?.startsWith('dsh-profile-')) return undefined
  const profilesDirectory = dirname(directory)
  if (dirname(profilesDirectory) === profilesDirectory || !['profiles', 'profile'].includes(profilesDirectory.split(/[\\/]/u).at(-1) ?? '')) return undefined
  return { name: value.name.slice('dsh-profile-'.length), directory, dshHome: dirname(profilesDirectory) }
}

function installed(profile: Profile | undefined, packageName: string): boolean {
  if (profile === undefined) return false
  const value = manifest(join(profile.directory, 'package.json'))
  return value?.dependencies?.[packageName] !== undefined || value?.devDependencies?.[packageName] !== undefined
}

export class MemoryPluginInstallation {
  readonly suggestions = [...SUGGESTIONS]
  readonly settingsNamespace: string
  private readonly runner: ProcessRunner
  private readonly fetcher: (packageName: string, tag: string) => Promise<unknown>
  private readonly command: () => DshCommand | undefined
  private readonly currentVersion: string
  private readonly engine: MemoryRuntime | undefined
  private readonly settings: HostSettingsScope<MemoryPluginPreferences> | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private changingEntries = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private restoreError: string | undefined

  constructor(private readonly ctx: HostContextShape, dependencies: MemoryPluginInstallationDependencies = {}) {
    this.engine = dependencies.engine
    this.runner = dependencies.processRunner ?? runProcess
    this.fetcher = dependencies.fetchPackage ?? fetchPackage
    this.command = dependencies.resolveDshCommand ?? dshCommand
    this.currentVersion = dependencies.currentVersion ?? PACKAGE_MANIFEST?.version ?? '0.0.0'
    const loader = this.loader()
    const anchor = loader?.config?.baseUrl ?? loader?.context?.baseUrl
    this.settingsNamespace = `mnemon-plugins${anchor === undefined ? '' : `-${createHash('sha256').update(anchor).digest('hex').slice(0, 16)}`}`
    this.settings = typeof ctx.settings?.register === 'function' ? ctx.settings.register<MemoryPluginPreferences>(this.settingsNamespace, preferencesSchema, {
      base: { sources: {} }, applies: 'live', validate: value => { preferences(value) },
    }) : undefined
  }

  /** Restore Profile-local Source choices after bundle defaults are mounted. */
  start(): () => void {
    const schedule = () => {
      if (this.closed || this.changingEntries || this.timer || this.settings === undefined
        || !Object.keys(this.settings.get().sources ?? {}).length) return
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.exclusive(() => this.restore()).catch(error => {
          this.restoreError = error instanceof Error ? error.message : String(error)
        })
      }, 0)
    }
    const stops = [this.ctx.on('loader/entry-init', schedule), this.ctx.on('loader/partial-dispose', schedule),
      this.ctx.on('settings/updated', ((namespace: string) => { if (namespace === this.settingsNamespace) schedule() }) as never)]
    schedule()
    return () => {
      this.closed = true
      clearTimeout(this.timer)
      for (const stop of stops.reverse()) stop()
    }
  }

  private loader(): StrategyLoader | undefined {
    const candidate = this.ctx.get('loader') as Partial<StrategyLoader> | undefined
    return candidate !== undefined && typeof candidate.entries === 'function' ? candidate as StrategyLoader : undefined
  }

  private settingsRevision(): number {
    return this.ctx.settings.describe({ redactSecrets: true }).find(value => value.ns === this.settingsNamespace)?.revision ?? 0
  }

  environment(): MemoryPluginInstallationEnvironment {
    const loader = this.ctx.get('loader') as Partial<StrategyLoader> | undefined
    if (loader === undefined || typeof loader.entries !== 'function') return { supported: false, reason: 'loader-unavailable', suggestions: this.suggestions }
    const profile = profileFrom(this.ctx)
    if (profile === undefined) return { supported: false, reason: 'profile-unavailable', suggestions: this.suggestions }
    if (this.command() === undefined) return { supported: false, profileName: profile.name, reason: 'cli-unavailable', suggestions: this.suggestions }
    return { supported: true, profileName: profile.name, suggestions: this.suggestions }
  }

  registered(): MemoryRegisteredPluginView[] {
    const loader = this.loader()
    if (loader === undefined) return []
    const snapshot = this.engine?.contributionSnapshot()
    return [...loader.entries()].flatMap(entry => {
      if (entry.options.group || !PACKAGE.test(entry.options.name)) return []
      const kind = packageKind(entry.options.name)
      const ancestorDisabled = entry.parent.ctx?.fiber?.entry?.disabled === true
      const active = kind === 'source'
        ? snapshot?.sources.some(source => source.provenance.entryId === entry.id) === true
        : [...snapshot?.strategies ?? [], ...snapshot?.strategyExtensions ?? []].some(strategy => strategy.provenance.entryId === entry.id)
      return [{ entryId: entry.id, packageName: entry.options.name, kind, enabled: !entry.disabled, active,
        writable: this.settings !== undefined && this.ctx.settings.writable && !ancestorDisabled && (entry.options.disabled === undefined || typeof entry.options.disabled === 'boolean'),
        ...(ancestorDisabled ? { diagnostic: 'This Entry is disabled by its parent.' }
          : kind === 'source' && this.restoreError !== undefined ? { diagnostic: `Saved Source state could not be restored: ${this.restoreError}` } : {}) }]
    }).sort((left, right) => left.kind.localeCompare(right.kind) || left.packageName.localeCompare(right.packageName) || left.entryId.localeCompare(right.entryId))
  }

  async inspect(packageName: string): Promise<MemoryPluginInspection> {
    const kind = packageKind(packageName)
    const channel = parseSemver(this.currentVersion)?.prerelease[0]
    const tags = channel !== undefined && ['alpha', 'beta', 'rc'].includes(channel) ? [channel, 'latest'] : ['latest']
    let lastError: unknown
    for (const tag of tags) {
      try {
        const raw = await this.fetcher(packageName, tag)
        if (typeof raw !== 'object' || raw === null) throw new Error('Registry returned an invalid package manifest')
        const value = raw as PackageManifest
        if (value.name !== packageName || typeof value.version !== 'string' || parseSemver(value.version) === undefined) throw new Error('Registry returned a mismatched package identity or version')
        if (!safeBundlePatch(value.dsh?.bundle?.patch)) throw new Error('Package does not declare a safe DSH bundle patch')
        const peer = value.peerDependencies?.['dsh-mnemon']
        if (typeof peer !== 'string' || peer.trim() === '') throw new Error('Package does not declare its dsh-mnemon peer compatibility')
        return { packageName, version: value.version, kind, mnemonPeerRange: peer,
          ...(typeof value.description === 'string' && value.description.trim() !== '' ? { description: value.description.slice(0, 500) } : {}),
          installed: installed(profileFrom(this.ctx), packageName) }
      } catch (error) { lastError = error }
    }
    throw lastError instanceof Error ? lastError : new Error('Package could not be inspected')
  }

  install(packageName: string, version: string, signal?: AbortSignal): Promise<MemoryPluginInstallResult> {
    return this.exclusive(async () => {
      const environment = this.environment()
      if (!environment.supported || environment.profileName === undefined) throw new Error('This DSH Profile cannot install plugins from the Web UI')
      const inspected = await this.inspect(packageName)
      if (inspected.version !== version) throw new Error('Package version changed after inspection; inspect it again before installing')
      const profile = profileFrom(this.ctx)
      const command = this.command()
      if (profile === undefined || command === undefined) throw new Error('The active DSH Profile or CLI is no longer available')
      const result = await this.runner(command.command, [...command.prefix, 'plugin', '--profile', profile.name, 'add', `${packageName}@${version}`, '--save-exact'], {
        signal, timeoutMs: INSTALL_TIMEOUT_MS, maxOutputBytes: 64 * 1024, cwd: profile.directory,
        env: { ...process.env, DSH_HOME: profile.dshHome }, label: 'DSH plugin installation',
      })
      if (result.exitCode !== 0) throw new Error((result.stderr.trim() || result.stdout.trim() || `DSH plugin installation exited with ${String(result.exitCode)}`).slice(-4000))
      const value = manifest(join(profile.directory, 'package.json'))
      const dependency = value?.dependencies?.[packageName] ?? value?.devDependencies?.[packageName]
      const bundles = value?.dsh?.profile?.bundles
      if (dependency === undefined || !Array.isArray(bundles) || !bundles.includes(packageName)) throw new Error('DSH completed without registering the package as a Profile bundle')
      return { packageName, version, profileName: profile.name, installed: true, restartRequired: true }
    })
  }

  setSourceEnabled(entryId: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      if (this.engine === undefined || this.settings === undefined || !this.ctx.settings.writable) throw new Error('Source plugin activation is read-only')
      const entry = [...this.loader()?.entries() ?? []].find(candidate => candidate.id === entryId)
      if (entry === undefined || entry.options.group || packageKind(entry.options.name) !== 'source') throw new Error('Source plugin Entry was not found')
      if (entry.parent.ctx?.fiber?.entry?.disabled === true || entry.options.disabled !== undefined && typeof entry.options.disabled !== 'boolean') throw new Error('Source plugin lifecycle is owned by its parent DSH configuration')
      const previousPreferences = preferences(this.settings.get())
      const next = preferences({ sources: { ...previousPreferences.sources, [entryId]: { enabled } } })
      await this.updateSources([{ entry, enabled }], async () => {
        await this.ctx.settings.mutate(this.settingsNamespace, [{ op: 'set', path: ['sources'], value: next.sources }], this.settingsRevision())
        this.restoreError = undefined
      }, signal)
    })
  }

  private async restore(): Promise<void> {
    if (this.closed || this.settings === undefined || this.engine === undefined) return
    const desired = this.settings.get().sources ?? {}
    const entries = [...this.loader()?.entries() ?? []]
    const changes = entries.flatMap(entry => {
      const chosen = desired[entry.id]
      if (chosen === undefined || entry.options.group || !PACKAGE.test(entry.options.name) || packageKind(entry.options.name) !== 'source'
        || entry.parent.ctx?.fiber?.entry?.disabled === true || entry.options.disabled !== undefined && typeof entry.options.disabled !== 'boolean') return []
      return [{ entry, enabled: chosen.enabled }]
    })
    await this.updateSources(changes)
    this.restoreError = undefined
  }

  private async updateSources(changes: Array<{ entry: StrategyLoaderEntry; enabled: boolean }>, commit?: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (this.engine === undefined) throw new Error('Source plugin activation is unavailable')
    const changed = changes.filter(({ entry, enabled }) => entry.disabled === enabled)
    const restored: Array<{ entry: StrategyLoaderEntry; disabled: boolean | null }> = []
    this.changingEntries = true
    try {
      await this.engine.batch(async () => {
        try {
          for (const { entry, enabled } of changed) {
            signal?.throwIfAborted()
            if (this.closed) throw new Error('Memory plugin management service is disposed')
            restored.push({ entry, disabled: entry.options.disabled as boolean | undefined ?? null })
            await entry.update({ disabled: !enabled })
            await entry.fiber?.await?.()
            const active = this.engine!.contributionSnapshot().sources.some(source => source.provenance.entryId === entry.id)
            if (entry.disabled !== !enabled || active !== enabled) throw new Error('Cordis did not register the requested Source state: ' + entry.id)
          }
          signal?.throwIfAborted()
          if (this.closed) throw new Error('Memory plugin management service is disposed')
          await commit?.()
        } catch (error) {
          const failures: unknown[] = []
          for (const previous of restored.reverse()) {
            try {
              await previous.entry.update({ disabled: previous.disabled })
              await previous.entry.fiber?.await?.()
            } catch (rollback) { failures.push(rollback) }
          }
          if (failures.length) throw new AggregateError([error, ...failures], 'Source change failed and rollback was incomplete; inspect DSH plugin state.')
          throw error
        }
      })
    } finally { this.changingEntries = false }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => {
      if (this.closed) throw new Error('Memory plugin management service is disposed')
      return operation()
    })
    this.queue = next.then(() => {}, () => {})
    return next
  }
}
