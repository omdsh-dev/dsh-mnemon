import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryPluginInstallation } from '../src/host/plugin-installation.ts'
import type { HostContextShape } from '../src/host/dsh.ts'
import type { ProcessOptions } from '../src/host/process.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function profile() {
  const root = await mkdtemp(join(tmpdir(), 'mnemon-plugin-install-'))
  roots.push(root)
  const directory = join(root, 'profiles', 'web')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'cordis.yml'), '[]\n')
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2))
  const loader = { entries: () => [], config: { baseUrl: pathToFileURL(join(directory, 'cordis.yml')).href } }
  const ctx = { get: (name: string) => name === 'loader' ? loader : undefined } as unknown as HostContextShape
  return { root, directory, ctx }
}

const registryManifest = (name = 'dsh-mnemon-strategy-focus') => ({
  name, version: '0.5.0-beta.4', description: 'A bounded test Strategy.',
  peerDependencies: { 'dsh-mnemon': '^0.5.0-beta.1' }, dsh: { bundle: { patch: './cordis.patch.yml' } },
})

describe('DSH-native Memory plugin installation', () => {
  it('reports the exact active Profile and keeps suggestions distinct from activation', async () => {
    const f = await profile()
    const manager = new MemoryPluginInstallation(f.ctx, { resolveDshCommand: () => ({ command: '/fake/dsh', prefix: [] }) })
    expect(manager.environment()).toEqual({ supported: true, profileName: 'web', suggestions: [
      'dsh-mnemon-strategy-scoped', 'dsh-mnemon-strategy-light-context', 'dsh-mnemon-strategy-auto-capture',
    ] })
  })

  it('discovers a compatible Source or Strategy only from an exact package name', async () => {
    const f = await profile()
    const fetchPackage = vi.fn(async (name: string, tag: string) => registryManifest(name))
    const manager = new MemoryPluginInstallation(f.ctx, { currentVersion: '0.5.0-beta.1', fetchPackage,
      resolveDshCommand: () => ({ command: '/fake/dsh', prefix: [] }) })
    await expect(manager.inspect('dsh-mnemon-strategy-focus')).resolves.toEqual({
      packageName: 'dsh-mnemon-strategy-focus', version: '0.5.0-beta.4', kind: 'strategy',
      description: 'A bounded test Strategy.', mnemonPeerRange: '^0.5.0-beta.1', installed: false,
    })
    expect(fetchPackage).toHaveBeenCalledWith('dsh-mnemon-strategy-focus', 'beta')
    await expect(manager.inspect('file:../plugin')).rejects.toThrow('exact dsh-mnemon')
  })

  it('rejects packages that cannot join the DSH bundle stack', async () => {
    const f = await profile()
    const manager = new MemoryPluginInstallation(f.ctx, { fetchPackage: async name => ({ ...registryManifest(name), dsh: undefined }),
      resolveDshCommand: () => ({ command: '/fake/dsh', prefix: [] }) })
    await expect(manager.inspect('dsh-mnemon-source-notes')).rejects.toThrow('bundle patch')
  })

  it('installs an inspected exact version through the current DSH Profile and verifies registration', async () => {
    const f = await profile()
    const processRunner = vi.fn(async (command: string, args: readonly string[], options: ProcessOptions) => {
      const value = JSON.parse(await readFile(join(f.directory, 'package.json'), 'utf8')) as Record<string, any>
      value.dependencies['dsh-mnemon-strategy-focus'] = '0.5.0-beta.4'
      value.dsh.profile.bundles.push('dsh-mnemon-strategy-focus')
      await writeFile(join(f.directory, 'package.json'), JSON.stringify(value, null, 2))
      expect(command).toBe(process.execPath)
      expect(args).toEqual(['/opt/dsh/lib/bin.js', 'plugin', '--profile', 'web', 'add', 'dsh-mnemon-strategy-focus@0.5.0-beta.4', '--save-exact'])
      expect(options.env?.DSH_HOME).toBe(f.root)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const manager = new MemoryPluginInstallation(f.ctx, { currentVersion: '0.5.0-beta.1', fetchPackage: async name => registryManifest(name), processRunner,
      resolveDshCommand: () => ({ command: process.execPath, prefix: ['/opt/dsh/lib/bin.js'] }) })
    await expect(manager.install('dsh-mnemon-strategy-focus', '0.5.0-beta.4')).resolves.toEqual({
      packageName: 'dsh-mnemon-strategy-focus', version: '0.5.0-beta.4', profileName: 'web', installed: true, restartRequired: true,
    })
    expect(processRunner).toHaveBeenCalledOnce()
  })

  it('requires a Loader-owned Profile and rechecks the inspected version', async () => {
    const noLoader = { get: () => undefined } as unknown as HostContextShape
    expect(new MemoryPluginInstallation(noLoader).environment()).toMatchObject({ supported: false, reason: 'loader-unavailable' })
    const f = await profile()
    const manager = new MemoryPluginInstallation(f.ctx, { fetchPackage: async name => registryManifest(name), resolveDshCommand: () => ({ command: '/fake/dsh', prefix: [] }) })
    await expect(manager.install('dsh-mnemon-strategy-focus', '0.5.0-beta.3')).rejects.toThrow('version changed')
  })

  it('activates a registered Source Entry and reports only the observed runtime state', async () => {
    const f = await profile()
    let active = false
    const entry = {
      id: 'notion', disabled: true,
      options: { id: 'notion', name: 'dsh-mnemon-source-notion', disabled: true },
      parent: { tree: { import: async () => ({}) } }, fiber: { await: async () => {} },
      update: vi.fn(async ({ disabled }: { disabled?: boolean | null }) => {
        entry.disabled = disabled === true
        entry.options.disabled = disabled === true
        active = disabled !== true
      }),
    }
    const loader = { entries: () => [entry], config: { baseUrl: pathToFileURL(join(f.directory, 'cordis.yml')).href } }
    const ctx = { ...f.ctx, settings: { writable: true }, get: (name: string) => name === 'loader' ? loader : undefined } as unknown as HostContextShape
    const engine = { contributionSnapshot: () => ({ sources: active ? [{ provenance: { entryId: 'notion' } }] : [], strategies: [], strategyExtensions: [] }),
      batch: async (operation: () => Promise<void>) => operation() }
    const manager = new MemoryPluginInstallation(ctx, { engine: engine as never, resolveDshCommand: () => ({ command: '/fake/dsh', prefix: [] }) })
    expect(manager.registered()).toMatchObject([{ entryId: 'notion', enabled: false, active: false, writable: true }])
    await manager.setSourceEnabled('notion', true)
    expect(entry.update).toHaveBeenCalledWith({ disabled: false })
    expect(manager.registered()).toMatchObject([{ entryId: 'notion', enabled: true, active: true }])
  })
})
