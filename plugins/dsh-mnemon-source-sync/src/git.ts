import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import type { Bundle } from './protocol.ts'
import { canonical } from './protocol.ts'
export const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
export function remoteAddress(value: string, allowLocal: boolean): string {
  const remote = value.trim()
  if (!remote || remote.length > 2000 || /[\x00-\x20\x7f]/.test(remote) || remote.startsWith('-')) throw new Error('Enter a Git remote without whitespace or options')
  if (allowLocal && isAbsolute(remote)) return remote
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9._/-]+$/.test(remote)) return remote
  let url: URL
  try { url = new URL(remote) } catch { throw new Error('Use an HTTPS or SSH Git remote') }
  if (!['https:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash || url.protocol === 'https:' && url.username) throw new Error('Git remote must use HTTPS or SSH without embedded credentials')
  return remote
}
export function repositoryIdentity(remote: string): string {
  const scp = /^(?:[^@]+@)?([^/:]+):(.+)$/.exec(remote)
  if (scp && !remote.includes('://')) return `${scp[1]!.toLowerCase()}/${scp[2]}`.replace(/\.git\/?$/, '').replace(/\/$/, '')
  try { const url = new URL(remote); return `${url.hostname.toLowerCase()}${url.port ? ':' + url.port : ''}/${url.pathname.replace(/^\//, '')}`.replace(/\.git\/?$/, '').replace(/\/$/, '') } catch { return remote.replace(/\.git\/?$/, '').replace(/\/$/, '') }
}
export class GitFailure extends Error { constructor(readonly exitCode: number | null, message: string) { super(message) } }
const baseArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never']
export async function git(args: string[], options: { input?: string; signal?: AbortSignal; allowLocal?: boolean; directory?: string } = {}): Promise<string> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_AUTHOR_NAME: 'Memory snapshots', GIT_AUTHOR_EMAIL: 'snapshots@localhost', GIT_COMMITTER_NAME: 'Memory snapshots', GIT_COMMITTER_EMAIL: 'snapshots@localhost' }
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT']) delete (env as Record<string, string | undefined>)[key]
    const child = spawn('git', [...baseArgs, ...(options.allowLocal ? ['-c', 'protocol.file.allow=always'] : []), ...(options.directory ? ['--git-dir', options.directory] : []), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', bytes = 0, failure: Error | undefined
    const stop = (error: Error) => { failure ??= error; child.kill('SIGKILL') }
    const timer = setTimeout(() => stop(new Error('Git operation timed out after 30 seconds')), 30000)
    const abort = () => stop(new Error('Git operation cancelled'))
    options.signal?.addEventListener('abort', abort, { once: true })
    const collect = (chunk: string, output: boolean) => { bytes += Buffer.byteLength(chunk); if (bytes > 20 * 1024 * 1024) { stop(new Error('Git output exceeds its bound')); return } if (output) stdout += chunk; else stderr += chunk }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => collect(chunk, true)); child.stderr.on('data', chunk => collect(chunk, false))
    child.on('error', error => { failure = error })
    child.stdin.on('error', () => {})
    child.on('close', code => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); if (failure) reject(failure); else if (code !== 0) reject(new GitFailure(code, stderr.trim().slice(-1500) || 'Git command failed')); else resolve(stdout.trimEnd()) })
    child.stdin.end(options.input ?? '')
    if (options.signal?.aborted) abort()
  })
}
export async function suggestedIdentity(workspaceId?: string): Promise<{ origin: string; projectKey: string }> {
  if (!workspaceId) return { origin: '', projectKey: '' }
  try { const origin = await git(['-C', workspaceId, 'remote', 'get-url', 'origin']); return { origin: remoteAddress(origin, true), projectKey: repositoryIdentity(origin) } } catch { return { origin: '', projectKey: '' } }
}
export class SnapshotGit {
  constructor(readonly directory: string, readonly allowLocal: boolean) {}
  run(args: string[], signal?: AbortSignal, input?: string) { return git(args, { directory: this.directory, allowLocal: this.allowLocal, ...(signal ? { signal } : {}), ...(input === undefined ? {} : { input }) }) }
  async initialize(signal?: AbortSignal) { await mkdir(this.directory, { recursive: true, mode: 0o700 }); await git(['init', '--bare', '--template=', this.directory], { ...(signal ? { signal } : {}) }) }
  async head(branch: string, signal?: AbortSignal): Promise<string> { try { return await this.run(['rev-parse', '--verify', `refs/heads/${branch}`], signal) } catch (error) { if (error instanceof GitFailure && error.exitCode === 128) return ''; throw error } }
  async fetch(remote: string, branch: string, signal?: AbortSignal): Promise<string> {
    try { await this.run(['ls-remote', '--exit-code', '--heads', '--', remote, `refs/heads/${branch}`], signal) }
    catch (error) { if (error instanceof GitFailure && error.exitCode === 2) return ''; throw error }
    await this.run(['fetch', '--no-tags', '--', remote, `+refs/heads/${branch}:refs/remotes/memory/snapshot`], signal)
    return this.run(['rev-parse', '--verify', 'refs/remotes/memory/snapshot'], signal)
  }
  async common(left: string, right: string, signal?: AbortSignal): Promise<string> { if (!left || !right) return ''; try { return await this.run(['merge-base', left, right], signal) } catch (error) { if (error instanceof GitFailure && error.exitCode === 1) return ''; throw error } }
  async bundle(commit: string, identity: string, scope: Bundle['scope'], signal?: AbortSignal): Promise<Bundle> {
    if (!commit) return { format: 'mnemon-sync/v1', identity, scope, tracks: {} }
    const body = await this.run(['show', `${commit}:bundle.json`], signal)
    if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('Remote snapshot exceeds 8 MiB')
    const value = JSON.parse(body) as Bundle
    if (value.format !== 'mnemon-sync/v1' || value.identity !== identity || value.scope !== scope || !value.tracks || typeof value.tracks !== 'object' || Array.isArray(value.tracks) || Object.keys(value.tracks).length > 100) throw new Error('Snapshot identity or format does not match this target')
    return value
  }
  async reviewedHead(bundle: Bundle, branch: string, expectedHead: string, remoteHead: string, operationId: string, signal?: AbortSignal): Promise<string> {
    const current = await this.head(branch, signal)
    const parents = [...new Set([expectedHead, remoteHead].filter(Boolean))]
    if (current !== expectedHead) {
      // Recover an acknowledged Git ref update whose subsequent local receipt
      // write was interrupted. A different commit never becomes an implicit retry.
      const message = await this.run(['show', '-s', '--format=%B', current], signal)
      const actualParents = (await this.run(['show', '-s', '--format=%P', current], signal)).split(' ').filter(Boolean)
      if (message.includes('\nSync-Plan: ' + operationId) && canonical(actualParents) === canonical(parents) && hash(await this.bundle(current, bundle.identity, bundle.scope, signal)) === hash(bundle)) return current
      throw new Error('Snapshot branch changed; prepare a new merge')
    }
    return current
  }
  async commit(bundle: Bundle, branch: string, expectedHead: string, remoteHead: string, operationId: string, signal?: AbortSignal): Promise<string> {
    const current = await this.reviewedHead(bundle, branch, expectedHead, remoteHead, operationId, signal)
    if (current !== expectedHead) return current
    const parents = [...new Set([expectedHead, remoteHead].filter(Boolean))]
    const blob = await this.run(['hash-object', '-w', '--stdin'], signal, canonical(bundle) + '\n')
    const tree = await this.run(['mktree'], signal, `100644 blob ${blob}\tbundle.json\n`)
    const commit = await this.run(['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent])], signal, 'chore(memory): reconcile reviewed snapshots\n\nSync-Plan: ' + operationId + '\n')
    await this.run(['update-ref', `refs/heads/${branch}`, commit, expectedHead || '0000000000000000000000000000000000000000'], signal)
    return commit
  }
  async push(remote: string, branch: string, head: string, signal?: AbortSignal) {
    if (!head || await this.head(branch, signal) !== head) throw new Error('The reviewed snapshot changed; refresh before pushing')
    await this.run(['push', '--porcelain', '--', remote, `${head}:refs/heads/${branch}`], signal)
  }
}
