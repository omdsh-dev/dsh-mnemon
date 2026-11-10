import { describe, expect, it } from 'vitest'
import { triageSuggestion } from '../src/triage.ts'
import type { SkillSuggestion, TrajectorySummary } from '../src/contracts.ts'

const trajectories = Array.from({ length: 3 }, (_, index) => ({ id: `window-${index}`, sessionId: `session-${index}` })) as TrajectorySummary[]
function suggestion(windows: number, steps: number, confidence = 0.9): SkillSuggestion {
  return { confidence, signals: ['tool-failure'], evidence: Array.from({ length: windows }, (_, index) => ({ trajectoryId: `window-${index}`, steps: Array.from({ length: steps }, (_, i) => i + 1) })) } as SkillSuggestion
}
describe('reproducible suggestion triage', () => {
  it('recognizes repeated procedure evidence without trusting model signal labels', () => {
    const input = suggestion(3, 7)
    expect(triageSuggestion(input, trajectories)).toEqual({ version: 1, classification: 'durable', windows: 3, sessions: 3, steps: 21, confidence: 0.9 })
    expect(triageSuggestion({ ...input, signals: ['success'] }, trajectories)).toEqual(triageSuggestion(input, trajectories))
    expect(triageSuggestion(suggestion(3, 7, 0.79), trajectories).classification).toBe('uncertain')
  })
  it('folds short single-window evidence, keeping boundary and unknown cases visible', () => {
    expect(triageSuggestion(suggestion(1, 19), trajectories).classification).toBe('one-off')
    expect(triageSuggestion(suggestion(1, 20), trajectories).classification).toBe('uncertain')
    expect(triageSuggestion(suggestion(2, 20), trajectories).classification).toBe('uncertain')
    expect(triageSuggestion(suggestion(0, 0), trajectories).classification).toBe('uncertain')
    expect(triageSuggestion(suggestion(3, 7), []).classification).toBe('uncertain')
  })
  it('does not multiply repeated references or confuse windows with distinct sessions', () => {
    const input = suggestion(1, 4)
    input.evidence.push(input.evidence[0]!, input.evidence[0]!, { trajectoryId: 'missing', steps: [1, 2] })
    expect(triageSuggestion(input, trajectories)).toMatchObject({ windows: 1, sessions: 1, steps: 4, classification: 'one-off' })
    expect(triageSuggestion(suggestion(3, 7), trajectories.map(trajectory => ({ ...trajectory, sessionId: 'same-session' })))).toMatchObject({ windows: 3, sessions: 1, steps: 21 })
    expect(triageSuggestion(input, trajectories)).toEqual(triageSuggestion(input, [...trajectories].reverse()))
  })
})
