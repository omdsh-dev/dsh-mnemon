import type { MnemonSyncFailureReason } from './protocol.ts'

export class MnemonSyncError extends Error {
  constructor(readonly reason: MnemonSyncFailureReason, message: string) {
    super(message)
    this.name = 'MnemonSyncError'
  }
}
