import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

function makeWritable(path: string): void {
  let entry
  try { entry = lstatSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (entry.isSymbolicLink()) return
  if ((entry.mode & 0o200) === 0) chmodSync(path, entry.mode | 0o200)
  if (entry.isDirectory()) for (const name of readdirSync(path)) makeWritable(join(path, name))
}

export function removeDisposableDirectory(path: string): void {
  try { rmSync(path, { recursive: true, force: true }) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'ENOTEMPTY', 'EBUSY'].includes(code ?? '')) throw error
    makeWritable(path)
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
