import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess, type ProcessResult, type ProcessRunner } from './process.ts'
import type { VersionComponentId, VersionComponentStatus, VersionInstallMode, VersionStatus, VersionUpdateResult } from "./protocol.ts"

export type { VersionComponentId, VersionComponentStatus, VersionInstallMode, VersionStatus, VersionUpdateResult } from "./protocol.ts"

interface PackageManifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

interface DshInstall {
  mode: Extract<VersionInstallMode, 'npm' | 'link' | 'manual'>
  locationDir: string
  profileName?: string
  profileDir?: string
}

interface MnemonInstall {
  mode: Extract<VersionInstallMode, 'homebrew' | 'go' | 'manual' | 'missing'>
  command?: string
  updateCommand?: string
  updateArgs?: string[]
}

export interface VersionUpdateDependencies {
  packageManifestPath?: string
  dshHome?: string
  mnemonCliPath?: () => string | undefined
  processRunner?: ProcessRunner
  resolveExecutable?: (command: string) => string | undefined
  fetchNpmLatest?: (name: string) => Promise<string | undefined>
  fetchMnemonLatest?: () => Promise<string | undefined>
}

const DSH_MNEMON_PACKAGE = 'dsh-mnemon'
const findMnemonCommand = (config: { cliPath?: string }): string | undefined => config.cliPath ?? process.env.MNEMON_CLI_PATH ?? resolveExecutable('mnemon') ?? resolveExecutable('/opt/homebrew/bin/mnemon') ?? resolveExecutable(join(homedir(), '.local/bin/mnemon'))
const MNEMON_MODULE = 'github.com/mnemon-dev/mnemon'
const PACKAGE_MANIFEST_PATH = [new URL('../package.json', import.meta.url), new URL('../../package.json', import.meta.url)]
  .map(url => fileURLToPath(url)).find(path => manifest(path)?.name === DSH_MNEMON_PACKAGE) ?? fileURLToPath(new URL('../package.json', import.meta.url))
const CHECK_TIMEOUT_MS = 10_000
const UPDATE_TIMEOUT_MS = 10 * 60_000
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

/** Resolve one executable without invoking a shell. */
export function resolveExecutable(command: string): string | undefined {
  if (command.includes('/') || command.includes('\\')) {
    const path = command.startsWith('~/') ? join(homedir(), command.slice(2)) : resolve(command)
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

async function fetchNpmLatest(name: string): Promise<string | undefined> {
  const body = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`)
  if (typeof body !== 'object' || body === null) return undefined
  const version = (body as Record<string, unknown>).version
  return typeof version === 'string' ? version : undefined
}

async function fetchMnemonLatest(): Promise<string | undefined> {
  const body = await fetchJson('https://api.github.com/repos/mnemon-dev/mnemon/releases/latest')
  if (typeof body !== 'object' || body === null) return undefined
  const tag = (body as Record<string, unknown>).tag_name
  return typeof tag === 'string' ? tag.replace(/^v/, '') : undefined
}

function dependencySpec(profile: PackageManifest | undefined): string | undefined {
  return profile?.dependencies?.[DSH_MNEMON_PACKAGE] ?? profile?.devDependencies?.[DSH_MNEMON_PACKAGE]
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
      // A stale link belongs to neither the running package nor an update target.
    }
  }
  const match = matches[0]
  return match === undefined ? undefined : { mode: 'link', locationDir: match.locationDir, profileName: match.name, profileDir: match.dir }
}

function inspectDshInstall(packageManifestPath: string, dshHome: string): DshInstall {
  return profileFromAncestor(packageManifestPath) ?? linkedProfile(packageManifestPath, dshHome) ?? { mode: 'manual', locationDir: resolve(dirname(packageManifestPath)) }
}

async function resultOrThrow(runner: ProcessRunner, command: string, args: readonly string[], timeoutMs: number, options: { cwd?: string } = {}): Promise<ProcessResult> {
  const result = await runner(command, args, { timeoutMs, maxOutputBytes: MAX_UPDATE_OUTPUT_BYTES, ...options })
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`
    throw new Error(detail)
  }
  return result
}

function updateOutput(result: ProcessResult): string | undefined {
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n').trim()
  return output === '' ? undefined : output.slice(-4_000)
}

export class VersionUpdateManager {
  private dshMnemonVersion: string
  private readonly packageManifestPath: string
  private readonly dshHome: string
  private readonly mnemonCliPath: () => string | undefined
  private readonly processRunner: ProcessRunner
  private readonly executable: (command: string) => string | undefined
  private readonly fetchNpmLatest: (name: string) => Promise<string | undefined>
  private readonly fetchMnemonLatest: () => Promise<string | undefined>

  constructor(dependencies: VersionUpdateDependencies = {}) {
    this.packageManifestPath = dependencies.packageManifestPath ?? PACKAGE_MANIFEST_PATH
    this.dshMnemonVersion = manifest(this.packageManifestPath)?.version ?? '0.0.0'
    this.dshHome = dependencies.dshHome ?? (process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
    this.mnemonCliPath = dependencies.mnemonCliPath ?? (() => findMnemonCommand({}))
    this.processRunner = dependencies.processRunner ?? runProcess
    this.executable = dependencies.resolveExecutable ?? resolveExecutable
    this.fetchNpmLatest = dependencies.fetchNpmLatest ?? fetchNpmLatest
    this.fetchMnemonLatest = dependencies.fetchMnemonLatest ?? fetchMnemonLatest
  }

  get currentDshMnemonVersion(): string {
    return this.dshMnemonVersion
  }

  private async inspectMnemon(): Promise<{ install: MnemonInstall; current?: string }> {
    const configured = this.mnemonCliPath() ?? findMnemonCommand({})
    const command = configured === undefined ? undefined : this.executable(configured)
    if (command === undefined) return { install: { mode: 'missing' } }
    let current: string | undefined
    try {
      current = versionFrom((await resultOrThrow(this.processRunner, command, ['--version'], CHECK_TIMEOUT_MS)).stdout)
    } catch {
      return { install: { mode: 'manual', command } }
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
        const metadata = await resultOrThrow(this.processRunner, go, ['version', '-m', command], CHECK_TIMEOUT_MS)
        if (metadata.stdout.includes(MNEMON_MODULE)) {
          return { ...(current === undefined ? {} : { current }), install: { mode: 'go', command, updateCommand: go, updateArgs: ['install', `${MNEMON_MODULE}@latest`] } }
        }
      } catch {
        // A non-Go binary falls through to the manual installation mode.
      }
    }
    return { ...(current === undefined ? {} : { current }), install: { mode: 'manual', command } }
  }

  async check(): Promise<VersionStatus> {
    const [mnemonLocal, mnemonLatest, dshLatest] = await Promise.all([
      settledWithin(this.inspectMnemon(), { install: { mode: 'missing' } }),
      settledWithin(this.fetchMnemonLatest(), undefined),
      settledWithin(this.fetchNpmLatest(DSH_MNEMON_PACKAGE), undefined),
    ])
    const dshInstall = inspectDshInstall(this.packageManifestPath, this.dshHome)
    const pnpm = this.executable('pnpm')
    const mnemonOutdated = mnemonLocal.current !== undefined && mnemonLatest !== undefined && compareVersions(mnemonLocal.current, mnemonLatest) < 0
    const dshOutdated = dshLatest !== undefined && compareVersions(this.currentDshMnemonVersion, dshLatest) < 0
    const mnemonSupported = mnemonLocal.install.updateCommand !== undefined
    const dshSupported = dshInstall.mode === 'npm' && dshInstall.profileDir !== undefined && pnpm !== undefined
    return {
      checkedAt: new Date().toISOString(),
      components: [
        {
          id: 'mnemon',
          name: 'Mnemon CLI',
          ...(mnemonLocal.install.command === undefined ? {} : { executablePath: mnemonLocal.install.command }),
          ...(mnemonLocal.current === undefined ? {} : { current: mnemonLocal.current }),
          ...(mnemonLatest === undefined ? {} : { latest: mnemonLatest }),
          outdated: mnemonOutdated,
          installMode: mnemonLocal.install.mode,
          updateSupported: mnemonSupported,
          updateHint: mnemonLocal.install.mode === 'homebrew'
            ? mnemonSupported ? 'brew' : 'brew-missing'
            : mnemonLocal.install.mode === 'go'
              ? 'go'
              : mnemonLocal.install.mode === 'missing' ? 'install' : 'manual',
          ...(mnemonLatest === undefined ? { checkError: 'latest-unavailable' } : {}),
        },
        {
          id: 'dsh-mnemon',
          name: 'dsh-mnemon',
          ...(dshInstall.profileName === undefined ? {} : { installProfile: dshInstall.profileName }),
          installPath: dshInstall.locationDir,
          current: this.currentDshMnemonVersion,
          ...(dshLatest === undefined ? {} : { latest: dshLatest }),
          outdated: dshOutdated,
          installMode: dshInstall.mode,
          updateSupported: dshSupported,
          updateHint: dshInstall.mode === 'npm'
            ? dshSupported ? 'pnpm' : 'pnpm-missing'
            : dshInstall.mode === 'link' ? 'link' : 'manual',
          ...(dshLatest === undefined ? { checkError: 'latest-unavailable' } : {}),
        },
      ],
    }
  }

  async update(component: VersionComponentId): Promise<VersionUpdateResult> {
    if (component === 'mnemon') {
      const before = await this.inspectMnemon()
      const latest = await this.fetchMnemonLatest()
      if (before.current === undefined) throw new Error('Mnemon CLI is unavailable')
      if (latest === undefined) throw new Error('Unable to verify the latest Mnemon release')
      if (compareVersions(before.current, latest) >= 0) return { component, previousVersion: before.current, currentVersion: before.current, updated: false, restartRequired: false }
      if (before.install.updateCommand === undefined || before.install.updateArgs === undefined) throw new Error('This Mnemon installation cannot be updated automatically')
      const output = await resultOrThrow(this.processRunner, before.install.updateCommand, before.install.updateArgs, UPDATE_TIMEOUT_MS)
      const after = await this.inspectMnemon()
      const outputText = updateOutput(output)
      return {
        component,
        previousVersion: before.current,
        currentVersion: after.current ?? latest,
        updated: true,
        restartRequired: false,
        ...(outputText === undefined ? {} : { output: outputText }),
      }
    }

    if (component !== 'dsh-mnemon') throw new Error(`Unknown version component: ${String(component)}`)
    const latest = await this.fetchNpmLatest(DSH_MNEMON_PACKAGE)
    if (latest === undefined) throw new Error('Unable to verify the latest dsh-mnemon release')
    if (compareVersions(this.currentDshMnemonVersion, latest) >= 0) return { component, previousVersion: this.currentDshMnemonVersion, currentVersion: this.currentDshMnemonVersion, updated: false, restartRequired: false }
    const install = inspectDshInstall(this.packageManifestPath, this.dshHome)
    const pnpm = this.executable('pnpm')
    if (install.mode !== 'npm' || install.profileDir === undefined || pnpm === undefined) throw new Error('This dsh-mnemon installation cannot be updated automatically')
    const output = await resultOrThrow(this.processRunner, pnpm, ['update', DSH_MNEMON_PACKAGE], UPDATE_TIMEOUT_MS, { cwd: install.profileDir })
    const outputText = updateOutput(output)
    this.dshMnemonVersion = latest
    return {
      component,
      previousVersion: this.currentDshMnemonVersion,
      currentVersion: latest,
      updated: true,
      restartRequired: true,
      ...(outputText === undefined ? {} : { output: outputText }),
    }
  }
}
