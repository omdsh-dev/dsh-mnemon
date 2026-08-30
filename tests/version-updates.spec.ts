import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    const run = vi.fn<ProcessRunner>(async () => ({ stdout: 'updated', stderr: '', exitCode: 0 }))
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
    await expect(manager.update('dsh-mnemon')).resolves.toMatchObject({ updated: true, currentVersion: '0.1.3', restartRequired: true })
    expect(manager.currentDshMnemonVersion).toBe('0.1.3')
    expect(run).toHaveBeenCalledWith(expect.stringMatching(/pnpm$/), ['update', 'dsh-mnemon'], expect.objectContaining({ timeoutMs: 600_000, maxOutputBytes: 16 * 1024, cwd: profile }))
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
