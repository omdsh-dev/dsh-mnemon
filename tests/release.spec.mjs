import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createReleasePlan, packRelease, publishRelease, readReleasePackages } from '../scripts/release.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
function fixture(version = '0.5.0-beta.1', distTag = 'beta') {
  const provider = { directory: '/provider', manifest: { name: 'dsh-mnemon-provider-example', version, publishConfig: { access: 'public', tag: distTag } } }
  const starter = { directory: '/starter', manifest: { name: 'dsh-mnemon', version, publishConfig: { access: 'public', tag: distTag }, dependencies: { [provider.manifest.name]: version } } }
  return [starter, provider]
}

describe('complete, channel-safe official release', () => {
  it('validates every real package and publishes the Starter last', async () => {
    const packages = await readReleasePackages(root)
    const plan = createReleasePlan(packages)
    expect(plan.packages).toHaveLength(14)
    expect(plan.distTag).toBe('beta')
    expect(plan.packages.at(-1).manifest.name).toBe('dsh-mnemon')
    for (const { directory, manifest } of packages.filter(item => item.manifest.name.startsWith('dsh-mnemon-provider-'))) {
      // Provider contribution metadata must not retain the previous product version.
      const source = await readFile(join(directory, 'src/index.ts'), 'utf8')
      expect(source).toContain(`version: '${manifest.version}'`)
    }
  })

  it.each([['0.5.0', 'latest', false], ['0.5.0-beta.1', 'beta', true], ['0.5.0-rc.1', 'rc', true]])('selects the explicit channel for %s', (version, channel, prerelease) => {
    expect(createReleasePlan(fixture(version, channel), { tag: `v${version}`, prerelease }).distTag).toBe(channel)
  })

  it('rejects tag, prerelease and publishConfig mismatches before packing', () => {
    expect(() => createReleasePlan(fixture(), { tag: 'v0.4.0' })).toThrow('Release tag')
    expect(() => createReleasePlan(fixture(), { prerelease: false })).toThrow('prerelease flag')
    expect(() => createReleasePlan(fixture('0.5.0-beta.1', 'latest'))).toThrow('publishConfig.tag')
    expect(() => createReleasePlan(fixture('0.5.0-dev.1'))).toThrow('Expected a stable version')
  })

  it('rejects missing artifacts, skewed versions and old peer ranges', () => {
    const packages = fixture()
    packages[0].manifest.dependencies['dsh-mnemon-source-missing'] = '0.5.0-beta.1'
    expect(() => createReleasePlan(packages)).toThrow('missing release artifact')
    const skewed = fixture()
    skewed[1].manifest.version = '0.4.0'
    expect(() => createReleasePlan(skewed)).toThrow('versions must agree')
    const stalePeer = fixture()
    stalePeer[1].manifest.peerDependencies = { 'dsh-mnemon': '^0.4.0' }
    expect(() => createReleasePlan(stalePeer)).toThrow('must pin the tested release version')
  })

  it('packs all packages before any publish and passes an explicit non-latest tag', async () => {
    const plan = createReleasePlan(fixture())
    const calls = []
    const run = vi.fn(async (args, cwd) => {
      calls.push(args)
      if (args[0] !== 'pack') return ''
      const { manifest } = plan.packages.find(item => item.directory === cwd)
      return JSON.stringify([{ name: manifest.name, version: plan.version, filename: manifest.name + '.tgz', files: [{ path: 'LICENSE' }] }])
    })
    const artifacts = await packRelease(plan, '/packed', run)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try { await publishRelease(plan, artifacts, run) } finally { log.mockRestore() }
    expect(calls.map(args => args[0])).toEqual(['pack', 'pack', 'publish', 'publish'])
    for (const args of calls.filter(args => args[0] === 'publish')) {
      expect(args.slice(-2)).toEqual(['--tag', 'beta'])
      expect(args).toContain('--ignore-scripts')
    }
    expect(calls.at(-1)[1]).toBe(join('/packed', 'dsh-mnemon.tgz'))
  })

  it('refuses partial artifact sets and stops before publishing the Starter after a plugin failure', async () => {
    const plan = createReleasePlan(fixture())
    const artifacts = plan.packages.map(item => ({ name: item.manifest.name, filename: item.manifest.name + '.tgz' }))
    const run = vi.fn(async () => { throw new Error('registry rejected publish') })
    await expect(publishRelease(plan, artifacts.slice(0, 1), run)).rejects.toThrow('entire release')
    expect(run).not.toHaveBeenCalled()
    await expect(publishRelease(plan, artifacts, run)).rejects.toThrow('registry rejected')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0][1]).not.toBe('dsh-mnemon.tgz')
  })

  it('requires artifact tests and release validation in the actual publishing workflow', async () => {
    const workflow = await readFile(join(root, '.github/workflows/publish.yml'), 'utf8')
    expect(workflow).toContain('pnpm run release:check')
    expect(workflow).toContain('pnpm run verify:plugins')
    expect(workflow).toContain('node scripts/release.mjs --publish')
    expect(workflow).toContain('RELEASE_PRERELEASE: ${{ github.event.release.prerelease }}')
    expect(workflow).not.toContain('npm publish "dsh-mnemon-')
  })
})
