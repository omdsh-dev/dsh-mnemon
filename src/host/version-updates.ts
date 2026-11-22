import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmdirSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findMnemonCommand, mnemonNpmLauncher, nodeLauncherEnvironment, resolveMnemonInvocation } from 'dsh-mnemon-source-memory-spaces/native-cli'
import { expandUserPath } from './config/index.ts'
import { runProcess, type ProcessOptions, type ProcessResult, type ProcessRunner } from './process.ts'
import type { VersionComponentId, VersionInstallMode, VersionPackageId, VersionPackageStatus, VersionRestartStatus, VersionStatus, VersionUpdateOutcome, VersionUpdateResult } from "./protocol.ts"

export type { VersionComponentId, VersionComponentStatus, VersionInstallMode, VersionStatus, VersionUpdateResult } from "./protocol.ts"

interface PackageManifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  bin?: Record<string, string>
  dsh?: { bundle?: unknown }
}

interface DshInstall {
  mode: Extract<VersionInstallMode, 'npm' | 'link' | 'manual'>
  locationDir: string
  profileName?: string
  profileDir?: string
}

interface MnemonInstall {
  mode: Extract<VersionInstallMode, 'homebrew' | 'go' | 'npm' | 'manual' | 'missing'>
  command?: string
  hint?: string
  updateCommand?: string
  updateArgs?: string[]
  updateEnv?: NodeJS.ProcessEnv
}

export interface VersionUpdateDependencies {
  packageManifestPath?: string
  dshHome?: string
  mnemonCliPath?: () => string | undefined
  processRunner?: ProcessRunner
  resolveExecutable?: (command: string) => string | undefined
  fetchNpmLatest?: (name: string, tag?: string) => Promise<string | undefined>
  fetchMnemonLatest?: () => Promise<string | undefined>
  bundleInstaller?: () => DshBundleInstaller | undefined
  runningProfile?: () => DshRunningProfile | undefined
  pluginCommand?: () => Promise<DshPluginCommand | undefined>
  platform?: NodeJS.Platform
}

export interface DshRunningProfile {
  dir: string
  packageManager: boolean
}

export type DshPluginCommand = (args: readonly string[]) => Promise<DshPluginCommandResult>

export interface DshPluginCommandResult {
  exitCode: number | null
  output: string
  logPath?: string
  kind?: string
  timedOut?: boolean
  incompatible?: ReadonlyArray<DshIncompatibility>
}

interface DshProfileContext {
  name: string
  dir: string
  installAnchor: string
  cwd: string
  home: string
  packageManager?: { command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
}

function profileContextOf(value: unknown): DshProfileContext | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const profile = value as Partial<DshProfileContext>
  return ['name', 'dir', 'installAnchor', 'cwd', 'home'].every(key => typeof profile[key as keyof DshProfileContext] === 'string') ? profile as DshProfileContext : undefined
}

export async function dshPluginCommand(profileContext: unknown): Promise<DshPluginCommand | undefined> {
  const profile = profileContextOf(profileContext)
  if (profile === undefined) return undefined
  const specifier = '@deepseek-ai/dsh-plugin-manager/operations'
  let operations: { runPluginCommand?: (context: object, args: readonly string[], options: object) => Promise<DshPluginCommandResult> }
  try {
    operations = await import(specifier) as typeof operations
  } catch {
    return undefined
  }
  const run = operations.runPluginCommand
  if (typeof run !== 'function') return undefined
  return args => run(
    { profile: profile.name, dir: profile.dir, installAnchor: profile.installAnchor, cwd: profile.cwd, home: profile.home },
    args,
    { execution: 'service', ...(profile.packageManager ?? {}), outputBytes: MAX_UPDATE_OUTPUT_BYTES, activateNewBundles: false, idleTimeoutMs: UPDATE_TIMEOUT_MS, signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS) },
  )
}

export interface DshBundleInstaller {
  installBundle(spec: string, options?: { enabled?: boolean }): Promise<DshBundleChange>
  listBundles(): Promise<ReadonlyArray<{ name: string; version?: string }>>
}

export interface DshIncompatibility {
  runtimeVersion?: string
  requirements?: Readonly<Record<string, string>>
  peers?: Readonly<Record<string, string>>
}

export interface DshBundleChange {
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  error?: {
    code?: string
    diagnostic?: string
    incompatible?: ReadonlyArray<DshIncompatibility>
  }
  packageResult?: { output?: string; logPath?: string; kind?: string }
}

const DSH_MNEMON_PACKAGE = 'dsh-mnemon'
const MNEMON_NPM_PACKAGE = '@mnemon-dev/mnemon'
const SUBPACKAGE = /^dsh-mnemon-(source|strategy|provider)-[a-z0-9][a-z0-9._-]*$/

export function isVersionComponentId(value: unknown): value is VersionComponentId {
  return typeof value === 'string' && (value === 'mnemon' || value === DSH_MNEMON_PACKAGE || SUBPACKAGE.test(value))
}
const MNEMON_MODULE = 'github.com/mnemon-dev/mnemon'
const PACKAGE_MANIFEST_PATH = [new URL('../package.json', import.meta.url), new URL('../../package.json', import.meta.url)]
  .map(url => fileURLToPath(url)).find(path => manifest(path)?.name === DSH_MNEMON_PACKAGE) ?? fileURLToPath(new URL('../package.json', import.meta.url))
const LOADED_VERSION = manifest(PACKAGE_MANIFEST_PATH)?.version
export function pluginPackageVersion(): string {
  return LOADED_VERSION ?? '0.0.0'
}
const CHECK_TIMEOUT_MS = 10_000
const UPDATE_TIMEOUT_MS = 10 * 60_000
const IN_FLIGHT_WAIT_MS = 3_000
const MAX_UPDATE_OUTPUT_BYTES = 16 * 1024

async function settledWithin<T>(promise: Promise<T>, fallback: T, timeoutMs = CHECK_TIMEOUT_MS + 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function manifest(path: string): PackageManifest | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as PackageManifest : undefined
  } catch {
    return undefined
  }
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveExecutable(command: string): string | undefined {
  if (command.includes('/') || command.includes('\\') || command === '~') {
    const path = resolve(expandUserPath(command))
    return executable(path) ? path : undefined
  }
  const names = process.platform === 'win32' ? [`${command}.exe`, `${command}.cmd`, command] : [command]
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const name of names) {
      const path = join(directory, name)
      if (executable(path)) return path
    }
  }
  return undefined
}

export interface SemverParts {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

export function parseSemver(value: string): SemverParts | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

export function compareVersions(a: string, b: string): number {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (left === undefined && right === undefined) return 0
  if (left === undefined) return -1
  if (right === undefined) return 1
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const aPart = left.prerelease[index]
    const bPart = right.prerelease[index]
    if (aPart === undefined) return -1
    if (bPart === undefined) return 1
    if (aPart === bPart) continue
    const aNumber = /^\d+$/.test(aPart)
    const bNumber = /^\d+$/.test(bPart)
    if (aNumber && bNumber) return Number(aPart) < Number(bPart) ? -1 : 1
    if (aNumber) return -1
    if (bNumber) return 1
    return aPart < bPart ? -1 : 1
  }
  return 0
}

function versionFrom(text: string): string | undefined {
  return text.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/)?.[1]
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, CHECK_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'dsh-mnemon-version-check' },
    })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

function npmRegistryBase(): string {
  return (process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/u, '')
}

export async function fetchNpmLatest(name: string, tag = 'latest'): Promise<string | undefined> {
  const body = await fetchJson(`${npmRegistryBase()}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`)
  if (typeof body !== 'object' || body === null) return undefined
  const version = (body as Record<string, unknown>).version
  return typeof version === 'string' ? version : undefined
}

function dependencySpec(profile: PackageManifest | undefined, name = DSH_MNEMON_PACKAGE): string | undefined {
  return profile?.dependencies?.[name] ?? profile?.devDependencies?.[name]
}

function exactVersion(spec: string | undefined): string | undefined {
  return spec !== undefined && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(spec) ? spec : undefined
}

function isLinkSpec(spec: string | undefined): boolean {
  return spec !== undefined && /^(?:link|file|workspace):|^\.{1,2}(?:[/\\]|$)/.test(spec)
}

function linkedTarget(profileDir: string, spec: string): string | undefined {
  const value = spec.replace(/^(?:link|file):/, '')
  if (value.startsWith('workspace:')) return undefined
  return isAbsolute(value) ? resolve(value) : resolve(profileDir, value)
}

function profileFromAncestor(packageManifestPath: string): DshInstall | undefined {
  let directory = dirname(packageManifestPath)
  for (let depth = 0; depth < 12; depth++) {
    const profile = manifest(join(directory, 'package.json'))
    if (profile?.name?.startsWith('dsh-profile-') === true) {
      const spec = dependencySpec(profile)
      if (spec === undefined) return undefined
      const linked = isLinkSpec(spec)
      return {
        mode: linked ? 'link' : 'npm',
        locationDir: linked && spec !== undefined ? linkedTarget(directory, spec) ?? resolve(dirname(packageManifestPath)) : directory,
        profileName: profile.name.slice('dsh-profile-'.length),
        profileDir: directory,
      }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

function linkedProfile(packageManifestPath: string, dshHome: string): DshInstall | undefined {
  const profilesDir = join(dshHome, 'profiles')
  if (!existsSync(profilesDir)) return undefined
  const packageRoot = realpathSync(dirname(packageManifestPath))
  const matches: Array<{ name: string; dir: string; locationDir: string }> = []
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const profileDir = join(profilesDir, entry.name)
    const spec = dependencySpec(manifest(join(profileDir, 'package.json')))
    if (!isLinkSpec(spec)) continue
    const target = spec === undefined ? undefined : linkedTarget(profileDir, spec)
    if (target === undefined || !existsSync(target)) continue
    try {
      if (realpathSync(target) === packageRoot) matches.push({ name: entry.name, dir: profileDir, locationDir: target })
    } catch {
    }
  }
  const match = matches[0]
  return match === undefined ? undefined : { mode: 'link', locationDir: match.locationDir, profileName: match.name, profileDir: match.dir }
}

function inspectDshInstall(packageManifestPath: string, dshHome: string): DshInstall {
  return profileFromAncestor(packageManifestPath) ?? linkedProfile(packageManifestPath, dshHome) ?? { mode: 'manual', locationDir: resolve(dirname(packageManifestPath)) }
}

async function resultOrThrow(runner: ProcessRunner, command: string, args: readonly string[], timeoutMs: number, options: Pick<ProcessOptions, 'cwd' | 'env'> = {}): Promise<ProcessResult> {
  const result = await runner(command, args, { timeoutMs, maxOutputBytes: MAX_UPDATE_OUTPUT_BYTES, ...options })
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`
    throw new Error(detail)
  }
  return result
}

function dshFailure(change: DshBundleChange): string {
  const reason = change.error?.code ?? change.application
  const incompatible = change.error?.incompatible ?? []
  const peers = incompatible.flatMap(plugin => Object.entries(plugin.requirements ?? plugin.peers ?? {})
    .map(([name, range]) => `${name === 'engines.dsh' ? 'DSH' : name} ${range}`))
  if (peers.length > 0) {
    const runtime = incompatible.find(plugin => plugin.runtimeVersion !== undefined)?.runtimeVersion
    return `${reason} (requires ${peers.join(', ')}${runtime === undefined ? '' : `; this DSH is ${runtime}`})`
  }
  const lines = (change.error?.diagnostic ?? change.packageResult?.output ?? '').split('\n').map(line => line.trim()).filter(line => line !== '')
  const line = lines.findLast(line => /ERR_PNPM_[A-Z_]+/.test(line))
    ?? lines.findLast(line => /^(?:\[?error\]?\b|ERROR\b)|\brejected\b/i.test(line))
    ?? lines.at(-1)
  const kind = change.packageResult?.kind
  const detail = [kind === undefined || kind === 'unknown' || line?.includes(kind) === true ? undefined : kind, line?.slice(0, 300)].filter(Boolean).join(': ')
  const log = change.packageResult?.logPath
  return `${reason}${detail === '' ? '' : ` (${detail})`}${log === undefined || log === '' ? '' : `; log: ${log}`}`
}

function updateOutput(result: ProcessResult): string | undefined {
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n').trim()
  return output === '' ? undefined : output.slice(-4_000)
}

function packageAt(directory: string, name: string): string | undefined {
  for (let depth = 0; depth < 16; depth++) {
    const path = join(directory, 'node_modules', name, 'package.json')
    if (manifest(path)?.name === name) return path
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

function samePath(left: string, right: string): boolean {
  try { return realpathSync(left) === realpathSync(right) } catch { return false }
}

const LOCKED_ERROR_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

function isLockedError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    if (LOCKED_ERROR_CODES.has((error as { code: string }).code)) return true
  }
  const text = error instanceof Error ? error.message : String(error)
  return /\b(?:ERR_PNPM_EPERM|ERR_PNPM_EBUSY|EPERM|EBUSY)\b/u.test(text)
}

function emptyPackageShell(packageDir: string): boolean {
  try {
    return lstatSync(packageDir).isDirectory() && readdirSync(packageDir).length === 0
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function removeEmptyPackageShell(packageDir: string): boolean {
  if (!emptyPackageShell(packageDir)) return false
  try {
    rmdirSync(packageDir)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

interface PackageUpdateSnapshot {
  packageDir: string
  version: string
  profileManifest: Buffer
  lockfile?: Buffer
  backup?: { directory: string; packageDir: string }
  symlinkTarget?: string
}

async function readLockfile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

async function captureUpdateSnapshot(profileDir: string, packageDir: string): Promise<PackageUpdateSnapshot | undefined> {
  const version = manifest(join(packageDir, 'package.json'))?.version
  if (version === undefined) return undefined
  const profileManifest = await readFile(join(profileDir, 'package.json'))
  const lockfile = await readLockfile(join(profileDir, 'pnpm-lock.yaml'))
  const snapshot = { packageDir, version, profileManifest, ...(lockfile === undefined ? {} : { lockfile }) }
  if (lstatSync(packageDir).isSymbolicLink()) return { ...snapshot, symlinkTarget: realpathSync(packageDir) }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mnemon-update-backup-'))
  const backup = { directory, packageDir: join(directory, 'package') }
  try {
    await cp(packageDir, backup.packageDir, { recursive: true, verbatimSymlinks: true })
    return { ...snapshot, backup }
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function restoreUpdateSnapshot(profileDir: string, snapshot: PackageUpdateSnapshot): Promise<boolean> {
  const { packageDir, symlinkTarget, backup, version } = snapshot
  if (symlinkTarget !== undefined && manifest(join(symlinkTarget, 'package.json'))?.version !== version) return false
  if (!removeEmptyPackageShell(packageDir)) return false
  try {
    if (symlinkTarget !== undefined) {
      await symlink(symlinkTarget, packageDir, process.platform === 'win32' ? 'junction' : 'dir')
    } else if (backup !== undefined) {
      await cp(backup.packageDir, packageDir, { recursive: true, verbatimSymlinks: true })
    }
    if (manifest(join(packageDir, 'package.json'))?.version !== version) return false
    await writeFile(join(profileDir, 'package.json'), snapshot.profileManifest)
    const lockfilePath = join(profileDir, 'pnpm-lock.yaml')
    if (snapshot.lockfile === undefined) await rm(lockfilePath, { force: true })
    else await writeFile(lockfilePath, snapshot.lockfile)
    return true
  } catch {
    return false
  }
}

function manualUpdateCommand(profileName: string | undefined, profileDir: string, spec: string): string {
  return profileName !== undefined
    ? `dsh plugin --profile ${profileName} add ${spec}`
    : `pnpm add ${spec} --save-exact (in ${profileDir})`
}

export class VersionUpdateManager {
  readonly runningVersion: string
  private dshMnemonVersion: string
  private readonly packageManifestPath: string
  private readonly dshHome: string
  private readonly mnemonCliPath: () => string | undefined
  private readonly processRunner: ProcessRunner
  private readonly executable: (command: string) => string | undefined
  private readonly fetchNpmLatest: (name: string, tag?: string) => Promise<string | undefined>
  private readonly fetchMnemonLatest: () => Promise<string | undefined>
  private readonly bundleInstallerOf: () => DshBundleInstaller | undefined
  private readonly runningProfile: () => DshRunningProfile | undefined
  private readonly pluginCommand: () => Promise<DshPluginCommand | undefined>
  private readonly platform: NodeJS.Platform
  private readonly pendingRestart = new Map<VersionComponentId, string | undefined>()
  private inFlight: Promise<VersionUpdateResult> | undefined
  private lastUpdate: VersionUpdateOutcome | undefined

  constructor(dependencies: VersionUpdateDependencies = {}) {
    this.packageManifestPath = dependencies.packageManifestPath ?? PACKAGE_MANIFEST_PATH
    this.runningVersion = (dependencies.packageManifestPath === undefined ? LOADED_VERSION : undefined) ?? manifest(this.packageManifestPath)?.version ?? '0.0.0'
    this.dshMnemonVersion = this.runningVersion
    this.dshHome = dependencies.dshHome ?? resolve(expandUserPath(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')))
    this.mnemonCliPath = dependencies.mnemonCliPath ?? (() => findMnemonCommand({}))
    this.processRunner = dependencies.processRunner ?? runProcess
    this.executable = dependencies.resolveExecutable ?? resolveExecutable
    this.fetchNpmLatest = dependencies.fetchNpmLatest ?? fetchNpmLatest
    this.fetchMnemonLatest = dependencies.fetchMnemonLatest ?? (() => this.fetchNpmLatest(MNEMON_NPM_PACKAGE))
    this.bundleInstallerOf = dependencies.bundleInstaller ?? (() => undefined)
    this.runningProfile = dependencies.runningProfile ?? (() => undefined)
    this.pluginCommand = dependencies.pluginCommand ?? (async () => undefined)
    this.platform = dependencies.platform ?? process.platform
  }

  private bundleInstaller(install: DshInstall): DshBundleInstaller | undefined {
    if (install.mode !== 'npm' || install.profileDir === undefined) return undefined
    const installer = this.bundleInstallerOf()
    if (typeof installer?.installBundle !== 'function' || typeof installer.listBundles !== 'function') return undefined
    const running = this.runningProfile()
    if (running === undefined || (!running.packageManager && this.executable('pnpm') === undefined)) return undefined
    try {
      return realpathSync(running.dir) === realpathSync(install.profileDir) ? installer : undefined
    } catch {
      return undefined
    }
  }

  get currentDshMnemonVersion(): string {
    return this.installedVersion(inspectDshInstall(this.packageManifestPath, this.dshHome))
  }

  private installedVersion(install: DshInstall): string {
    const diskPath = install.mode === 'npm' && install.profileDir !== undefined
      ? packageAt(install.profileDir, DSH_MNEMON_PACKAGE) : undefined
    const recorded = install.mode === 'npm' && install.profileDir !== undefined && diskPath !== undefined
      ? exactVersion(dependencySpec(manifest(join(install.profileDir, 'package.json')))) : undefined
    if (recorded !== undefined) return recorded
    return manifest(diskPath ?? this.packageManifestPath)?.version ?? this.dshMnemonVersion
  }

  private replaced(id: VersionComponentId, current: string | undefined): boolean {
    return this.pendingRestart.has(id) && current !== this.pendingRestart.get(id)
  }

  private remember(id: VersionComponentId, previousVersion: string | undefined): void {
    if (!this.pendingRestart.has(id)) this.pendingRestart.set(id, previousVersion)
  }

  restartStatus(): VersionRestartStatus | undefined {
    const install = inspectDshInstall(this.packageManifestPath, this.dshHome)
    const installed = this.installedVersion(install)
    const pending = [...this.pendingRestart.keys()].filter((id): id is VersionPackageId => id !== DSH_MNEMON_PACKAGE)
    const rows = pending.length === 0 ? [] : this.subpackages(install).map(row => row.status)
    const packages = pending.filter(id => this.replaced(id, rows.find(row => row.id === id)?.current)).sort()
    if (installed === this.runningVersion && packages.length === 0) return undefined
    return { running: this.runningVersion, ...(installed === this.runningVersion ? {} : { installed }), ...(packages.length === 0 ? {} : { packages }) }
  }

  private async latestPackageVersion(name: string, current?: string): Promise<string | undefined> {
    const channel = current === undefined ? undefined : parseSemver(current)?.prerelease[0]
    const tags = channel !== undefined && ['alpha', 'beta', 'rc'].includes(channel) ? ['latest', channel] : ['latest']
    const candidates = await Promise.all(tags.map(async tag => {
      const version = await settledWithin(this.fetchNpmLatest(name, tag), undefined)
      const parsed = version === undefined ? undefined : parseSemver(version)
      if (parsed === undefined) return undefined
      if (parsed.prerelease.length > 0 && (tag === 'latest' || parsed.prerelease[0] !== tag)) return undefined
      return version
    }))
    return candidates.filter((version): version is string => version !== undefined).sort(compareVersions).at(-1)
  }

  private latestDshMnemonVersion(): Promise<string | undefined> {
    return this.latestPackageVersion(DSH_MNEMON_PACKAGE, this.currentDshMnemonVersion)
  }

  private async latestMnemonVersion(): Promise<string | undefined> {
    const version = await settledWithin(this.fetchMnemonLatest(), undefined)
    const parsed = version === undefined ? undefined : parseSemver(version)
    return parsed !== undefined && parsed.prerelease.length === 0 ? version : undefined
  }

  private npmInvocation(): { command: string; args: string[]; env?: NodeJS.ProcessEnv } | undefined {
    const npm = this.executable('npm')
    if (npm === undefined) return undefined
    if (!/\.cmd$/i.test(npm)) return { command: npm, args: [] }
    const cli = join(dirname(npm), 'node_modules/npm/bin/npm-cli.js')
    return existsSync(cli) ? { command: process.execPath, args: [cli], env: nodeLauncherEnvironment() } : undefined
  }

  private async inspectMnemon(): Promise<{ install: MnemonInstall; current?: string }> {
    const configured = this.mnemonCliPath() ?? findMnemonCommand({})
    const command = configured === undefined ? undefined : this.executable(configured)
    if (command === undefined) return { install: { mode: 'missing' } }
    const launcher = mnemonNpmLauncher(command)
    let current: string | undefined
    try {
      const invocation = resolveMnemonInvocation(command, ['--version'])
      current = versionFrom((await resultOrThrow(this.processRunner, invocation.command, invocation.args, CHECK_TIMEOUT_MS,
        { env: invocation.env })).stdout)
    } catch {
      return { install: { mode: launcher === undefined ? 'manual' : 'npm', command, hint: 'cli-unreadable' } }
    }
    if (launcher !== undefined) {
      const install: MnemonInstall = { mode: 'npm', command, hint: 'npm-unmanaged' }
      const npm = this.npmInvocation()
      if (npm === undefined) install.hint = 'npm-missing'
      else {
        try {
          const globalRoot = (await resultOrThrow(this.processRunner, npm.command, [...npm.args, 'root', '--global'], CHECK_TIMEOUT_MS, { env: npm.env })).stdout.trim()
          if (isAbsolute(globalRoot) && samePath(dirname(dirname(launcher)), join(globalRoot, MNEMON_NPM_PACKAGE))) {
            install.hint = 'npm'
            install.updateCommand = process.execPath
            install.updateArgs = [launcher, 'update']
            install.updateEnv = nodeLauncherEnvironment()
          }
        } catch { }
      }
      return { install, ...(current === undefined ? {} : { current }) }
    }
    let realCommand = command
    try { realCommand = realpathSync(command) } catch {}
    const normalizedCommand = realCommand.replaceAll('\\', '/')
    if (normalizedCommand.includes('/Caskroom/mnemon/')) {
      const brew = this.executable('brew')
      return { ...(current === undefined ? {} : { current }), install: { mode: 'homebrew', command, ...(brew === undefined ? {} : { updateCommand: brew, updateArgs: ['upgrade', '--cask', 'mnemon'] }) } }
    }
    if (normalizedCommand.includes('/Cellar/mnemon/')) {
      const brew = this.executable('brew')
      return { ...(current === undefined ? {} : { current }), install: { mode: 'homebrew', command, ...(brew === undefined ? {} : { updateCommand: brew, updateArgs: ['upgrade', 'mnemon-dev/tap/mnemon'] }) } }
    }
    const go = this.executable('go')
    if (go !== undefined) {
      try {
        const environment = JSON.parse((await resultOrThrow(this.processRunner, go, ['env', '-json', 'GOBIN', 'GOPATH', 'GOOS', 'GOARCH', 'GOHOSTOS', 'GOHOSTARCH'], CHECK_TIMEOUT_MS)).stdout) as Record<string, unknown>
        const goPath = typeof environment.GOPATH === 'string' ? environment.GOPATH.split(delimiter)[0] : undefined
        const bin = typeof environment.GOBIN === 'string' && environment.GOBIN !== '' ? environment.GOBIN : goPath === undefined || goPath === '' ? undefined : join(goPath, 'bin')
        if (bin === undefined || !isAbsolute(bin)
          || typeof environment.GOOS !== 'string' || environment.GOOS !== environment.GOHOSTOS
          || typeof environment.GOARCH !== 'string' || environment.GOARCH !== environment.GOHOSTARCH
          || realpathSync(join(bin, process.platform === 'win32' ? 'mnemon.exe' : 'mnemon')) !== realCommand) {
          return { ...(current === undefined ? {} : { current }), install: { mode: 'manual', command } }
        }
        const metadata = await resultOrThrow(this.processRunner, go, ['version', '-m', command], CHECK_TIMEOUT_MS)
        const mainPath = metadata.stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(fields => fields[0] === 'path')?.[1]
        if (mainPath === MNEMON_MODULE) {
          return { ...(current === undefined ? {} : { current }), install: { mode: 'go', command, updateCommand: go, updateArgs: ['install', `${MNEMON_MODULE}@latest`] } }
        }
      } catch {
      }
    }
    return { ...(current === undefined ? {} : { current }), install: { mode: 'manual', command } }
  }

  private subpackages(install: DshInstall): Array<{ status: VersionPackageStatus; manifestPath?: string }> {
    const starterPath = install.mode === 'npm' && install.profileDir !== undefined
      ? packageAt(install.profileDir, DSH_MNEMON_PACKAGE) ?? this.packageManifestPath : this.packageManifestPath
    const starter = manifest(starterPath)
    const starterReplaced = this.installedVersion(install) !== this.runningVersion
    const profile = install.profileDir === undefined ? undefined : manifest(join(install.profileDir, 'package.json'))
    const names = [...new Set([...Object.keys(starter?.dependencies ?? {}), ...Object.keys(profile?.dependencies ?? {}), ...Object.keys(profile?.devDependencies ?? {})])].filter(name => SUBPACKAGE.test(name)).sort()
    const installer = this.bundleInstaller(install)
    return names.map(name => {
      const directSpec = dependencySpec(profile, name)
      const managedBy = directSpec === undefined ? 'starter' : 'profile'
      const base = directSpec === undefined ? dirname(starterPath) : install.profileDir!
      const path = packageAt(base, name)
      const value = path === undefined ? undefined : manifest(path)
      const current = (managedBy === 'profile' ? exactVersion(directSpec) : undefined) ?? value?.version
      const linked = isLinkSpec(directSpec ?? starter?.dependencies?.[name]) || install.mode === 'link'
        || (path !== undefined && !realpathSync(dirname(path)).replaceAll('\\', '/').includes('/node_modules/'))
      const mode: VersionInstallMode = linked ? 'link' : path === undefined ? 'missing' : install.mode === 'npm' ? 'npm' : 'manual'
      const throughDsh = managedBy === 'profile' && mode === 'npm' && installer !== undefined && value?.dsh?.bundle !== undefined
      const supported = managedBy === 'profile' && mode === 'npm' && (throughDsh || this.executable('pnpm') !== undefined)
      return {
        ...(path === undefined ? {} : { manifestPath: path }),
        status: {
          id: name as VersionPackageId, name, kind: SUBPACKAGE.exec(name)![1] as VersionPackageStatus['kind'], managedBy,
          ...(starter?.dependencies?.[name] === undefined ? {} : { expectedVersion: starter.dependencies[name] }),
          ...(current === undefined ? {} : { current }),
          ...(path === undefined ? {} : { installPath: realpathSync(dirname(path)) }),
          ...(install.profileName === undefined ? {} : { installProfile: install.profileName }),
          installMode: mode, outdated: false, updateSupported: supported,
          updateHint: linked ? 'link' : managedBy === 'starter' ? 'starter' : throughDsh ? 'dsh' : supported ? 'pnpm' : mode === 'npm' ? 'pnpm-missing' : 'manual',
          restartRequired: this.replaced(name as VersionPackageId, current) || starterReplaced,
        },
      }
    })
  }

  async check(): Promise<VersionStatus> {
    if (this.inFlight !== undefined) await settledWithin<VersionUpdateResult | undefined>(this.inFlight, undefined, IN_FLIGHT_WAIT_MS)
    const dshInstall = inspectDshInstall(this.packageManifestPath, this.dshHome)
    const [mnemonLocal, mnemonLatest, dshLatest, packages] = await Promise.all([
      settledWithin(this.inspectMnemon(), { install: { mode: 'manual', hint: 'cli-unreadable' } }),
      this.latestMnemonVersion(),
      settledWithin(this.latestDshMnemonVersion(), undefined),
      Promise.all(this.subpackages(dshInstall).map(async ({ status }) => {
        const latest = await this.latestPackageVersion(status.id, status.current)
        return { ...status, ...(latest === undefined ? { checkError: 'latest-unavailable' } : { latest }), outdated: status.current !== undefined && latest !== undefined && compareVersions(status.current, latest) < 0 }
      })),
    ])
    const pnpm = this.executable('pnpm')
    const installer = this.bundleInstaller(dshInstall)
    const mnemonOutdated = mnemonLocal.current !== undefined && mnemonLatest !== undefined && compareVersions(mnemonLocal.current, mnemonLatest) < 0
    const installed = this.installedVersion(dshInstall)
    const dshOutdated = dshLatest !== undefined && compareVersions(installed, dshLatest) < 0
    const mnemonSupported = mnemonLocal.install.updateCommand !== undefined
    const dshSupported = dshInstall.mode === 'npm' && dshInstall.profileDir !== undefined && (installer !== undefined || pnpm !== undefined)
    return {
      checkedAt: new Date().toISOString(),
      ...(this.lastUpdate === undefined ? {} : { lastUpdate: this.lastUpdate }),
      components: [
        {
          id: 'dsh-mnemon',
          name: 'dsh-mnemon',
          ...(dshInstall.profileName === undefined ? {} : { installProfile: dshInstall.profileName }),
          installPath: dshInstall.locationDir,
          current: installed,
          ...(dshLatest === undefined ? {} : { latest: dshLatest }),
          outdated: dshOutdated,
          installMode: dshInstall.mode,
          updateSupported: dshSupported,
          packages,
          restartRequired: this.restartStatus() !== undefined,
          updateHint: dshInstall.mode === 'npm'
            ? installer !== undefined ? 'dsh' : dshSupported ? 'pnpm' : 'pnpm-missing'
            : dshInstall.mode === 'link' ? 'link' : 'manual',
          ...(dshLatest === undefined ? { checkError: 'latest-unavailable' } : {}),
        },
        {
          id: 'mnemon',
          name: 'Mnemon CLI',
          ...(mnemonLocal.install.command === undefined ? {} : { executablePath: mnemonLocal.install.command }),
          ...(mnemonLocal.current === undefined ? {} : { current: mnemonLocal.current }),
          ...(mnemonLatest === undefined ? {} : { latest: mnemonLatest }),
          outdated: mnemonOutdated,
          installMode: mnemonLocal.install.mode,
          updateSupported: mnemonSupported,
          updateHint: mnemonLocal.install.hint ?? (mnemonLocal.install.mode === 'homebrew'
            ? mnemonSupported ? 'brew' : 'brew-missing'
            : mnemonLocal.install.mode === 'go'
              ? 'go'
              : mnemonLocal.install.mode === 'missing' ? 'install' : 'manual'),
          ...(mnemonLatest === undefined ? { checkError: 'latest-unavailable' } : {}),
        },
      ],
    }
  }

  async update(component: VersionComponentId): Promise<VersionUpdateResult> {
    if (this.inFlight !== undefined) throw new Error('A version update is already in progress')
    const run = this.performUpdate(component)
    this.inFlight = run
    try {
      const result = await run
      this.lastUpdate = { at: new Date().toISOString(), component, result }
      return result
    } catch (error) {
      this.lastUpdate = { at: new Date().toISOString(), component, error: error instanceof Error ? error.message : String(error) }
      throw error
    } finally {
      this.inFlight = undefined
    }
  }

  private async performUpdate(component: VersionComponentId): Promise<VersionUpdateResult> {
    if (component === 'mnemon') {
      const before = await this.inspectMnemon()
      const latest = await this.latestMnemonVersion()
      if (before.current === undefined) throw new Error('Mnemon CLI is unavailable')
      if (latest === undefined) throw new Error('Unable to verify the latest Mnemon release')
      if (compareVersions(before.current, latest) >= 0) return { component, previousVersion: before.current, currentVersion: before.current, updated: false, restartRequired: false }
      if (before.install.updateCommand === undefined || before.install.updateArgs === undefined) throw new Error('This Mnemon installation cannot be updated automatically')
      const output = await resultOrThrow(this.processRunner, before.install.updateCommand, before.install.updateArgs, UPDATE_TIMEOUT_MS, { env: before.install.updateEnv })
      const after = await this.inspectMnemon()
      if (after.current === undefined || compareVersions(after.current, latest) < 0) throw new Error(`Mnemon update did not activate version ${latest}; found ${after.current ?? 'no executable version'}`)
      const outputText = updateOutput(output)
      return {
        component,
        previousVersion: before.current,
        currentVersion: after.current,
        updated: true,
        restartRequired: false,
        ...(outputText === undefined ? {} : { output: outputText }),
      }
    }

    const install = inspectDshInstall(this.packageManifestPath, this.dshHome)
    const child = component === DSH_MNEMON_PACKAGE ? undefined : this.subpackages(install).find(item => item.status.id === component)?.status
    if (component !== DSH_MNEMON_PACKAGE && child === undefined) throw new Error(`Unknown version component: ${String(component)}`)
    if (child !== undefined && !child.updateSupported) throw new Error('This subpackage must be updated through its Starter or original installation method')
    const previousVersion = child?.current ?? this.currentDshMnemonVersion
    const latest = await this.latestPackageVersion(component, previousVersion)
    if (latest === undefined) throw new Error('Unable to verify the latest dsh-mnemon release')
    if (compareVersions(previousVersion, latest) >= 0) {
      const restartRequired = component === DSH_MNEMON_PACKAGE ? previousVersion !== this.runningVersion : this.replaced(component, previousVersion)
      return { component, previousVersion, currentVersion: previousVersion, updated: false, restartRequired }
    }
    const installer = child === undefined || child.updateHint === 'dsh' ? this.bundleInstaller(install) : undefined
    const pnpm = installer === undefined ? this.executable('pnpm') : undefined
    if (install.mode !== 'npm' || install.profileDir === undefined || (installer === undefined && pnpm === undefined)) {
      throw new Error('This dsh-mnemon installation cannot be updated automatically')
    }
    const profileDir = install.profileDir
    const spec = `${component}@${latest}`
    const packageDir = join(profileDir, 'node_modules', component)
    const update = async () => {
      if (installer !== undefined) {
        const result = await this.updateThroughDsh(installer, profileDir, component, previousVersion, latest)
        if (result !== undefined) return result
        return this.updateThroughPluginCommand(profileDir, install.profileName, component, previousVersion, latest)
      }
      const output = await resultOrThrow(this.processRunner, pnpm!, ['add', spec, '--save-exact'], UPDATE_TIMEOUT_MS, { cwd: profileDir })
      return this.completePackageUpdate(component, previousVersion, latest, manifest(join(packageDir, 'package.json'))?.version, updateOutput(output))
    }
    if (this.platform !== 'win32') return update()

    const commandHint = manualUpdateCommand(install.profileName, profileDir, spec)
    const retryHint = `Quit DSH completely, run \`${commandHint}\`, then start DSH again.`
    const snapshot = await captureUpdateSnapshot(profileDir, packageDir).catch(error => {
      throw new Error(`Could not back up ${component} before updating. No installation files were changed. ${retryHint}`, { cause: error })
    })
    let keepBackup = false
    try {
      return await update()
    } catch (error) {
      const locked = isLockedError(error)
      if (locked && emptyPackageShell(packageDir) && exactVersion(dependencySpec(manifest(join(profileDir, 'package.json')), component)) === latest) {
        const healed = await this.recoverEmptyShell(profileDir, component, previousVersion, latest, installer !== undefined, pnpm)
        if (healed !== undefined) return healed
      }
      const base = error instanceof Error ? error.message : String(error)
      if (snapshot !== undefined && manifest(join(packageDir, 'package.json')) === undefined) {
        const restored = await restoreUpdateSnapshot(profileDir, snapshot)
        keepBackup = !restored && snapshot.backup !== undefined
        const backupHint = keepBackup ? ` Previous package backup: ${snapshot.backup!.packageDir}.` : ''
        throw new Error(restored
          ? `${base}. Restored previous ${component}@${snapshot.version}; your memory data is intact. ${retryHint}`
          : `${base}. The plugin installation needs repair and your memory data is intact.${backupHint} ${retryHint}`, { cause: error })
      }
      if (locked) throw new Error(`${base}. Your memory data is intact. ${retryHint}`, { cause: error })
      throw error
    } finally {
      if (!keepBackup && snapshot?.backup !== undefined) {
        await rm(snapshot.backup.directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
      }
    }
  }

  private completePackageUpdate(component: VersionComponentId, previousVersion: string, latest: string, installedVersion: string | undefined, output?: string): VersionUpdateResult {
    if (installedVersion !== latest) throw new Error(`${component} update did not install the requested version ${latest}; found ${installedVersion ?? 'no package'}`)
    if (component === DSH_MNEMON_PACKAGE) this.dshMnemonVersion = installedVersion
    this.remember(component, previousVersion)
    return {
      component,
      previousVersion,
      currentVersion: installedVersion,
      updated: true,
      restartRequired: true,
      ...(output === undefined || output === '' ? {} : { output: output.slice(-4_000) }),
    }
  }

  private async recoverEmptyShell(
    profileDir: string,
    component: VersionComponentId,
    previousVersion: string,
    latest: string,
    usePluginCommand: boolean,
    pnpm: string | undefined,
  ): Promise<VersionUpdateResult | undefined> {
    const packageDir = join(profileDir, 'node_modules', component)
    if (!removeEmptyPackageShell(packageDir)) return undefined
    try {
      let output: string | undefined
      if (usePluginCommand) {
        const command = await this.pluginCommand().catch(() => undefined)
        if (command === undefined) return undefined
        const result = await command(['install'])
        if ((result.incompatible?.length ?? 0) > 0 || result.exitCode !== 0 || result.timedOut === true) return undefined
        output = result.output.trim() || undefined
      } else if (pnpm !== undefined) {
        output = updateOutput(await resultOrThrow(this.processRunner, pnpm, ['install'], UPDATE_TIMEOUT_MS, { cwd: profileDir }))
      } else {
        return undefined
      }
      const installedVersion = manifest(join(packageDir, 'package.json'))?.version
      return this.completePackageUpdate(component, previousVersion, latest, installedVersion, output)
    } catch {
      return undefined
    }
  }

  private async updateThroughPluginCommand(profileDir: string, profileName: string | undefined, component: VersionComponentId, previousVersion: string, latest: string): Promise<VersionUpdateResult> {
    const spec = `${component}@${latest}`
    const command = await this.pluginCommand().catch(() => undefined)
    if (command === undefined) {
      throw new Error(`This DSH does not install over an installed plugin and offers no plugin command here; quit DSH, run \`dsh plugin --profile ${profileName ?? '<profile>'} add ${spec}\`, then start DSH again`)
    }
    let result: DshPluginCommandResult
    try {
      result = await command(['add', spec, '--save-exact'])
    } catch (error) {
      throw new Error(`DSH could not install ${spec}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const refused = (result.incompatible?.length ?? 0) > 0
    if (refused || result.exitCode !== 0 || result.timedOut === true) {
      throw new Error(`DSH could not install ${spec}: ${dshFailure({
        application: 'failed',
        error: { code: refused ? 'incompatible-version' : 'operation-error', diagnostic: result.output, ...(refused ? { incompatible: result.incompatible! } : {}) },
        packageResult: { output: result.output, ...(result.logPath === undefined ? {} : { logPath: result.logPath }), ...(result.kind === undefined ? {} : { kind: result.kind }) },
      })}`)
    }
    const installedVersion = manifest(join(profileDir, 'node_modules', component, 'package.json'))?.version
    return this.completePackageUpdate(component, previousVersion, latest, installedVersion, result.output.trim())
  }

  private async updateThroughDsh(installer: DshBundleInstaller, profileDir: string, component: VersionComponentId, previousVersion: string, latest: string): Promise<VersionUpdateResult | undefined> {
    const spec = `${component}@${latest}`
    let change: DshBundleChange
    try {
      change = await installer.installBundle(spec, { enabled: false })
    } catch (error) {
      throw new Error(`DSH could not install ${spec}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const output = change.packageResult?.output?.trim()
    if (change.application === 'failed' && change.error?.code === 'already-installed') return undefined
    if (change.application === 'failed' || change.application === 'cancelled') throw new Error(`DSH could not install ${spec}: ${dshFailure(change)}`)
    const installedVersion = this.platform === 'win32'
      ? manifest(join(profileDir, 'node_modules', component, 'package.json'))?.version
      : (await installer.listBundles()).find(bundle => bundle.name === component)?.version
    return this.completePackageUpdate(component, previousVersion, latest, installedVersion, output)
  }
}
