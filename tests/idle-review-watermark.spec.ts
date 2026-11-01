import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IdleReviewWatermarkStore } from '../src/host/idle-review-watermark.ts'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture(sessionId = '../../unsafe/session') {
  const root = fs.mkdtempSync(join(tmpdir(), 'mnemon-watermark-'))
  roots.push(root)
  const directory = join(root, 'state', 'idle-review')
  const path = join(directory, createHash('sha256').update(sessionId).digest('hex') + '.json')
  const store = new IdleReviewWatermarkStore(root, sessionId)
  const seed = (value: unknown) => { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)) }
  return { root, directory, path, store, seed }
}
const policy = { maxPerSession: 2, minIntervalMs: 5_000, now: 10_000 }

describe('persistent idle-review admission', () => {
  it.each(['', 'x'.repeat(4097), '\0'.repeat(4096)])('refuses session ids that cannot fit a bounded validated record', sessionId => {
    expect(() => new IdleReviewWatermarkStore('/unused-synthetic-root', sessionId)).toThrow(/Idle review watermark/)
  })

  it('keeps missing state empty without creating files and hashes unsafe session ids', () => {
    const f = fixture()
    expect(f.store.load()).toEqual({ version: 1, sessionId: '../../unsafe/session', attempts: 0, lastReviewAttemptAt: null })
    expect(fs.existsSync(f.directory)).toBe(false)
    expect(f.store.reserve(policy)).toMatchObject({ attempts: 1, lastReviewAttemptAt: 10_000 })
    expect(JSON.parse(fs.readFileSync(f.path, 'utf8'))).toMatchObject({ sessionId: '../../unsafe/session', attempts: 1 })
    if (process.platform !== 'win32') {
      expect(fs.statSync(f.path).mode & 0o777).toBe(0o600)
      expect(fs.statSync(f.directory).mode & 0o777).toBe(0o700)
    }
  })

  it('reloads under the lock so independent stores cannot reuse a quota or cooling interval', () => {
    const f = fixture('parent')
    const other = new IdleReviewWatermarkStore(f.root, 'parent')
    expect(f.store.reserve(policy)?.attempts).toBe(1)
    expect(other.reserve({ ...policy, now: 14_999 })).toBeUndefined()
    expect(other.reserve({ ...policy, now: 15_000 })?.attempts).toBe(2)
    expect(f.store.reserve({ ...policy, now: 20_000 })).toBeUndefined()
    expect(f.store.load().attempts).toBe(2)
  })

  it('admits at most one attempt across independent Node processes sharing the same root', async () => {
    const f = fixture('parent')
    const script = `
      const { IdleReviewWatermarkStore } = await import(process.argv[1]);
      try {
        const result = new IdleReviewWatermarkStore(process.argv[2], 'parent').reserve({ now: 10000, minIntervalMs: 5000, maxPerSession: 1 });
        process.stdout.write(result ? 'reserved' : 'blocked');
      } catch (error) {
        if (!error.message.includes('(busy)')) throw error;
        process.stdout.write('blocked');
      }
    `
    const launch = () => promisify(execFile)(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script,
      new URL('../src/host/idle-review-watermark.ts', import.meta.url).href, f.root], { env: { ...process.env, NODE_NO_WARNINGS: '1' } })
    const results = await Promise.all([launch(), launch()])
    expect(results.map(result => result.stdout).sort()).toEqual(['blocked', 'reserved'])
    expect(f.store.load().attempts).toBe(1)
  })

  it('preserves the in-memory usage floor on first opt-in and refuses backwards clocks and a zero budget', () => {
    const f = fixture('parent')
    expect(f.store.reserve({ ...policy, floor: { attempts: 1, lastReviewAttemptAt: 10_000 }, now: 15_000 })?.attempts).toBe(2)
    expect(f.store.reserve({ ...policy, now: 5_000 })).toBeUndefined()
    const fresh = fixture('new-parent')
    expect(fresh.store.reserve({ ...policy, maxPerSession: 0 })).toBeUndefined()
    expect(fs.existsSync(fresh.path)).toBe(false)
  })

  it.each([
    '{', { version: 2, sessionId: 'parent', attempts: 1, lastReviewAttemptAt: 1 },
    { version: 1, sessionId: 'other', attempts: 1, lastReviewAttemptAt: 1 },
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(attempts => ({ version: 1, sessionId: 'parent', attempts, lastReviewAttemptAt: 1 })),
    ...[-1, 1.5, 8_640_000_000_000_001, null, '1'].map(lastReviewAttemptAt => ({ version: 1, sessionId: 'parent', attempts: 1, lastReviewAttemptAt })),
    { version: 1, sessionId: 'parent', attempts: 0, lastReviewAttemptAt: 1 },
    ' '.repeat(16_385),
  ])('refuses damaged state without granting a budget (%j)', value => {
    const f = fixture('parent'); f.seed(value)
    expect(() => f.store.load()).toThrow(/Idle review watermark/)
    expect(() => f.store.reserve(policy)).toThrow(/Idle review watermark/)
    expect(fs.readFileSync(f.path, 'utf8')).toBe(typeof value === 'string' ? value : JSON.stringify(value))
  })

  it('fails closed on an existing lock and never deletes another writer lock', () => {
    const f = fixture('parent')
    fs.mkdirSync(f.directory, { recursive: true }); fs.mkdirSync(f.path + '.lock')
    expect(() => f.store.reserve(policy)).toThrow(/busy/)
    expect(fs.existsSync(f.path + '.lock')).toBe(true)
    expect(fs.existsSync(f.path)).toBe(false)
  })

  it('preserves the old file and removes only its temporary file when atomic replacement fails', () => {
    const f = fixture('parent')
    f.store.reserve(policy)
    const previous = fs.readFileSync(f.path, 'utf8')
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw Object.assign(new Error('private-path sk-secret'), { code: 'EACCES' }) })
    expect(() => f.store.reserve({ ...policy, now: 15_000 })).toThrow(/EACCES/)
    expect(fs.readFileSync(f.path, 'utf8')).toBe(previous)
    expect(fs.readdirSync(f.directory)).toEqual([f.path.split('/').at(-1)])
  })

  it('redacts lock cleanup failures after retaining the consumed reservation', () => {
    const f = fixture('parent')
    vi.spyOn(fs, 'rmdirSync').mockImplementationOnce(() => { throw Object.assign(new Error('private-root sk-privatecredential'), { code: 'EACCES' }) })
    expect(() => f.store.reserve(policy)).toThrow(/Idle review watermark unavailable.*EACCES/)
    expect(f.store.load().attempts).toBe(1)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('treats an unreadable watermark as a failure, not an empty budget', () => {
    const f = fixture('parent'); f.store.reserve(policy)
    fs.chmodSync(f.path, 0)
    try { expect(() => f.store.load()).toThrow(/EACCES/) }
    finally { fs.chmodSync(f.path, 0o600) }
  })

  it('does not treat a non-file or a non-ENOENT read failure as a fresh session', () => {
    const f = fixture('parent'); fs.mkdirSync(f.path, { recursive: true })
    expect(() => f.store.load()).toThrow(/Idle review watermark/)
    expect(() => f.store.reserve(policy)).toThrow(/Idle review watermark/)
  })
})
