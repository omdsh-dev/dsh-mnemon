import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessRunner } from '../src/host/process.ts'
import { compareVersions, VersionUpdateManager } from "../src/host/version-updates.ts"

const temporary: string[] = []

function directory(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `dsh-mnemon-${label}-`))
  temporary.push(path)
  return path
}

function json(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), 'utf8')
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('VersionUpdateManager', () => {
  it('compares releases and prereleases using semantic-version precedence', () => {
    expect(compareVersions('0.1.9', '0.1.10')).toBeLessThan(0)
    expect(compareVersions('v1.0.0-rc.2', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0+build.2', '1.0.0+build.1')).toBe(0)
  })

  it('reports a local DSH link without offering a destructive package update', async () => {
    const root = directory('link-source')
    const dshHome = directory('link-home')
    const profile = join(dshHome, 'profiles', 'web')
    mkdirSync(profile, { recursive: true })
    json(join(root, 'package.json'), { name: 'dsh-mnemon', version: '0.1.2' })
    json(join(profile, 'package.json'), { name: 'dsh-profile-web', dependencies: { 'dsh-mnemon': `link:${root}` } })
    const manager = new VersionUpdateManager({
      packageManifestPath: join(root, 'package.json'),
      dshHome,
      mnemonCliPath: () => '/missing/mnemon',
      resolveExecutable: () => undefined,
      fetchNpmLatest: async () => '0.1.3',
      fetchMnemonLatest: async () => '0.2.0',
    })

    const status = await manager.check()
    expect(status.components.find(component => component.id === 'dsh-mnemon')).toMatchObject({
      current: '0.1.2', latest: '0.1.3', outdated: true, installMode: 'link', installProfile: 'web', installPath: root, updateSupported: false, updateHint: 'link',
    })
  })

  it('reports the Mnemon executable used for the version check', async () => {
    const root = directory('executable-path')
    const command = join(root, 'mnemon')
    writeFileSync(command, '#!/bin/sh\n', 'utf8')
    chmodSync(command, 0o755)
    const manager = new VersionUpdateManager({
      packageManifestPath: join(root, 'package.json'),
      mnemonCliPath: () => command,
      resolveExecutable: value => value === command ? command : undefined,
      processRunner: async () => ({ stdout: 'mnemon version 0.2.3\n', stderr: '', exitCode: 0 }),
      fetchNpmLatest: async () => '0.1.4',
      fetchMnemonLatest: async () => '0.2.3',
    })

    const status = await manager.check()
    expect(status.components.find(component => component.id === 'mnemon')).toMatchObject({
      executablePath: command,
      current: '0.2.3',
      latest: '0.2.3',
    })
    expect(status.components.find(component => component.id === 'dsh-mnemon')).toMatchObject({
      installMode: 'manual',
      installPath: root,
    })
  })

  it('updates an npm-managed plugin only inside its owning DSH profile', async () => {
    const profile = directory('npm-profile')
    const packageRoot = join(profile, 'node_modules', 'dsh-mnemon')
    mkdirSync(packageRoot, { recursive: true })
    json(join(profile, 'package.json'), { name: 'dsh-profile-web', dependencies: { 'dsh-mnemon': '^0.1.2' } })
    json(join(packageRoot, 'package.json'), { name: 'dsh-mnemon', version: '0.1.2' })
    const run = vi.fn<ProcessRunner>(async () => {
      json(join(packageRoot, 'package.json'), { name: 'dsh-mnemon', version: '0.1.3' })
      return { stdout: 'updated', stderr: '', exitCode: 0 }
    })
    const manager = new VersionUpdateManager({
      packageManifestPath: join(packageRoot, 'package.json'),
      mnemonCliPath: () => '/missing/mnemon',
      resolveExecutable: command => command === 'pnpm' ? '/fake/pnpm' : undefined,
      processRunner: run,
      fetchNpmLatest: async () => '0.1.3',
      fetchMnemonLatest: async () => '0.2.0',
    })

    const status = await manager.check()
    expect(status.components.find(component => component.id === 'dsh-mnemon')).toMatchObject({
      installMode: 'npm',
      installProfile: 'web',
      installPath: profile,
    })
    await expect(manager.update('dsh-mnemon')).resolves.toMatchObject({ updated: true, previousVersion: '0.1.2', currentVersion: '0.1.3', restartRequired: true })
    expect(manager.currentDshMnemonVersion).toBe('0.1.3')
    expect(run).toHaveBeenCalledWith(expect.stringMatching(/pnpm$/), ['add', 'dsh-mnemon@0.1.3', '--save-exact'], expect.objectContaining({ timeoutMs: 600_000, maxOutputBytes: 16 * 1024, cwd: profile }))
  })

  function npmFixture(current: string, tags: Record<string, string | undefined>) {
    const profile = directory('npm-channel')
    const packageRoot = join(profile, 'node_modules', 'dsh-mnemon')
    mkdirSync(packageRoot, { recursive: true })
    json(join(profile, 'package.json'), { name: 'dsh-profile-web', dependencies: { 'dsh-mnemon': current } })
    json(join(packageRoot, 'package.json'), { name: 'dsh-mnemon', version: current })
    const fetch = vi.fn(async (_name: string, tag = 'latest') => tags[tag])
    const run = vi.fn<ProcessRunner>(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    const options = {
      packageManifestPath: join(packageRoot, 'package.json'), dshHome: profile,
      mnemonCliPath: () => '/missing/mnemon', resolveExecutable: (name: string) => name === 'pnpm' ? '/fake/pnpm' : undefined,
      processRunner: run, fetchNpmLatest: fetch, fetchMnemonLatest: async () => undefined,
    }
    return { profile, packageRoot, fetch, run, options, manager: new VersionUpdateManager(options) }
  }

  it('finds beta updates without exposing prereleases to stable users', async () => {
    const beta = npmFixture('0.5.0-beta.1', { latest: '0.4.0', beta: '0.5.0-beta.2' })
    expect((await beta.manager.check()).components[1]).toMatchObject({ current: '0.5.0-beta.1', latest: '0.5.0-beta.2', outdated: true })
    expect(beta.fetch.mock.calls.map(call => call[1])).toEqual(['latest', 'beta'])
    const stable = npmFixture('0.4.0', { latest: '0.4.1', beta: '0.5.0-beta.2' })
    expect((await stable.manager.check()).components[1]).toMatchObject({ latest: '0.4.1', outdated: true })
    expect(stable.fetch).toHaveBeenCalledTimes(1)
    expect(stable.fetch).toHaveBeenCalledWith('dsh-mnemon', 'latest')
    expect(stable.run).not.toHaveBeenCalled()
  })

  it('offers the final stable version to beta users but never downgrades to an older stable version', async () => {
    const beta = npmFixture('0.5.0-beta.1', { latest: '0.5.0', beta: '0.5.0-beta.2' })
    expect((await beta.manager.check()).components[1]).toMatchObject({ latest: '0.5.0', outdated: true })
    const older = npmFixture('0.5.0-beta.1', { latest: '0.4.0' })
    await expect(older.manager.update('dsh-mnemon')).resolves.toMatchObject({ updated: false, currentVersion: '0.5.0-beta.1' })
    expect(older.run).not.toHaveBeenCalled()
  })

  it('rejects a mis-tagged prerelease instead of silently enrolling a stable user', async () => {
    const stable = npmFixture('0.4.0', { latest: '0.5.0-beta.2' })
    expect((await stable.manager.check()).components[1]).toMatchObject({ outdated: false, checkError: 'latest-unavailable' })
    await expect(stable.manager.update('dsh-mnemon')).rejects.toThrow('Unable to verify')
    expect(stable.run).not.toHaveBeenCalled()
  })

  it('installs the exact checked beta and verifies the profile link instead of pnpm’s old package directory', async () => {
    const value = npmFixture('0.5.0-beta.1', { latest: '0.4.0', beta: '0.5.0-beta.2' })
    const oldManifest = join(value.profile, 'node_modules/.pnpm/old/node_modules/dsh-mnemon/package.json')
    mkdirSync(join(value.profile, 'node_modules/.pnpm/old/node_modules/dsh-mnemon'), { recursive: true })
    json(oldManifest, { name: 'dsh-mnemon', version: '0.5.0-beta.1' })
    const manager = new VersionUpdateManager({ ...value.options, packageManifestPath: oldManifest })
    value.run.mockImplementation(async () => {
      json(join(value.packageRoot, 'package.json'), { name: 'dsh-mnemon', version: '0.5.0-beta.2' })
      return { stdout: 'installed', stderr: '', exitCode: 0 }
    })
    await expect(manager.update('dsh-mnemon')).resolves.toMatchObject({ previousVersion: '0.5.0-beta.1', currentVersion: '0.5.0-beta.2', updated: true, restartRequired: true })
    expect(value.run).toHaveBeenCalledWith('/fake/pnpm', ['add', 'dsh-mnemon@0.5.0-beta.2', '--save-exact'], expect.objectContaining({ cwd: value.profile }))
  })

  it('does not report success when pnpm exits cleanly without installing the requested version', async () => {
    const value = npmFixture('0.5.0-beta.1', { beta: '0.5.0-beta.2' })
    await expect(value.manager.update('dsh-mnemon')).rejects.toThrow('did not install the requested version')
    expect(value.manager.currentDshMnemonVersion).toBe('0.5.0-beta.1')
  })

  it('preserves the known version on installation or registry failure', async () => {
    const value = npmFixture('0.5.0-beta.1', { beta: '0.5.0-beta.2' })
    value.run.mockResolvedValue({ stdout: '', stderr: 'fixture network failure', exitCode: 1 })
    await expect(value.manager.update('dsh-mnemon')).rejects.toThrow('fixture network failure')
    expect(value.manager.currentDshMnemonVersion).toBe('0.5.0-beta.1')
    value.fetch.mockRejectedValue(new Error('registry unavailable'))
    expect((await value.manager.check()).components[1]).toMatchObject({ outdated: false, checkError: 'latest-unavailable' })
  })

  function goFixture(location: 'gobin' | 'gopath' | 'download' = 'gobin') {
    const root = directory('go-install')
    const goPath = join(root, 'go')
    const bin = location === 'gopath' ? join(goPath, 'bin') : join(root, 'custom-bin')
    const commandDir = location === 'download' ? join(root, 'download') : bin
    mkdirSync(commandDir, { recursive: true })
    const command = join(commandDir, process.platform === 'win32' ? 'mnemon.exe' : 'mnemon')
    writeFileSync(command, 'synthetic executable; process execution is mocked', 'utf8')
    const environment = {
      GOBIN: location === 'gopath' ? '' : bin,
      GOPATH: [goPath, join(root, 'other-go')].join(delimiter),
      GOOS: process.platform, GOHOSTOS: process.platform,
      GOARCH: process.arch, GOHOSTARCH: process.arch,
    }
    const state = { current: '0.2.0', installed: '0.3.0', mainPath: 'github.com/mnemon-dev/mnemon' }
    const run = vi.fn<ProcessRunner>(async (_command, args) => {
      if (args[0] === '--version') return { stdout: `mnemon version ${state.current}\n`, stderr: '', exitCode: 0 }
      if (args[0] === 'env') return { stdout: JSON.stringify(environment), stderr: '', exitCode: 0 }
      if (args[0] === 'version') return { stdout: `\tpath\t${state.mainPath}\n\tdep\tgithub.com/mnemon-dev/mnemon\tv0.2.0\n`, stderr: '', exitCode: 0 }
      if (args[0] === 'install') {
        state.current = state.installed
        return { stdout: 'go install completed', stderr: '', exitCode: 0 }
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    })
    const manager = new VersionUpdateManager({
      packageManifestPath: join(root, 'package.json'), dshHome: root,
      mnemonCliPath: () => command,
      resolveExecutable: value => value === command ? command : value === 'go' ? '/fake/go' : undefined,
      processRunner: run,
      fetchNpmLatest: async () => undefined,
      fetchMnemonLatest: async () => '0.3.0',
    })
    return { command, environment, state, run, manager }
  }

  it.each(['gobin', 'gopath'] as const)('updates a Go install only at its actual %s output location', async location => {
    const value = goFixture(location)
    expect((await value.manager.check()).components[0]).toMatchObject({ installMode: 'go', updateSupported: true, executablePath: value.command })
    expect(value.run.mock.calls.some(([, args]) => args[0] === 'install')).toBe(false)
    await expect(value.manager.update('mnemon')).resolves.toMatchObject({ previousVersion: '0.2.0', currentVersion: '0.3.0', updated: true })
    expect(value.run).toHaveBeenCalledWith('/fake/go', ['install', 'github.com/mnemon-dev/mnemon@latest'], expect.objectContaining({ timeoutMs: 600_000 }))
  })

  it('keeps downloaded Go binaries outside the install output directory manual', async () => {
    const value = goFixture('download')
    expect((await value.manager.check()).components[0]).toMatchObject({ current: '0.2.0', outdated: true, installMode: 'manual', updateSupported: false })
    await expect(value.manager.update('mnemon')).rejects.toThrow('cannot be updated automatically')
    expect(value.run.mock.calls.some(([, args]) => args[0] === 'install')).toBe(false)
  })

  it('does not mistake a dependency for the main Go executable package', async () => {
    const value = goFixture()
    value.state.mainPath = 'example.com/other-tool'
    expect((await value.manager.check()).components[0]).toMatchObject({ installMode: 'manual', updateSupported: false })
  })

  it('does not offer Go updates when cross compilation would change the output location', async () => {
    const value = goFixture()
    value.environment.GOARCH = process.arch === 'arm64' ? 'x64' : 'arm64'
    expect((await value.manager.check()).components[0]).toMatchObject({ installMode: 'manual', updateSupported: false })
  })

  it.each(['0.2.0', 'unknown'])('does not report a successful CLI update when the active version is %s', async installed => {
    const value = goFixture()
    value.state.installed = installed
    await expect(value.manager.update('mnemon')).rejects.toThrow('Mnemon update did not activate version 0.3.0')
  })

  it('uses the fixed Homebrew cask command for a recognized Mnemon install', async () => {
    const root = directory('brew')
    const command = join(root, 'Caskroom', 'mnemon', '0.2.0', 'mnemon')
    mkdirSync(join(root, 'Caskroom', 'mnemon', '0.2.0'), { recursive: true })
    writeFileSync(command, '#!/bin/sh\n', 'utf8')
    chmodSync(command, 0o755)
    let versionCalls = 0
    const run = vi.fn<ProcessRunner>(async (_command, args) => {
      if (args[0] === '--version') {
        versionCalls++
        return { stdout: `mnemon version ${versionCalls > 1 ? '0.3.0' : '0.2.0'}\n`, stderr: '', exitCode: 0 }
      }
      return { stdout: 'brew upgraded mnemon', stderr: '', exitCode: 0 }
    })
    const manager = new VersionUpdateManager({
      packageManifestPath: join(root, 'package.json'),
      mnemonCliPath: () => command,
      resolveExecutable: value => value === command ? command : value === 'brew' ? '/fake/brew' : undefined,
      processRunner: run,
      fetchNpmLatest: async () => '0.1.2',
      fetchMnemonLatest: async () => '0.3.0',
    })

    await expect(manager.update('mnemon')).resolves.toMatchObject({ previousVersion: '0.2.0', currentVersion: '0.3.0', updated: true })
    expect(run).toHaveBeenCalledWith(expect.stringMatching(/brew$/), ['upgrade', '--cask', 'mnemon'], expect.objectContaining({ timeoutMs: 600_000 }))
  })
})
