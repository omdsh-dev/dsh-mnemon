import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { SKILL_ROOT_KINDS, SKILL_ROOT_RANK, type SkillCatalog, type SkillDocument, type SkillProblem, type SkillRoot, type SkillRootKind, type SkillSummary } from './contracts.ts'
import { parseSkill, splitFrontmatter } from './frontmatter.ts'

export interface SkillRootOptions {
  /** DSH's home; `$DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** The shared agents home; `$DSH_AGENTS_HOME`, then `~/.agents`. */
  agentsHome?: string
  /** The workspace whose project roots are read; none means user roots only. */
  workspace?: string
}

const MAX_FILE_BYTES = 1024 * 1024
const MAX_RESOURCES = 40

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function configuredHome(explicit: string | undefined, variable: string, fallback: string): string {
  const value = explicit?.trim() || process.env[variable]?.trim() || fallback
  return resolve(expandHome(value))
}

/** The nearest ancestor holding `.git`, as DSH finds a project; the workspace itself otherwise. */
export function projectRoot(workspace: string): string {
  let current = resolve(workspace)
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(workspace)
    current = parent
  }
}

export function skillRoots(options: SkillRootOptions): { projectRoot?: string; roots: Array<{ kind: SkillRootKind; path: string }> } {
  const dshHome = configuredHome(options.dshHome, 'DSH_HOME', join(homedir(), '.dsh'))
  const agentsHome = configuredHome(options.agentsHome, 'DSH_AGENTS_HOME', join(homedir(), '.agents'))
  const workspace = options.workspace?.trim()
  const project = workspace === undefined || workspace === '' ? undefined : projectRoot(workspace)
  const roots: Array<{ kind: SkillRootKind; path: string }> = [
    ...(project === undefined ? [] : [
      { kind: 'project-dsh' as const, path: join(project, '.dsh', 'skills') },
      { kind: 'project-agents' as const, path: join(project, '.agents', 'skills') },
    ]),
    { kind: 'user-dsh', path: join(dshHome, 'skills') },
    { kind: 'user-agents', path: join(agentsHome, 'skills') },
  ]
  return { ...(project === undefined ? {} : { projectRoot: project }), roots }
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Links at the skill root, bundle directory or document are readable, never writable.
 * Do not resolve OS aliases (for example macOS /tmp) or compare path casing. */
export function linkedSkill(rootPath: string, path: string): boolean {
  return [rootPath, dirname(path), path].some(candidate => lstatSync(candidate).isSymbolicLink())
}

export function requireWritableRoot(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Linked skill roots are read-only; select a local skill root.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function requireWritableSkill(skill: Pick<SkillSummary, 'rootPath' | 'path'>): void {
  if (linkedSkill(skill.rootPath, skill.path)) throw new Error('Linked skills are read-only; edit the original skill in its source repository or use a local copy.')
}

function entryKind(root: string, entry: Dirent): 'directory' | 'file' | undefined {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  if (!entry.isSymbolicLink()) return undefined
  try {
    const info = statSync(join(root, entry.name))
    return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : undefined
  } catch { return undefined }
}

function resources(directory: string): string[] {
  const found: string[] = []
  const visit = (path: string, depth: number) => {
    let entries: Dirent[]
    try { entries = readdirSync(path, { withFileTypes: true }) } catch { return }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_RESOURCES || entry.name.startsWith('.')) continue
      const full = join(path, entry.name)
      if (entry.isDirectory()) { if (depth < 2) visit(full, depth + 1) } else if (relative(directory, full) !== 'SKILL.md') found.push(relative(directory, full))
    }
  }
  visit(directory, 0)
  return found
}

/** Discover every skill in the four roots with `dsh-skill-filesystem`'s rules. */
export function readCatalog(options: SkillRootOptions): SkillCatalog {
  const { projectRoot: project, roots } = skillRoots(options)
  const listedRoots: SkillRoot[] = []
  const skills: SkillSummary[] = []
  const problems: SkillProblem[] = []
  for (const root of roots) {
    const exists = existsSync(root.path)
    const listed: SkillRoot = { kind: root.kind, path: root.path, exists }
    listedRoots.push(listed)
    if (!exists) continue
    let entries: Dirent[]
    try {
      entries = readdirSync(root.path, { withFileTypes: true })
      if (lstatSync(root.path).isSymbolicLink()) listed.readOnly = true
    } catch (error) {
      problems.push({ root: root.kind, path: root.path, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    const seen = new Set<string>()
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (root.kind === 'user-dsh' && entry.name === '.system') continue
      const kind = entryKind(root.path, entry)
      const layout = kind === 'directory' ? 'bundle' as const : kind === 'file' && entry.name.endsWith('.md') ? 'flat' as const : undefined
      if (layout === undefined) continue
      const path = layout === 'bundle' ? join(root.path, entry.name, 'SKILL.md') : join(root.path, entry.name)
      let raw: Buffer
      let modifiedAt: string
      let readOnly: boolean
      try {
        const info = statSync(path)
        if (!info.isFile()) continue
        if (info.size > MAX_FILE_BYTES) { problems.push({ root: root.kind, path, reason: 'file is larger than 1 MiB' }); continue }
        raw = readFileSync(path)
        modifiedAt = info.mtime.toISOString()
        readOnly = linkedSkill(root.path, path)
      } catch { continue }
      const parsed = parseSkill(raw.toString('utf8'))
      if ('problem' in parsed) { problems.push({ root: root.kind, path, reason: parsed.problem }); continue }
      if (seen.has(parsed.skill.name)) { problems.push({ root: root.kind, path, reason: `another file in this root already names "${parsed.skill.name}"` }); continue }
      seen.add(parsed.skill.name)
      skills.push({
        key: `${root.kind}:${parsed.skill.name}`,
        name: parsed.skill.name,
        description: parsed.skill.description,
        ...(parsed.skill.whenToUse === undefined ? {} : { whenToUse: parsed.skill.whenToUse }),
        root: root.kind,
        rootPath: root.path,
        path,
        layout,
        ...(readOnly ? { readOnly: true } : {}),
        invocation: parsed.skill.invocation,
        hash: sha256(raw),
        bytes: raw.byteLength,
        modifiedAt,
        ...(layout === 'bundle' ? { resources: resources(dirname(path)) } : {}),
      })
    }
  }
  const winners = new Map<string, SkillSummary>()
  for (const skill of skills) {
    const current = winners.get(skill.name)
    if (current === undefined || SKILL_ROOT_RANK[skill.root] < SKILL_ROOT_RANK[current.root]) winners.set(skill.name, skill)
  }
  for (const skill of skills) {
    const winner = winners.get(skill.name)!
    if (winner !== skill) skill.shadowedBy = winner.key
  }
  skills.sort((a, b) => a.name.localeCompare(b.name) || SKILL_ROOT_KINDS.indexOf(a.root) - SKILL_ROOT_KINDS.indexOf(b.root))
  return { ...(project === undefined ? {} : { projectRoot: project }), roots: listedRoots, skills, problems }
}

/** A cheap fingerprint of the roots: names, sizes and times, no content. */
export function catalogFingerprint(options: SkillRootOptions): string {
  const hash = createHash('sha256')
  for (const root of skillRoots(options).roots) {
    hash.update(`${root.kind}\0${root.path}\0`)
    let entries: Dirent[]
    try {
      entries = readdirSync(root.path, { withFileTypes: true })
      hash.update(`${lstatSync(root.path).isSymbolicLink()}\0`)
    } catch { hash.update('missing\0'); continue }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = entry.name.endsWith('.md') ? join(root.path, entry.name) : join(root.path, entry.name, 'SKILL.md')
      try {
        const info = statSync(candidate)
        hash.update(`${entry.name}\0${info.size}\0${info.mtimeMs}\0${linkedSkill(root.path, candidate)}\0`)
      } catch { hash.update(`${entry.name}\0-\0`) }
    }
  }
  return hash.digest('hex').slice(0, 24)
}

export function findSkill(catalog: SkillCatalog, key: string): SkillSummary {
  const skill = catalog.skills.find(candidate => candidate.key === key)
  if (skill === undefined) throw new Error('skill is not in this catalog: ' + key)
  return skill
}

/** The skill DSH loads for a name, if any root holds one. */
export function activeSkill(catalog: SkillCatalog, name: string): SkillSummary | undefined {
  return catalog.skills.find(skill => skill.name === name && skill.shadowedBy === undefined)
}

export function readSkillDocument(summary: SkillSummary): SkillDocument {
  const content = readFileSync(summary.path, 'utf8')
  const split = splitFrontmatter(content)
  return { ...summary, hash: sha256(content), bytes: Buffer.byteLength(content, 'utf8'), content, frontmatter: split?.frontmatter ?? '', body: split?.body ?? content }
}

export function rootPath(catalog: SkillCatalog, kind: SkillRootKind): string {
  const root = catalog.roots.find(candidate => candidate.kind === kind)
  if (root === undefined) throw new Error(kind.startsWith('project') ? 'project skill roots need a selected workspace' : 'unknown skill root: ' + kind)
  return root.path
}
