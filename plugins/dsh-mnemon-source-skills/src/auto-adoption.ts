import type { BacktestRun, CaseResult, EvalCase } from './contracts.ts'

/** Stable evaluation inputs, excluding presentation timestamps and provenance. Hash at the server boundary. */
export function skillCaseSignature(cases: readonly EvalCase[]): string {
  return JSON.stringify([...cases].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(entry => [entry.id, entry.skillName, entry.title, entry.prompt, entry.context ?? '', entry.enabled, entry.requiresVision === true, entry.checks.map(check => [check.id, check.text, check.must])]))
}

/** Automatic decisions require full matching coverage, not the UI's scored intersection. */
export function compareAutomaticSkillRuns(cases: readonly EvalCase[], baseline: BacktestRun | undefined, draft: BacktestRun | undefined, casesHash: string): { outcome: 'unmeasured' | 'regressed' | 'not-worse'; baselineScore?: number; draftScore?: number } {
  const unmeasured = { outcome: 'unmeasured' as const }
  if (cases.length === 0 || cases.some(entry => !entry.enabled || entry.requiresVision === true || entry.checks.length === 0)) return unmeasured
  const ids = new Set(cases.map(entry => entry.id))
  if (ids.size !== cases.length || baseline === undefined || draft === undefined || baseline.model === undefined || draft.model === undefined
    || baseline.model.provider !== draft.model.provider || baseline.model.model !== draft.model.model || baseline.model.reasoningEffort !== draft.model.reasoningEffort) return unmeasured
  const complete = (run: BacktestRun): Map<string, CaseResult> | undefined => {
    if (run.status !== 'completed' || run.casesHash !== casesHash || run.errors || run.caseIds.length !== ids.size || new Set(run.caseIds).size !== ids.size
      || run.caseIds.some(id => !ids.has(id)) || run.results.length !== ids.size || run.progress.done !== ids.size || run.progress.total !== ids.size) return
    const results = new Map(run.results.map(result => [result.caseId, result]))
    if (results.size !== ids.size) return
    for (const entry of cases) {
      const result = results.get(entry.id)
      if (result === undefined || result.fullyGraded !== true || result.verdict === 'error' || result.unmeasuredReason !== undefined || result.error !== undefined || !Number.isFinite(result.score)) return
      const checks = new Map(result.checks.map(check => [check.checkId, check.pass]))
      if (checks.size !== entry.checks.length || result.checks.length !== checks.size || entry.checks.some(check => typeof checks.get(check.id) !== 'boolean')) return
      const weight = entry.checks.reduce((sum, check) => sum + (check.must ? 2 : 1), 0)
      const score = entry.checks.reduce((sum, check) => sum + (checks.get(check.id) ? (check.must ? 2 : 1) : 0), 0) / weight
      const verdict = entry.checks.every(check => !check.must || checks.get(check.id)) ? 'pass' : 'fail'
      if (Math.abs(result.score - score) > 1e-8 || result.verdict !== verdict) return
    }
    return results
  }
  const before = complete(baseline)
  const after = complete(draft)
  if (before === undefined || after === undefined) return unmeasured
  const baselineScore = cases.reduce((sum, entry) => sum + before.get(entry.id)!.score, 0) / cases.length
  const draftScore = cases.reduce((sum, entry) => sum + after.get(entry.id)!.score, 0) / cases.length
  const worse = cases.some(entry => {
    const left = before.get(entry.id)!
    const right = after.get(entry.id)!
    const checks = new Map(right.checks.map(check => [check.checkId, check.pass]))
    return right.score + 1e-8 < left.score || left.checks.some(check => check.pass && !checks.get(check.checkId))
  })
  return { outcome: worse ? 'regressed' : 'not-worse', baselineScore, draftScore }
}
