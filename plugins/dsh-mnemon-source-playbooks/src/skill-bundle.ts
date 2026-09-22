import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { parseDocument } from 'yaml'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { memoryInputRecord, memoryInputText } from 'dsh-mnemon/extension-sdk'
import type { MemoryJsonValue } from 'dsh-mnemon/contracts'

export interface SkillFile { path: string; content: string }
export interface SkillCheck { label: string; command: string }
export interface SkillBundle { name: string; description: string; files: SkillFile[]; checks: SkillCheck[] }
export interface SkillInspection { digest: string; errors: string[]; warnings: string[]; scriptCount: number }
export const bundleDigest = (bundle: SkillBundle): string => createHash('sha256').update(JSON.stringify(bundle)).digest('hex')
const textExtensions = /\.(?:md|txt|json|jsonl|yaml|yml|toml|csv|tsv|js|mjs|cjs|ts|tsx|py|sh|bash|ps1|rb|sql)$/i

export function skillPath(value: string): string {
  if (value.length > 200 || value.includes('\\') || !/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))
    || posix.normalize(value) !== value || !textExtensions.test(value)) throw new Error('Skill files need relative text-file paths without traversal or hidden directories')
  return value
}

export function redactSkillText(text: string): string {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{16,}|Bearer\s+[a-zA-Z0-9._~+\/-]{16,})/gi, '[redacted credential]')
}

export function parseSkillBundle(value: unknown): SkillBundle {
  const input = memoryInputRecord(value as MemoryJsonValue, 'skill bundle')
  const name = memoryInputText(input.name, 'skill name', 100)!, description = memoryInputText(input.description, 'skill description', 1000)!
  if (!isSkillName(name)) throw new Error('Use a reusable lowercase kebab-case skill name')
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 24) throw new Error('A skill bundle needs 1–24 text files')
  const files = input.files.map(value => {
    const file = memoryInputRecord(value, 'skill file'), path = skillPath(memoryInputText(file.path, 'file path', 200)!)
    if (typeof file.content !== 'string' || file.content.includes('\0') || Buffer.byteLength(file.content) > 64 * 1024) throw new Error('Skill files must be text and at most 64 KiB each')
    return { path, content: file.content }
  }).sort((a, b) => a.path.localeCompare(b.path))
  if (new Set(files.map(file => file.path.toLowerCase())).size !== files.length) throw new Error('Skill file paths must be unique, including case')
  if (files.some(file => files.some(other => other.path.startsWith(file.path + '/')))) throw new Error('A file cannot also be a directory')
  if (!files.some(file => file.path === 'SKILL.md')) throw new Error('A skill bundle requires SKILL.md')
  if (JSON.stringify(files).length > 90_000) throw new Error('Skill bundle exceeds its 90,000 character limit')
  if (input.checks !== undefined && (!Array.isArray(input.checks) || input.checks.length > 6)) throw new Error('At most six explicit validation checks are supported')
  const checks = (input.checks as MemoryJsonValue[] | undefined ?? []).map(value => {
    const check = memoryInputRecord(value, 'skill check')
    return { label: memoryInputText(check.label, 'check label', 200)!, command: memoryInputText(check.command, 'check command', 2000)! }
  })
  const bundle = { name, description, files, checks }
  if (redactSkillText(JSON.stringify(bundle)) !== JSON.stringify(bundle)) throw new Error('Credentials cannot be stored in skill bundles')
  return bundle
}

export function inspectSkillBundle(bundle: SkillBundle): SkillInspection {
  const errors: string[] = [], warnings: string[] = [], document = bundle.files.find(file => file.path === 'SKILL.md')!
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(document.content)
  if (!frontmatter) errors.push('SKILL.md needs YAML frontmatter with name and description')
  else {
    const parsed = parseDocument(frontmatter[1]!, { uniqueKeys: true })
    if (parsed.errors.length) errors.push('SKILL.md contains invalid YAML frontmatter')
    else {
      let fields: Record<string, unknown> | undefined
      try { fields = parsed.toJS({ maxAliasCount: 20 }) as Record<string, unknown> } catch { errors.push('SKILL.md frontmatter exceeds its alias limit') }
      if (!fields || typeof fields !== 'object' || Array.isArray(fields) || fields.name !== bundle.name || fields.description !== bundle.description) errors.push('SKILL.md name and description must match the reviewed skill')
      for (const key of ['disable-model-invocation', 'user-invocable']) if (fields?.[key] !== undefined && typeof fields[key] !== 'boolean') errors.push(key + ' must be a boolean')
      if (fields?.['disable-model-invocation'] === true || fields?.['user-invocable'] === false) errors.push('Use the skill enable controls; published bundles must permit native invocation')
      if (!frontmatter[2]?.trim()) errors.push('SKILL.md needs instructions explaining when and how to use this skill')
    }
  }
  for (const match of document.content.matchAll(/(?:scripts|references|tests|assets)\/[a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+/g)) {
    if (!bundle.files.some(file => file.path === match[0])) errors.push('Missing referenced resource: ' + match[0])
  }
  const scriptCount = bundle.files.filter(file => /\.(?:js|mjs|cjs|ts|tsx|py|sh|bash|ps1|rb|sql)$/.test(file.path)).length
  if (scriptCount && !bundle.checks.length) errors.push('Skills with scripts require at least one executable validation check')
  if (!scriptCount && !bundle.checks.length) warnings.push('Instructions only; no executable checks were declared')
  return { digest: bundleDigest(bundle), errors: [...new Set(errors)], warnings, scriptCount }
}

/** Atomic publication keeps each resource directory tied to the reviewed content. */
export async function materializeSkillBundle(root: string, bundle: SkillBundle, signal?: AbortSignal): Promise<string> {
  const digest = bundleDigest(bundle), directory = join(root, digest)
  signal?.throwIfAborted()
  try { await verifySkillFiles(directory, bundle, signal); return directory } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await mkdir(root, { recursive: true, mode: 0o700 })
  const temporary = join(root, '.candidate-' + randomUUID())
  await mkdir(temporary, { mode: 0o700 })
  try {
    for (const file of bundle.files) {
      signal?.throwIfAborted()
      const path = join(temporary, file.path)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const handle = await open(path, 'wx', 0o600)
      try { await handle.writeFile(file.content); await handle.sync() } finally { await handle.close() }
    }
    signal?.throwIfAborted()
    try { await rename(temporary, directory) } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(String((error as NodeJS.ErrnoException).code))) throw error
    }
    await verifySkillFiles(directory, bundle, signal)
    return directory
  } finally { await rm(temporary, { force: true, recursive: true }) }
}

export async function verifySkillFiles(directory: string, bundle: SkillBundle, signal?: AbortSignal): Promise<void> {
  if (!(await lstat(directory)).isDirectory()) throw new Error('The skill resource directory is not a regular directory')
  for (const file of bundle.files) {
    signal?.throwIfAborted()
    let path = directory
    for (const part of file.path.split('/')) {
      path = join(path, part)
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Skill resources must not contain symbolic links')
    }
    const info = await lstat(path)
    if (!info.isFile() || info.size > 64 * 1024 || await readFile(path, 'utf8') !== file.content) throw new Error('Skill resources changed outside the reviewed version')
  }
}

export async function readSkillBundleDirectory(directory: string, signal?: AbortSignal): Promise<SkillFile[]> {
  const files: SkillFile[] = []
  async function visit(relative: string, depth: number): Promise<void> {
    if (depth > 5) throw new Error('Skill directory is too deep')
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      signal?.throwIfAborted()
      if (entry.name.startsWith('.')) continue
      if (entry.isSymbolicLink()) throw new Error('Import requires regular skill files without symbolic links')
      const path = relative ? relative + '/' + entry.name : entry.name
      if (entry.isDirectory()) await visit(path, depth + 1)
      else if (entry.isFile() && textExtensions.test(path)) {
        if (files.length >= 24 || (await lstat(join(directory, path))).size > 64 * 1024) throw new Error('Skill import exceeds its file limits')
        files.push({ path: skillPath(path), content: await readFile(join(directory, path), 'utf8') })
      }
    }
  }
  if (!(await lstat(directory)).isDirectory()) throw new Error('Choose a regular skill directory')
  await visit('', 0)
  return files
}
