import { SKILL_ROOT_KINDS, type SkillCatalog, type SkillCreationChoices, type SkillCreationConfig, type SkillRootKind } from './contracts.ts'

export function validateCreationConfig(value: SkillCreationConfig | undefined): SkillCreationConfig | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || !Array.isArray(value.create)
    || value.create.length === 0 || value.create.length > 4
    || value.create.some(root => !SKILL_ROOT_KINDS.includes(root))
    || new Set(value.create).size !== value.create.length || !value.create.includes(value.default)) {
    throw new Error('skillRoots requires 1..4 unique known create roots and a default included in create')
  }
  return { create: [...value.create], default: value.default }
}

/** A project default falls back to its corresponding user root outside a workspace. */
export function creationChoices(config: SkillCreationConfig, catalog: SkillCatalog): SkillCreationChoices {
  const available = (root: SkillRootKind) => catalog.roots.some(entry => entry.kind === root)
  const roots = config.create.filter(available)
  const fallback: SkillRootKind = config.default === 'project-agents' ? 'user-agents' : 'user-dsh'
  const selected = available(config.default) ? config.default : fallback
  if (!roots.includes(selected)) roots.push(selected)
  return { roots, default: selected }
}
