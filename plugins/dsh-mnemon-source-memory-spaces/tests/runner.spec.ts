import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveMemorySpacesConfig as resolveConfig } from '../src/config.ts'
import { createRunner, findMnemonCommand } from '../src/runner.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mnemon-runner-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('Mnemon CLI discovery', () => {
  it.each([
    { platform: 'darwin' as const, command: 'mnemon', env: { PATH: '/tools/bin' }, expected: '/tools/bin/mnemon' },
    { platform: 'linux' as const, command: 'mnemon-custom', env: { PATH: '/tools/bin' }, expected: '/tools/bin/mnemon-custom' },
    { platform: 'win32' as const, command: 'mnemon', env: { Path: 'C:\\tools' }, expected: 'C:\\tools\\mnemon.exe' },
    { platform: 'win32' as const, command: 'mnemon.exe', env: { Path: 'C:\\tools' }, expected: 'C:\\tools\\mnemon.exe' },
  ])('resolves the configured command name through PATH on $platform ($command)', ({ platform, command, env, expected }) => {
    expect(findMnemonCommand({ cliPath: command }, {
      platform, env, home: '/unused', isExecutable: path => path === expected,
    })).toBe(expected)
  })

  it('does not substitute a different binary for an unavailable configured command', () => {
    expect(findMnemonCommand({ cliPath: 'missing-mnemon' }, {
      platform: 'linux', env: { PATH: '/tools', MNEMON_CLI_PATH: '/other/mnemon' }, home: '/unused',
      isExecutable: path => path === '/tools/mnemon' || path === '/other/mnemon',
    })).toBeUndefined()
  })

  it('uses the same executable for command-name health checks and execution', async () => {
    const root = temporaryDirectory()
    const binary = join(root, process.platform === 'win32' ? 'mnemon.exe' : 'mnemon')
    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    vi.stubEnv('PATH', root)
    vi.stubEnv('MNEMON_CLI_PATH', '')
    const config = resolveConfig({ cliPath: 'mnemon', dataDir: root })
    const run = vi.fn(async () => ({ stdout: 'mnemon version 0.2.5\n', stderr: '', exitCode: 0 }))
    const runner = createRunner(config, run)

    expect(runner.command).toBe(binary)
    expect(runner.commandFound).toBe(true)
    await runner.runText(['--version'], { globalFlags: false })
    expect(run).toHaveBeenCalledWith(binary, ['--version'], expect.any(Object))
  })

  it('refreshes CLI discovery after installation and removal without recreating the runner', async () => {
    const root = temporaryDirectory()
    const binary = join(root, process.platform === 'win32' ? 'mnemon.exe' : 'mnemon')
    vi.stubEnv('PATH', root)
    vi.stubEnv('MNEMON_CLI_PATH', '')
    const run = vi.fn(async () => ({ stdout: 'mnemon version 0.2.5\n', stderr: '', exitCode: 0 }))
    const runner = createRunner(resolveConfig({ cliPath: 'mnemon', dataDir: root }), run)
    expect(runner.commandFound).toBe(false)

    writeFileSync(binary, 'fixture')
    chmodSync(binary, 0o755)
    expect(runner.commandFound).toBe(true)
    expect(runner.command).toBe(binary)
    await runner.runText(['--version'], { globalFlags: false })
    expect(run).toHaveBeenCalledWith(binary, ['--version'], expect.any(Object))

    rmSync(binary)
    expect(runner.commandFound).toBe(false)
  })

  it('keeps an explicit cliPath first and expands Windows home syntax', () => {
    expect(findMnemonCommand(
      { cliPath: '~\\go\\bin\\mnemon.exe' },
      { platform: 'win32', env: {}, home: 'C:\\Users\\alice', isExecutable: () => false },
    )).toBe('C:\\Users\\alice\\go\\bin\\mnemon.exe')
  })

  it('reads Windows environment names case-insensitively and accepts only mnemon.exe from PATH', () => {
    const probes: string[] = []
    const command = findMnemonCommand({}, {
      platform: 'win32',
      env: { Path: 'C:\\tools' },
      home: 'C:\\Users\\alice',
      isExecutable: (path) => {
        probes.push(path)
        return path.endsWith('mnemon.cmd')
      },
    })

    expect(command).toBeUndefined()
    expect(probes).toContain('C:\\tools\\mnemon.exe')
    expect(probes.every(path => !path.endsWith('.cmd'))).toBe(true)
  })

  it.each([
    {
      name: 'GOBIN',
      env: { GOBIN: 'D:\\go-bin', GOPATH: 'E:\\go-work' },
      expected: 'D:\\go-bin\\mnemon.exe',
    },
    {
      name: 'the first GOPATH entry',
      env: { GOPATH: 'D:\\go-work;E:\\other-work' },
      expected: 'D:\\go-work\\bin\\mnemon.exe',
    },
    {
      name: 'the default user Go bin',
      env: {},
      expected: 'C:\\Users\\alice\\go\\bin\\mnemon.exe',
    },
    {
      name: 'LOCALAPPDATA programs',
      env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
      expected: 'C:\\Users\\alice\\AppData\\Local\\Programs\\mnemon\\mnemon.exe',
    },
    {
      name: 'Program Files',
      env: { ProgramFiles: 'C:\\Program Files' },
      expected: 'C:\\Program Files\\mnemon\\mnemon.exe',
    },
  ])('discovers a Windows binary from $name', ({ env, expected }) => {
    expect(findMnemonCommand({}, {
      platform: 'win32',
      env,
      home: 'C:\\Users\\alice',
      isExecutable: path => path === expected,
    })).toBe(expected)
  })

  it('rejects a directory and accepts a regular .exe file on Windows', () => {
    const root = temporaryDirectory()
    const directory = join(root, 'directory.exe')
    const command = join(root, 'mnemon.exe')
    mkdirSync(directory)
    writeFileSync(command, 'fixture', 'utf8')

    expect(findMnemonCommand({}, {
      platform: 'win32', env: { MNEMON_CLI_PATH: directory }, home: root,
    })).toBeUndefined()
    expect(findMnemonCommand({}, {
      platform: 'win32', env: { MNEMON_CLI_PATH: command }, home: root,
    })).toBe(command)
  })

  it('uses native Windows path joining for discovery candidates', () => {
    const expected = win32.join('C:\\Users\\alice', 'go', 'bin', 'mnemon.exe')
    expect(findMnemonCommand({}, {
      platform: 'win32', env: {}, home: 'C:\\Users\\alice', isExecutable: path => path === expected,
    })).toBe(expected)
  })
})
