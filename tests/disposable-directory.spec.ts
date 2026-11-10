import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeDisposableDirectory } from '../src/host/disposable-directory.ts'

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
