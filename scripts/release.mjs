import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const execute = promisify(execFile)

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
      // Optional strategy contributions ship independently, not in the default
      // Starter. The development workspace still pins and tests their artifact.
      assert.equal(starter.manifest.dependencies?.[manifest.name] ?? starter.manifest.devDependencies?.[manifest.name], version, `${manifest.name}: Starter must pin the tested plugin version (runtime or development)`)
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
  return { version, distTag, packages: [...plugins, starter] }
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
  const { stdout } = await execute('npm', args, { cwd, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

export async function packRelease(plan, destination, run = npm) {
  const artifacts = []
  for (const item of plan.packages) {
    const output = await run(['pack', '--ignore-scripts', '--json', '--pack-destination', destination], item.directory)
    const [artifact] = JSON.parse(output)
    assert.equal(artifact.name, item.manifest.name, 'Unexpected packed package')
    assert.equal(artifact.version, plan.version, 'Unexpected packed version')
    assert.equal(artifact.filename, basename(artifact.filename), 'Artifact filename must not escape the destination')
    assert(artifact.files.some(file => file.path === 'LICENSE'), `${artifact.name}: packed license is missing`)
    artifacts.push({ name: artifact.name, filename: join(destination, artifact.filename) })
  }
  return artifacts
}

export async function publishRelease(plan, artifacts, run = npm) {
  assert.deepEqual(artifacts.map(item => item.name), plan.packages.map(item => item.manifest.name), 'Pack the entire release before publishing')
  for (const artifact of artifacts) {
    await run(['publish', artifact.filename, '--access', 'public', '--ignore-scripts', '--tag', plan.distTag], root)
    console.log(`Published ${artifact.name}@${plan.version} to ${plan.distTag}`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const mode = args[0] ?? '--check'
  assert(args.length <= 1 && ['--check', '--pack', '--publish'].includes(mode), 'Use --check, --pack or --publish')
  const { RELEASE_TAG, RELEASE_PRERELEASE } = process.env
  if (mode === '--publish') assert(RELEASE_TAG && RELEASE_PRERELEASE, 'Publication requires explicit RELEASE_TAG and RELEASE_PRERELEASE')
  if (RELEASE_PRERELEASE !== undefined) assert(['true', 'false'].includes(RELEASE_PRERELEASE), 'RELEASE_PRERELEASE must be true or false')
  const plan = createReleasePlan(await readReleasePackages(), {
    tag: RELEASE_TAG, prerelease: RELEASE_PRERELEASE === undefined ? undefined : RELEASE_PRERELEASE === 'true',
  })
  console.log(JSON.stringify({ version: plan.version, distTag: plan.distTag, packages: plan.packages.map(item => item.manifest.name) }, null, 2))
  if (mode === '--check') return
  const destination = await mkdtemp(join(tmpdir(), 'mnemon-release-'))
  let published = false
  try {
    const artifacts = await packRelease(plan, destination)
    if (mode === '--publish') { await publishRelease(plan, artifacts); published = true }
  } finally {
    if (published) await rm(destination, { recursive: true, force: true })
    else console.log(`Release artifacts retained: ${destination}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
