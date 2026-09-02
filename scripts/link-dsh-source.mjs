import { access, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const restore = process.argv[2] === '--restore'
const sourceInput = process.env.DSH_SOURCE_ROOT ?? (restore ? undefined : process.argv[2])
const expectedVersion = process.env.DSH_SOURCE_VERSION ?? '0.1.2-alpha.5'

if (!restore && sourceInput === undefined) {
  throw new Error('Set DSH_SOURCE_ROOT or pass the DeepSeek Harness source checkout path.')
}

const links = new Map([
  ['@deepseek-ai/cordis', 'vendor/cordis'],
  ['@deepseek-ai/dsh', 'apps/cli'],
  ['@deepseek-ai/dsh-agent', 'packages/core/agent'],
  ['@deepseek-ai/dsh-agent-loop', 'packages/core/agent-loop'],
  ['@deepseek-ai/dsh-client-connection', 'packages/client/connection'],
  ['@deepseek-ai/dsh-client-locale', 'packages/client/locale'],
  ['@deepseek-ai/dsh-client-store', 'packages/client/store'],
  ['@deepseek-ai/dsh-client-ui-conversation', 'packages/client/ui-conversation'],
  ['@deepseek-ai/dsh-client-ui-primitives', 'packages/client/ui-primitives'],
  ['@deepseek-ai/dsh-client-ui-renderer', 'packages/client/ui-renderer'],
  ['@deepseek-ai/dsh-client-ui-settings', 'packages/client/ui-settings'],
  ['@deepseek-ai/dsh-client-ui-slots', 'packages/client/ui-slots'],
  ['@deepseek-ai/dsh-client-ui-tool', 'packages/client/ui-tool'],
  ['@deepseek-ai/dsh-invariants', 'packages/runtime-diagnostics/invariants'],
  ['@deepseek-ai/dsh-llm', 'packages/llm/llm'],
  ['@deepseek-ai/dsh-session', 'packages/core/session'],
  ['@deepseek-ai/dsh-session-persistence-jsonl', 'packages/session/session-persistence-jsonl'],
  ['@deepseek-ai/dsh-session-projection', 'packages/session/session-projection'],
  ['@deepseek-ai/dsh-session-query', 'packages/session-query/session-query'],
  ['@deepseek-ai/dsh-subagent', 'packages/subagent/subagent'],
  ['@deepseek-ai/dsh-subagent-spawn-in-process', 'packages/subagent/subagent-spawn-in-process'],
  ['@deepseek-ai/dsh-system-prompt', 'packages/core/system-prompt'],
  ['@deepseek-ai/dsh-tools', 'packages/core/tools'],
])
const restoreFile = join(root, 'node_modules', '.dsh-mnemon-dsh-source-links.json')

async function manifest(directory) {
  return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
}

function normalizedPath(value) {
  return value.split(sep).join('/')
}

function restorePath(name) {
  return normalizedPath(join('node_modules', ...name.split('/')))
}

function validateRestoreTargets(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid DSH registry link restore record.')
  }

  // Records created before the plugin-workspace layout covered only Root.
  if (!('version' in value) && [...links.keys()].every(name => typeof value[name] === 'string' && value[name] !== '')) {
    return Object.fromEntries([...links.keys()].map(name => [restorePath(name), value[name]]))
  }

  if (value.version !== 1 || typeof value.targets !== 'object' || value.targets === null || Array.isArray(value.targets)) {
    throw new Error('Invalid DSH registry link restore record version.')
  }
  const targets = value.targets
  for (const [path, target] of Object.entries(targets)) {
    const normalized = path.replaceAll('\\', '/')
    const dependency = [...links.keys()].find(name => normalized.endsWith(`/node_modules/${name}`) || normalized === `node_modules/${name}`)
    const workspacePath = /^plugins\/[^/]+\/node_modules\//u.test(normalized)
    if (normalized !== path || dependency === undefined || (!workspacePath && normalized !== `node_modules/${dependency}`)) {
      throw new Error(`Invalid DSH registry restore path: ${path}`)
    }
    const destination = resolve(root, normalized)
    if (!destination.startsWith(`${root}${sep}`) || typeof target !== 'string' || target === '') {
      throw new Error(`Invalid DSH registry restore target for ${path}`)
    }
  }
  return targets
}

async function workspaceRoots() {
  const plugins = await readdir(join(root, 'plugins'), { withFileTypes: true })
  return [root, ...plugins.filter(entry => entry.isDirectory()).map(entry => join(root, 'plugins', entry.name))]
}

async function overlayDestinations(sourceByName) {
  const destinations = []
  for (const packageRoot of await workspaceRoots()) {
    // Root exercises the full DSH source graph. Independent plugin workspaces
    // only need the Harness-owned Cordis identity; their Client dev dependency
    // stays registry-backed so Vitest does not execute a package outside that
    // workspace's filesystem root.
    const dependencies = packageRoot === root ? links.keys() : ['@deepseek-ai/cordis']
    for (const name of dependencies) {
      const destination = join(packageRoot, 'node_modules', ...name.split('/'))
      let status
      try {
        status = await lstat(destination)
      } catch (error) {
        if (packageRoot !== root && error?.code === 'ENOENT') continue
        throw error
      }
      if (!status.isSymbolicLink()) throw new Error(`Expected pnpm dependency link at ${destination}`)
      destinations.push({
        key: normalizedPath(relative(root, destination)),
        destination,
        source: sourceByName.get(name),
      })
    }
  }
  return destinations
}

if (restore) {
  let targets
  try {
    targets = validateRestoreTargets(JSON.parse(await readFile(restoreFile, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('No recorded DSH registry links are available to restore.')
    throw error
  }
  for (const [path, target] of Object.entries(targets)) {
    const destination = resolve(root, path)
    await rm(destination, { recursive: true, force: true })
    await mkdir(dirname(destination), { recursive: true })
    await symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir')
  }
  await rm(restoreFile, { force: true })
  console.log(`Restored ${Object.keys(targets).length} registry package links.`)
  process.exit(0)
}

const sourceRoot = resolve(sourceInput)
const sourceManifest = await manifest(sourceRoot)
if (sourceManifest.version !== expectedVersion) {
  throw new Error(`Expected DSH ${expectedVersion}, received ${String(sourceManifest.version)} at ${sourceRoot}`)
}
await access(join(sourceRoot, 'apps', 'cli', 'lib', 'bin.js'))

const sourceByName = new Map()
for (const [name, relativeSource] of links) {
  const source = join(sourceRoot, relativeSource)
  const packageManifest = await manifest(source)
  if (packageManifest.name !== name) {
    throw new Error(`Expected ${name} at ${source}, received ${String(packageManifest.name)}`)
  }
  if (name !== '@deepseek-ai/cordis' && packageManifest.version !== expectedVersion) {
    throw new Error(`Expected ${name}@${expectedVersion}, received ${String(packageManifest.version)}`)
  }
  await access(join(source, 'lib'))
  sourceByName.set(name, source)
}

const destinations = await overlayDestinations(sourceByName)
try {
  const targets = validateRestoreTargets(JSON.parse(await readFile(restoreFile, 'utf8')))
  if (destinations.some(({ key }) => !(key in targets)) || Object.keys(targets).length !== destinations.length) {
    throw new Error('Restore existing DSH source links before applying the expanded workspace overlay.')
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  const targets = Object.fromEntries(await Promise.all(destinations.map(async ({ key, destination }) => [key, await readlink(destination)])))
  await writeFile(restoreFile, `${JSON.stringify({ version: 1, targets }, null, 2)}\n`, { flag: 'wx' })
}

for (const { destination, source } of destinations) {
  await mkdir(dirname(destination), { recursive: true })
  try {
    await lstat(destination)
    await rm(destination, { recursive: true, force: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
}

console.log(`Linked ${destinations.length} Root/workspace dependency paths from DSH ${expectedVersion} at ${sourceRoot}.`)
console.log('Run pnpm_config_verify_deps_before_run=false pnpm run verify to preserve these source links while verifying.')
console.log('Run pnpm_config_verify_deps_before_run=false pnpm run dsh:restore-registry to restore registry dependencies.')
