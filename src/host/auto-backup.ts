import type { MnemonSyncAutoBackup, MnemonSyncFailureReason } from './protocol.ts'
import type { LiveMnemonRuntime } from './runtime.ts'

const BUSY_MESSAGE = 'another Mnemon sync operation is still running'

const MINUTE_MS = 60_000

export class MnemonAutoBackupScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private controller: AbortController | undefined
  private running = false
  private stopped = false
  private lastAt: string | undefined
  private lastAttemptAt: number | undefined
  private lastError: string | undefined
  private lastFailure: MnemonSyncFailureReason | undefined
  private lastCommit: string | undefined
  private lastPushed: boolean | undefined

  constructor(
    private readonly runtime: LiveMnemonRuntime,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): () => void {
    this.schedule()
    return () => {
      this.stopped = true
      this.cancel()
    }
  }

  refresh(): void {
    if (this.stopped) return
    this.cancel()
    this.schedule()
  }

  snapshot(): MnemonSyncAutoBackup {
    const minutes = this.minutes()
    const available = minutes > 0 && !this.stopped
    return {
      available,
      ...(this.lastAt === undefined ? {} : { lastAt: this.lastAt }),
      ...(this.lastAttemptAt === undefined || !available ? {} : { nextAt: new Date(this.lastAttemptAt + minutes * MINUTE_MS).toISOString() }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.lastError === undefined || this.lastFailure === undefined ? {} : { lastFailure: this.lastFailure }),
      ...(this.lastCommit === undefined ? {} : { lastCommit: this.lastCommit }),
      ...(this.lastPushed === undefined ? {} : { lastPushed: this.lastPushed }),
    }
  }

  private minutes(): number {
    if (!this.runtime.config.syncEnabled) return 0
    try {
      return this.runtime.sync.settings().read().autoBackupMinutes
    } catch {
      return 0
    }
  }

  private schedule(): void {
    if (this.stopped || this.timer !== undefined) return
    const minutes = this.minutes()
    if (minutes <= 0) return
    this.lastAttemptAt = this.now().getTime()
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.run()
    }, minutes * MINUTE_MS)
  }

  private cancel(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.controller?.abort()
    this.controller = undefined
  }

  private async run(): Promise<void> {
    if (this.stopped || this.running) return this.schedule()
    const sync = this.runtime.sync
    this.running = true
    const controller = new AbortController()
    this.controller = controller
    try {
      const settings = sync.settings().read()
      if (settings.repoUrl === undefined) {
        this.lastError = undefined
        this.lastFailure = undefined
      } else if (!this.runtime.config.writeEnabled) {
        this.lastError = 'dsh-mnemon is configured read-only'
        this.lastFailure = undefined
      } else {
        const result = await sync.push({ signal: controller.signal })
        this.lastAt = this.now().toISOString()
        this.lastCommit = result.commit
        this.lastPushed = result.pushed
        this.lastError = result.pushed ? undefined : result.committed ? result.reason : undefined
        this.lastFailure = this.lastError === undefined ? undefined : result.failure
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const reason = error instanceof Error ? (error as { reason?: unknown }).reason : undefined
      if (!this.stopped && reason !== 'busy' && !message.includes(BUSY_MESSAGE)) {
        this.lastError = message
        this.lastFailure = typeof reason === 'string' ? reason as MnemonSyncFailureReason : undefined
        console.warn('dsh-mnemon: automatic Git backup failed', error)
      }
    } finally {
      this.running = false
      if (this.controller === controller) this.controller = undefined
      this.schedule()
    }
  }
}
