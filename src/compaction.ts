import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { HostSession } from './host/dsh.ts'
import { summaryWithoutTransientMemory } from './host/memory-snapshot.ts'
import { markSnapshotCompactionStep, markSummaryAuthority, readSnapshotAuthority } from './host/snapshot-compaction.ts'

export default class MnemonCompactionEngine extends BasicCompactionEngine {
  constructor(...[ctx, config]: ConstructorParameters<typeof BasicCompactionEngine>) {
    super(ctx, config)
    ctx.on('agent/pre-step', ({ agent, turn, step }, next) => {
      markSnapshotCompactionStep(agent.session as unknown as HostSession, turn, step)
      return next()
    }, { prepend: true })
  }

  protected override async summarize(...[input, agent, signal]: Parameters<BasicCompactionEngine['summarize']>): ReturnType<BasicCompactionEngine['summarize']> {
    const session = agent.session as unknown as HostSession
    const authority = await readSnapshotAuthority(session, signal)
    signal?.throwIfAborted()
    markSummaryAuthority(session, authority)
    const messages = summaryWithoutTransientMemory(input.messages, authority?.state)
    if (messages === input.messages) return super.summarize(input, agent, signal)
    const { llmStreamCall: _defaultReplay, ...summary } = await super.summarize({ ...input, messages }, agent, signal)
    return summary
  }
}
