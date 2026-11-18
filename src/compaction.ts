// DSH resolves its own compactor when this entry is selected. A Starter peer
// would make the installer resolve and validate it even for unselected presets.
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { HostSession } from './host/dsh.ts'
import { summaryWithoutRuntimeSnapshots } from './host/memory-snapshot.ts'
import { markSnapshotCompactionStep, markSummaryAuthority, readSnapshotAuthority } from './host/snapshot-compaction.ts'

/** Optional replacement for a preset's Basic compaction provider. */
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
    const messages = summaryWithoutRuntimeSnapshots(input.messages, authority)
    if (messages === input.messages) return super.summarize(input, agent, signal)
    // DSH's default replay would reconstruct the unfiltered range. The
    // custom-summarizer result still records output, route and usage.
    const { llmStreamCall: _defaultReplay, ...summary } = await super.summarize({ ...input, messages }, agent, signal)
    return summary
  }
}
