import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeDisposableDirectory } from '../src/host/disposable-directory.ts'

// Model Windows' permission failure portably: a read-only pack refuses removal
// until the cleanup path makes it writable. All other filesystem calls are real.
const permissionFault = vi.hoisted(() => ({ path: undefined as string | undefined, pack: '' }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, rmSync: (path: import('node:fs').PathLike, options: import('node:fs').RmOptions) => {
    if (path === permissionFault.path && (fs.statSync(permissionFault.pack).mode & 0o200) === 0) {
      throw Object.assign(new Error('Synthetic Windows read-only pack'), { code: 'EPERM' })
    }
    return fs.rmSync(path, options)
  } }
})

const roots: string[] = []
const writable: string[] = []
afterEach(() => {
  for (const path of writable.splice(0)) if (existsSync(path)) chmodSync(path, 0o600)
  for (const root of roots.splice(0)) removeDisposableDirectory(root)
})
function root() { const path = mkdtempSync(join(tmpdir(), 'mnemon-read-only-')); roots.push(path); return path }

it('removes read-only Git pack files and partially deleted disposable mirrors', () => {
  for (const gitDirectory of ['.git/objects/pack', 'partially-removed']) {
    const mirror = join(root(), 'mirror')
    const packs = join(mirror, gitDirectory)
    mkdirSync(packs, { recursive: true })
    for (const extension of ['pack', 'idx', 'rev']) {
      const file = join(packs, 'synthetic.' + extension)
      writeFileSync(file, 'synthetic pack')
      chmodSync(file, 0o444)
    }
    removeDisposableDirectory(mirror)
    expect(existsSync(mirror)).toBe(false)
    expect(() => removeDisposableDirectory(mirror)).not.toThrow()
  }
})

it('never changes read-only files outside a disposable directory through links or junctions', () => {
  const outside = join(root(), 'external')
  mkdirSync(outside)
  const file = join(outside, 'protected.txt')
  writeFileSync(file, 'external content')
  chmodSync(file, 0o444)
  writable.push(file)
  const mode = statSync(file).mode
  for (const linkedRoot of [false, true]) {
    const mirror = join(root(), 'mirror')
    if (!linkedRoot) {
      mkdirSync(mirror)
      const pack = join(mirror, 'read-only.pack')
      writeFileSync(pack, 'pack')
      chmodSync(pack, 0o444)
    }
    symlinkSync(outside, linkedRoot ? mirror : join(mirror, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    removeDisposableDirectory(mirror)
    expect(existsSync(mirror)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('external content')
    expect(statSync(file).mode).toBe(mode)
  }
})


it('recovers a read-only Windows pack permission failure without chmod through a junction', () => {
  const mirror = join(root(), 'mirror')
  const outside = join(root(), 'outside')
  mkdirSync(mirror)
  mkdirSync(outside)
  const pack = join(mirror, 'read-only.pack')
  const protectedFile = join(outside, 'protected.txt')
  writeFileSync(pack, 'synthetic pack')
  writeFileSync(protectedFile, 'upstream')
  chmodSync(pack, 0o444)
  chmodSync(protectedFile, 0o444)
  writable.push(protectedFile)
  const mode = statSync(protectedFile).mode
  symlinkSync(outside, join(mirror, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const platform = process.platform
  permissionFault.path = mirror
  permissionFault.pack = pack
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    removeDisposableDirectory(mirror)
    expect(existsSync(mirror)).toBe(false)
    expect(statSync(protectedFile).mode).toBe(mode)
    expect(readFileSync(protectedFile, 'utf8')).toBe('upstream')
  } finally {
    Object.defineProperty(process, 'platform', { value: platform })
    permissionFault.path = undefined
  }
})
