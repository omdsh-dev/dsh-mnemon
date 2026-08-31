import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshBin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const marker = 'HEADLESS_MNEMON_READY'
const arguments_ = process.argv.slice(2)
const options = new Map()
for (let index = 0; index < arguments_.length; index += 2) {
  if (!['--package', '--registry', '--strategy-extensions'].includes(arguments_[index]) || !arguments_[index + 1]) throw new Error('Expected --package <specifier> --registry <url> and/or --strategy-extensions true')
  options.set(arguments_[index], arguments_[index + 1])
}
if (options.has('--package') !== options.has('--registry')) throw new Error('--package and --registry must be supplied together')
if (options.has('--strategy-extensions') && options.get('--strategy-extensions') !== 'true') throw new Error('--strategy-extensions expects true')
const extensions = options.has('--strategy-extensions')
  ? ['dsh-mnemon-strategy-scoped', 'dsh-mnemon-strategy-light-context', 'dsh-mnemon-strategy-auto-capture'] : []

function run(args, { cwd = root, env = process.env, timeoutMs = 30_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [dshBin, ...args], {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`dsh Headless verification timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timeout)
      resolveRun({ code, signal, stdout, stderr })
    })
  })
}

function assertSuccess(label, result) {
  if (result.code === 0) return
  throw new Error([
    `${label} failed with code ${String(result.code)}${result.signal === null ? '' : ` (${result.signal})`}`,
    result.stdout.trim(),
    result.stderr.trim(),
  ].filter(Boolean).join('\n'))
}

const requests = []
const server = createServer(async (request, response) => {
  try {
    let body = ''
    request.setEncoding('utf8')
    for await (const chunk of request) body += chunk
    requests.push(JSON.parse(body))
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const id = `chatcmpl-${requests.length}`
    response.write(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta: { role: 'assistant', content: marker }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id, choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
  }
})

const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-mnemon-headless-'))
const dshHome = join(temporaryRoot, 'dsh-home')
const storageRoot = join(temporaryRoot, 'mnemon-data')
const workspaceRoot = join(temporaryRoot, 'workspace')
await Promise.all([mkdir(dshHome), mkdir(storageRoot), mkdir(workspaceRoot)])

try {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock DeepSeek server did not expose a TCP port')
  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: 'headless-verification-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
    MNEMON_DATA_DIR: storageRoot,
    ...(options.has('--registry') ? { npm_config_registry: options.get('--registry'), NPM_CONFIG_REGISTRY: options.get('--registry') } : {}),
  }

  // link: skips dependency installation. Explicitly link the same plugin set
  // that a normal install resolves from the Starter's semver dependencies.
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const plugins = Object.keys(manifest.dependencies).filter(name => name.startsWith('dsh-mnemon-'))
  const packages = options.has('--package')
    ? [options.get('--package'), ...extensions.map(name => `${name}@${manifest.version}`)]
    : [`link:${root}`, ...[...plugins, ...extensions].map(name => `link:${join(root, 'plugins', name)}`)]
  const install = await run(['plugin', '--profile', 'headless', 'add', ...packages,
    ...(options.has('--registry') ? ['--registry', options.get('--registry')] : []),
  ], { env, timeoutMs: 120_000 })
  assertSuccess('installing dsh-mnemon into the Headless profile', install)

  const settingsPath = join(dshHome, 'settings.yaml')
  await writeFile(settingsPath, '# Legacy placement migration fixture\nmnemon:\n  displayMode: buildin\n  timeoutMs: 25000\n')

  // The verification exercises Mnemon composition, not DSH's native PTY
  // transport. Disable the unrelated shell stack so the check remains
  // hermetic on CI Node/platform combinations without a node-pty prebuild.
  await writeFile(join(dshHome, 'profiles', 'headless', 'cordis.patch.yml'), `
- id: subprocess
  disabled: true
- id: bash-sandbox
  disabled: true
- id: pwsh-sandbox
  disabled: true
- id: tool-bash
  disabled: true
- id: tool-pwsh
  disabled: true
- id: permission
  disabled: true
- id: tool-fs-search
  disabled: true
`.trimStart() + (extensions.length === 0 ? '' : '\n- insert:\n' + extensions.map(name =>
    `    - id: ${name.slice(4)}\n      name: ${name}\n`,
  ).join('')))

  const execution = await run(['--profile', 'headless', 'Verify that the Mnemon tool surface is available.'], {
    cwd: workspaceRoot,
    env,
  })
  assertSuccess('running the Headless profile', execution)
  if (!execution.stdout.includes(marker)) throw new Error(`Headless output did not contain ${marker}:\n${execution.stdout}`)

  const toolRequest = requests.find(request => Array.isArray(request.tools) && request.tools.length > 0)
  if (toolRequest === undefined) throw new Error('Headless model request did not expose any tools')
  const toolNames = new Set(toolRequest.tools.map(tool => tool?.function?.name).filter(name => typeof name === 'string'))
  const required = ['mnemon_status', 'mnemon_recall', 'mnemon_document_search', 'mnemon_runtime_memory', 'mnemon_remember', 'mnemon_view_route', 'mnemon_view_action']
  const missing = required.filter(name => !toolNames.has(name))
  if (missing.length > 0) throw new Error(`Headless model request is missing Mnemon tools: ${missing.join(', ')}`)
  if (extensions.length > 0) {
    const prompt = JSON.stringify(toolRequest.messages)
    for (const expected of ['Source order expresses preference', 'MNEMON OPTIONAL AUTO CAPTURE']) {
      if (!prompt.includes(expected)) throw new Error(`Optional Strategy contribution did not reach the real DSH prompt: ${expected}`)
    }
  }
  if (!existsSync(join(storageRoot, 'runtime', 'memories.json'))) throw new Error('Headless plugin did not initialize isolated runtime memory')

  const canonicalSettings = await readFile(settingsPath, 'utf8')
  if (!canonicalSettings.includes('displayMode: builtin') || canonicalSettings.includes('displayMode: buildin')) throw new Error('Headless did not persist the canonical builtin displayMode')
  if (!canonicalSettings.includes('# Legacy placement migration fixture') || !canonicalSettings.includes('timeoutMs: 25000')) throw new Error('Placement migration changed unrelated configuration or comments')
  const restarted = await run(['--profile', 'headless', 'Verify that normalized Mnemon settings survive a restart.'], { cwd: workspaceRoot, env })
  assertSuccess('restarting Headless with normalized Mnemon settings', restarted)
  if (!restarted.stdout.includes(marker)) throw new Error('Restarted Headless did not complete its test turn')
  if (await readFile(settingsPath, 'utf8') !== canonicalSettings) throw new Error('Canonical placement was rewritten on restart')

  console.log(`Verified Headless profile activation with ${toolNames.size} total tools and ${required.length} representative Mnemon tools.`)
  console.log('Verified buildin-to-builtin persistence, preservation of unrelated settings/comments, and an idempotent Headless restart.')
  if (extensions.length > 0) console.log('Verified simultaneous activation of scoped, light-context and auto-capture Entries without changing the default Strategy.')
} finally {
  await new Promise(resolveClose => server.close(resolveClose))
  await rm(temporaryRoot, { recursive: true, force: true })
}
