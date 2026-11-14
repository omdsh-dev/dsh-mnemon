import { randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { dirname } from 'node:path'

export interface AtomicWriteOptions {
  mode?: number
  dirMode?: number
  flag?: string
  fs?: Pick<typeof nodeFs, 'mkdirSync' | 'writeFileSync' | 'renameSync' | 'rmSync'>
}

export interface AtomicJsonWriteOptions extends AtomicWriteOptions {
  indent?: number
}

export function writeAtomicFileSync(path: string, content: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const fs = options.fs ?? nodeFs
  const directory = dirname(path)
  fs.mkdirSync(directory, { recursive: true, mode: options.dirMode ?? 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, content, {
      mode: options.mode ?? 0o600,
      ...(options.flag === undefined ? {} : { flag: options.flag }),
    })
    fs.renameSync(temporary, path)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

export function writeAtomicJsonSync(path: string, value: unknown, options: AtomicJsonWriteOptions = {}): void {
  const indent = options.indent ?? 2
  const serialized = indent > 0 ? JSON.stringify(value, null, indent) : JSON.stringify(value)
  writeAtomicFileSync(path, `${serialized}\n`, options)
}
