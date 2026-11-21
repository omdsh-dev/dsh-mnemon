import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export function canonicalWorkspacePath(workspacePath: string): string {
  if (!isAbsolute(workspacePath) || workspacePath.includes('\0')) throw new Error('Workspace path must be absolute')
  let parent = resolve(workspacePath)
  const suffix: string[] = []
  for (;;) {
    let real: string
    try { real = realpathSync.native(parent) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const next = dirname(parent)
      if (next === parent) throw error
      suffix.unshift(parent.slice(next.length).replace(/^[/\\]+/u, ''))
      parent = next
      continue
    }
    if (suffix.length > 0 && !statSync(real).isDirectory()) {
      throw Object.assign(new Error(`ENOTDIR: not a directory, realpath '${parent}'`), { code: 'ENOTDIR', path: parent, syscall: 'realpath' })
    }
    return join(real, ...suffix)
  }
}

export function workspaceStorageId(workspacePath: string): string {
  return createHash('sha256').update(canonicalWorkspacePath(workspacePath)).digest('hex')
}
