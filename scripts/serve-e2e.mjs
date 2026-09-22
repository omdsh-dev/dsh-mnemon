#!/usr/bin/env node
// Real DSH WebUI with disposable state and a loopback-only model stub.
// Run after pnpm build && pnpm --workspace-concurrency=4 -r build; stop with Ctrl-C to remove the fixture.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { documentProtectionModel } from './fixtures/document-protection-model.mjs'
import { documentArchiveModel } from './fixtures/document-archive-model.mjs'
import { runtimeRoutingModel } from './fixtures/runtime-routing-model.mjs'
import { runtimeWriteScopeModel } from './fixtures/runtime-write-scope-model.mjs'
import { resultToolCacheModel } from './fixtures/result-tool-cache-model.mjs'
import { legacySessionReplayModel } from './fixtures/legacy-session-replay-model.mjs'
import { reviewEvidenceModel, scopedOverviewPlugin } from './fixtures/review-evidence-model.mjs'
import { openVikingWriteModel } from './fixtures/openviking-write-model.mjs'
import { idleReviewModel } from './fixtures/idle-review-model.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const flags = new Set(process.argv.slice(2))
let betterSidebarRoot
let electronExecutable
for (const flag of flags) {
  if (flag === '--strategy-extensions') continue
  if (flag === '--document-protection') continue
  if (flag === '--document-archive') continue
  if (flag === '--review-failure') continue
  if (flag === '--runtime-archive') continue
  if (flag === '--runtime-routing') continue
  if (flag === '--runtime-write-scope') continue
  if (flag === '--result-tool-cache') continue
  if (flag === '--legacy-session-replay') continue
  if (flag === '--review-evidence') continue
  if (flag === '--openviking-write') continue
  if (flag === '--idle-review') continue
  if (flag.startsWith('--electron=')) {
    const value = flag.slice('--electron='.length)
    if (value === '') throw new Error('--electron requires an Electron executable')
    electronExecutable = resolve(value)
    continue
  }
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
const runtimeArchive = flags.has('--runtime-archive')
const fixture = await mkdtemp(join(tmpdir(), 'mnemon-web-e2e-'))
const dshHome = join(fixture, 'dsh-home')
const dataDir = join(fixture, 'data')
const workspace = join(fixture, 'workspace')
await Promise.all([dshHome, dataDir, workspace].map(path => mkdir(path)))
let modelRequests = 0
let archiveWrites = 0
const archiveProvider = runtimeArchive ? createServer(async (request, response) => {
  let input = ''
  for await (const chunk of request) input += chunk
  const path = request.url ?? ''
  let value = {}
  if (path === '/v1/default/banks') value = { banks: [{ bank_id: 'archive-fixture', name: 'Async archive fixture' }] }
  else if (path.endsWith('/memories') && request.method === 'POST') {
    archiveWrites += JSON.parse(input).items.length
    console.log('Runtime archive accepted writes: ' + archiveWrites)
    value = { operation_id: 'fixture-operation-' + archiveWrites }
  } else if (path.endsWith('/stats')) value = { total_nodes: archiveWrites, total_links: 0 }
  else if (path.includes('/memories/recall')) value = { results: [] }
  else if (path.includes('/entities') || path.includes('/memories/list')) value = { items: [] }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}) : undefined
if (archiveProvider) await new Promise(resolveListen => archiveProvider.listen(0, '127.0.0.1', resolveListen))
const protectionModel = flags.has('--document-protection') ? documentProtectionModel(event => console.log('Document protection: ' + JSON.stringify(event))) : undefined
const reviewModel = flags.has('--review-evidence') ? reviewEvidenceModel(event => console.log('Review evidence: ' + JSON.stringify(event))) : undefined
const scriptedModel = flags.has('--runtime-routing') ? runtimeRoutingModel(event => console.log('Runtime routing: ' + JSON.stringify(event)))
  : flags.has('--openviking-write') ? openVikingWriteModel(event => console.log('OpenViking write: ' + JSON.stringify(event)))
  : flags.has('--idle-review') ? idleReviewModel(event => console.log('Idle review: ' + JSON.stringify(event)))
  : flags.has('--runtime-write-scope') ? runtimeWriteScopeModel(event => console.log('Runtime write scope: ' + JSON.stringify(event)))
  : flags.has('--result-tool-cache') ? resultToolCacheModel(event => console.log('Result tool cache: ' + JSON.stringify(event)))
  : flags.has('--legacy-session-replay') ? legacySessionReplayModel(event => console.log('Legacy replay: ' + JSON.stringify(event)))
  : flags.has('--document-archive') ? documentArchiveModel(event => console.log('Document archive: ' + JSON.stringify(event))) : reviewModel ?? protectionModel
const reviewFailure = flags.has('--review-failure')
const model = createServer(async (request, response) => {
  let input = ''
  for await (const chunk of request) { if (scriptedModel !== undefined || reviewFailure) input += chunk }
  console.log('Fixture model request: ' + ++modelRequests)
  const reviewPersona = reviewFailure ? (JSON.parse(input).messages ?? [])
    .filter(message => message.role === 'system')
    .map(message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(block => block.text ?? '').join('\n')).join('\n') : ''
  if (/Completion protocol: call `mnemon_subagent_result(?:_[^`]+)?`/u.test(reviewPersona)) {
    console.log('Review fixture: rejected inherited context with CONTEXT_WINDOW_EXCEEDED')
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'request (145508 tokens) exceeds the available context size (98304 tokens)' } }))
    return
  }
  let reply
  try { reply = scriptedModel?.(JSON.parse(input)) ?? 'Isolated Mnemon WebUI test response.' }
  catch (error) {
    console.error(error)
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
    return
  }
  if (typeof reply === 'object' && reply.error !== undefined) {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: reply.error } }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const delta = typeof reply === 'string' ? { role: 'assistant', content: reply } : {
    role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-call-' + modelRequests, type: 'function', function: { name: reply.name, arguments: JSON.stringify(reply.args) } }],
  }
  for (const choice of [
    { index: 0, delta, finish_reason: null },
    { index: 0, delta: {}, finish_reason: typeof reply === 'string' ? 'stop' : 'tool_calls' },
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
  const args = [dshBin, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0']
  const hostEnv = { ...env }
  if (electronExecutable !== undefined) {
    for (const key of Object.keys(hostEnv)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete hostEnv[key]
    args.unshift('--expose-internals', join(root, 'scripts/fixtures/electron-dsh-host.cjs'))
  }
  web = spawn(electronExecutable ?? process.execPath, args, { env: hostEnv, cwd: workspace, stdio: 'inherit' })
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
  if (archiveProvider) {
    archiveProvider.closeAllConnections()
    await new Promise(resolveClose => archiveProvider.close(resolveClose))
  }
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
  await writeFile(join(preset, 'agent.cordis.yml'), "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    prefix: You are testing the Mnemon memory UI.\n")
  // Leave the entire real WebUI/plugin stack enabled. Only unrelated native
  // PTY/search tools are disabled so a test cannot launch workspace commands.
  const disabled = ['subprocess', 'open-in-app', 'bash-sandbox', 'pwsh-sandbox', 'tool-bash', 'tool-pwsh', 'permission', 'tool-fs-search', 'directory-picker']
  const browsePicker = `- id: agent-presets
  config:
    default: mnemon-e2e
- insert:
    - id: e2e-directory-picker
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: e2e-directory-picker-ui
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
`
  const reviewFixture = join(fixture, 'review-evidence-plugin.mjs')
  if (reviewModel !== undefined) await writeFile(reviewFixture, scopedOverviewPlugin)
  await writeFile(join(dshHome, 'profiles/web/cordis.patch.yml'), disabled.map(id => `- id: ${id}\n  disabled: true\n`).join('') + browsePicker
    + (protectionModel === undefined && reviewModel === undefined && !reviewFailure ? '' : '- id: mnemon\n  config:\n    idleReviewMs: 5000\n')
    + (runtimeArchive ? '- id: mnemon\n  config:\n    persistenceStrategy:\n      mode: manual\n    runtimeMemory:\n      memoryLimitBytes: 300\n' : '')
    + (flags.has('--idle-review') ? '- id: mnemon\n  config:\n    idleReviewMs: 5000\n    idleReview:\n      minIntervalMs: 5000\n      maxPerSession: 1\n' : '')
    + (flags.has('--runtime-routing') ? '- id: mnemon\n  config:\n    runtimeMemory:\n      memoryLimitBytes: 1600\n' : '')
    + (flags.has('--runtime-write-scope') ? '- id: mnemon\n  config:\n    persistenceStrategy:\n      mode: manual\n      providerId: mnemon-native\n    runtimeMemory:\n      memoryLimitBytes: 512\n' : '')
    + (reviewModel === undefined ? '' : '- insert:\n    - id: review-evidence-fixture\n      name: ' + JSON.stringify(reviewFixture) + '\n')
    + (extensionsEnabled ? extensionNames.map(name => `- id: ${name.slice(4)}\n  disabled: false\n`).join('') : ''))
  await writeFile(join(workspace, 'README.md'), '# Mnemon isolated browser test\n\nNo production memory or credentials are used.\n')
  console.log('Fixture: ' + fixture)
  console.log('Workspace: ' + workspace)
  console.log('Fixture PID: ' + process.pid + ' (SIGUSR2 restarts WebUI, retaining test data)')
  console.log('For a conversation, choose the Mnemon E2E preset in the WebUI.')
  if (archiveProvider) console.log('Runtime archive Hindsight endpoint: http://127.0.0.1:' + archiveProvider.address().port)
  launch()
} catch (error) {
  console.error(error)
  process.exitCode = 1
  await stop()
}
