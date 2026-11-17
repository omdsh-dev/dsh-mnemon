import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { SkillBundleSnapshot } from './store.ts'
import type { SkillDraftFileChange, SkillResourceFile, SkillSummary } from './contracts.ts'
import { MAX_BUNDLE_SNAPSHOT_BYTES, MAX_BUNDLE_SNAPSHOT_FILES, writeFileAtomic } from './store.ts'
export { MAX_BUNDLE_SNAPSHOT_BYTES } from './store.ts'

export const MAX_DRAFT_FILE_OPS = 20
export const MAX_RESOURCE_TEXT_BYTES = 32 * 1024
export const MAX_TOTAL_RESOURCE_TEXT_BYTES = 96 * 1024
export const MAX_DRAFT_RESOURCE_FILE_BYTES = 256 * 1024
const MAX_READ_RESOURCES = 40

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function insideDirectory(rootReal: string, candidateReal: string): boolean {
  return candidateReal === rootReal || candidateReal.startsWith(rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`)
}

/** Validate and canonicalize one relative supporting-file path inside a skill bundle. */
export function normalizeBundleRelativePath(raw: string): string {
  if (typeof raw !== 'string' || raw.includes('\0')) throw new Error('invalid supporting file path')
  const normalized = raw.trim().replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
  if (normalized === '' || normalized.length > 200 || normalized.startsWith('/') || /^[a-zA-Z]:/u.test(normalized)) {
    throw new Error(`supporting file path must be relative to the skill directory: ${raw}`)
  }
  const segments = normalized.split('/')
  if (segments.some(seg => seg === '' || seg === '.' || seg === '..' || seg.startsWith('.'))) {
    throw new Error(`invalid segment in supporting file path: ${raw}`)
  }
  if (segments.length > 4) throw new Error(`supporting file path is nested too deeply: ${raw}`)
  const canonical = segments.join('/')
  if (canonical === 'SKILL.md' || canonical.toLowerCase() === 'skill.md') {
    throw new Error('SKILL.md is edited via content rather than supporting files')
  }
  return canonical
}

function ensureContainedParents(bundleReal: string, relPath: string): string {
  const segments = relPath.split('/')
  let current = bundleReal
  for (let i = 0; i < segments.length - 1; i++) {
    current = join(current, segments[i]!)
    try {
      const info = lstatSync(current)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`refusing non-directory or symlink segment: ${segments.slice(0, i + 1).join('/')}`)
      const real = realpathSync(current)
      if (!insideDirectory(bundleReal, real)) throw new Error(`supporting path escapes skill directory: ${relPath}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return join(bundleReal, ...segments)
}

/** Inspect non-symlink supporting files inside a bundle directory without failing on unreadable entries. */
export function readSkillResourceFiles(summary: Pick<SkillSummary, 'path' | 'layout'>): SkillResourceFile[] {
  if (summary.layout !== 'bundle') return []
  const directory = dirname(summary.path)
  let rootReal: string
  try {
    rootReal = realpathSync(directory)
  } catch {
    return []
  }
  const collected: Array<{ rel: string; full: string; bytes: number }> = []
  const visit = (dir: string, depth: number) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (collected.length >= MAX_READ_RESOURCES || entry.name.startsWith('.')) continue
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      const rel = relative(directory, full).replaceAll('\\', '/')
      if (rel === '' || rel === 'SKILL.md') continue
      if (entry.isDirectory()) {
        if (depth < 3) visit(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = lstatSync(full)
        if (!info.isFile() || info.isSymbolicLink()) continue
        const fileReal = realpathSync(full)
        if (!insideDirectory(rootReal, fileReal)) continue
        collected.push({ rel, full: fileReal, bytes: info.size })
      } catch {
        // Ignore transient or unreadable files during catalog inspection.
      }
    }
  }
  visit(directory, 0)
  let totalTextBytes = 0
  return collected.flatMap(({ rel, full, bytes }): SkillResourceFile[] => {
    try {
      if (bytes > 1024 * 1024) return []
      const buf = readFileSync(full)
      const hash = sha256Hex(buf)
      const binary = buf.includes(0)
      if (!binary && buf.byteLength <= MAX_RESOURCE_TEXT_BYTES && totalTextBytes + buf.byteLength <= MAX_TOTAL_RESOURCE_TEXT_BYTES) {
        totalTextBytes += buf.byteLength
        return [{ path: rel, hash, bytes: buf.byteLength, content: buf.toString('utf8') }]
      }
      return [{ path: rel, hash, bytes: buf.byteLength, ...(binary ? { binary: true } : {}) }]
    } catch {
      return []
    }
  })
}

/** Read one exact supporting file inside a bundle directory, rejecting symlinks and traversal. */
export function readBundleResourceState(bundleDir: string, relPath: string): { exists: boolean; hash: string | null; content?: string } {
  const canonical = normalizeBundleRelativePath(relPath)
  const bundleReal = realpathSync(bundleDir)
  const full = ensureContainedParents(bundleReal, canonical)
  let info
  try {
    info = lstatSync(full)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, hash: null }
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`supporting path is not a regular file: ${canonical}`)
  const fileReal = realpathSync(full)
  if (!insideDirectory(bundleReal, fileReal)) throw new Error(`supporting file escapes skill directory: ${canonical}`)
  const buf = readFileSync(fileReal)
  const hash = sha256Hex(buf)
  return { exists: true, hash, ...(buf.includes(0) || buf.byteLength > MAX_DRAFT_RESOURCE_FILE_BYTES ? {} : { content: buf.toString('utf8') }) }
}

/** Complete recoverable bytes for editable paths, independent of model preview limits. */

export function snapshotBundleFiles(bundleDir: string): SkillBundleSnapshot {
  const root = realpathSync(bundleDir)
  const files: SkillBundleSnapshot['files'] = Object.create(null)
  let bytes = 0
  const visit = (directory: string, depth: number) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) { if (depth < 3) visit(full, depth + 1); continue }
      if (!entry.isFile()) continue
      const path = relative(root, full).replaceAll('\\', '/')
      if (path.toLowerCase() === 'skill.md') continue
      // Names the editing API cannot accept remain outside its restore scope.
      try { if (normalizeBundleRelativePath(path) !== path) continue } catch { continue }
      const info = lstatSync(full)
      if (!info.isFile() || info.isSymbolicLink() || !insideDirectory(root, realpathSync(full))) throw new Error('supporting file changed during backup: ' + path)
      bytes += info.size
      if (bytes > MAX_BUNDLE_SNAPSHOT_BYTES || Object.keys(files).length >= MAX_BUNDLE_SNAPSHOT_FILES) throw new Error('Skill supporting-file backup exceeds 16 MiB or 1024 files; no files were changed')
      const data = readFileSync(full)
      if (data.length !== info.size) throw new Error('supporting file changed during backup: ' + path)
      files[path] = { base64: data.toString('base64'), mode: info.mode & 0o777 }
    }
  }
  visit(root, 0)
  return { version: 1, complete: true, files }
}

export function changedBundleSnapshot(before: SkillBundleSnapshot, changes: readonly SkillDraftFileChange[]): SkillBundleSnapshot {
  const files: SkillBundleSnapshot['files'] = Object.assign(Object.create(null), before.files)
  for (const change of changes) {
    const path = normalizeBundleRelativePath(change.path)
    if (change.action === 'delete') delete files[path]
    else files[path] = { base64: Buffer.from(change.content ?? '', 'utf8').toString('base64'), mode: files[path]?.mode ?? 0o600 }
  }
  return boundedSnapshot(files)
}

function boundedSnapshot(files: SkillBundleSnapshot['files']): SkillBundleSnapshot {
  const bytes = Object.values(files).reduce((total, file) => total + Buffer.from(file.base64, 'base64').length, 0)
  if (bytes > MAX_BUNDLE_SNAPSHOT_BYTES || Object.keys(files).length > MAX_BUNDLE_SNAPSHOT_FILES) throw new Error('Skill supporting-file backup exceeds 16 MiB or 1024 files; no files were changed')
  return { version: 1, complete: true, files }
}

export function restoreBundleFiles(bundleDir: string, target: SkillBundleSnapshot, current: SkillBundleSnapshot): { rollback(): void; snapshot: SkillBundleSnapshot } {
  const files: SkillBundleSnapshot['files'] = Object.assign(Object.create(null), target.complete ? {} : current.files)
  for (const [path, file] of Object.entries(target.files)) files[path] = { ...file, mode: file.mode ?? current.files[path]?.mode ?? 0o600 }
  const snapshot = boundedSnapshot(files)
  const changes: BundleFileMutation[] = Object.entries(target.files).map(([path, file]) => ({
    path, action: 'upsert', content: Buffer.from(file.base64, 'base64'), ...(file.mode === undefined ? {} : { mode: file.mode }),
  }))
  // Legacy text previews never described a complete bundle: absence is not a deletion.
  if (target.complete) for (const path of Object.keys(current.files)) {
    if (!Object.hasOwn(target.files, path)) changes.push({ path, action: 'delete' })
  }
  return { ...applyBundleFileChanges(bundleDir, changes), snapshot }
}

/** Backtests get the same bounded text preview, never persisted binary/base64 data. */
export function snapshotResourcePreview(snapshot: SkillBundleSnapshot): Array<{ path: string; content: string }> {
  let bytes = 0
  return Object.keys(snapshot.files).sort((a, b) => a.localeCompare(b)).slice(0, MAX_READ_RESOURCES).flatMap(path => {
    const data = Buffer.from(snapshot.files[path]!.base64, 'base64')
    if (data.includes(0) || data.length > MAX_RESOURCE_TEXT_BYTES || bytes + data.length > MAX_TOTAL_RESOURCE_TEXT_BYTES) return []
    bytes += data.length
    return [{ path, content: data.toString('utf8') }]
  })
}

const REFERENCE_LINK = /\[[^\]]*\]\(([^)\s]+)\)/gu
const REFERENCE_CODE = /`((?:\.\/)?(?:references|scripts|assets)\/[^`\s]+)`/gu
const TEMPLATE_HINT = /[*<>{}$[\]]|\.\.\./u
const CONCRETE_EXT = /\.[a-z0-9]{1,10}$/iu

/** Extract concrete relative `references/...`, `scripts/...`, or `assets/...` file paths referenced in SKILL.md. */
export function extractConcreteBundleReferences(markdown: string): string[] {
  const found = new Set<string>()
  const consider = (raw: string) => {
    const stripped = raw.split('#')[0]!.split('?')[0]!.trim().replace(/^\.\//u, '').replaceAll('\\', '/')
    if (!/^(?:references|scripts|assets)\//u.test(stripped)) return
    if (TEMPLATE_HINT.test(stripped) || !CONCRETE_EXT.test(stripped)) return
    try {
      found.add(normalizeBundleRelativePath(stripped))
    } catch {
      // Malformed traversal paths stay ignored here or caught when drafted as files.
    }
  }
  for (const match of markdown.matchAll(REFERENCE_LINK)) consider(match[1]!)
  for (const match of markdown.matchAll(REFERENCE_CODE)) consider(match[1]!)
  return [...found]
}

export function brokenBundleReferences(markdown: string, existingPaths: ReadonlySet<string>): string[] {
  return extractConcreteBundleReferences(markdown).filter(path => !existingPaths.has(path))
}

/** Validate supporting-file ops, hash fences, and SKILL.md reference integrity before saving a draft. */
export function prepareDraftFileChanges(input: {
  action: 'create' | 'update'
  isFlatSkill: boolean
  skillContent: string
  baseContent?: string
  existingResources: readonly SkillResourceFile[]
  files?: readonly SkillDraftFileChange[]
}): { files?: SkillDraftFileChange[]; baseFileHashes?: Record<string, string | null> } {
  const rawFiles = input.files ?? []
  if (rawFiles.length > MAX_DRAFT_FILE_OPS) throw new Error(`a skill draft can change at most ${MAX_DRAFT_FILE_OPS} supporting files`)
  if (rawFiles.length > 0 && input.action === 'update' && input.isFlatSkill) {
    throw new Error('This skill is a single .md file and has no bundle directory for supporting files; keep all changes in SKILL.md.')
  }
  const existingByPath = new Map(input.existingResources.map(file => [file.path, file]))
  const seen = new Set<string>()
  const normalized: SkillDraftFileChange[] = []
  const baseFileHashes: Record<string, string | null> = {}

  for (const entry of rawFiles) {
    const path = normalizeBundleRelativePath(entry.path)
    if (seen.has(path)) throw new Error(`duplicate supporting file operation: ${path}`)
    seen.add(path)
    const current = existingByPath.get(path)
    if (input.action === 'create' && entry.action === 'delete') {
      throw new Error(`cannot delete supporting file while creating a new skill: ${path}`)
    }
    if (entry.action === 'delete') {
      if (current === undefined) throw new Error(`cannot delete supporting file that does not exist: ${path}`)
    } else if (entry.action === 'upsert') {
      if (typeof entry.content !== 'string' || entry.content.trim() === '') throw new Error(`supporting file requires non-empty text content: ${path}`)
      if (Buffer.byteLength(entry.content, 'utf8') > MAX_DRAFT_RESOURCE_FILE_BYTES) {
        throw new Error(`supporting file exceeds ${MAX_DRAFT_RESOURCE_FILE_BYTES} bytes: ${path}`)
      }
    } else {
      throw new Error(`unsupported file operation for ${path}`)
    }
    const actualBaseHash = current?.hash ?? null
    if (entry.baseHash !== undefined && entry.baseHash !== actualBaseHash) {
      throw new Error(`supporting file changed since it was read: ${path}`)
    }
    if (input.action === 'update') baseFileHashes[path] = actualBaseHash
    normalized.push({
      path,
      action: entry.action,
      ...(entry.action === 'upsert' ? { content: entry.content! } : {}),
    })
  }

  const resultingPaths = new Set(input.existingResources.map(file => file.path))
  for (const change of normalized) {
    if (change.action === 'delete') resultingPaths.delete(change.path)
    else resultingPaths.add(change.path)
  }
  const preExistingBroken = input.baseContent === undefined
    ? new Set<string>()
    : new Set(brokenBundleReferences(input.baseContent, new Set(input.existingResources.map(file => file.path))))
  const broken = brokenBundleReferences(input.skillContent, resultingPaths)
    .filter(path => input.action === 'create' || !preExistingBroken.has(path) || normalized.some(change => change.action === 'delete' && change.path === path))
  if (broken.length > 0) {
    throw new Error(`SKILL.md links supporting file(s) missing from the skill directory: ${broken.join(', ')}. Include them in files or fix the link.`)
  }

  return normalized.length === 0
    ? {}
    : { files: normalized, ...(input.action === 'update' ? { baseFileHashes } : {}) }
}

/** Apply supporting-file upserts/deletes inside `bundleDir` and return a rollback handle. */
type BundleFileMutation = Omit<SkillDraftFileChange, 'content'> & { content?: string | Buffer; mode?: number }

export function applyBundleFileChanges(bundleDir: string, changes: readonly BundleFileMutation[]): { rollback: () => void } {
  const bundleReal = realpathSync(resolve(bundleDir))
  const targets = changes.map(change => {
    const path = normalizeBundleRelativePath(change.path)
    const full = ensureContainedParents(bundleReal, path)
    let previous: Buffer | null = null
    let mode = 0o600
    try {
      const info = lstatSync(full)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`refusing non-regular supporting file: ${path}`)
      const fileReal = realpathSync(full)
      if (!insideDirectory(bundleReal, fileReal)) throw new Error(`supporting path escapes skill directory: ${path}`)
      previous = readFileSync(fileReal)
      mode = info.mode & 0o777
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return { change, full, previous, mode }
  })

  const applied: Array<{ full: string; previous: Buffer | null; mode: number }> = []
  const rollback = () => {
    for (const entry of applied.reverse()) {
      try {
        if (entry.previous === null) rmSync(entry.full, { force: true })
        else {
          mkdirSync(dirname(entry.full), { recursive: true, mode: 0o700 })
          writeFileAtomic(entry.full, entry.previous, { dirMode: 0o700, fileMode: entry.mode })
        }
      } catch {
        // Best-effort rollback of prior files in reverse order.
      }
    }
  }

  try {
    for (const { change, full, previous, mode } of targets) {
      if (change.action === 'delete') {
        if (previous !== null) {
          rmSync(full, { force: true })
          applied.push({ full, previous, mode })
          let parent = dirname(full)
          while (parent !== bundleReal && insideDirectory(bundleReal, parent)) {
            if (readdirSync(parent).length > 0) break
            rmSync(parent, { recursive: true, force: true })
            parent = dirname(parent)
          }
        }
      } else {
        mkdirSync(dirname(full), { recursive: true, mode: 0o700 })
        writeFileAtomic(full, change.content ?? '', { dirMode: 0o700, fileMode: change.mode ?? mode })
        applied.push({ full, previous, mode })
      }
    }
  } catch (error) {
    rollback()
    throw error
  }
  return { rollback }
}
