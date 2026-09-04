import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  createReleasePlan,
  devOnlyManifestChanges,
  publicationInputsChanged,
  readChangedPaths,
  readReleasePackages,
} from './release.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const execute = promisify(execFile)
const require = createRequire(import.meta.url)
const changesetBin = require.resolve('@changesets/cli/bin.js')

async function git(args) {
  const { stdout } = await execute('git', args, { cwd: root, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
  return stdout.trim()
}

export function assertReleaseIntentCoverage(changedPackages, releases) {
  const covered = new Set(releases.map(release => release.name))
  const missing = [...changedPackages].filter(name => !covered.has(name)).sort()
  assert.equal(missing.length, 0, `Published inputs changed without a changeset: ${missing.join(', ')}`)
  return covered
}

async function readChangesetStatusSince(baseRevision) {
  const directory = await mkdtemp(join(tmpdir(), 'mnemon-changeset-status-'))
  const output = join(directory, 'status.json')
  try {
    await execute(process.execPath, [changesetBin, 'status', '--since', baseRevision, '--output', output], {
      cwd: root,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return JSON.parse(await readFile(output, 'utf8'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function main() {
  const revision = process.env.CHANGESET_REVISION?.trim() || await git(['rev-parse', 'HEAD'])
  const baseRevision = process.env.CHANGESET_BASE_REVISION?.trim() || await git(['merge-base', revision, 'origin/main'])
  for (const value of [baseRevision, revision]) assert.match(value, /^[0-9a-f]{40}$/u, 'Changeset validation requires full Git revisions')

  const packages = await readReleasePackages()
  const plan = createReleasePlan(packages)
  const paths = await readChangedPaths(baseRevision, revision)
  const ignoredPackageJson = await devOnlyManifestChanges(plan, paths, baseRevision, revision)
  const changedPackages = publicationInputsChanged(plan, paths, { ignoredPackageJson })
  const status = await readChangesetStatusSince(baseRevision)
  assertReleaseIntentCoverage(changedPackages, status.releases)

  console.log(changedPackages.size === 0
    ? 'No published package inputs changed; no release intent is required.'
    : `Verified changeset coverage for ${[...changedPackages].sort().join(', ')}.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
