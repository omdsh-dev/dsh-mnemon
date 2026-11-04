#!/usr/bin/env node
// Real DSH WebUI with disposable state and a loopback-only model stub.
// Run after pnpm build && pnpm --workspace-concurrency=4 -r build; stop with Ctrl-C to remove the fixture.
// Set MNEMON_E2E_PORT to keep one WebUI address across SIGUSR2 restarts.
// --live-model answers with the real DeepSeek API instead: it reads DEEPSEEK_API_KEY
// (and DEEPSEEK_BASE_URL when set) from the caller's environment and never stores them.
// Set MNEMON_E2E_DSH to another DSH installation's lib/bin.js to serve the WebUI on that release.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STARTER_ENHANCEMENT_PACKAGES, STARTER_SELF_REGISTERING_PACKAGES } from '../src/host/starter-components.ts'
import { documentProtectionModel } from './fixtures/document-protection-model.mjs'
import { documentArchiveModel } from './fixtures/document-archive-model.mjs'
import { runtimeRoutingModel } from './fixtures/runtime-routing-model.mjs'
import { runtimeWriteScopeModel } from './fixtures/runtime-write-scope-model.mjs'
import { resultToolCacheModel } from './fixtures/result-tool-cache-model.mjs'
import { legacySessionReplayModel } from './fixtures/legacy-session-replay-model.mjs'
import { reviewEvidenceModel, scopedOverviewPlugin } from './fixtures/review-evidence-model.mjs'
import { openVikingWriteModel } from './fixtures/openviking-write-model.mjs'
import { idleReviewModel } from './fixtures/idle-review-model.mjs'
import { reviewLayersModel } from './fixtures/review-layers-model.mjs'
import { strictTemplateModel } from './fixtures/strict-template-model.mjs'
import { generalStrategyModel } from './fixtures/general-strategy-model.mjs'
import { exactIdModel } from './fixtures/exact-id-model.mjs'
import { rememberTargetModel } from './fixtures/remember-target-model.mjs'
import { saveActionModel } from './fixtures/save-action-model.mjs'
import { profileCompactionModel } from './fixtures/profile-compaction-model.mjs'
import { DOCS_DEMO_LANGUAGES, docsDemoAssistant, docsDemoModel, seedDocsDemo } from './fixtures/docs-demo.mjs'
import { recallBudgetModel } from './fixtures/recall-budget-model.mjs'
import { archiveCopiesLimitBytes, archiveCopiesPending, seedArchiveCopies } from './fixtures/archive-copies.mjs'
import { fakeEmbeddingServer } from './fixtures/fake-embeddings.mjs'
import { describeModelRequest } from './fixtures/model-request-log.mjs'
import { seedEvolutionScroll } from './fixtures/evolution-scroll.mjs'
import { seedSkillsScroll } from './fixtures/skills-scroll.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const flags = new Set(process.argv.slice(2))
let betterSidebarRoot
// Test-only plugins linked into the profile beside dsh-mnemon, for example a shell fixture.
const extraPlugins = []
let electronExecutable
let trustedHost
// Documentation media: a seeded fictional project and a model that reads it through the real tools.
let docsDemo
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
  if (flag === '--review-layers') continue
  if (flag === '--strict-template') continue
  if (flag === '--general-strategy') continue
  if (flag === '--second-runtime') continue
  if (flag === '--evolution-scroll') continue
  if (flag === '--skills-scroll') continue
  if (flag === '--exact-id') continue
  if (flag === '--archive-copies') continue
  if (flag === '--save-action') continue
  if (flag === '--remember-target') continue
  if (flag === '--profile-compaction') continue
  if (flag === '--without-mnemon-cli') continue
  if (flag === '--remote-management') continue
  if (flag === '--live-model') continue
  if (flag === '--log-model-requests') continue
  if (flag === '--native-directory-picker') continue
  if (flag === '--recall-budget') continue
  if (flag === '--docs-demo' || flag.startsWith('--docs-demo=')) {
    docsDemo = flag === '--docs-demo' ? 'zh-CN' : flag.slice('--docs-demo='.length)
    if (!DOCS_DEMO_LANGUAGES.includes(docsDemo)) throw new Error('--docs-demo accepts ' + DOCS_DEMO_LANGUAGES.join(' or '))
    continue
  }
  if (flag.startsWith('--electron=')) {
    const value = flag.slice('--electron='.length)
    if (value === '') throw new Error('--electron requires an Electron executable')
    electronExecutable = resolve(value)
    continue
  }
  if (flag.startsWith('--plugin=')) {
    const value = flag.slice('--plugin='.length)
    if (value === '') throw new Error('--plugin requires a package directory')
    extraPlugins.push(resolve(value))
    continue
  }
  if (flag.startsWith('--better-sidebar=')) {
    const value = flag.slice('--better-sidebar='.length)
    if (value === '') throw new Error('--better-sidebar requires a package directory')
    betterSidebarRoot = resolve(value)
    continue
  }
  // A remote page: DSH's browser-trust fence accepts this extra authority.
  if (flag.startsWith('--trusted-host=')) {
    trustedHost = flag.slice('--trusted-host='.length)
    if (!/^[a-z0-9.-]+(?::\d+)?$/iu.test(trustedHost)) throw new Error('--trusted-host requires a host or host:port authority')
    continue
  }
  throw new Error('Unknown option: ' + flag)
}
// The Layered strategy composes one Source per role, so a second runtime track needs the General one.
if (flags.has('--second-runtime') && !flags.has('--general-strategy')) throw new Error('--second-runtime requires --general-strategy')
const extensionNames = STARTER_ENHANCEMENT_PACKAGES
// Strategy packages that also register themselves as bundles; the Starter row owns them.
const selfRegistering = new Set(STARTER_SELF_REGISTERING_PACKAGES)
const extensionsEnabled = flags.has('--strategy-extensions')
const liveModel = flags.has('--live-model')
if (liveModel && !process.env.DEEPSEEK_API_KEY?.trim()) throw new Error('--live-model reads the model key from DEEPSEEK_API_KEY')
const logModelRequests = flags.has('--log-model-requests')
if (logModelRequests && liveModel) throw new Error("--log-model-requests logs the loopback model stub's requests, and --live-model replaces the stub")
const runtimeArchive = flags.has('--runtime-archive')
const fixture = await mkdtemp(join(tmpdir(), 'mnemon-web-e2e-'))
const dshHome = join(fixture, 'dsh-home')
const dataDir = join(fixture, 'data')
const workspace = join(fixture, 'workspace')
// DSH and the Skills Source read user skills from ~/.agents unless told otherwise; keep it inside the fixture.
const agentsHome = join(fixture, 'agents-home')
// DSH creates its first-use workspace under the system Documents folder, which on
// macOS it asks the OS for, whatever HOME is; keep that inside the fixture too.
const documents = join(fixture, 'documents')
await Promise.all([dshHome, dataDir, workspace, documents, agentsHome].map(path => mkdir(path)))
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
// Issue #339: an embedding service slower than the Mnemon CLI's default 10 s timeout, with one
// `Archive copies:` line per embedding request, as the #339 record counts them.
const embeddingDelayMs = Number(process.env.MNEMON_E2E_EMBEDDING_DELAY_MS ?? 12_000)
const slowEmbedder = flags.has('--archive-copies') ? fakeEmbeddingServer({ model: 'fixture-embed', delayMs: embeddingDelayMs,
  report: ({ event, request, delayMs }) => console.log('Archive copies: ' + JSON.stringify({ event, request, delayMs })) }) : undefined
if (slowEmbedder) await new Promise(resolveListen => slowEmbedder.listen(0, '127.0.0.1', resolveListen))
const protectionModel = flags.has('--document-protection') ? documentProtectionModel(event => console.log('Document protection: ' + JSON.stringify(event))) : undefined
const reviewModel = flags.has('--review-evidence') ? reviewEvidenceModel(event => console.log('Review evidence: ' + JSON.stringify(event))) : undefined
const scriptedModel = liveModel ? undefined : flags.has('--runtime-routing') ? runtimeRoutingModel(event => console.log('Runtime routing: ' + JSON.stringify(event)))
  : flags.has('--openviking-write') ? openVikingWriteModel(event => console.log('OpenViking write: ' + JSON.stringify(event)))
  : flags.has('--idle-review') ? idleReviewModel(event => console.log('Idle review: ' + JSON.stringify(event)))
  : flags.has('--review-layers') ? reviewLayersModel(event => console.log('Review layers: ' + JSON.stringify(event)))
  : flags.has('--strict-template') ? strictTemplateModel(event => console.log('Strict template: ' + JSON.stringify(event)))
  : flags.has('--general-strategy') ? generalStrategyModel(event => console.log('General strategy: ' + JSON.stringify(event)))
  : flags.has('--exact-id') ? exactIdModel(event => console.log('Exact id: ' + JSON.stringify(event)))
  : flags.has('--save-action') ? saveActionModel(event => console.log('Save action: ' + JSON.stringify(event)))
  : flags.has('--remember-target') ? rememberTargetModel(event => console.log('Remember target: ' + JSON.stringify(event)))
  : flags.has('--profile-compaction') ? profileCompactionModel(event => console.log('Profile compaction: ' + JSON.stringify(event)))
  : flags.has('--runtime-write-scope') ? runtimeWriteScopeModel(event => console.log('Runtime write scope: ' + JSON.stringify(event)))
  : flags.has('--result-tool-cache') ? resultToolCacheModel(event => console.log('Result tool cache: ' + JSON.stringify(event)))
  : flags.has('--legacy-session-replay') ? legacySessionReplayModel(event => console.log('Legacy replay: ' + JSON.stringify(event)))
  : flags.has('--document-archive') ? documentArchiveModel(event => console.log('Document archive: ' + JSON.stringify(event)))
  : flags.has('--recall-budget') ? recallBudgetModel(event => console.log('Recall budget: ' + JSON.stringify(event)))
  : docsDemo !== undefined ? docsDemoModel(docsDemo, event => console.log('Docs demo: ' + JSON.stringify(event))) : reviewModel ?? protectionModel
const reviewFailure = flags.has('--review-failure')
/**
 * DSH's DeepSeek adapter speaks the Messages protocol. Scripted fixtures read
 * one neutral request: system text as a system message, tool results as tool
 * messages, tool calls on assistant messages and tools as functions.
 */
function fixtureRequest(wire) {
  const blocks = content => typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? []
  const text = content => blocks(content).filter(block => block.type === 'text').map(block => block.text).join('\n')
  const messages = (wire.messages ?? []).flatMap(message => {
    const results = blocks(message.content).filter(block => block.type === 'tool_result')
      .map(block => ({ role: 'tool', tool_call_id: block.tool_use_id, content: text(block.content) }))
    const calls = blocks(message.content).filter(block => block.type === 'tool_use')
      .map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }))
    const body = text(message.content)
    return [...results, ...(body === '' && calls.length === 0 ? [] : [{ role: message.role, content: body, ...(calls.length === 0 ? {} : { tool_calls: calls }) }])]
  })
  return {
    ...wire,
    messages: [...(wire.system === undefined ? [] : [{ role: 'system', content: text(wire.system) }]), ...messages],
    tools: (wire.tools ?? []).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })),
  }
}
const model = createServer(async (request, response) => {
  let input = ''
  for await (const chunk of request) input += chunk
  const wire = input === '' ? {} : JSON.parse(input)
  console.log('Fixture model request: ' + ++modelRequests + (logModelRequests ? ' ' + JSON.stringify(describeModelRequest(wire)) : ''))
  const reviewPersona = reviewFailure ? fixtureRequest(wire).messages
    .filter(message => message.role === 'system').map(message => message.content).join('\n') : ''
  if (/Completion protocol: call `mnemon_subagent_result(?:_[^`]+)?`/u.test(reviewPersona)) {
    console.log('Review fixture: rejected inherited context with CONTEXT_WINDOW_EXCEEDED')
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'request (145508 tokens) exceeds the available context size (98304 tokens)' } }))
    return
  }
  let reply
  try { reply = scriptedModel?.(fixtureRequest(wire)) ?? 'Isolated Mnemon WebUI test response.' }
  catch (error) {
    console.error(error)
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
    return
  }
  if (typeof reply === 'object' && reply.error !== undefined) {
    response.writeHead(reply.status ?? 400, { 'content-type': 'application/json' })
    // A server failure answers as Ollama's Messages endpoint does.
    response.end(JSON.stringify(reply.status === undefined ? { error: { message: reply.error } } : { type: 'error', error: { type: 'api_error', message: reply.error } }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const call = typeof reply !== 'string'
  const event = value => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
  event({ type: 'message_start', message: { id: 'mnemon-web-e2e-' + modelRequests, type: 'message', role: 'assistant', model: wire.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
  event({ type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id: 'fixture-call-' + modelRequests, name: reply.name, input: {} } : { type: 'text', text: '' } })
  event({ type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(reply.args) } : { type: 'text_delta', text: reply } })
  event({ type: 'content_block_stop', index: 0 })
  event({ type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } })
  event({ type: 'message_stop' })
  response.end()
})
await new Promise((resolveListen, reject) => {
  model.once('error', reject)
  model.listen(0, '127.0.0.1', resolveListen)
})
const env = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_AGENTS_HOME: agentsHome,
  DSH_TELEMETRY_DISABLED: '1',
  // A live run keeps the caller's key and endpoint; otherwise the loopback stub answers.
  ...(liveModel ? {} : { DEEPSEEK_API_KEY: 'isolated-test-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.address().port}` }),
  MNEMON_DATA_DIR: dataDir,
}
const dshBin = process.env.MNEMON_E2E_DSH ? resolve(process.env.MNEMON_E2E_DSH) : join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
let web
let stopping = false
let restarting = false
function launch() {
  const args = [dshBin, 'web', '--no-open', '--host', '127.0.0.1', '--port', process.env.MNEMON_E2E_PORT ?? '0',
    ...(trustedHost === undefined ? [] : ['--trusted-host', trustedHost])]
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
  if (slowEmbedder) {
    slowEmbedder.closeAllConnections()
    await new Promise(resolveClose => slowEmbedder.close(resolveClose))
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
  const plugins = Object.keys(manifest.dependencies).filter(name => name.startsWith('dsh-mnemon-') && !selfRegistering.has(name))
  const installer = spawn(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add',
    `link:${root}`, ...plugins.map(name => `link:${join(root, 'plugins', name)}`),
    ...(betterSidebarRoot === undefined ? [] : [`link:${betterSidebarRoot}`]),
    ...extraPlugins.map(path => `link:${path}`),
  ], { env, cwd: workspace, stdio: 'inherit' })
  await new Promise((resolveInstall, reject) => {
    installer.once('error', reject)
    installer.once('exit', code => code === 0 ? resolveInstall() : reject(new Error('DSH installation failed: ' + code)))
  })
  // Leave the entire real WebUI/plugin stack enabled. Only unrelated native
  // PTY/search tools are disabled so a test cannot launch workspace commands.
  const disabled = ['subprocess', 'open-in-app', 'bash-sandbox', 'pwsh-sandbox', 'tool-bash', 'tool-pwsh', 'permission', 'tool-fs-search', 'directory-picker']
  // A test-owned preset uses all Host memory tools without the shipped
  // presets' shell requirements. Never modify a shipped DSH preset. The docs
  // demo names it after its fictional project.
  const assistant = docsDemo === undefined
    ? { name: 'Mnemon E2E', description: 'Isolated memory UI test (no Shell).', persona: 'You are testing the Mnemon memory UI.' }
    : docsDemoAssistant(docsDemo)
  // The docs demo's assistant reads files and loads skills, as DSH's standard preset does.
  const docsDemoTools = ['tool-fs', 'skill-filesystem', 'tool-skill'].map(id => `          - id: ${id}\n            name: '@deepseek-ai/dsh-${id}'\n`).join('')
  const pickerKind = flags.has('--native-directory-picker') ? 'native' : 'browse'
  const browsePicker = `- id: agent-preset-registry
  config:
    default: mnemon-e2e
- insert:
    - id: preset-mnemon-e2e
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: mnemon-e2e
        name: ${JSON.stringify(assistant.name)}
        description: ${JSON.stringify(assistant.description)}
        order: 0
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: ${JSON.stringify(assistant.persona)}
${docsDemo === undefined ? '' : docsDemoTools}    - id: e2e-directory-picker
      name: '@deepseek-ai/dsh-host-directory-picker-${pickerKind}'
    - id: e2e-directory-picker-ui
      name: '@deepseek-ai/dsh-client-ui-directory-picker-${pickerKind}'
`
  const reviewFixture = join(fixture, 'review-evidence-plugin.mjs')
  if (reviewModel !== undefined) await writeFile(reviewFixture, scopedOverviewPlugin)
  await writeFile(join(dshHome, 'profiles/web/cordis.patch.yml'), disabled.map(id => `- id: ${id}\n  disabled: true\n`).join('') + browsePicker
    + '- id: workspace-controller\n  config:\n    documentsDirectory: ' + JSON.stringify(documents) + '\n'
    + (protectionModel === undefined && reviewModel === undefined && !reviewFailure ? '' : '- id: mnemon\n  config:\n    idleReviewMs: 5000\n')
    + (runtimeArchive ? '- id: mnemon\n  config:\n    persistenceStrategy:\n      mode: manual\n    runtimeMemory:\n      memoryLimitBytes: 300\n' : '')
    + (flags.has('--idle-review') || flags.has('--review-layers') || flags.has('--strict-template') ? '- id: mnemon\n  config:\n    idleReviewMs: 5000\n    idleReview:\n      minIntervalMs: 5000\n      maxPerSession: 1\n' : '')
    + (flags.has('--runtime-routing') ? '- id: mnemon\n  config:\n    runtimeMemory:\n      memoryLimitBytes: 1600\n' : '')
    // An explicit cliPath is authoritative, so a missing file hides any installed Mnemon CLI.
    + (flags.has('--without-mnemon-cli') ? '- id: mnemon\n  config:\n    cliPath: ' + JSON.stringify(join(fixture, 'no-mnemon-cli', 'mnemon')) + '\n' : '')
    + (flags.has('--remote-management') ? '- id: mnemon\n  config:\n    remoteAccess: trusted-host\n' : '')
    // Two short USER.md entries fill it, so the third write needs the compaction child.
    + (flags.has('--profile-compaction') ? '- id: mnemon\n  config:\n    runtimeMemory:\n      userLimitBytes: 100\n    idleReview:\n      enabled: false\n' : '')
    + (slowEmbedder === undefined ? '' : `- id: mnemon\n  config:\n    runtimeMemory:\n      memoryLimitBytes: ${archiveCopiesLimitBytes}\n    embedding:\n      enabled: true\n      endpoint: http://127.0.0.1:${slowEmbedder.address().port}/v1\n      model: fixture-embed\n      protocol: openai\n`)
    + (flags.has('--general-strategy') ? '- id: mnemon-strategy-general\n  disabled: false\n- id: mnemon-strategy-default-three-tier\n  disabled: true\n- id: mnemon\n  config:\n    memoryView:\n      strategyTypeId: general\n' : '')
    // A second runtime track beside the Starter's, with its own directory, as a profile can mount one (#397).
    + (flags.has('--second-runtime') ? '- insert:\n    - id: mnemon-source-runtime-global\n      name: dsh-mnemon-source-runtime\n      config:\n        dataDir: '
      + JSON.stringify(join(fixture, 'global-runtime')) + '\n        userDataDir: ' + JSON.stringify(join(fixture, 'global-runtime')) + '\n' : '')
    + (flags.has('--runtime-write-scope') ? '- id: mnemon\n  config:\n    persistenceStrategy:\n      mode: manual\n      providerId: mnemon-native\n    runtimeMemory:\n      memoryLimitBytes: 512\n' : '')
    + (reviewModel === undefined ? '' : '- insert:\n    - id: review-evidence-fixture\n      name: ' + JSON.stringify(reviewFixture) + '\n')
    + (extensionsEnabled ? extensionNames.map(name => `- id: ${name.slice(4)}\n  disabled: false\n`).join('') : '')
    // The docs demo shows Skills with self-evolution on, as a user who turned it on sees it.
    + (docsDemo === undefined ? '' : '- id: mnemon\n  config:\n    skills:\n      evolution: true\n'))
  await writeFile(join(workspace, 'README.md'), '# Mnemon isolated browser test\n\nNo production memory or credentials are used.\n')
  if (slowEmbedder !== undefined) {
    const memoryBodyId = await seedArchiveCopies({ dataDir, workspace })
    console.log(`Archive copies seeded: working memory is full and Memory Space ${memoryBodyId} holds an exact copy of each entry; embeddings answer after ${embeddingDelayMs} ms.`)
    console.log('Add this working-memory entry on the Runtime Memory page: ' + archiveCopiesPending)
  }
  // The docs demo's spaces, one of them switched off, for a memory saved into a named space (#387).
  if (flags.has('--remember-target') && docsDemo === undefined) {
    await seedDocsDemo({ dataDir, workspace, language: 'zh-CN' })
    console.log('Remember target seeded; send remember-target-check.')
  }
  if (docsDemo !== undefined) {
    // DSH opens conversations in its first-use workspace, a fixed folder under Documents; the project's skills go there.
    const defaultWorkspace = join(documents, 'deepseek-harness', 'default-workspace')
    await mkdir(defaultWorkspace, { recursive: true })
    await seedDocsDemo({ dataDir, workspace, language: docsDemo, skills: { workspace: defaultWorkspace, dshHome, agentsHome, catalogDir: join(fixture, 'team-skills') } })
    console.log('Docs demo seeded (' + docsDemo + ')' + (liveModel ? '.' : '; ask about checkout, then ask to remember a new target, or ask for the 2.4 release notes and then correct them.'))
  }
  // The docs demo's memory, read by a model that asks three different Recall questions in one turn (#389).
  if (flags.has('--recall-budget') && docsDemo === undefined) {
    await seedDocsDemo({ dataDir, workspace, language: 'zh-CN' })
    console.log('Recall budget seeded; send recall-budget-check.')
  }
  if (flags.has('--evolution-scroll')) await seedEvolutionScroll({ dataDir, workspace, dshHome, agentsHome })
  if (flags.has('--skills-scroll')) await seedSkillsScroll({ dshHome })
  console.log('Fixture: ' + fixture)
  console.log('Workspace: ' + workspace)
  console.log('Fixture PID: ' + process.pid + ' (SIGUSR2 restarts WebUI, retaining test data)')
  console.log('For a conversation, choose the ' + assistant.name + ' preset in the WebUI.')
  if (liveModel) console.log('Live model: the DeepSeek API answers; scripted replies are off.')
  if (archiveProvider) console.log('Runtime archive Hindsight endpoint: http://127.0.0.1:' + archiveProvider.address().port)
  launch()
} catch (error) {
  console.error(error)
  process.exitCode = 1
  await stop()
}
