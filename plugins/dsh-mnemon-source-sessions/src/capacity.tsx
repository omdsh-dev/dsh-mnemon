import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ContextPressureProjection } from '@deepseek-ai/dsh-token-meter'

export function capacityReading(pressure: ContextPressureProjection | undefined) {
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens, capacity = pressure?.contextWindow
  if (used === undefined || !Number.isFinite(used) || used < 0 || capacity === undefined || !Number.isFinite(capacity) || capacity <= 0) return null
  const percent = Math.min(100, Math.round(used / capacity * 100))
  return { percent, level: percent >= 40 ? 'high' : percent >= 30 ? 'moderate' : 'low' }
}
export function CapacityBadge(props: Pick<PropsRuntime<'conversation.input.right'>, 'useProjection'>) {
  const reading = capacityReading(props.useProjection('contextPressure'))
  if (!reading || reading.level === 'low') return null
  return <span role="status" aria-label={`上下文占用 / Context usage ${reading.percent}%`} title="上下文占用估算。保存关键结论，必要时从已完成轮次开启分支。 / Estimated context use. Save key decisions and consider branching from a completed turn." style={{ display: 'inline-flex', alignItems: 'center', borderRadius: 6, padding: '3px 6px', fontSize: 11, lineHeight: 1.3, color: reading.level === 'high' ? '#ffd5d5' : '#ffe5a6', background: reading.level === 'high' ? '#783c3c' : '#665125' }}>
    {reading.percent}% · {reading.level === 'high' ? '整理上下文 / Review' : '关注容量 / Capacity'}
  </span>
}
/** An additive public composer slot; no native DOM inspection or renderer replacement. */
export interface CapacityContext { slots: { inject(name: 'conversation.input.right', setup: () => () => void): () => void; register(options: { name: 'conversation.input.right'; id: string; order: number }, component: typeof CapacityBadge): () => void } }
export function installCapacityBadge(ctx: CapacityContext) {
  return ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'mnemon-session-capacity', order: 90 }, CapacityBadge))
}
