import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export const withinRoot = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel === '' || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}
const sensitive = (target: string): boolean => target.split(/[\\/]/).some(part => /^(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.env(?:\..*)?|credentials(?:\.json)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?)$/i.test(part))

/** Resolve only explicitly configured directories and the current workspace. */
export async function allowedDirectories(configured: readonly string[], workspace?: string): Promise<string[]> {
  const result: string[] = []
  for (const value of [...(workspace ? [workspace] : []), ...configured]) {
    if (!isAbsolute(value)) throw new Error('Read roots must be absolute directories')
    const root = await realpath(value)
    if (root === sep || sensitive(root)) throw new Error('A filesystem root or credential directory cannot be a read root')
    if (!(await stat(root)).isDirectory()) throw new Error('Read root is not a directory')
    if (!result.includes(root)) result.push(root)
  }
  if (result.length > 16) throw new Error('At most sixteen read roots are supported')
  return result
}

/** Validate canonical paths, including system aliases such as /var on macOS. */
export async function allowedFile(roots: readonly string[], value: string): Promise<string> {
  if (!value || value.includes('\0') || sensitive(value)) throw new Error('This path is not available for reading')
  const candidate = resolve(roots[0] ?? '.', value)
  const target = await realpath(candidate)
  if (sensitive(target) || !roots.some(root => withinRoot(root, target))) throw new Error('Resolved path is outside the registered roots')
  if (!(await stat(target)).isFile()) throw new Error('Path is not a regular file')
  return target
}

export async function readBoundedFile(roots: readonly string[], value: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  const target = await allowedFile(roots, value)
  const before = await stat(target)
  if (before.size > maxBytes) throw new Error('File exceeds the configured read limit')
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile() || opened.size > maxBytes) throw new Error('File changed while opening; retry')
    signal?.throwIfAborted()
    // Do not allow a growing file to allocate an unbounded buffer.
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, opened.size + 1))
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      signal?.throwIfAborted()
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (!chunk.bytesRead) break
      bytesRead += chunk.bytesRead
    }
    signal?.throwIfAborted()
    if (bytesRead > maxBytes) throw new Error('File exceeds the configured read limit')
    const after = await handle.stat()
    if (bytesRead !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error('File changed while reading; retry')
    return buffer.subarray(0, bytesRead)
  } finally { await handle.close() }
}

export interface ProcessResult { code: number | null; stdout: string; stderr: string; truncated: boolean }

/** Resolve the declared platform binary lazily; explicit local overrides remain supported. */
export async function resolveRipgrepPath(configured?: string): Promise<string> {
  if (configured?.trim()) return configured
  return (await import('@vscode/ripgrep')).rgPath
}

/** An argv-only child, bounded in time and output, with process-group cancellation. */
export function runBoundedProcess(command: string, args: readonly string[], options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv; stdin?: string; onOutput?(stream: 'stdout' | 'stderr', text: string): void } = {}): Promise<ProcessResult> {
  options.signal?.throwIfAborted()
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}) })
    child.stdin.on('error', () => { /* A child may exit before consuming all input. */ })
    child.stdin.end(options.stdin ?? '')
    let stdout = '', stderr = '', size = 0, truncated = false, failure: unknown
    const max = options.maxBytes ?? 2 * 1024 * 1024
    const kill = (signal: NodeJS.Signals) => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal) } catch { /* Already exited. */ } }
    let force: ReturnType<typeof setTimeout> | undefined
    const stop = () => { kill('SIGTERM'); force ??= setTimeout(() => kill('SIGKILL'), 500); force.unref() }
    const abort = () => { failure = options.signal?.reason ?? new Error('Process cancelled'); stop() }
    const timer = setTimeout(() => { failure = new Error('Process timed out'); stop() }, options.timeoutMs ?? 10_000)
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const collect = (chunk: Buffer, error: boolean) => {
      const remaining = Math.max(0, max - size)
      const stream = error ? 'stderr' : 'stdout'
      const value = decoders[stream].write(chunk.subarray(0, remaining))
      if (error) stderr += value; else stdout += value
      try { options.onOutput?.(stream, value) } catch (reason) { failure = reason; stop() }
      size += chunk.length
      if (size > max) { truncated = true; stop() }
    }
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, false))
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, true))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    const cleanup = () => { clearTimeout(timer); if (force) clearTimeout(force); options.signal?.removeEventListener('abort', abort) }
    child.once('error', error => { cleanup(); reject(error) })
    child.once('close', code => { cleanup(); stdout += decoders.stdout.end(); stderr += decoders.stderr.end(); if (failure) reject(failure); else resolveResult({ code, stdout, stderr, truncated }) })
  })
}
