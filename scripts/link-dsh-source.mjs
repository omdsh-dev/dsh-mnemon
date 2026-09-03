import { access, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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

function validateRestoreTargets(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid DSH registry link restore record.')
  }
  for (const name of links.keys()) {
    if (typeof value[name] !== 'string' || value[name] === '') {
      throw new Error(`Missing recorded registry link for ${name}`)
    }
  }
  return value
}

if (restore) {
  let targets
  try {
    targets = validateRestoreTargets(JSON.parse(await readFile(restoreFile, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('No recorded DSH registry links are available to restore.')
    throw error
  }
  for (const name of links.keys()) {
    const target = targets[name]
    const destination = join(root, 'node_modules', ...name.split('/'))
    await rm(destination, { recursive: true, force: true })
    await mkdir(dirname(destination), { recursive: true })
    await symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir')
  }
  await rm(restoreFile, { force: true })
  console.log(`Restored ${links.size} registry package links.`)
  process.exit(0)
}

const sourceRoot = resolve(sourceInput)
const sourceManifest = await manifest(sourceRoot)
if (sourceManifest.version !== expectedVersion) {
  throw new Error(`Expected DSH ${expectedVersion}, received ${String(sourceManifest.version)} at ${sourceRoot}`)
}
await access(join(sourceRoot, 'apps', 'cli', 'lib', 'bin.js'))

const validatedLinks = []
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
  validatedLinks.push([name, source])
}

try {
  validateRestoreTargets(JSON.parse(await readFile(restoreFile, 'utf8')))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  const restoreTargets = Object.fromEntries(await Promise.all([...links.keys()].map(async name => [
    name,
    await readlink(join(root, 'node_modules', ...name.split('/'))),
  ])))
  await writeFile(restoreFile, `${JSON.stringify(restoreTargets, null, 2)}\n`, { flag: 'wx' })
}

for (const [name, source] of validatedLinks) {
  const destination = join(root, 'node_modules', ...name.split('/'))
  await mkdir(dirname(destination), { recursive: true })
  try {
    await lstat(destination)
    await rm(destination, { recursive: true, force: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
}

console.log(`Linked ${links.size} build-time packages from DSH ${expectedVersion} at ${sourceRoot}.`)
console.log('Run pnpm_config_verify_deps_before_run=false pnpm run verify to preserve these source links while verifying.')
console.log('Run pnpm_config_verify_deps_before_run=false pnpm run dsh:restore-registry to restore registry dependencies.')
