import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { join, resolve } from 'node:path'

export interface IdleReviewWatermark {
  readonly version: 1
  readonly sessionId: string
  readonly attempts: number
  readonly lastReviewAttemptAt: number | null
}

const MAX_STATE_BYTES = 16_384
const MAX_TIMESTAMP = 8_640_000_000_000_000

function validAttempts(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP
}

/** Messages deliberately omit filesystem paths, session ids and raw input. */
function failure(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const detail = code === 'EBUSY' ? ' (busy)' : typeof code === 'string' && /^[A-Z_]+$/u.test(code) ? ` (${code})` : ''
  return new Error(`Idle review watermark unavailable${detail}. Automatic review is paused. Stop Hosts using this storage root, repair this session's state or lock under state/idle-review, then reopen the session.`, { cause: error })
}

/** Host-local admission state, deliberately outside Packs and Git sync. */
export class IdleReviewWatermarkStore {
  private readonly directory: string
  private readonly path: string

  constructor(directory: string, private readonly sessionId: string) {
    if (!sessionId || Buffer.byteLength(sessionId) > 4096 || Buffer.byteLength(JSON.stringify(sessionId)) > MAX_STATE_BYTES - 256) throw failure(undefined)
    this.directory = join(resolve(directory), 'state', 'idle-review')
    this.path = join(this.directory, createHash('sha256').update(sessionId).digest('hex') + '.json')
  }

  load(): IdleReviewWatermark {
    let descriptor: number | undefined
    try {
      try { descriptor = fs.openSync(this.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessionId: this.sessionId, attempts: 0, lastReviewAttemptAt: null }
        throw error
      }
      const info = fs.fstatSync(descriptor)
      if (!info.isFile() || info.size > MAX_STATE_BYTES) throw new Error('invalid state file')
      const bytes = Buffer.alloc(MAX_STATE_BYTES + 1)
      let length = 0
      while (length < bytes.length) {
        const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null)
        if (count === 0) break
        length += count
      }
      if (length > MAX_STATE_BYTES) throw new Error('oversized state')
      const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'))
      if (value === null || typeof value !== 'object') throw new Error('invalid state')
      const state = value as Partial<IdleReviewWatermark>
      if (state.version !== 1 || state.sessionId !== this.sessionId || !validAttempts(state.attempts)
        || (state.attempts === 0 ? state.lastReviewAttemptAt !== null : !validTimestamp(state.lastReviewAttemptAt))) throw new Error('invalid state')
      return { version: 1, sessionId: this.sessionId, attempts: state.attempts, lastReviewAttemptAt: state.lastReviewAttemptAt! }
    } catch (error) { throw failure(error) } finally {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor) } catch (error) { throw failure(error) } }
    }
  }

  /** Preserve already-used in-process quota on opt-in without admitting work. */
  restore(floor?: Pick<IdleReviewWatermark, 'attempts' | 'lastReviewAttemptAt'>): IdleReviewWatermark {
    if (floor === undefined || floor.attempts === 0 && floor.lastReviewAttemptAt === null) return this.load()
    return this.withLock(() => {
      const saved = this.load()
      const merged = this.merge(saved, floor)
      if (merged.attempts !== saved.attempts || merged.lastReviewAttemptAt !== saved.lastReviewAttemptAt) this.write(merged)
      return merged
    })
  }

  reserve(policy: { maxPerSession: number; minIntervalMs: number; now: number; floor?: Pick<IdleReviewWatermark, 'attempts' | 'lastReviewAttemptAt'> }): IdleReviewWatermark | undefined {
    if (!validTimestamp(policy.now) || !validAttempts(policy.maxPerSession) || !validAttempts(policy.minIntervalMs)) throw failure(undefined)
    return this.withLock(() => {
      const saved = this.merge(this.load(), policy.floor)
      if (saved.attempts >= policy.maxPerSession || policy.now - (saved.lastReviewAttemptAt ?? -Infinity) < policy.minIntervalMs) return undefined
      const next: IdleReviewWatermark = { version: 1, sessionId: this.sessionId, attempts: saved.attempts + 1, lastReviewAttemptAt: policy.now }
      this.write(next)
      return next
    })
  }

  private merge(saved: IdleReviewWatermark, floor?: Pick<IdleReviewWatermark, 'attempts' | 'lastReviewAttemptAt'>): IdleReviewWatermark {
    if (floor === undefined) return saved
    if (!validAttempts(floor.attempts) || (floor.attempts === 0 ? floor.lastReviewAttemptAt !== null : !validTimestamp(floor.lastReviewAttemptAt))) throw failure(undefined)
    const previous = Math.max(saved.lastReviewAttemptAt ?? -Infinity, floor.lastReviewAttemptAt ?? -Infinity)
    return { version: 1, sessionId: this.sessionId, attempts: Math.max(saved.attempts, floor.attempts), lastReviewAttemptAt: previous === -Infinity ? null : previous }
  }

  private write(state: IdleReviewWatermark): void {
    const temporary = this.path + '.' + randomUUID() + '.tmp'
    try {
      fs.writeFileSync(temporary, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, this.path)
    } finally { fs.rmSync(temporary, { force: true }) }
  }

  /**
   * One bounded synchronous read/check/write critical section. Exclusive mkdir
   * protects independent Hosts too; contention fails closed without stale-lock
   * takeover. Never hold this lock while starting or awaiting model work.
   */
  private withLock<T>(operation: () => T): T {
    const lock = this.path + '.lock'
    let held = false
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      try { fs.mkdirSync(lock, { mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        throw error
      }
      held = true
      return operation()
    } catch (error) { throw failure(error) } finally {
      if (held) { try { fs.rmdirSync(lock) } catch (error) { throw failure(error) } }
    }
  }
}
