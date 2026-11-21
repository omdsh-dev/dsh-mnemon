export class SubagentStoppedError extends Error {
  constructor(readonly stopReason: string, readonly maxTokens: number | undefined, detail?: string) {
    super(`memory subagent stopped with ${stopReason}${detail === undefined ? '' : `: ${detail}`}`)
    this.name = 'SubagentStoppedError'
  }
}
