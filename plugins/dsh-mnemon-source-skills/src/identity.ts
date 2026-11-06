import { isAbsolute, resolve } from 'node:path'
import { projectRoot } from './catalog.ts'
import type { SkillCatalog, SkillOrigin, SkillSuggestion, SkillSummary } from './contracts.ts'
import type { LedgerFile } from './store.ts'

export function skillOrigin(catalog: SkillCatalog, skill: SkillSummary): SkillOrigin {
  return { path: skill.path, ...(skill.root.startsWith('project-') ? { workspace: catalog.projectRoot! } : {}) }
}

export function validOrigin(key: string, origin: SkillOrigin): boolean {
  return origin !== null && typeof origin === 'object' && typeof origin.path === 'string' && isAbsolute(origin.path)
    && (key.startsWith('project-') ? typeof origin.workspace === 'string' && isAbsolute(origin.workspace) : origin.workspace === undefined)
}

/** Old reviews kept their cwd in the cited trajectory, even before origins existed. */
export function legacySuggestionWorkspace(ledger: LedgerFile, suggestion: SkillSuggestion): string | undefined {
  if (!suggestion.skillKey?.startsWith('project-')) return undefined
  const cited = new Set(suggestion.evidence.map(reference => reference.trajectoryId))
  const trajectories = ledger.trajectories.filter(trajectory => cited.has(trajectory.id)
    && (suggestion.reviewId === undefined || trajectory.reviewId === suggestion.reviewId))
  if (suggestion.reviewId === undefined && trajectories.length !== cited.size) return undefined
  if (trajectories.length === 0 || trajectories.some(trajectory => typeof trajectory.workspace !== 'string' || !isAbsolute(trajectory.workspace))) return undefined
  const roots = new Set(trajectories.map(trajectory => projectRoot(trajectory.workspace!)))
  return roots.size === 1 ? [...roots][0] : undefined
}

/** A name alone, or identical contents in another project, is not an identity. */
export function sameSuggestionSkill(ledger: LedgerFile, suggestion: SkillSuggestion, catalog: SkillCatalog, skill: SkillSummary): boolean {
  if (suggestion.skillKey !== skill.key) return false
  if (suggestion.origin !== undefined) {
    return validOrigin(skill.key, suggestion.origin) && resolve(suggestion.origin.path) === resolve(skill.path)
      && (!skill.root.startsWith('project-') || resolve(suggestion.origin.workspace!) === catalog.projectRoot)
  }
  return !skill.root.startsWith('project-') || legacySuggestionWorkspace(ledger, suggestion) === catalog.projectRoot
}
