import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

export interface ProcessOptions {
  signal?: AbortSignal | undefined
  timeoutMs: number
  killGraceMs?: number | undefined
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
const DEFAULT_KILL_GRACE_MS = 1_500

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
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  let stdout = ''
  let stderr = ''
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  let outputBytes = 0
  let settled = false
  let killTimer: NodeJS.Timeout | undefined

  const clearKillTimer = (): void => {
    if (killTimer !== undefined) {
      clearTimeout(killTimer)
      killTimer = undefined
    }
  }

  const stop = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (killTimer !== undefined) return
    child.kill('SIGTERM')
    killTimer = setTimeout(() => {
      killTimer = undefined
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, killGraceMs)
    killTimer.unref?.()
  }
  const finish = (error: Error | null, result?: ProcessResult): void => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
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
    if (target === 'stdout') stdout += stdoutDecoder.write(chunk)
    else stderr += stderrDecoder.write(chunk)
  }

  child.stdout.on('data', (chunk: Buffer) => { append('stdout', chunk) })
  child.stderr.on('data', (chunk: Buffer) => { append('stderr', chunk) })
  child.on('error', (error) => {
    clearKillTimer()
    finish(new Error(`failed to launch ${label} (${JSON.stringify(command)}): ${error.message}`))
  })
  child.on('close', (exitCode) => {
    clearKillTimer()
    stdout += stdoutDecoder.end()
    stderr += stderrDecoder.end()
    finish(null, { stdout, stderr, exitCode })
  })

  const timeout = setTimeout(() => {
    stop()
    finish(new Error(`${label} did not respond within ${options.timeoutMs}ms`))
  }, options.timeoutMs)
  if (options.signal?.aborted === true) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
})
