import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

function makeWritable(path: string): void {
  let entry
  try { entry = lstatSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  // A Git mirror can contain links or Windows junctions. Never chmod or walk
  // their targets, including when the disposable root itself is a link.
  if (entry.isSymbolicLink()) return
  if ((entry.mode & 0o200) === 0) chmodSync(path, entry.mode | 0o200)
  if (entry.isDirectory()) for (const name of readdirSync(path)) makeWritable(join(path, name))
}

/** Remove only a caller-owned disposable tree, including read-only Git packs on Windows. */
export function removeDisposableDirectory(path: string): void {
  try { rmSync(path, { recursive: true, force: true }) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'ENOTEMPTY', 'EBUSY'].includes(code ?? '')) throw error
    // The first removal may have made partial progress. Missing entries are
    // harmless; genuine ACL/I/O errors still propagate after the bounded retry.
    makeWritable(path)
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
