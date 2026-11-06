import { describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { unpack } from '../src/host/git-sync.ts'

// Exercise the real inflater with valid tiny archives; malicious declared sizes
// are rejected from the central-directory metadata before any large allocation.
function declaredSize(archive: Uint8Array, bytes: number): Uint8Array {
  const changed = archive.slice()
  const view = new DataView(changed.buffer, changed.byteOffset, changed.byteLength)
  for (let offset = 0; offset < changed.length - 46; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint32(offset + 24, bytes, true)
      return changed
    }
  }
  throw new Error('fixture central directory not found')
}

describe('Git sync ZIP pre-inflate validation', () => {
  it.each([0, 6] as const)('preserves ordinary files and ignores safe directory entries at compression level %s', level => {
    const bytes = new Uint8Array([1, 2, 3])
    const result = unpack(zipSync({ 'payload/': new Uint8Array(), 'payload/runtime/memories.json': bytes }, { level }))
    expect(Object.keys(result)).toEqual(['payload/runtime/memories.json'])
    expect(result['payload/runtime/memories.json']).toEqual(bytes)
  })

  it.each(['../escape', '/absolute', 'a/../../escape', 'C:/absolute', 'a\\escape', 'a//b', 'a/./b', 'a\0b'])('rejects unsafe entry %s', path => {
    expect(() => unpack(zipSync({ [path]: new Uint8Array([1]) }))).toThrow('not a readable archive')
  })

  it('rejects a declared oversized entry before inflation', () => {
    const archive = zipSync({ 'payload/huge': new Uint8Array([1]) })
    expect(() => unpack(declaredSize(archive, 128 * 1024 * 1024 + 1))).toThrow('not a readable archive')
  })

  it.each([1, 1025])('rejects a stored entry whose declared size %s disagrees with the bytes copied', size => {
    const archive = zipSync({ 'payload/stored': new Uint8Array(1024) }, { level: 0 })
    expect(() => unpack(declaredSize(archive, size))).toThrow('not a readable archive')
  })

  it('rejects excess file counts even when every file is empty', () => {
    const files = Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`payload/f${i}`, new Uint8Array()]))
    expect(() => unpack(zipSync(files))).toThrow('not a readable archive')
  })
})
