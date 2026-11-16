import { describe, expect, it } from 'vitest'
import { RUNTIME_MEMORY_PROTOCOL, SCOPED_RUNTIME_MEMORY_PROTOCOL, boundedRuntimeMemoryProtocol, ROUTING_GUIDANCE, ROUTING_GUIDANCE_WITHOUT_RECALL, THREE_TIER_REMINDERS, THREE_TIER_REMINDERS_WITHOUT_RECALL } from '../src/guidance.ts'

describe('attended Runtime admission (#655)', () => {
  it.each([
    RUNTIME_MEMORY_PROTOCOL, SCOPED_RUNTIME_MEMORY_PROTOCOL,
    ...[false, true].flatMap(recall => [false, true].map(archive => boundedRuntimeMemoryProtocol({ recall, archive }))),
  ])('keeps project records out of automatic hot-memory capture in every protocol', protocol => {
    expect(protocol).toContain('durable user-authored')
    expect(protocol).toContain('future work')
    expect(protocol).toContain('Project records')
    expect(protocol).toContain('Documents')
    expect(protocol).toContain('otherwise skip')
    expect(protocol).toContain('explicitly chooses Runtime')
    expect(protocol).not.toContain('lesson is discovered')
    expect(protocol).not.toContain('low" for transient')
    expect(protocol).not.toContain('project facts in target=memory')
  })

  it.each([ROUTING_GUIDANCE, ROUTING_GUIDANCE_WITHOUT_RECALL, THREE_TIER_REMINDERS.both, THREE_TIER_REMINDERS.write, THREE_TIER_REMINDERS_WITHOUT_RECALL.both])('does not let a shorter cue override the admission rule', cue => {
    expect(cue).toContain('durable user-authored')
    expect(cue).toContain('future work')
    expect(cue).toContain('Project records')
    expect(cue).toContain('otherwise skip')
    expect(cue).toContain('explicitly chooses Runtime')
    expect(cue).not.toContain('only new user facts or explicit save')
  })
})
