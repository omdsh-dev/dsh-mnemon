#!/usr/bin/env node
// Real DSH WebUI with disposable state and a loopback-only model stub.
// Run after pnpm build && pnpm --workspace-concurrency=1 -r build; stop with Ctrl-C to remove the fixture.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const flags = new Set(process.argv.slice(2))
let betterSidebarRoot
for (const flag of flags) {
  if (flag === '--strategy-extensions') continue
  if (flag.startsWith('--better-sidebar=')) {
    const value = flag.slice('--better-sidebar='.length)
    if (value === '') throw new Error('--better-sidebar requires a package directory')
    betterSidebarRoot = resolve(value)
    continue
  }
  throw new Error('Unknown option: ' + flag)
}
const extensionNames = ['dsh-mnemon-strategy-scoped', 'dsh-mnemon-strategy-light-context', 'dsh-mnemon-strategy-auto-capture']
const extensionNameSet = new Set(extensionNames)
const extensionsEnabled = flags.has('--strategy-extensions')
const fixture = await mkdtemp(join(tmpdir(), 'mnemon-web-e2e-'))
const dshHome = join(fixture, 'dsh-home')
const dataDir = join(fixture, 'data')
const workspace = join(fixture, 'workspace')
await Promise.all([dshHome, dataDir, workspace].map(path => mkdir(path)))
let modelRequests = 0
const model = createServer(async (request, response) => {
  for await (const _chunk of request) { /* Consume the request without storing model input. */ }
  console.log('Fixture model request: ' + ++modelRequests)
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const choice of [
    { index: 0, delta: { role: 'assistant', content: 'Isolated Mnemon WebUI test response.' }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: 'stop' },
  ]) response.write(`data: ${JSON.stringify({ id: 'mnemon-web-e2e', choices: [choice] })}\n\n`)
  response.end('data: [DONE]\n\n')
})
await new Promise((resolveListen, reject) => {
  model.once('error', reject)
  model.listen(0, '127.0.0.1', resolveListen)
})
const env = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_TELEMETRY_DISABLED: '1',
  DEEPSEEK_API_KEY: 'isolated-test-key',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.address().port}`,
  MNEMON_DATA_DIR: dataDir,
}
const dshBin = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
let web
let stopping = false
let restarting = false
function launch() {
  web = spawn(process.execPath, [dshBin, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { env, cwd: workspace, stdio: 'inherit' })
  web.once('error', error => { console.error(error); process.exitCode = 1; void stop() })
  web.once('exit', code => { if (!stopping && !restarting) { if (code) process.exitCode = code; void stop() } })
}
async function restart() {
  if (stopping || restarting || !web || web.exitCode !== null) return
  restarting = true
  web.kill('SIGTERM')
  await new Promise(resolveExit => web.once('exit', resolveExit))
  if (!stopping) { console.log('Restarting the same disposable Profile'); launch() }
  restarting = false
}
async function stop() {
  if (stopping) return
  stopping = true
  if (web && web.exitCode === null) {
    web.kill('SIGTERM')
    await new Promise(resolveExit => web.once('exit', resolveExit))
  }
  model.closeAllConnections()
  await new Promise(resolveClose => model.close(resolveClose))
  await rm(fixture, { recursive: true, force: true })
  console.log('Removed disposable WebUI fixture: ' + fixture)
}
process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
process.on('SIGUSR2', () => { void restart() })

try {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  // Root owns the disabled enhancement Entries. Adding their self-registering
  // bundles as separate Profile layers would intentionally duplicate ids.
  const plugins = Object.keys(manifest.dependencies).filter(name => name.startsWith('dsh-mnemon-') && !extensionNameSet.has(name))
  const installer = spawn(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add',
    `link:${root}`, ...plugins.map(name => `link:${join(root, 'plugins', name)}`),
    ...(betterSidebarRoot === undefined ? [] : [`link:${betterSidebarRoot}`]),
  ], { env, cwd: workspace, stdio: 'inherit' })
  await new Promise((resolveInstall, reject) => {
    installer.once('error', reject)
    installer.once('exit', code => code === 0 ? resolveInstall() : reject(new Error('DSH installation failed: ' + code)))
  })
  // A test-owned preset uses all Host memory tools without the unrelated
  // coding preset's shell requirements. Never modify a shipped DSH preset.
  const preset = join(dshHome, '.agent-presets/mnemon-e2e')
  await mkdir(preset, { recursive: true })
  await writeFile(join(preset, 'preset.yml'), 'name: Mnemon E2E\ndescription: Isolated memory UI test (no Shell).\norder: 0\n')
  await writeFile(join(preset, 'agent.cordis.yml'), "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: You are testing the Mnemon memory UI.\n")
  // Leave the entire real WebUI/plugin stack enabled. Only unrelated native
  // PTY/search tools are disabled so a test cannot launch workspace commands.
  const disabled = ['subprocess', 'bash-sandbox', 'pwsh-sandbox', 'tool-bash', 'tool-pwsh', 'permission', 'tool-fs-search', 'directory-picker']
  const browsePicker = `- id: agent-presets
  config:
    default: mnemon-e2e
- insert:
    - id: e2e-directory-picker
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: e2e-directory-picker-ui
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
`
  await writeFile(join(dshHome, 'profiles/web/cordis.patch.yml'), disabled.map(id => `- id: ${id}\n  disabled: true\n`).join('') + browsePicker
    + (extensionsEnabled ? extensionNames.map(name => `- id: ${name.slice(4)}\n  disabled: false\n`).join('') : ''))
  await writeFile(join(workspace, 'README.md'), '# Mnemon isolated browser test\n\nNo production memory or credentials are used.\n')
  console.log('Fixture: ' + fixture)
  console.log('Workspace: ' + workspace)
  console.log('Fixture PID: ' + process.pid + ' (SIGUSR2 restarts WebUI, retaining test data)')
  console.log('For a conversation, choose the Mnemon E2E preset in the WebUI.')
  launch()
} catch (error) {
  console.error(error)
  process.exitCode = 1
  await stop()
}
