import type { SkillSuggestion, SuggestionTriage, TrajectorySummary } from './contracts.ts'

/** Only admitted evidence counts. Signals and model-supplied reuse labels do not. */
export function triageSuggestion(suggestion: SkillSuggestion, trajectories: readonly TrajectorySummary[]): SuggestionTriage {
  const windows = new Set<string>()
  const sessions = new Set<string>()
  const steps = new Set<string>()
  const known = new Map(trajectories.map(trajectory => [trajectory.id, trajectory]))
  for (const reference of suggestion.evidence) {
    const trajectory = known.get(reference.trajectoryId)
    if (trajectory === undefined) continue
    const valid = reference.steps.filter(step => Number.isInteger(step) && step > 0)
    if (valid.length === 0) continue
    windows.add(trajectory.id)
    sessions.add(trajectory.sessionId)
    for (const step of valid) steps.add(`${trajectory.id}:${step}`)
  }
  const confidence = Number.isFinite(suggestion.confidence) ? Math.max(0, Math.min(1, suggestion.confidence)) : 0
  const classification = windows.size >= 3 && steps.size >= 20 && confidence >= 0.8 ? 'durable'
    : windows.size === 1 && steps.size < 20 ? 'one-off' : 'uncertain'
  return { version: 1, classification, windows: windows.size, sessions: sessions.size, steps: steps.size, confidence }
}
