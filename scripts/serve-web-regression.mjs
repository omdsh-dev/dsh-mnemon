#!/usr/bin/env node
// Real npm DSH/Web UI packages with test-owned home, memory, workspace and model.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { constants, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: {
  package: { type: 'string', default: `link:${root}` },
  'web-ui': { type: 'string', default: '@linxin666/dsh-web-all@0.3.6' },
  cli: { type: 'string' },
  'cli-name': { type: 'string', default: 'mnemon' },
  'mnemon-first': { type: 'boolean', default: false },
  'panel-event-loss': { type: 'boolean', default: false },
  'display-mode': { type: 'string', default: 'sidebar' },
  'storage-scope': { type: 'string', default: 'custom' },
} })
if (!['sidebar', 'builtin', 'buildin'].includes(values['display-mode'])) throw new Error('--display-mode must be sidebar, builtin, or legacy buildin')
if (!['global', 'workspace', 'custom'].includes(values['storage-scope'])) throw new Error('--storage-scope must be global, workspace, or custom')
if (!values.cli) throw new Error('Pass --cli /absolute/path/to/a/test-owned/mnemon binary')
const cli = resolve(values.cli)
await access(cli, constants.X_OK)
const dshPackage = join(root, 'node_modules/@deepseek-ai/dsh')
const dshManifest = JSON.parse(await readFile(join(dshPackage, 'package.json'), 'utf8'))
if (dshManifest.version !== '0.1.1-rc.2') throw new Error(`Expected npm DSH 0.1.1-rc.2, got ${dshManifest.version}`)
const dshBin = join(dshPackage, 'lib/bin.js')
const fixture = await mkdtemp(join(tmpdir(), 'dsh-mnemon-npm-regression-'))
const dshHome = join(fixture, 'dsh-home')
const dataDir = join(fixture, 'memory')
const workspace = join(fixture, 'workspace')
await Promise.all([dshHome, dataDir, workspace].map(path => mkdir(path)))
const model = createServer(async (request, response) => {
  for await (const _chunk of request) { /* Never persist request input. */ }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const choice of [
    { index: 0, delta: { role: 'assistant', content: 'Isolated npm regression test response.' }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: 'stop' },
  ]) response.write(`data: ${JSON.stringify({ id: 'mnemon-regression', choices: [choice] })}\n\n`)
  response.end('data: [DONE]\n\n')
})
await new Promise((resolveListen, reject) => {
  model.once('error', reject)
  model.listen(0, '127.0.0.1', resolveListen)
})
const env = {
  ...process.env,
  PATH: `${dirname(cli)}${delimiter}${process.env.PATH ?? ''}`,
  DSH_HOME: dshHome,
  DSH_TELEMETRY_DISABLED: '1',
  MNEMON_DATA_DIR: dataDir,
  MNEMON_CLI_PATH: cli,
  DEEPSEEK_API_KEY: 'isolated-regression-key',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.address().port}`,
}
let web
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  if (web && web.exitCode === null) {
    web.kill('SIGTERM')
    await new Promise(resolveExit => web.once('exit', resolveExit))
  }
  model.closeAllConnections()
  await new Promise(resolveClose => model.close(resolveClose))
  console.log(`Stopped only this test instance. Retained fixture: ${fixture}`)
}
process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })

try {
  const packages = [
    values.package,
    ...(values['web-ui'] === 'none' ? [] : [values['web-ui']]),
    ...(values['panel-event-loss'] ? [`link:${join(root, 'scripts/web-regression-panel-event-loss')}`] : []),
  ]
  for (const group of values['mnemon-first'] ? packages.map(packageName => [packageName]) : [packages]) {
    // Optional SSH/PTY/tunnel native installers are outside this UI regression.
    const installer = spawn(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', ...group, '--ignore-scripts'], {
      env, cwd: workspace, stdio: 'inherit', shell: false,
    })
    await new Promise((resolveInstall, reject) => {
      installer.once('error', reject)
      installer.once('exit', code => code === 0 ? resolveInstall() : reject(new Error(`DSH plugin installation failed: ${code}`)))
    })
  }
  const preset = join(dshHome, '.agent-presets/mnemon-regression')
  await mkdir(preset, { recursive: true })
  await writeFile(join(preset, 'preset.yml'), 'name: Mnemon Regression\ndescription: Isolated npm regression (no Shell).\norder: 0\n')
  await writeFile(join(preset, 'agent.cordis.yml'), "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: You are testing an isolated memory workspace.\n")
  const disabled = ['bash-sandbox', 'pwsh-sandbox', 'tool-bash', 'tool-pwsh', 'permission', 'tool-fs-search', 'directory-picker']
  await writeFile(join(dshHome, 'profiles/web/cordis.patch.yml'), disabled.map(id => `- id: ${id}\n  disabled: true\n`).join('') + `
- id: mnemon
  config:
    cliPath: ${JSON.stringify(values['cli-name'])}
    displayMode: ${values['display-mode']}
    storageScope: ${values['storage-scope']}
${values['storage-scope'] === 'custom' ? `    dataDir: ${JSON.stringify(dataDir)}\n` : ''}    lifecycleEnabled: false
    writeEnabled: true
- id: agent-presets
  config:
    default: mnemon-regression
- insert:
    - id: regression-directory-picker
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: regression-directory-picker-ui
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
`)
  await writeFile(join(workspace, 'README.md'), '# Isolated npm Web UI regression\n\nSynthetic workspace: no personal memory or credentials.\n')
  const manifest = { fixture, workspace, dshHome, dataDir, cli, cliName: values['cli-name'], dsh: dshManifest.version, packages, displayMode: values['display-mode'], storageScope: values['storage-scope'], mnemonFirst: values['mnemon-first'], panelEventLoss: values['panel-event-loss'], harnessPid: process.pid }
  await writeFile(join(fixture, 'fixture.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify(manifest, null, 2))
  web = spawn(process.execPath, [dshBin, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  })
  const log = createWriteStream(join(fixture, 'dsh.log'), { flags: 'a' })
  for (const [stream, output] of [[web.stdout, process.stdout], [web.stderr, process.stderr]]) {
    stream.on('data', chunk => { output.write(chunk); log.write(chunk) })
  }
  manifest.webPid = web.pid
  await writeFile(join(fixture, 'fixture.json'), JSON.stringify(manifest, null, 2) + '\n')
  web.once('error', error => { console.error(error); process.exitCode = 1; void stop() })
  web.once('exit', code => { log.end(); if (code) process.exitCode = code; void stop() })
} catch (error) {
  console.error(error)
  process.exitCode = 1
  await stop()
}
