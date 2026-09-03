import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const execute = promisify(execFile)
const defaultRegistry = 'https://registry.npmjs.org'
const manifestName = 'release-manifest.json'

/** Official distribution only. External plugin repositories own their releases. */
export function createReleasePlan(packages, { tag, prerelease } = {}) {
  const starter = packages.find(item => item.manifest.name === 'dsh-mnemon')
  assert(starter, 'Release must include the default Starter')
  const { version } = starter.manifest
  const versionMatch = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(alpha|beta|rc)\.(?:0|[1-9]\d*))?$/u.exec(version)
  assert(versionMatch, 'Expected a stable version or an alpha.N / beta.N / rc.N prerelease')
  const distTag = versionMatch[1] ?? 'latest'
  assert.equal(tag ?? `v${version}`, `v${version}`, 'Release tag must match the package version')
  assert.equal(prerelease ?? (distTag !== 'latest'), distTag !== 'latest', 'GitHub prerelease flag must match the package version')
  const names = new Set(packages.map(item => item.manifest.name))
  assert.equal(names.size, packages.length, 'Duplicate package in release')
  const plugins = packages.filter(item => item !== starter).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, 'en'))
  assert(plugins.length > 0, 'Release must include independently packed plugins')
  for (const item of packages) {
    const manifest = item.manifest
    assert.equal(manifest.version, version, `${manifest.name}: release versions must agree`)
    assert.notEqual(manifest.private, true, `${manifest.name}: private package cannot be published`)
    assert.equal(manifest.publishConfig?.access, 'public', `${manifest.name}: public access must be explicit`)
    assert.equal(manifest.publishConfig?.tag, distTag, `${manifest.name}: publishConfig.tag must match the release channel`)
    if (item !== starter) {
      assert.match(manifest.name, /^dsh-mnemon-(?:source|strategy|provider)-[a-z0-9-]+$/u)
      assert.equal(starter.manifest.dependencies?.[manifest.name] ?? starter.manifest.devDependencies?.[manifest.name], version, `${manifest.name}: Starter must pin the tested plugin version (runtime or development)`)
      if (item.directory.startsWith(root + '/')) {
        assert.equal(manifest.repository?.url, 'git+https://github.com/omdsh-dev/dsh-mnemon.git', `${manifest.name}: repository URL must identify the official source`)
        assert.equal(manifest.repository?.directory, relative(root, item.directory), `${manifest.name}: repository directory must identify the package source`)
      }
    }
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (name !== 'dsh-mnemon' && !name.startsWith('dsh-mnemon-')) continue
        assert(names.has(name), `${manifest.name}: missing release artifact for ${name}`)
        assert.equal(range, version, `${manifest.name}: ${field}.${name} must pin the tested release version`)
      }
    }
  }
  // Peer relationships are cyclic; publish every plugin before exposing the
  // one-package Starter installation. All artifacts are packed before any write.
  return { version, distTag, starter, plugins, packages: [...plugins, starter] }
}

export async function readReleasePackages(directory = root) {
  const names = (await readdir(join(directory, 'plugins'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith('dsh-mnemon-')).map(entry => entry.name)
  return Promise.all([directory, ...names.map(name => join(directory, 'plugins', name))].map(async directory => ({
    directory, manifest: JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')),
  })))
}

async function npm(args, cwd) {
  // Release publication runs on Linux. No shell expansion or implicit scripts.
  const { stdout } = await execute('npm', args, { cwd, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

async function fileIntegrity(path) {
  const bytes = await readFile(path)
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

export async function packRelease(plan, destination, run = npm) {
  await mkdir(destination, { recursive: true })
  const existing = await readdir(destination)
  assert.equal(existing.length, 0, `Release artifact directory must be empty: ${destination}`)
  const artifacts = []
  for (const item of plan.packages) {
    const output = await run(['pack', '--ignore-scripts', '--json', '--pack-destination', destination], item.directory)
    const [artifact] = JSON.parse(output)
    assert.equal(artifact.name, item.manifest.name, 'Unexpected packed package')
    assert.equal(artifact.version, plan.version, 'Unexpected packed version')
    assert.equal(artifact.filename, basename(artifact.filename), 'Artifact filename must not escape the destination')
    assert(artifact.files.some(file => file.path === 'LICENSE'), `${artifact.name}: packed license is missing`)
    const filename = join(destination, artifact.filename)
    const integrity = await fileIntegrity(filename)
    if (artifact.integrity !== undefined) assert.equal(artifact.integrity, integrity, `${artifact.name}: npm pack integrity mismatch`)
    artifacts.push({ name: artifact.name, filename, integrity, size: (await stat(filename)).size })
  }
  return artifacts
}

export async function writeReleaseManifest(plan, artifacts, destination, revision = process.env.RELEASE_REVISION) {
  assert.deepEqual(artifacts.map(item => item.name), plan.packages.map(item => item.manifest.name), 'Manifest requires the complete ordered artifact set')
  assert.match(revision ?? '', /^[0-9a-f]{40}$/u, 'A full frozen release revision is required')
  const manifest = {
    schemaVersion: 1,
    revision,
    version: plan.version,
    distTag: plan.distTag,
    packages: artifacts.map(item => ({ ...item, filename: basename(item.filename) })),
  }
  await writeFile(join(destination, manifestName), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

export async function readReleaseArtifacts(plan, destination, revision = process.env.RELEASE_REVISION) {
  const manifest = JSON.parse(await readFile(join(destination, manifestName), 'utf8'))
  assert.equal(manifest.schemaVersion, 1, 'Unsupported release manifest')
  assert.equal(manifest.version, plan.version, 'Artifact version does not match source')
  assert.equal(manifest.distTag, plan.distTag, 'Artifact channel does not match source')
  if (revision !== undefined) assert.equal(manifest.revision, revision, 'Artifacts were not built from the frozen revision')
  assert.deepEqual(manifest.packages.map(item => item.name), plan.packages.map(item => item.manifest.name), 'Artifact manifest does not contain the complete ordered release')
  const artifacts = []
  for (const item of manifest.packages) {
    assert.equal(item.filename, basename(item.filename), `${item.name}: artifact filename must not escape its directory`)
    const filename = join(destination, item.filename)
    assert.equal(await fileIntegrity(filename), item.integrity, `${item.name}: artifact bytes changed after packing`)
    assert.equal((await stat(filename)).size, item.size, `${item.name}: artifact size changed after packing`)
    artifacts.push({ ...item, filename })
  }
  return artifacts
}

function missingRegistryVersion(error) {
  const output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`
  return error?.code === 'E404' || /\bE404\b|404 Not Found|is not in this registry/iu.test(output)
}

export async function inspectRegistryArtifact(name, version, registry = defaultRegistry, run = npm) {
  try {
    const output = await run(['view', `${name}@${version}`, 'version', 'dist.integrity', '--json', '--registry', registry], root)
    const value = JSON.parse(output)
    return { version: value.version, integrity: value['dist.integrity'] }
  } catch (error) {
    if (missingRegistryVersion(error)) return null
    throw error
  }
}

async function waitForRegistryArtifact(expected, registry, run, inspect, attempts = 12) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const published = await inspect(expected.name, expected.version, registry, run)
    if (published !== null) {
      assert.equal(published.version, expected.version, `${expected.name}: unexpected Registry version`)
      assert.equal(published.integrity, expected.integrity, `${expected.name}: Registry bytes differ from the frozen tarball`)
      return published
    }
    if (attempt < attempts) await new Promise(resolveDelay => setTimeout(resolveDelay, 2_000))
  }
  throw new Error(`${expected.name}@${expected.version} did not become readable from ${registry}`)
}

export async function publishRelease(plan, artifacts, run = npm, {
  scope = 'all',
  registry = defaultRegistry,
  inspect = inspectRegistryArtifact,
  provenance = process.env.GITHUB_ACTIONS === 'true',
} = {}) {
  assert.deepEqual(artifacts.map(item => item.name), plan.packages.map(item => item.manifest.name), 'Pack the entire release before publishing')
  assert(['all', 'plugins', 'starter'].includes(scope), 'Unknown publication scope')
  const selected = scope === 'plugins' ? artifacts.slice(0, -1) : scope === 'starter' ? artifacts.slice(-1) : artifacts
  for (const artifact of selected) {
    const expected = { ...artifact, version: plan.version }
    const published = await inspect(artifact.name, plan.version, registry, run)
    if (published !== null) {
      assert.equal(published.integrity, artifact.integrity, `${artifact.name}: refusing to reuse a different Registry artifact at the frozen version`)
      console.log(`Verified existing ${artifact.name}@${plan.version} on ${plan.distTag}`)
      continue
    }
    await run(['publish', artifact.filename, '--access', 'public', '--ignore-scripts', '--tag', plan.distTag, '--registry', registry, ...(provenance ? ['--provenance'] : [])], root)
    await waitForRegistryArtifact(expected, registry, run, inspect)
    console.log(`Published ${artifact.name}@${plan.version} to ${plan.distTag}`)
  }
}

async function verifyInstalledPackages(directory, packages, version) {
  for (const { manifest: { name } } of packages) {
    const installed = JSON.parse(await readFile(join(directory, 'node_modules', name, 'package.json'), 'utf8'))
    assert.equal(installed.version, version, `${name}: installed version differs from the frozen release`)
  }
}

export async function verifyRegistryRelease(plan, artifacts, run = npm, {
  scope = 'all', registry = defaultRegistry, inspect = inspectRegistryArtifact,
} = {}) {
  assert(['all', 'plugins'].includes(scope), 'Unknown Registry verification scope')
  const selected = scope === 'plugins' ? artifacts.slice(0, -1) : artifacts
  for (const artifact of selected) await waitForRegistryArtifact({ ...artifact, version: plan.version }, registry, run, inspect)

  const directory = await mkdtemp(join(tmpdir(), 'mnemon-registry-release-'))
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'mnemon-release-verifier', private: true }, null, 2) + '\n')
    const starter = artifacts.at(-1)
    const target = scope === 'plugins' ? `file:${starter.filename}` : `dsh-mnemon@${plan.version}`
    await run(['install', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--registry', registry, target], directory)
    await verifyInstalledPackages(directory, plan.packages, plan.version)
    console.log(scope === 'plugins'
      ? `Verified all ${plan.plugins.length} plugins from the Registry through the frozen local Starter.`
      : `Verified the published Starter and all ${plan.plugins.length} Registry plugin dependencies.`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function readArguments(arguments_) {
  const mode = arguments_[0] ?? '--check'
  const modes = ['--check', '--pack', '--publish-plugins', '--verify-plugins', '--publish-starter', '--verify-release']
  assert(modes.includes(mode), `Use ${modes.join(', ')}`)
  const options = new Map()
  for (let index = 1; index < arguments_.length; index += 2) {
    assert(['--artifacts', '--registry'].includes(arguments_[index]) && arguments_[index + 1], 'Expected --artifacts <directory> and/or --registry <url>')
    options.set(arguments_[index], arguments_[index + 1])
  }
  return { mode, options }
}

async function main() {
  const { mode, options } = readArguments(process.argv.slice(2))
  const { RELEASE_TAG, RELEASE_PRERELEASE, RELEASE_REVISION } = process.env
  const writesRegistry = mode === '--publish-plugins' || mode === '--publish-starter'
  if (writesRegistry) {
    assert(RELEASE_TAG && RELEASE_PRERELEASE && RELEASE_REVISION, 'Publication requires an explicit tag, prerelease flag and frozen revision')
    assert.match(RELEASE_REVISION, /^[0-9a-f]{40}$/u, 'Publication requires a full frozen revision')
  }
  if (RELEASE_PRERELEASE !== undefined) assert(['true', 'false'].includes(RELEASE_PRERELEASE), 'RELEASE_PRERELEASE must be true or false')
  const plan = createReleasePlan(await readReleasePackages(), {
    tag: RELEASE_TAG, prerelease: RELEASE_PRERELEASE === undefined ? undefined : RELEASE_PRERELEASE === 'true',
  })
  console.log(JSON.stringify({ version: plan.version, distTag: plan.distTag, packages: plan.packages.map(item => item.manifest.name) }, null, 2))
  if (mode === '--check') return

  const destination = resolve(options.get('--artifacts') ?? await mkdtemp(join(tmpdir(), 'mnemon-release-')))
  const registry = options.get('--registry') ?? defaultRegistry
  if (mode === '--pack') {
    const artifacts = await packRelease(plan, destination)
    await writeReleaseManifest(plan, artifacts, destination, RELEASE_REVISION)
    console.log(`Packed ${artifacts.length} frozen artifacts in ${destination}`)
    return
  }
  assert(options.has('--artifacts'), `${mode} requires --artifacts <directory>`)
  const artifacts = await readReleaseArtifacts(plan, destination, RELEASE_REVISION)
  if (mode === '--publish-plugins') await publishRelease(plan, artifacts, npm, { scope: 'plugins', registry })
  if (mode === '--verify-plugins') await verifyRegistryRelease(plan, artifacts, npm, { scope: 'plugins', registry })
  if (mode === '--publish-starter') await publishRelease(plan, artifacts, npm, { scope: 'starter', registry })
  if (mode === '--verify-release') await verifyRegistryRelease(plan, artifacts, npm, { scope: 'all', registry })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
