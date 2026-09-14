#!/usr/bin/env node
// Persistent, isolated development profile using the actual DSH and Mnemon binaries.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { constants, createWriteStream } from 'node:fs'
import { access, appendFile, copyFile, cp, chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: {
  'state-dir': { type: 'string' },
  mnemon: { type: 'string' },
  port: { type: 'string', default: '0' },
  model: { type: 'string', default: 'fixture' },
  'workspace-plugins': { type: 'boolean', default: false },
  reuse: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} })
if (values.help) { console.log('Usage: node scripts/serve-workspace.mjs --state-dir /directory --mnemon /binary [--port 0] [--model fixture|configured] [--workspace-plugins] [--reuse]'); process.exit(0) }
if (!values['state-dir'] || !values.mnemon) throw new Error('Required: --state-dir /absolute/directory --mnemon /absolute/binary')
if (!['fixture', 'configured'].includes(values.model)) throw new Error('--model must be fixture or configured')
if (values.reuse && values.model !== 'configured') throw new Error('--reuse requires --model configured; fixture endpoints must be recreated')
if (!/^\d{1,5}$/.test(values.port) || Number(values.port) > 65535) throw new Error('Invalid port')
const state = resolve(values['state-dir'])
if (state === root || root.startsWith(state + '/')) throw new Error('State directory must be separate from the source checkout')
const dshHome = join(state, 'dsh-home')
const memory = join(state, 'memory')
const workspace = join(state, 'workspace')
const bin = join(state, 'bin')
const logs = join(state, 'logs')
await Promise.all([dshHome, memory, workspace, bin, logs].map(directory => mkdir(directory, { recursive: true })))
await access(resolve(values.mnemon), constants.X_OK)
const native = join(bin, 'mnemon')
if (resolve(values.mnemon) !== native) await copyFile(resolve(values.mnemon), native)
await chmod(native, 0o700)
const completedChecks = new Set()
try {
  const history = await readFile(join(logs, 'workspace-checks.jsonl'), 'utf8')
  for (const line of history.split('\n').filter(Boolean)) { const value = JSON.parse(line); if (typeof value.check === 'string' && !['read', 'job-plan', 'prompt-read'].includes(value.dispatched)) completedChecks.add(value.check) }
} catch (error) { if (error.code !== 'ENOENT') throw error }
const model = values.model === 'fixture' ? createServer(async (request, response) => {
  const deliveryFixture = request.url?.startsWith('/notification/') === true
  const maxBody = deliveryFixture ? 36 * 1024 * 1024 : 2 * 1024 * 1024
  const chunks = []; let bytes = 0
  for await (const chunk of request) { bytes += chunk.length; if (bytes <= maxBody) chunks.push(chunk) }
  if (bytes > maxBody) { response.writeHead(413); response.end('Fixture input limit exceeded'); return }
  if (deliveryFixture) {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (payload.format !== 'mnemon-notification/v1') throw new Error('Invalid fixture payload')
      await appendFile(join(logs, 'notification-deliveries.jsonl'), JSON.stringify({ at: new Date().toISOString(), route: request.url, payload }) + '\n', { mode: 0o600 })
      response.writeHead(202); response.end(); return
    } catch { response.writeHead(400); response.end(); return }
  }
  let review = false, proposals = false, body = {}
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); proposals = JSON.stringify(body.messages).includes('[proposals]'); review = body.messages?.some(message => message.role === 'system' && typeof message.content === 'string' && message.content.includes('Conversation review contract v1')) === true } catch {}
  const tools = (body.tools ?? []).map(tool => tool.function?.name), check = [...JSON.stringify(body.messages ?? []).matchAll(/\[workspace-check:file-write:([a-zA-Z0-9-]{1,100})\]/g)].at(-1)?.[1]
  let toolCall
  const messageText = (value) => typeof value === 'string' ? value : Array.isArray(value) ? value.map(item => messageText(item.text ?? item.content ?? '')).join('\n') : ''
  const fullText = (body.messages ?? []).map(message => messageText(message.content)).join('\n')
  const jobCheck = [...fullText.matchAll(/\[workspace-check:run-job:([a-f0-9-]{36}):([a-zA-Z0-9-]{1,100})\]/g)].at(-1)
  if (!review && jobCheck && !completedChecks.has('job:' + jobCheck[2]) && tools.includes('mnemon_view_route') && tools.includes('mnemon_view_action')) {
    const [, jobId, nonce] = jobCheck, planResult = (body.messages ?? []).find(message => message.role === 'tool' && message.tool_call_id === 'workspace-job-plan-' + nonce)
    const envelopes = [...fullText.matchAll(/^MNEMON VIEW ROUTES .*?: (\[.*\])$/gm)]
    let source
    try { source = JSON.parse(envelopes.at(-1)?.[1] ?? '[]').find(value => value.source.includes('agent-jobs')) } catch {}
    if (!planResult) {
      const route = source?.routes.find(route => route.description.includes('execution plan'))
      if (route) toolCall = { id: 'workspace-job-plan-' + nonce, name: 'mnemon_view_route', args: { routeId: route.id, input: { id: jobId } } }
    } else {
      const findPlan = (value, depth = 0) => {
        if (depth > 8 || value == null) return
        if (typeof value === 'string') { try { return findPlan(JSON.parse(value), depth + 1) } catch { return } }
        if (typeof value !== 'object') return
        if (value.jobId === jobId && typeof value.digest === 'string' && Array.isArray(value.args)) return value
        for (const child of Object.values(value)) { const found = findPlan(child, depth + 1); if (found) return found }
      }
      const plan = findPlan(planResult.content), action = source?.actions.find(action => action.description.startsWith('Start an approved draft'))
      completedChecks.add('job:' + nonce)
      if (plan && action) toolCall = { id: 'workspace-job-run-' + nonce, name: 'mnemon_view_action', args: { offerId: action.id, input: { id: jobId, plan } } }
    }
    await appendFile(join(logs, 'workspace-checks.jsonl'), JSON.stringify({ check: 'job:' + jobCheck[2], offeredTools: tools, dispatched: !planResult && toolCall ? 'job-plan' : toolCall?.name ?? null }) + '\n', { mode: 0o600 })
  }
  const promptCheck = [...fullText.matchAll(/\[workspace-check:use-playbook:([a-f0-9-]{36}):([a-zA-Z0-9-]{1,100})\]/g)].at(-1)
  if (!toolCall && !review && promptCheck && !completedChecks.has('prompt:' + promptCheck[2]) && tools.includes('mnemon_view_action') && tools.includes('mnemon_view_route')) {
    const [, id, nonce] = promptCheck, evidence = (body.messages ?? []).find(message => message.role === 'tool' && message.tool_call_id === 'workspace-prompt-read-' + nonce)
    const envelopes = [...fullText.matchAll(/^MNEMON VIEW ROUTES .*?: (\[.*\])$/gm)]
    let source
    try { source = JSON.parse(envelopes.at(-1)?.[1] ?? '[]').find(value => value.source.includes('playbooks')) } catch {}
    if (!evidence) {
      const route = source?.routes.find(route => route.description.startsWith('Search and read Playbooks'))
      if (route) toolCall = { id: 'workspace-prompt-read-' + nonce, name: 'mnemon_view_route', args: { routeId: route.id, input: { id } } }
    } else {
      const find = (value, depth = 0) => {
        if (depth > 8 || value == null) return
        if (typeof value === 'string') { try { return find(JSON.parse(value), depth + 1) } catch { return } }
        if (typeof value !== 'object') return
        if (value.id === id && typeof value.text === 'string' && typeof value.revision === 'string') return value
        for (const child of Object.values(value)) { const found = find(child, depth + 1); if (found) return found }
      }
      const record = find(evidence.content), action = source?.actions.find(action => action.description.startsWith('Use this approved prompt once.'))
      completedChecks.add('prompt:' + nonce)
      if (record && action) toolCall = { id: 'workspace-prompt-use-' + nonce, name: 'mnemon_view_action', args: { offerId: action.id, input: { id, version: Number(record.revision), variables: { task: '模型提示词授权验收' }, wake: true } } }
    }
    await appendFile(join(logs, 'workspace-checks.jsonl'), JSON.stringify({ check: 'prompt:' + promptCheck[2], offeredTools: tools, dispatched: !evidence && toolCall ? 'prompt-read' : toolCall?.name ?? null }) + '\n', { mode: 0o600 })
  }
  const sessionCheck = [...fullText.matchAll(/\[workspace-check:create-session:([a-zA-Z0-9-]{1,100})\]/g)].at(-1)?.[1]
  if (!toolCall && !review && sessionCheck && !completedChecks.has('session:' + sessionCheck) && tools.includes('mnemon_view_action')) {
    const envelopes = [...fullText.matchAll(/^MNEMON VIEW ROUTES .*?: (\[.*\])$/gm)]
    let source
    try { source = JSON.parse(envelopes.at(-1)?.[1] ?? '[]').find(value => value.source.includes('sessions')) } catch {}
    const action = source?.actions.find(action => action.description.startsWith('Create one ordinary workspace conversation'))
    completedChecks.add('session:' + sessionCheck)
    if (action) toolCall = { id: 'workspace-session-create-' + sessionCheck, name: 'mnemon_view_action', args: { offerId: action.id, input: { requestId: sessionCheck, preset: 'workspace-validation', text: 'Synthetic teammate startup: confirm your standard preset is available. This is a local orchestration check.', wake: true } } }
    await appendFile(join(logs, 'workspace-checks.jsonl'), JSON.stringify({ check: 'session:' + sessionCheck, offeredTools: tools, dispatched: toolCall?.name ?? null }) + '\n', { mode: 0o600 })
  }
  if (!toolCall && !review && tools.length && check && !completedChecks.has(check)) {
    const args = { file_path: join(workspace, 'coordination-output.txt'), content: 'Successful workspace write check: ' + check + '\n' }
    const read = body.messages?.some(message => message.role === 'tool' && message.tool_call_id === 'workspace-read-' + check)
    if (tools.includes('read') && !read) toolCall = { name: 'read', args: { file_path: args.file_path } }
    else {
      completedChecks.add(check)
      if (tools.includes('write')) toolCall = { name: 'write', args }
    }
    await appendFile(join(logs, 'workspace-checks.jsonl'), JSON.stringify({ check, offeredTools: tools, dispatched: toolCall?.name ?? null }) + '\n', { mode: 0o600 })
  }
  const content = review ? JSON.stringify({ severity: 'info', summary: '本地审核链路已完成；这是合成结果，仅用于验证流程。', issues: [{ severity: 'info', text: '审核输入来自用户可见对话，未请求工具或私有推理。' }], proposals: proposals ? [{ kind: 'fact', title: '合成验收建议', content: '这是一条用于验证跨插件审核流程的合成建议。' }] : [], ...(proposals ? { skill: { slug: 'validation-checklist', title: '验收检查流程', content: '检查具体结果、测试证据与适用范围。此条目用于验证插件流程。' } } : {}) }) : 'The isolated workspace is ready. This is a deterministic local test response.'
  const capacityCheck = !review && [...fullText.matchAll(/\[workspace-check:context-usage:(\d{1,7})\]/g)].at(-1)?.[1]
  const syntheticUsage = capacityCheck === false || capacityCheck === undefined ? undefined : { prompt_tokens: Number(capacityCheck), completion_tokens: 20, total_tokens: Number(capacityCheck) + 20 }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const choice of [
    { index: 0, delta: toolCall ? { role: 'assistant', tool_calls: [{ index: 0, id: toolCall.id ?? 'workspace-' + toolCall.name + '-' + check, type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }] } : { role: 'assistant', content }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' },
  ]) response.write(`data: ${JSON.stringify({ id: 'workspace-fixture', choices: [choice], ...(choice.finish_reason && syntheticUsage ? { usage: syntheticUsage } : {}) })}\n\n`)
  response.end('data: [DONE]\n\n')
}) : undefined
if (model) await new Promise((fulfill, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', fulfill) })
const env = {
  ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1',
  MNEMON_DATA_DIR: memory, MNEMON_CLI_PATH: native,
  ...(model ? { DEEPSEEK_API_KEY: 'local-fixture', DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.address().port}` } : {}),
}
const dshBin = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
async function run(command, args) {
  const child = spawn(command, args, { cwd: workspace, env, stdio: 'inherit' })
  await new Promise((fulfill, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? fulfill() : reject(new Error(`Command failed with code ${code}`)))
  })
}
let web
let stopping = false
let restarting = false
const output = createWriteStream(join(logs, 'dsh.log'), { flags: 'a', mode: 0o600 })
function launch() {
  // Browser cookies span loopback ports; many development profiles plus DSH's
  // batched module URL can exceed Node's 16 KiB default. Keep a bounded test limit.
  web = spawn(process.execPath, ['--max-http-header-size=32768', dshBin, 'web', '--no-open', '--host', '127.0.0.1', '--port', values.port], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
  web.stdout.pipe(output, { end: false }); web.stderr.pipe(output, { end: false })
  web.stdout.pipe(process.stdout); web.stderr.pipe(process.stderr)
  web.once('error', error => { console.error(error); process.exitCode = 1; void stop() })
  web.once('exit', code => { if (!stopping && !restarting) { process.exitCode = code ?? 1; void stop() } })
}
async function stop() {
  if (stopping) return
  stopping = true
  if (web && web.exitCode === null) { web.kill('SIGTERM'); await new Promise(fulfill => web.once('exit', fulfill)) }
  if (model) { model.closeAllConnections(); await new Promise(fulfill => model.close(fulfill)) }
  output.end()
  console.log('Stopped this workspace. Its data and logs are retained at ' + state)
}
process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
process.on('SIGUSR2', async () => {
  if (stopping || restarting || !web || web.exitCode !== null) return
  restarting = true
  web.kill('SIGTERM'); await new Promise(fulfill => web.once('exit', fulfill))
  if (!stopping) launch()
  restarting = false
})
try {
  await run(native, ['--version'])
  await run(native, ['--data-dir', memory, 'status'])
  if (values.reuse) await access(join(dshHome, 'profiles/web/cordis.patch.yml'))
  else {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const legacyEnhancements = new Set(['dsh-mnemon-strategy-auto-capture', 'dsh-mnemon-strategy-light-context', 'dsh-mnemon-strategy-scoped'])
  const packages = Object.keys(manifest.dependencies).filter(name => name.startsWith('dsh-mnemon-') && !legacyEnhancements.has(name))
  await run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', `link:${root}`,
    ...packages.map(name => `link:${join(root, 'plugins', name)}`)])
  const preset = join(dshHome, '.agent-presets/workspace-validation')
  const harnessRequire = createRequire(await realpath(join(root, 'node_modules/@deepseek-ai/dsh/package.json')))
  const presetPackage = harnessRequire.resolve('@deepseek-ai/dsh-agent-presets/package.json')
  // Copy the shipped composition as authored preset data, retaining its tools,
  // compaction, skills and isolated service realms without editing DSH itself.
  await cp(join(dirname(presetPackage), 'presets/standard'), preset, { recursive: true, dereference: true })
  await writeFile(join(preset, 'preset.yml'), 'name: Workspace Validation\ndescription: Standard coding tools with isolated workspace memory.\norder: 0\n')
  let patch = `- id: mnemon
  config:
    storageScope: custom
    dataDir: ${JSON.stringify(memory)}
    cliPath: ${JSON.stringify(native)}
    writeEnabled: true
    lifecycleEnabled: true
    displayMode: sidebar
${values['workspace-plugins'] ? '    memoryTopology:\n      strategyId: workspace\n      viewBudget:\n        maxRoutes: 96\n        maxActions: 96\n' : ''}
- id: agent-presets
  config:
    default: workspace-validation
- id: directory-picker
  disabled: true
- insert:
    - id: workspace-directory-picker
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: workspace-directory-picker-ui
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
`
  if (values['workspace-plugins']) patch += await readFile(join(root, 'scripts/workspace-plugins.patch.yml'), 'utf8')
  if (values['workspace-plugins'] && model) patch += `- id: mnemon-source-agent-jobs\n  disabled: false\n  config:\n    adapters:\n      - id: local-fixture\n        label: Local validation\n        command: ${JSON.stringify(process.execPath)}\n        args: [${JSON.stringify(join(root, 'scripts/fixture-worker.mjs'))}, '{prompt}']\n        resumeArgs: [${JSON.stringify(join(root, 'scripts/fixture-worker.mjs'))}, '{prompt}', '{session}']\n        supportsImages: true\n        attachmentArgs: ['--image', '{attachment}']\n        timeoutSeconds: 60\n`
  if (values['workspace-plugins'] && model) patch += `- id: mnemon-source-notifications\n  disabled: false\n  config:\n    captureTurns: true\n    attachmentUrlOrigins: [http://127.0.0.1:${model.address().port}]\n    channels:\n      - id: local-inbox\n        label: Local inbox fixture\n        target: synthetic-inbox\n        endpoint: http://127.0.0.1:${model.address().port}/notification/inbox\n      - id: local-direct\n        label: Local direct fixture\n        target: synthetic-recipient\n        endpoint: http://127.0.0.1:${model.address().port}/notification/direct\n`
  if (values['workspace-plugins']) {
    const skillDirectory = join(workspace, 'skills'), fixtureSkill = join(skillDirectory, 'fixture-validation')
    await mkdir(fixtureSkill, { recursive: true })
    try { await writeFile(join(fixtureSkill, 'SKILL.md'), '---\nname: fixture-validation\ndescription: A synthetic workflow used for plugin verification.\n---\n\nRead the expected result, run the check and report the observed outcome.\n', { flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    patch += `- id: mnemon-source-playbooks\n  config:\n    skillDirectories: [${JSON.stringify(skillDirectory)}]\n`
  }
  await writeFile(join(dshHome, 'profiles/web/cordis.patch.yml'), patch)
  try { await writeFile(join(workspace, 'README.md'), '# Memory workspace validation\n\nSynthetic content used to validate local services and plugin composition.\n', { flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  await writeFile(join(state, 'workspace.code-workspace'), JSON.stringify({ folders: [{ path: root }, { path: workspace }] }, null, 2) + '\n')
  }
  await writeFile(join(state, 'instance.json'), JSON.stringify({ pid: process.pid, root, state, workspace, dshHome, memory, native, model: values.model, port: Number(values.port) }, null, 2) + '\n', { mode: 0o600 })
  console.log('Workspace state: ' + state)
  console.log('Workspace directory: ' + workspace)
  console.log('Supervisor PID: ' + process.pid + '; SIGUSR2 restarts DSH with retained state')
  launch()
} catch (error) { console.error(error); process.exitCode = 1; await stop() }
