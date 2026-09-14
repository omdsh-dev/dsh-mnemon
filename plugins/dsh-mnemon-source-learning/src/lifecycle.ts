import type {} from 'dsh-mnemon-workspace-kit'
import type {} from '@deepseek-ai/dsh-command-feedback'
import type { Context } from '@deepseek-ai/cordis'
import { agentMemoryScope, installAgentHooks, visibleMessages } from 'dsh-mnemon-workspace-kit/dsh'
import type { LearningConfig } from './learning.ts'
import { LearningStore } from './learning.ts'

export function installLearningCapture(ctx: Context, learning: LearningStore, sourceInstanceKey: string, config: LearningConfig): () => Promise<void> {
  const abort = new AbortController(), pending = new Set<Promise<void>>()
  const enqueue = (task: () => Promise<void>) => {
    if (abort.signal.aborted) return
    if (pending.size >= 128) { ctx.logger('mnemon-learning').warn('Learning observation queue is full; operation remains valid'); return }
    const promise = task().catch(error => { if (!abort.signal.aborted) ctx.logger('mnemon-learning').warn('Learning capture failed: %s', String(error)) })
    pending.add(promise); void promise.finally(() => pending.delete(promise))
  }
  if (!ctx.mnemonMemory.observeOperations) throw new Error('Learning requires a Core version with operation observations')
  const stopOperations = ctx.mnemonMemory.observeOperations(event => enqueue(() => learning.operation(event, sourceInstanceKey, abort.signal)))
  const stopActivity = ctx.on('mnemon-workspace/activity', activity => {
    if (!['job-completed', 'task-completed', 'task-blocked', 'review-completed', 'skill-validated', 'skill-executed', 'skill-feedback', 'skill-published'].includes(activity.kind)) return
    enqueue(async () => { const policy = await learning.policy(abort.signal); if (activity.kind === 'skill-feedback' ? policy.captureFeedback === false : policy.captureOutcomes === false) return; await learning.observe(activity.scope, { eventKey: activity.sourceInstanceKey + ':' + activity.eventKey, origin: activity.kind === 'skill-feedback' && activity.verifiedByHuman === true ? 'human-feedback' : activity.kind === 'review-completed' ? 'review-output' : activity.kind === 'job-completed' ? 'job-outcome' : 'task-outcome', title: activity.title, content: activity.summary, data: { sourceInstanceKey: activity.sourceInstanceKey, recordId: activity.recordId ?? '', activityKind: activity.kind, level: activity.level, verifiedByHuman: activity.verifiedByHuman === true, ...(activity.artifactId ? { artifactId: activity.artifactId } : {}), ...(activity.artifactDigest ? { artifactDigest: activity.artifactDigest } : {}), ...(activity.status ? { status: activity.status.slice(0, 100) } : {}), ...(activity.exitCode === undefined ? {} : { exitCode: activity.exitCode }) } }, abort.signal) })
  })
  const stopHooks = installAgentHooks(ctx, {
    async beforeStep(input) {
      if (input.step !== 1 || input.agent.session.header.origin === 'subagent') return []
      const human = input.messages.filter(message => message.source.kind === 'user')
      const content = human.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
      if (!content.trim()) return []
      const scope = agentMemoryScope(input.agent), key = `${scope.sessionId}:human:${input.turn}`
      await learning.observe(scope, { eventKey: key, origin: 'human-turn', title: `Human turn ${input.turn}`, content, independentKey: key, data: { turn: input.turn } }, input.signal)
      return []
    },
    async event(agent, event, signal) {
      if (agent.session.header.origin === 'subagent') return
      const scope = agentMemoryScope(agent), policy = await learning.policy(signal)
      if (event.type === 'feedback/record' && policy.captureFeedback !== false && event.data.text?.trim()) {
        await learning.observe(scope, { eventKey: `${scope.sessionId}:feedback:${event.seq}`, origin: 'human-feedback', title: 'Explicit human feedback', content: event.data.text, data: { category: event.data.category ?? 'other', eventAt: new Date(event.time).toISOString(), exactQuote: true } }, signal)
      }
      if (event.type === 'turn/end' && policy.captureOutcomes !== false) {
        const events = agent.session.ownEvents(), start = events.findLastIndex(value => value.type === 'turn/start' && value.data.turn === event.data.turn)
        const messages = visibleMessages(events.slice(Math.max(start, 0)).filter(value => value.seq <= event.seq), 20_000)
        if (!messages.messages.some(message => message.role === 'user')) return
        const text = messages.messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n')
        await learning.observe(scope, { eventKey: `${scope.sessionId}:outcome:${event.data.turn}`, independentKey: `${scope.sessionId}:human:${event.data.turn}`, origin: 'task-outcome', title: `Reported outcome ${event.data.turn}`, content: text, data: { turn: event.data.turn, attribution: 'assistant-report', verifiedByHuman: false } }, signal)
      }
    },
    error(error) { ctx.logger('mnemon-learning').warn('Learning lifecycle failed: %s', String(error)) },
  })
  return async () => { stopOperations(); stopActivity(); abort.abort(); await stopHooks(); await Promise.allSettled([...pending]) }
}
