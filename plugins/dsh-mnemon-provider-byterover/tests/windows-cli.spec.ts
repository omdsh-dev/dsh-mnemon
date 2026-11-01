import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemorySpaceProviderFixture } from 'dsh-mnemon-source-memory-spaces/testing'
import { resolveByteRoverInvocation } from '../src/cli.ts'
import { ByteRoverProvider, descriptor } from '../src/index.ts'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const temporary: string[] = []
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'byterover npm path ')))
  temporary.push(root)
  const packageRoot = join(root, 'node_modules', 'byterover-cli')
  mkdirSync(join(packageRoot, 'bin'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'byterover-cli', bin: { brv: 'bin/run.js' } }))
  const launcher = join(packageRoot, 'bin', 'run.js')
  writeFileSync(launcher, `const fs = require('node:fs'); const result = { args: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE, apiKey: process.env.BRV_API_KEY, cwd: process.cwd() }; fs.appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))}, JSON.stringify(result) + '\\n'); console.log(JSON.stringify(result))`)
  const shim = join(root, 'brv.cmd')
  writeFileSync(shim, '@"%dp0%\\node_modules\\byterover-cli\\bin\\run.js" %*')
  return { root, packageRoot, launcher, shim }
}

function provider(f: ReturnType<typeof fixture>, cliPath?: string) {
  const { authority, body } = createMemorySpaceProviderFixture(descriptor, {
    ...(cliPath === undefined ? {} : { cliPath }), workingDirectory: 'knowledge with spaces', apiKey: 'synthetic-key',
  }, { dataDir: f.root })
  return { adapter: new ByteRoverProvider(authority), body }
}

// Changing the launch command or dropping the argument array breaks the real
// child readback, including shell metacharacters, spaces, quotes and newlines.
describe('Windows npm ByteRover launcher', () => {
  it.each(['default', 'bare-cmd', 'explicit'] as const)('runs the %s npm shim through Node with literal query and curate arguments', async mode => {
    const f = fixture()
    vi.stubEnv('PATH', f.root)
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '0')
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const { adapter, body } = provider(f, mode === 'explicit' ? f.shim : mode === 'bare-cmd' ? 'brv.cmd' : undefined)
    const content = 'literal & | > < ^ %PATH% !bang! $value `command` "quoted"\nsecond line'
    const result = await adapter.search(body, { query: content })
    expect(JSON.parse(result.results[0]!.content)).toEqual({ args: ['query', '--', content], electron: '1', apiKey: 'synthetic-key', cwd: join(f.root, 'knowledge with spaces') })
    await expect(adapter.remember(body, { content })).resolves.toMatchObject({ action: 'stored' })
    const calls = readFileSync(join(f.root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(calls[1].args).toEqual(['curate', '--', content])
    expect(process.env.ELECTRON_RUN_AS_NODE).toBe('0')
    await expect(adapter.status(body)).resolves.toEqual({ healthy: true })
  })

  it('handles quoted Windows PATH directories and environment names without duplicates', () => {
    const f = fixture()
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const result = resolveByteRoverInvocation('brv', ['status'], { pAtH: `"${join(f.root, 'missing')}";"${f.root}"`, electron_run_as_node: '0' })
    expect({ command: result.command, args: result.args }).toEqual({ command: process.execPath, args: [f.launcher, 'status'] })
    expect(result.env).toEqual({ pAtH: `"${join(f.root, 'missing')}";"${f.root}"`, ELECTRON_RUN_AS_NODE: '1' })
  })

  it('prefers a native brv.exe in the same PATH directory', () => {
    const f = fixture()
    writeFileSync(join(f.root, 'brv.exe'), '')
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const result = resolveByteRoverInvocation('brv', ['status'], { PATH: f.root })
    expect(result).toEqual({ command: join(f.root, 'brv.exe'), args: ['status'], env: { PATH: f.root } })
  })

  it('gives installation guidance when brv is missing from the Windows PATH', async () => {
    const f = fixture()
    vi.stubEnv('PATH', join(f.root, 'missing'))
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const { adapter, body } = provider(f)
    await expect(adapter.status(body)).resolves.toMatchObject({ healthy: false, error: expect.stringContaining('npm install -g byterover-cli') })
  })

  it.each(['wrong-package', 'wrong-bin', 'wrong-shim', 'lookalike-shim', 'invalid-json', 'missing-launcher'] as const)('rejects %s instead of executing an unrecognized batch file', async reason => {
    const f = fixture()
    if (reason === 'wrong-package') writeFileSync(join(f.packageRoot, 'package.json'), JSON.stringify({ name: 'unrelated', bin: { brv: 'bin/run.js' } }))
    if (reason === 'wrong-bin') writeFileSync(join(f.packageRoot, 'package.json'), JSON.stringify({ name: 'byterover-cli', bin: { brv: '../unrelated.js' } }))
    if (reason === 'wrong-shim') writeFileSync(f.shim, '@echo unrelated')
    if (reason === 'lookalike-shim') writeFileSync(f.shim, '@"%dp0%\\node_modules\\byterover-cli\\bin\\run.jsx" %*')
    if (reason === 'invalid-json') writeFileSync(join(f.packageRoot, 'package.json'), '{')
    if (reason === 'missing-launcher') rmSync(f.launcher)
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const { adapter, body } = provider(f, f.shim)
    await expect(adapter.status(body)).resolves.toMatchObject({ healthy: false, error: expect.stringContaining('npm install -g byterover-cli') })
  })

  it('preserves a custom executable and its argument boundaries on Windows', async () => {
    const f = fixture()
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const { authority, body } = createMemorySpaceProviderFixture(descriptor, { cliPath: process.execPath }, { dataDir: f.root })
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const adapter = new ByteRoverProvider(authority, { process: async (command, args) => { calls.push({ command, args }); return { stdout: '', stderr: '', exitCode: 0 } } })
    await adapter.search(body, { query: 'literal & argument' })
    expect(calls[0]).toEqual({ command: process.execPath, args: ['query', '--', 'literal & argument'] })
  })

  it('keeps non-Windows commands on the existing direct process route', async () => {
    const f = fixture()
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    const { authority, body } = createMemorySpaceProviderFixture(descriptor, {}, { dataDir: f.root })
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const adapter = new ByteRoverProvider(authority, { process: async (command, args) => { calls.push({ command, args }); return { stdout: '', stderr: '', exitCode: 0 } } })
    await adapter.status(body)
    expect(calls[0]).toEqual({ command: 'brv', args: ['status'] })
  })
})
