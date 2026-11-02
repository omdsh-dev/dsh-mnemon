// Exercise shipped Web presets with local synthetic model choices and disposable data.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node verify-web-profile.mjs DSH_PACKAGE_ROOT OUTPUT_JSON [PACKED_STARTER REGISTRY]')
const dsh = resolve(process.argv[2])
const output = resolve(process.argv[3])
const packedStarter = process.argv[4]
const registry = process.argv[5]
if (Boolean(packedStarter) !== Boolean(registry)) throw new Error('A packed Starter requires its candidate registry')
const require = createRequire(join(dsh, 'package.json'))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const temporary = await mkdtemp(join(tmpdir(), 'mnemon-current-dsh-web-'))
const home = join(temporary, 'home'), workspace = join(temporary, 'workspace'), data = join(temporary, 'data')
await Promise.all([home, workspace, data].map(path => mkdir(path)))
const env = { ...process.env, DSH_HOME: home, MNEMON_DATA_DIR: data, DSH_TELEMETRY_DISABLED: '1',
  DEEPSEEK_API_KEY: 'synthetic-no-api', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1' }
delete env.NODE_PATH
Object.assign(process.env, env)
delete process.env.NODE_PATH
process.chdir(workspace)
let ctx
try {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const plugins = Object.keys(manifest.dependencies).filter(name => name.startsWith('dsh-mnemon-') && !/strategy-(general|scoped|light-context|auto-capture)$/.test(name))
  await new Promise((resolveInstall, reject) => {
    const packages = packedStarter ? [packedStarter, '--registry', registry] : [`link:${root}`, ...plugins.map(name => `link:${join(root, 'plugins', name)}`)]
    const child = spawn(process.execPath, [join(dsh, 'lib/bin.js'), 'plugin', '--profile', 'web', 'add', ...packages],
      { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', chunk => { log += chunk })
    child.stderr.on('data', chunk => { log += chunk })
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolveInstall() : reject(new Error(`Disposable profile install failed: ${log}`)) })
  })
  // The native folder chooser is irrelevant to the protocol smoke. Automatic
  // review has separate real native/PTC turn-integrity tests in the root suite.
  await writeFile(join(home, 'profiles/web/cordis.patch.yml'), '- id: directory-picker\n  disabled: true\n- id: mnemon\n  config:\n    idleReview:\n      enabled: false\n')
  const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment')
  const { runProfile } = await import(pathToFileURL(join(dsh, 'lib/profile-boot.js')).href)
  const { LlmAdapter, createUserMessage } = await load('@deepseek-ai/dsh-llm')
  ;({ ctx } = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]),
    profile: 'web', patchFiles: [], args: ['--no-open', '--host', '127.0.0.1', '--port', '0'] }))
  const observations = []
  class Adapter extends LlmAdapter {
    async *stream(options) {
      const prior = observations.filter(item => item.id === options.sessionId).length
      const tools = (options.tools ?? []).map(tool => tool.name)
      if (tools.length > 0) {
        const text = JSON.stringify([options.system, options.messages])
        observations.push({ id: options.sessionId, tools, memory: text.includes('MNEMON RUNTIME MEMORY SNAPSHOT'), guide: text.includes('[MNEMON]') })
      }
      if (tools.length > 0 && prior < 2) {
        const name = tools.includes('run_code') ? 'run_code' : prior === 0 ? 'mnemon_status' : 'mnemon_document_search'
        const args = name === 'run_code' ? { description: 'Synthetic read', code: prior === 0
          ? 'return await tools.mnemon_status({})' : 'return await tools.mnemon_document_search({query:"synthetic"})' } : prior === 0 ? {} : { query: 'synthetic' }
        const id = `synthetic-${options.sessionId}-${prior}`
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const text = 'Synthetic reads complete.'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Adapter())
  const presets = []
  for (const preset of ['standard', 'ptc']) {
    const handle = await ctx.agents.create({ sessionId: 'synthetic-' + preset, meta: { cwd: workspace, agentPreset: preset },
      agentOptions: { provider: 'fixture', model: 'fixture' }, setup: async scoped => { await ctx.agentPresets.mount(scoped, preset) } })
    try {
      const agent = handle.agent
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read synthetic status and documents.' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const requests = observations.filter(item => item.id === agent.id)
      const events = agent.session.snapshotEvents()
      const errors = events.filter(event => event.type === 'tool/result').map(event => event.data.message.isError)
      assert.equal(requests.length, 3)
      assert(requests.every(request => request.memory && request.guide))
      assert.deepEqual(errors, [false, false])
      assert(events.some(event => event.type === 'turn/end'))
      assert(requests.every(request => preset === 'ptc' ? request.tools.includes('run_code')
        : request.tools.includes('mnemon_status') && request.tools.includes('mnemon_document_search')))
      presets.push({ preset, modelRequests: requests.length, guide: true, memorySnapshot: true,
        toolsRead: ['mnemon_status', 'mnemon_document_search'], toolErrors: errors, completedTurn: true })
    } finally { await handle.dispose() }
  }
  const result = { dsh: require('@deepseek-ai/dsh/package.json').version, node: process.version,
    profile: 'web', linkedBuiltStarter: !packedStarter, packedStarter: Boolean(packedStarter), syntheticModel: true, realModelRequests: 0, presets }
  await writeFile(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally {
  await ctx?.fiber.dispose()
  await rm(temporary, { recursive: true, force: true })
}
// Exit only after successful assertions and cleanup; failed checks retain a nonzero status.
process.exit(0)
