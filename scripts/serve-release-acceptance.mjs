// Serve candidate tarballs beside real npm metadata for disposable official-DSH
// Add plugin and Check versions acceptance. This never publishes to a registry.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  dsh: { type: 'string' }, artifacts: { type: 'string' }, state: { type: 'string' },
  previous: { type: 'string' }, port: { type: 'string', default: '0' },
} })
for (const key of ['dsh', 'artifacts', 'state']) assert(values[key], `Missing --${key}`)
const state = resolve(values.state), dshBin = resolve(values.dsh), artifacts = resolve(values.artifacts)
const port = Number(values.port)
assert(Number.isInteger(port) && port >= 0 && port <= 65535, 'Invalid port')
await mkdir(state, { recursive: true, mode: 0o700 })
assert.equal((await readdir(state)).length, 0, 'Use an empty disposable state directory')
const workspace = join(state, 'workspace'), dshHome = join(state, 'dsh-home'), isolatedHome = join(state, 'home')
for (const directory of [workspace, dshHome, isolatedHome]) await mkdir(directory, { recursive: true })
const save = (name, value) => writeFile(join(state, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const run = (command, args, env = process.env) => new Promise((done, fail) => {
  const child = spawn(command, args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  child.once('error', fail)
  child.once('close', code => code === 0 ? done(output) : fail(new Error(`Command exited ${code}: ${output}`)))
})
const packages = new Map()
for (const filename of await readdir(artifacts)) {
  if (!filename.endsWith('.tgz')) continue
  const path = join(artifacts, filename), bytes = await readFile(path)
  const manifest = JSON.parse(await run('tar', ['-xOf', path, 'package/package.json']))
  assert(!packages.has(manifest.name), `Duplicate candidate ${manifest.name}`)
  assert(manifest.name === 'dsh-mnemon' || manifest.name.startsWith('dsh-mnemon-'), 'Only Mnemon candidates are accepted')
  packages.set(manifest.name, { manifest, path, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, sha256: createHash('sha256').update(bytes).digest('hex') })
}
assert(packages.has('dsh-mnemon'), 'Missing candidate Starter')
const metadata = new Map()
let registryUrl
const registry = createServer(async (request, response) => {
  try {
    const route = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1)
    if (route.startsWith('tarballs/')) {
      const pkg = packages.get(route.slice(9))
      if (!pkg) { response.writeHead(404); response.end(); return }
      response.writeHead(200, { 'content-type': 'application/octet-stream' }); createReadStream(pkg.path).pipe(response); return
    }
    const [name, requestedVersion] = route.split('/')
    if (!packages.has(name)) { response.writeHead(307, { location: `https://registry.npmjs.org${request.url}` }); response.end(); return }
    if (!metadata.has(name)) {
      const upstream = await fetch(`https://registry.npmjs.org/${name}`)
      assert(upstream.ok, `npm metadata returned ${upstream.status}`)
      metadata.set(name, await upstream.json())
    }
    const document = structuredClone(metadata.get(name)), pkg = packages.get(name)
    document.versions[pkg.manifest.version] = { ...pkg.manifest, dist: { integrity: pkg.integrity, tarball: `${registryUrl}/tarballs/${name}` } }
    document['dist-tags'].latest = pkg.manifest.version
    document.time[pkg.manifest.version] = '2020-01-01T00:00:00.000Z'
    const body = requestedVersion ? document.versions[document['dist-tags'][requestedVersion] ?? requestedVersion] : document
    response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }); response.end(JSON.stringify(body ?? { error: 'Not found' }))
  } catch (error) {
    await save('registry-error.txt', String(error)); response.writeHead(502); response.end('Fixture registry failed')
  }
})
await new Promise(done => registry.listen(0, '127.0.0.1', done))
registryUrl = `http://127.0.0.1:${registry.address().port}`
// Version checks fetch npm directly instead of using pnpm's configured registry.
// Restrict this test-only redirect to the selected candidate package names.
const preload = join(state, 'registry-preload.mjs')
await writeFile(preload, `const originalFetch = globalThis.fetch;\nconst names = new Set(${JSON.stringify([...packages.keys()])});\nglobalThis.fetch = (input, init) => {\n  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);\n  if (url.hostname === 'registry.npmjs.org' && names.has(decodeURIComponent(url.pathname).split('/')[1])) {\n    const target = ${JSON.stringify(registryUrl)} + url.pathname + url.search;\n    input = input instanceof Request ? new Request(target, input) : target;\n  }\n  return originalFetch(input, init);\n};\n`)
const env = { ...process.env, HOME: isolatedHome, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1',
  MNEMON_DATA_DIR: join(state, 'data'), npm_config_registry: registryUrl, NPM_CONFIG_REGISTRY: registryUrl,
  npm_config_store_dir: join(state, 'pnpm-store'), NODE_OPTIONS: `--import=${preload}`,
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` }
for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_AUTH_TOKEN', 'NPM_TOKEN', 'HTTP_PROXY']) delete env[name]
await writeFile(join(workspace, 'README.md'), '# Release acceptance\n\nSynthetic release verification data.\n')
if (values.previous) {
  const initialEnv = { ...env, NODE_OPTIONS: '', npm_config_registry: 'https://registry.npmjs.org', NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org' }
  await save('previous-install.log', await run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', values.previous, '--registry', 'https://registry.npmjs.org'], initialEnv))
}
await save('candidates.json', [...packages.values()].map(pkg => ({ name: pkg.manifest.name, version: pkg.manifest.version, filename: basename(pkg.path), sha256: pkg.sha256, integrity: pkg.integrity })))
const info = { pid: process.pid, state, workspace, dshHome, registryUrl, port, restarts: 0 }
let child, output = '', stopping = false, restarting = false
const launch = async () => {
  output = ''; delete info.url
  child = spawn(process.execPath, [dshBin, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
  info.webPid = child.pid
  const capture = data => {
    output += data.toString()
    const urls = output.replace(/\x1b\[[0-9;]*m/gu, '').match(/http:\/\/127\.0\.0\.1:\d+[^\s]*/gu) ?? []
    const url = urls.findLast(value => /[?&](?:token|key)=/u.test(value))
    if (url) info.url = url
    void save('host.log', output); void save('private.json', info)
  }
  child.stdout.on('data', capture); child.stderr.on('data', capture)
  child.once('exit', code => { if (!stopping && !restarting) { process.exitCode = code ?? 1; void stop() } })
  await save('private.json', info)
}
const stop = async () => {
  if (stopping) return
  stopping = true
  if (child?.exitCode === null) { child.kill('SIGTERM'); await new Promise(done => child.once('exit', done)) }
  registry.closeAllConnections(); await new Promise(done => registry.close(done))
}
process.once('SIGINT', () => { void stop() }); process.once('SIGTERM', () => { void stop() })
process.on('SIGUSR2', async () => {
  if (stopping || restarting || child?.exitCode !== null) return
  restarting = true; child.kill('SIGTERM'); await new Promise(done => child.once('exit', done))
  await save(`host-before-restart-${++info.restarts}.log`, output)
  await launch(); restarting = false
})
await launch()
console.log(`Release fixture started; private metadata: ${join(state, 'private.json')}`)
