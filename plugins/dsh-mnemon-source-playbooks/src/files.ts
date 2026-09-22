import { randomUUID } from 'node:crypto'
import { link, mkdir, open, rename, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { lock } from 'proper-lockfile'
import { withMemoryStorageLock } from 'dsh-mnemon/extension-sdk'
import { allowedDirectories, allowedFile, digest, readBoundedFile, resolveRipgrepPath, runBoundedProcess } from 'dsh-mnemon/source-sdk'

export async function listSkillFiles(roots: string[], signal?: AbortSignal): Promise<string[]> {
  const allowed = await allowedDirectories(roots)
  if (!allowed.length) return []
  const result = await runBoundedProcess(await resolveRipgrepPath(), ['--no-config', '--files', '--glob', '*.md', '--', ...allowed], {
    ...(signal ? { signal } : {}), maxBytes: 256 * 1024, timeoutMs: 5000,
  })
  if (result.code !== 0 && result.code !== 1) throw new Error('Could not list configured skill files')
  return result.stdout.split('\n').filter(Boolean).slice(0, 300)
}

export async function readSkillFile(roots: string[], path: string, signal?: AbortSignal, textResource = false) {
  const allowed = await allowedDirectories(roots), filename = await allowedFile(allowed, path)
  if (!filename.endsWith('.md') && !textResource) throw new Error('Only Markdown skill files can be edited')
  const content = (await readBoundedFile(allowed, filename, 256 * 1024, signal)).toString('utf8')
  return { path: filename, content, digest: digest(content) }
}

export async function saveSkillFile(roots: string[], path: string, content: string, expected: string, signal?: AbortSignal, textResource = false) {
  if (Buffer.byteLength(content) > 256 * 1024) throw new Error('Skill file exceeds 256 KiB')
  const filename = await allowedFile(await allowedDirectories(roots), path)
  return withMemoryStorageLock(filename, async () => {
    signal?.throwIfAborted()
    let compromised: Error | undefined
    const release = await lock(filename, {
      stale: 10000, update: 2000, retries: { retries: 12, minTimeout: 50, maxTimeout: 500 },
      onCompromised(error) { compromised = error },
    })
    const temporary = join(dirname(filename), '.skill-' + randomUUID() + '.tmp')
    try {
      const current = await readSkillFile(roots, path, signal, textResource)
      if (current.digest !== expected) throw new Error('Skill file changed; read it again before saving')
      const handle = await open(temporary, 'wx', (await stat(filename)).mode & 0o777)
      try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
      signal?.throwIfAborted()
      if (compromised) throw compromised
      if ((await readSkillFile(roots, path, signal, textResource)).digest !== expected) throw new Error('Skill file changed before commit')
      await rename(temporary, filename)
      return { path: filename, content, digest: digest(content) }
    } finally {
      await rm(temporary, { force: true })
      await release()
    }
  })
}

/** Create one named skill in an explicitly registered root, without replacing files. */
export async function createSkillFile(roots: string[], root: string, name: string, content: string, signal?: AbortSignal) {
  const allowed = await allowedDirectories(roots)
  if (!allowed.includes(root) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(name)) throw new Error('Choose a registered directory and a lowercase skill name')
  if (!content.trim() || Buffer.byteLength(content) > 256 * 1024) throw new Error('Skill content must be between 1 byte and 256 KiB')
  signal?.throwIfAborted()
  const directory = join(root, name), filename = join(directory, 'SKILL.md'), temporary = join(directory, '.skill-' + randomUUID() + '.tmp')
  await mkdir(directory, { mode: 0o700 })
  try {
    signal?.throwIfAborted()
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    signal?.throwIfAborted()
    await link(temporary, filename)
    return { path: filename, content, digest: digest(content) }
  } finally {
    await rm(temporary, { force: true })
    // Only remove an empty failed creation; leave existing files alone.
    await rmdir(directory).catch(() => {})
  }
}

/** Removing a skill preserves a recoverable sibling file, excluded from discovery. */
export async function archiveSkillFile(roots: string[], path: string, expected: string, signal?: AbortSignal) {
  const filename = await allowedFile(await allowedDirectories(roots), path)
  return withMemoryStorageLock(filename, async () => {
    let compromised: Error | undefined
    const release = await lock(filename, { stale: 10000, update: 2000, retries: { retries: 12, minTimeout: 50, maxTimeout: 500 }, onCompromised(error) { compromised = error } })
    try {
      signal?.throwIfAborted()
      const current = await readSkillFile(roots, filename, signal)
      if (current.digest !== expected) throw new Error('Skill file changed; read it again before removing')
      const archivedPath = join(dirname(filename), '.' + basename(filename) + '.' + randomUUID() + '.archived')
      signal?.throwIfAborted()
      if (compromised) throw compromised
      await rename(filename, archivedPath)
      return { path: filename, archivedPath }
    } finally { await release() }
  })
}
