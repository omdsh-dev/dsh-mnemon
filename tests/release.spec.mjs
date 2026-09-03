import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createReleasePlan, packRelease, publishRelease, readReleasePackages } from '../scripts/release.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
function fixture(version = '0.5.0-rc.1', distTag = 'rc') {
  const provider = { directory: '/provider', manifest: { name: 'dsh-mnemon-provider-example', version, publishConfig: { access: 'public', tag: distTag } } }
  const starter = { directory: '/starter', manifest: { name: 'dsh-mnemon', version, publishConfig: { access: 'public', tag: distTag }, dependencies: { [provider.manifest.name]: version } } }
  return [starter, provider]
}

describe('complete, channel-safe official release', () => {
  it('validates every real package and publishes the Starter last', async () => {
    const packages = await readReleasePackages(root)
    const plan = createReleasePlan(packages)
    expect(plan.packages).toHaveLength(17)
    expect(plan.distTag).toBe('rc')
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
    expect(() => createReleasePlan(fixture('0.5.0-rc.1', 'latest'))).toThrow('publishConfig.tag')
    expect(() => createReleasePlan(fixture('0.5.0-dev.1'))).toThrow('Expected a stable version')
  })

  it('rejects missing artifacts, skewed versions and old peer ranges', () => {
    const packages = fixture()
    packages[0].manifest.dependencies['dsh-mnemon-source-missing'] = '0.5.0-rc.1'
    expect(() => createReleasePlan(packages)).toThrow('missing release artifact')
    const skewed = fixture()
    skewed[1].manifest.version = '0.4.0'
    expect(() => createReleasePlan(skewed)).toThrow('versions must agree')
    const stalePeer = fixture()
    stalePeer[1].manifest.peerDependencies = { 'dsh-mnemon': '^0.4.0' }
    expect(() => createReleasePlan(stalePeer)).toThrow('must pin the tested release version')
  })

  it('releases optional plugins without silently adding them to the default Starter', () => {
    const packages = fixture()
    const optional = { directory: '/optional', manifest: { name: 'dsh-mnemon-strategy-example', version: '0.5.0-rc.1', publishConfig: { access: 'public', tag: 'rc' } } }
    packages[0].manifest.devDependencies = { [optional.manifest.name]: optional.manifest.version }
    expect(createReleasePlan([...packages, optional]).packages.map(item => item.manifest.name)).toContain(optional.manifest.name)
    expect(packages[0].manifest.dependencies).not.toHaveProperty(optional.manifest.name)
    delete packages[0].manifest.devDependencies
    expect(() => createReleasePlan([...packages, optional])).toThrow('pin the tested plugin version')
  })

  it('packs all packages before any publish and passes an explicit non-latest tag', async () => {
    const plan = createReleasePlan(fixture())
    const destination = await mkdtemp(join(tmpdir(), 'mnemon-release-test-'))
    const calls = []
    const published = new Set()
    let artifacts
    const run = vi.fn(async (args, cwd) => {
      calls.push(args)
      if (args[0] === 'publish') {
        published.add(artifacts.find(item => item.filename === args[1]).name)
        return ''
      }
      const { manifest } = plan.packages.find(item => item.directory === cwd)
      const filename = manifest.name + '.tgz'
      await writeFile(join(destination, filename), manifest.name)
      return JSON.stringify([{ name: manifest.name, version: plan.version, filename, files: [{ path: 'LICENSE' }] }])
    })
    artifacts = await packRelease(plan, destination, run)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await publishRelease(plan, artifacts, run, {
        inspect: async name => published.has(name)
          ? { version: plan.version, integrity: artifacts.find(item => item.name === name).integrity }
          : null,
      })
    } finally {
      log.mockRestore()
      await rm(destination, { recursive: true, force: true })
    }
    expect(calls.map(args => args[0])).toEqual(['pack', 'pack', 'publish', 'publish'])
    for (const args of calls.filter(args => args[0] === 'publish')) {
      expect(args).toContain('rc')
      expect(args).toContain('--ignore-scripts')
    }
    expect(calls.at(-1)[1]).toBe(join(destination, 'dsh-mnemon.tgz'))
  })

  it('refuses partial artifact sets and stops before publishing the Starter after a plugin failure', async () => {
    const plan = createReleasePlan(fixture())
    const artifacts = plan.packages.map(item => ({ name: item.manifest.name, filename: item.manifest.name + '.tgz', integrity: `sha512-${item.manifest.name}` }))
    const run = vi.fn(async () => { throw new Error('registry rejected publish') })
    await expect(publishRelease(plan, artifacts.slice(0, 1), run)).rejects.toThrow('entire release')
    expect(run).not.toHaveBeenCalled()
    await expect(publishRelease(plan, artifacts, run, { inspect: async () => null })).rejects.toThrow('registry rejected')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0][1]).not.toBe('dsh-mnemon.tgz')
  })

  it('requires artifact tests and release validation in the actual publishing workflow', async () => {
    const workflow = await readFile(join(root, '.github/workflows/publish.yml'), 'utf8')
    expect(workflow).toContain('pnpm run release:check')
    expect(workflow).toContain('pnpm run verify:plugins')
    expect(workflow).toContain('environment:\n      name: npm-release')
    expect(workflow).toContain('node scripts/release.mjs --publish-plugins')
    expect(workflow).toContain('node scripts/release.mjs --verify-plugins')
    expect(workflow).toContain('node scripts/release.mjs --publish-starter')
    expect(workflow.indexOf('--publish-plugins')).toBeLessThan(workflow.indexOf('--publish-starter'))
    expect(workflow.indexOf('--publish-starter')).toBeLessThan(workflow.indexOf('gh release create'))
    expect(workflow).toContain('--upgrade-from dsh-mnemon@0.4.7')
    expect(workflow).toContain('RELEASE_PRERELEASE: \'true\'')
    expect(workflow).not.toContain('npm publish "dsh-mnemon-')
  })

  it('resumes only when an existing Registry artifact matches the frozen bytes', async () => {
    const plan = createReleasePlan(fixture())
    const artifacts = plan.packages.map(item => ({ name: item.manifest.name, filename: item.manifest.name + '.tgz', integrity: `sha512-${item.manifest.name}` }))
    const run = vi.fn(async () => '')
    const inspect = vi.fn(async name => ({ version: plan.version, integrity: `sha512-${name}` }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try { await publishRelease(plan, artifacts, run, { inspect }) } finally { log.mockRestore() }
    expect(run).not.toHaveBeenCalled()
    await expect(publishRelease(plan, artifacts, run, {
      inspect: async () => ({ version: plan.version, integrity: 'sha512-different' }),
    })).rejects.toThrow('different Registry artifact')
  })
})
