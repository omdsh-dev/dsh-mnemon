import { spawn } from 'node:child_process'

export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

export interface ProcessOptions {
  signal?: AbortSignal | undefined
  timeoutMs: number
  maxOutputBytes?: number
  cwd?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  label?: string | undefined
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: ProcessOptions,
) => Promise<ProcessResult>

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024

/** Spawn without a shell, with bounded output and cooperative cancellation. */
export const runProcess: ProcessRunner = (command, args, options) => new Promise((resolve, reject) => {
  const label = options.label ?? 'mnemon'
  const child = spawn(command, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  let stdout = ''
  let stderr = ''
  let outputBytes = 0
  let settled = false
  let killTimer: NodeJS.Timeout | undefined

  const stop = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 1500)
  }
  const finish = (error: Error | null, result?: ProcessResult): void => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    if (killTimer !== undefined) clearTimeout(killTimer)
    options.signal?.removeEventListener('abort', abort)
    if (error === null) resolve(result!)
    else reject(error)
  }
  const abort = (): void => {
    stop()
    finish(new Error(`${label} command aborted: ${String(options.signal?.reason ?? 'cancelled')}`))
  }
  const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
    outputBytes += chunk.byteLength
    if (outputBytes > maxOutputBytes) {
      stop()
      finish(new Error(`${label} output exceeded ${maxOutputBytes} bytes`))
      return
    }
    if (target === 'stdout') stdout += chunk.toString('utf8')
    else stderr += chunk.toString('utf8')
  }

  child.stdout.on('data', (chunk: Buffer) => { append('stdout', chunk) })
  child.stderr.on('data', (chunk: Buffer) => { append('stderr', chunk) })
  child.on('error', (error) => {
    finish(new Error(`failed to launch ${label} (${JSON.stringify(command)}): ${error.message}`))
  })
  child.on('close', (exitCode) => { finish(null, { stdout, stderr, exitCode }) })

  const timeout = setTimeout(() => {
    stop()
    finish(new Error(`${label} did not respond within ${options.timeoutMs}ms`))
  }, options.timeoutMs)
  if (options.signal?.aborted === true) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
})
