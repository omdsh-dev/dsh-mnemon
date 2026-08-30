import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix, resolve, win32 } from 'node:path'
import type { JsonValue } from './contracts.ts'
import type { ResolvedMemorySpacesConfig as ResolvedConfig } from './config.ts'
import { runProcess, type ProcessOptions, type ProcessRunner } from './providers/process.ts'

const UNIX_COMMON_CLI_PATHS = [
  '~/.local/bin/mnemon',
  '/opt/homebrew/bin/mnemon',
  '/usr/local/bin/mnemon',
  '/usr/bin/mnemon',
] as const

export interface CommandDiscoveryOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  isExecutable?: (path: string) => boolean
}

function pathApi(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix
}

function expandHome(path: string, home = homedir(), platform = process.platform): string {
  if (path === '~') return home
  return path.startsWith('~/') || path.startsWith('~\\') ? pathApi(platform).join(home, path.slice(2)) : path
}

function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name]
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

function executable(path: string, platform = process.platform): boolean {
  if (platform === 'win32' && win32.extname(path).toLowerCase() !== '.exe') return false
  try {
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function windowsCommonCliPaths(env: NodeJS.ProcessEnv, home: string): string[] {
  const candidates: string[] = []
  const goBin = envValue(env, 'GOBIN', 'win32')?.trim()
  if (goBin !== undefined && win32.isAbsolute(goBin)) candidates.push(win32.join(goBin, 'mnemon.exe'))

  const goPath = envValue(env, 'GOPATH', 'win32')?.trim()
  const goPathRoot = goPath?.split(win32.delimiter).map(candidate => candidate.trim())
    .find(candidate => candidate !== '' && win32.isAbsolute(candidate))
  const goInstallRoot = goPathRoot ?? win32.join(home, 'go')
  candidates.push(win32.join(goInstallRoot, 'bin', 'mnemon.exe'))

  const localAppData = envValue(env, 'LOCALAPPDATA', 'win32')?.trim()
  if (localAppData !== undefined && win32.isAbsolute(localAppData)) {
    candidates.push(win32.join(localAppData, 'Programs', 'mnemon', 'mnemon.exe'))
  }
  const programFiles = envValue(env, 'ProgramFiles', 'win32')?.trim()
  if (programFiles !== undefined && win32.isAbsolute(programFiles)) {
    candidates.push(win32.join(programFiles, 'mnemon', 'mnemon.exe'))
  }
  return [...new Set(candidates)]
}

function commonCliPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === 'win32') return windowsCommonCliPaths(env, home)
  return UNIX_COMMON_CLI_PATHS.map(candidate => expandHome(candidate, home, platform))
}

/** Locate the local Mnemon binary without invoking a shell. */
export function findMnemonCommand(
  config: Pick<ResolvedConfig, 'cliPath'>,
  options: CommandDiscoveryOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const isExecutable = options.isExecutable ?? (path => executable(path, platform))
  if (config.cliPath !== undefined) return expandHome(config.cliPath, home, platform)
  const envPath = envValue(env, 'MNEMON_CLI_PATH', platform)?.trim()
  if (envPath !== undefined && envPath !== '') {
    const path = expandHome(envPath, home, platform)
    if (isExecutable(path)) return path
  }
  const paths = pathApi(platform)
  for (const directory of (envValue(env, 'PATH', platform) ?? '').split(paths.delimiter)) {
    if (directory === '') continue
    for (const name of platform === 'win32' ? ['mnemon.exe'] : ['mnemon']) {
      const path = paths.join(directory, name)
      if (isExecutable(path)) return path
    }
  }
  for (const path of commonCliPaths(platform, env, home)) {
    if (isExecutable(path)) return path
  }
  return undefined
}

export class MnemonCliError extends Error {
  readonly exitCode: number | null
  readonly stderr: string

  constructor(message: string, exitCode: number | null = null, stderr = '') {
    super(message)
    this.name = 'MnemonCliError'
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

export interface MnemonRunOptions {
  signal?: AbortSignal
  globalFlags?: boolean
  store?: string
}

export interface MnemonTextCommand {
  args: readonly string[]
  options?: MnemonRunOptions
}

export interface MnemonRunner {
  readonly command: string
  readonly commandFound: boolean
  readonly config: ResolvedConfig
  runJson(args: readonly string[], options?: MnemonRunOptions): Promise<JsonValue>
  runText(args: readonly string[], options?: MnemonRunOptions): Promise<string>
  /** Run related CLI commands consecutively without allowing queued work between them. */
  runTextBatch(commands: readonly MnemonTextCommand[]): Promise<string[]>
  /** Run one operation after all CLI work and hold the same queue until it settles. */
  withExclusive<T>(operation: () => T | Promise<T>): Promise<T>
  effectiveDataDir(): string
  /** Read Mnemon's persisted active-file selection, ignoring config and environment overrides. */
  persistedStore(): string
  effectiveStore(): string
}

const EMBEDDING_ENVIRONMENT_KEYS = new Set(['MNEMON_EMBED_ENDPOINT', 'MNEMON_EMBED_MODEL', 'MNEMON_EMBED_API_KEY', 'MNEMON_EMBED_PROTOCOL'])

/** Preserve the Host environment while making saved embedding overrides authoritative. */
function processEnvironment(config: ResolvedConfig): NodeJS.ProcessEnv | undefined {
  if (!config.embedding.enabled) return undefined
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !EMBEDDING_ENVIRONMENT_KEYS.has(key.toUpperCase())))
  return {
    ...inherited,
    MNEMON_EMBED_ENDPOINT: config.embedding.endpoint,
    MNEMON_EMBED_MODEL: config.embedding.model,
    MNEMON_EMBED_API_KEY: config.embedding.apiKey,
    // 'auto' leaves the protocol to Mnemon's /v1 auto-detection.
    ...(config.embedding.protocol === 'auto' ? {} : { MNEMON_EMBED_PROTOCOL: config.embedding.protocol }),
  }
}

export function createRunner(config: ResolvedConfig, processRunner: ProcessRunner = runProcess, workspaceRoot?: string): MnemonRunner {
  const found = findMnemonCommand(config)
  const command = found ?? config.cliPath ?? 'mnemon'
  // Mnemon 0.1.2 runs store migrations while opening the database. Serializing
  // CLI processes prevents parallel status/viz calls during WebUI mount from
  // racing that migration and surfacing a transient SQLITE_BUSY error.
  let processQueue: Promise<void> = Promise.resolve()

  const globalArgs = (store?: string): string[] => {
    const args: string[] = []
    if (config.storageScope !== 'global' || config.dataDir !== undefined) args.push('--data-dir', effectiveDataDir())
    if (store !== undefined) args.push('--store', store)
    else if (config.store !== undefined) args.push('--store', config.store)
    return args
  }
  const effectiveDataDir = (): string => {
    if (config.storageScope === 'workspace') return resolve(workspaceRoot ?? process.cwd(), '.mnemon')
    if (config.storageScope === 'custom') return expandHome(config.dataDir!)
    return expandHome(process.env.MNEMON_DATA_DIR?.trim() || '~/.mnemon')
  }
  const persistedStore = (): string => {
    const active = join(effectiveDataDir(), 'active')
    if (existsSync(active)) {
      try {
        const value = readFileSync(active, 'utf8').trim()
        if (/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) return value
      } catch {
        // Fall through to Mnemon's own default.
      }
    }
    return 'default'
  }
  const launch = async (
    args: readonly string[],
    options: MnemonRunOptions = {},
  ): Promise<string> => {
    if (options.signal?.aborted === true) throw new MnemonCliError(`mnemon command aborted: ${String(options.signal.reason ?? 'cancelled')}`)
    const argv = options.globalFlags === false ? [...args] : [...globalArgs(options.store), ...args]
    const environment = processEnvironment(config)
    const processOptions: ProcessOptions = {
      timeoutMs: config.timeoutMs,
      ...(environment === undefined ? {} : { env: environment }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }
    let result
    try {
      result = await processRunner(command, argv, processOptions)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const hint = process.platform === 'win32'
        ? 'Install the official Mnemon Windows release, ensure mnemon.exe is on PATH or under %LOCALAPPDATA%\\Programs\\mnemon, or set MNEMON_CLI_PATH or mnemon.cliPath to its absolute path.'
        : 'Install Mnemon and ensure "mnemon" is on PATH, or set MNEMON_CLI_PATH or mnemon.cliPath.'
      throw new MnemonCliError(
        `${detail}. ${hint}`,
      )
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || 'no output'
      throw new MnemonCliError(`mnemon ${args.join(' ')} exited ${String(result.exitCode)}: ${detail}`, result.exitCode, result.stderr)
    }
    return result.stdout
  }

  const execute = (
    args: readonly string[],
    options: MnemonRunOptions = {},
  ): Promise<string> => {
    const result = processQueue.then(() => launch(args, options))
    processQueue = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    command,
    commandFound: found !== undefined && executable(found),
    config,
    async runJson(args, options) {
      const stdout = await execute(args, options)
      try {
        return JSON.parse(stdout) as JsonValue
      } catch {
        throw new MnemonCliError(`mnemon ${args.join(' ')} returned invalid JSON`)
      }
    },
    runText: execute,
    runTextBatch(commands) {
      const result = processQueue.then(async () => {
        const outputs: string[] = []
        for (const command of commands) outputs.push(await launch(command.args, command.options))
        return outputs
      })
      processQueue = result.then(() => undefined, () => undefined)
      return result
    },
    withExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
      const result = processQueue.then(operation)
      processQueue = result.then(() => undefined, () => undefined)
      return result
    },
    effectiveDataDir() {
      return effectiveDataDir()
    },
    persistedStore() {
      return persistedStore()
    },
    effectiveStore() {
      if (config.store !== undefined) return config.store
      const fromEnvironment = process.env.MNEMON_STORE?.trim()
      if (fromEnvironment !== undefined && fromEnvironment !== '') return fromEnvironment
      return persistedStore()
    },
  }
}
