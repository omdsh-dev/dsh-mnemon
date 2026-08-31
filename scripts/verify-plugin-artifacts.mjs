import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
for (const arg of args) if (!['--skip-build', '--keep'].includes(arg)) throw new Error(`Unknown argument: ${arg}`)
const names = (await readdir(join(root, 'plugins'))).filter(name => name.startsWith('dsh-mnemon-')).sort()
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const distTag = manifest.publishConfig.tag
const temporary = await mkdtemp(join(tmpdir(), 'mnemon-plugin-artifacts-'))
assert(!inside(root, temporary), 'The consumer must be outside the development workspace')
const artifacts = new Map()
const artifactManifests = new Map()
let registryUrl = ''
const registry = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1)
  if (path.startsWith('tarballs/')) {
    const artifact = artifacts.get(path.slice('tarballs/'.length))
    if (artifact === undefined) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    createReadStream(artifact).pipe(response)
  } else if (artifactManifests.has(path)) {
    const value = artifactManifests.get(path)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ name: path, 'dist-tags': { [distTag]: value.version }, versions: { [value.version]: { ...value, dist: { tarball: registryUrl + '/tarballs/' + path } } } }))
  } else {
    response.writeHead(307, { location: 'https://registry.npmjs.org' + request.url })
    response.end()
  }
})

function inside(directory, path) {
  const child = relative(directory, path)
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

async function run(command, arguments_, cwd, label) {
  const started = performance.now()
  const output = await new Promise((fulfill, reject) => {
    const child = spawn(command, arguments_, {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      // NODE_PATH must never rescue an undeclared dependency from the workspace.
      env: { ...process.env, NODE_PATH: '', CI: '1', INIT_CWD: cwd },
    })
    let stdout = ''
    let stderr = ''
    const deadline = setTimeout(() => child.kill('SIGTERM'), 180_000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => { clearTimeout(deadline); reject(error) })
    child.on('close', (code, signal) => {
      clearTimeout(deadline)
      if (code === 0) fulfill(stdout)
      else reject(new Error(`${label} failed (${code ?? signal}):\n${stdout.slice(-16_000)}\n${stderr.slice(-8_000)}`))
    })
  })
  console.log(`✓ ${label} (${((performance.now() - started) / 1000).toFixed(1)}s)`)
  return output
}

async function parallel(values, concurrency, action) {
  const pending = [...values]
  // Wait for every in-flight check before cleaning or reporting the directory.
  const results = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
    while (pending.length > 0) await action(pending.shift())
  }))
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) throw new AggregateError(failures, failures.map(error => error.message).join('\n'))
}

async function pack(directory, expectedName) {
  const output = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', join(temporary, 'tarballs')], directory, `pack ${expectedName}`)
  const [artifact] = JSON.parse(output)
  assert.equal(artifact.name, expectedName)
  assert.equal(artifact.version, manifest.version)
  assert(artifact.files.some(file => file.path === 'LICENSE'), `${expectedName} must carry its own license`)
  for (const file of artifact.files) assert(!/^(?:src|tests|node_modules)\//u.test(file.path), `${expectedName} shipped development sources: ${file.path}`)
  artifacts.set(expectedName, join(temporary, 'tarballs', artifact.filename))
  artifactManifests.set(expectedName, JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')))
}

async function install(directory, input) {
  // Serve the exact artifacts with their original semver manifests. This
  // exercises peer resolution and Starter dependencies without file overrides.
  await run('npm', ['install', '--registry', registryUrl, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--workspaces=false'], directory, `${input.name}: install tarballs`)
  const code = `
    const fs = require('node:fs'); const path = require('node:path');
    const direct = new Set(${JSON.stringify(Object.keys({ ...input.dependencies, ...input.devDependencies, ...input.peerDependencies }))});
    for (const name of ${JSON.stringify([...artifacts.keys()].filter(name => name !== input.name))}) {
      let resolved;
      try { resolved = require.resolve(name + '/package.json'); }
      catch (error) {
        if (error.code === 'MODULE_NOT_FOUND' && !direct.has(name)) continue;
        throw error;
      }
      const installed = fs.realpathSync(resolved);
      if (!installed.startsWith(process.cwd() + path.sep + 'node_modules' + path.sep)) throw new Error('Workspace dependency leaked: ' + installed);
    }
  `
  await run(process.execPath, ['-e', code], directory, `${input.name}: no workspace links`)
}

async function verifyIndependent(name) {
  const source = join(root, 'plugins', name)
  const directory = join(temporary, 'independent', name)
  await mkdir(directory, { recursive: true })
  for (const file of await readdir(source)) {
    if (['lib', 'node_modules', '.DS_Store'].includes(file)) continue
    await cp(join(source, file), join(directory, file), { recursive: true, dereference: false })
  }
  const ownManifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  await install(directory, ownManifest)
  // npm runs the package's own commands; no workspace runner, shared config,
  // prebuilt lib/, repository aliases, or sibling source packages are present.
  for (const command of ['typecheck', 'test', 'build']) {
    await run('npm', ['run', command], directory, `${name}: standalone ${command}`)
  }
  const installed = await realpath(directory)
  assert(!inside(root, installed))
}

let succeeded = false
try {
  if (!args.has('--skip-build')) {
    await run('pnpm', ['build'], root, 'build default distribution and public SDK')
    await parallel(names.filter(name => name.startsWith('dsh-mnemon-source-')), 3,
      name => run('pnpm', ['build'], join(root, 'plugins', name), `build ${name}`))
    await run('pnpm', ['build'], join(root, 'plugins/dsh-mnemon-strategy-default-three-tier'), 'build Strategy-owned extension SDK')
    await parallel(names.filter(name => !name.startsWith('dsh-mnemon-source-') && name !== 'dsh-mnemon-strategy-default-three-tier'), 3,
      name => run('pnpm', ['build'], join(root, 'plugins', name), `build ${name}`))
  }
  await mkdir(join(temporary, 'tarballs'))
  await pack(root, manifest.name)
  for (const name of names) await pack(join(root, 'plugins', name), name)
  await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve))
  registryUrl = 'http://127.0.0.1:' + registry.address().port
  // Exercise the user's one-package installation, not just explicit link mounts.
  await run(process.execPath, [join(root, 'scripts/verify-headless-profile.mjs'),
    '--package', 'file:' + artifacts.get(manifest.name), '--registry', registryUrl,
  ], root, 'real DSH: install only the packed Starter and activate its plugins')
  await run(process.execPath, [join(root, 'scripts/verify-headless-profile.mjs'),
    '--package', 'file:' + artifacts.get(manifest.name), '--registry', registryUrl, '--strategy-extensions', 'true',
  ], root, 'real DSH: activate three optional packed Strategy plugins together')
  await parallel(names, 3, verifyIndependent)

  const consumer = join(temporary, 'consumer')
  await cp(join(root, 'scripts/fixtures/plugin-consumer'), consumer, { recursive: true })
  const consumerManifest = JSON.parse(await readFile(join(consumer, 'package.json'), 'utf8'))
  await install(consumer, consumerManifest)
  await writeFile(join(consumer, 'artifacts.json'), JSON.stringify([...artifacts.keys()]) + '\n')
  for (const command of ['build', 'typecheck', 'test']) await run('npm', ['run', command], consumer, `external consumer: ${command}`)
  console.log(`Verified ${names.length} independent plugin repositories and ${artifacts.size} packed artifacts with public SDK-only composition and Client tests.`)
  succeeded = true
} finally {
  await new Promise(resolve => registry.close(resolve))
  if (succeeded && !args.has('--keep')) await rm(temporary, { recursive: true, force: true })
  else console.log(`Artifact test directory retained for inspection: ${temporary}`)
}
