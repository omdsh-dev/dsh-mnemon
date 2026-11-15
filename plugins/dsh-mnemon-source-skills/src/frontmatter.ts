import { parse } from 'yaml'
import type { SkillInvocation } from './contracts.ts'

/** DSH's skill name rule, shared by the registry and the filesystem provider. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
export const MAX_SKILL_NAME = 64
export const MAX_SKILL_BYTES = 64 * 1024

export function isSkillName(value: string): boolean {
  return value.length <= MAX_SKILL_NAME && SKILL_NAME.test(value)
}

export { splitFrontmatter, type SplitSkill } from './fence.ts'
import { splitFrontmatter, type SplitSkill } from './fence.ts'

export interface ParsedSkill {
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocation
  frontmatter: string
  body: string
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true': case 'yes': case 'on': return true
      case 'false': case 'no': case 'off': return false
    }
  }
  throw new Error(`frontmatter field "${key}" must be a boolean`)
}

/**
 * Parse a skill the way DSH does, so the page never lists a file DSH would
 * skip as if it were loaded: the reason is returned instead.
 */
export function parseSkill(raw: string): { skill: ParsedSkill } | { problem: string } {
  let split: SplitSkill | undefined
  let data: unknown
  try {
    split = splitFrontmatter(raw)
    if (split === undefined) return { problem: 'missing YAML frontmatter' }
    data = parse(split.frontmatter)
  } catch (error) {
    return { problem: 'invalid YAML frontmatter: ' + (error instanceof Error ? error.message : String(error)) }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { problem: 'missing YAML frontmatter' }
  const fields = data as Record<string, unknown>
  const name = typeof fields.name === 'string' && fields.name.length > 0 ? fields.name : undefined
  const description = typeof fields.description === 'string' && fields.description.length > 0 ? fields.description : undefined
  if (name === undefined || description === undefined) return { problem: 'frontmatter requires name and description' }
  if (!isSkillName(name)) return { problem: `invalid skill name "${name}"` }
  for (const [legacy, canonical] of [['disableModelInvocation', 'disable-model-invocation'], ['modelInvocable', 'disable-model-invocation'], ['userInvocable', 'user-invocable']] as const) {
    if (Object.hasOwn(fields, legacy)) return { problem: `frontmatter field "${legacy}" is unsupported; use "${canonical}"` }
  }
  let invocation: SkillInvocation
  try {
    invocation = {
      modelInvocable: frontmatterBoolean(fields, 'disable-model-invocation') !== true,
      userInvocable: frontmatterBoolean(fields, 'user-invocable') !== false,
    }
  } catch (error) {
    return { problem: 'invalid invocation frontmatter: ' + (error instanceof Error ? error.message : String(error)) }
  }
  return {
    skill: {
      name, description, invocation,
      ...(typeof fields.whenToUse === 'string' && fields.whenToUse.length > 0 ? { whenToUse: fields.whenToUse } : {}),
      frontmatter: split!.frontmatter,
      body: split!.body,
    },
  }
}

// Keys are DSH frontmatter names: letters, digits and hyphens, so nothing needs escaping.
const KEY_LINE = (key: string) => {
  if (!/^[A-Za-z0-9-]+$/u.test(key)) throw new Error('unsupported frontmatter key: ' + key)
  return new RegExp(`^${key}\\s*:.*(?:\\r?\\n|$)`, 'mu')
}

/**
 * Set or remove one top-level scalar key in the frontmatter and keep every
 * other byte of the file. Removing restores DSH's default for that key.
 */
export function setFrontmatterKey(raw: string, key: string, value: string | undefined): string {
  const split = splitFrontmatter(raw)
  if (split === undefined) throw new Error('the skill has no YAML frontmatter')
  const before = raw.slice(0, split.frontmatterStart)
  const after = raw.slice(split.frontmatterEnd)
  let block = split.frontmatter
  const pattern = KEY_LINE(key)
  const eol = block.includes('\r\n') ? '\r\n' : '\n'
  if (value === undefined) block = block.replace(pattern, '')
  else if (pattern.test(block)) block = block.replace(pattern, match => `${key}: ${value}${match.endsWith('\n') ? (match.endsWith('\r\n') ? '\r\n' : '\n') : ''}`)
  else block = `${block}${block === '' || block.endsWith('\n') ? '' : eol}${key}: ${value}${eol}`
  return before + block + after
}

/** Write DSH's two invocation switches, leaving each key out when it holds DSH's default. */
export function withInvocation(raw: string, invocation: SkillInvocation): string {
  const model = setFrontmatterKey(raw, 'disable-model-invocation', invocation.modelInvocable ? undefined : 'true')
  return setFrontmatterKey(model, 'user-invocable', invocation.userInvocable ? undefined : 'false')
}

/** Validate content about to be written as one skill named `name`. */
export function validateSkillContent(content: string, name: string): ParsedSkill {
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) throw new Error(`SKILL.md is too large (max ${MAX_SKILL_BYTES} bytes)`)
  const parsed = parseSkill(content)
  if ('problem' in parsed) throw new Error('SKILL.md would not load in DSH: ' + parsed.problem)
  if (parsed.skill.name !== name) throw new Error(`SKILL.md names "${parsed.skill.name}", not "${name}"`)
  return parsed.skill
}

/** A starting SKILL.md for a new skill, in DSH's format. */
export function skillTemplate(name: string, description: string, body = ''): string {
  const quoted = JSON.stringify(description.replace(/\s+/gu, ' ').trim())
  const rest = body.trim() === '' ? `# ${name}\n\n## Steps\n1. The first thing to do, with the exact command or tool.\n\n## Pitfalls\n- What tends to go wrong, and how to avoid it.\n\n## Verification\n- How to confirm the result is right.\n` : body.trimStart()
  return `---\nname: ${name}\ndescription: ${quoted}\n---\n\n${rest}${rest.endsWith('\n') ? '' : '\n'}`
}
