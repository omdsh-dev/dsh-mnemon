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
const IGNORED_BUNDLE_DIRECTORIES = new Set(['node_modules', '__pycache__', 'venv'])

function isDependencyDirectory(name: string): boolean {
  return IGNORED_BUNDLE_DIRECTORIES.has(name.toLowerCase())
}

function isDependencyPath(path: string): boolean {
  return path.trim().replaceAll('\\', '/').split('/').slice(0, -1).some(isDependencyDirectory)
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function insideDirectory(rootReal: string, candidateReal: string): boolean {
  return candidateReal === rootReal || candidateReal.startsWith(rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`)
}

export function normalizeBundleRelativePath(raw: string): string {
  if (typeof raw !== 'string' || raw.includes('\0')) throw new Error('invalid supporting file path')
  const normalized = raw.trim().replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
  if (normalized === '' || normalized.length > 200 || normalized.startsWith('/') || /^[a-zA-Z]:/u.test(normalized)) {
    throw new Error(`supporting file path must be relative to the skill directory: ${raw}`)
  }
  const segments = normalized.split('/')
  if (segments.some(seg => seg === '' || seg === '.' || seg === '..' || seg.startsWith('.')) || isDependencyPath(normalized)) {
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

function* bundleFiles(root: string, strict: boolean, directory = root, depth = 0): Generator<{ path: string; full: string; bytes: number; mode: number }> {
  let entries
  try { entries = readdirSync(directory, { withFileTypes: true }) } catch (error) { if (strict) throw error; return }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
    if (entry.isDirectory() && isDependencyDirectory(entry.name)) continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) { if (depth < 3) yield* bundleFiles(root, strict, full, depth + 1); continue }
    if (!entry.isFile()) continue
    const path = relative(root, full).replaceAll('\\', '/')
    try { if (normalizeBundleRelativePath(path) !== path) continue } catch { continue }
    try {
      const info = lstatSync(full)
      if (!info.isFile() || info.isSymbolicLink() || !insideDirectory(root, realpathSync(full))) throw new Error('supporting file changed during read: ' + path)
      yield { path, full, bytes: info.size, mode: info.mode & 0o777 }
    } catch (error) { if (strict) throw error }
  }
}

export function readSkillResourceFiles(summary: Pick<SkillSummary, 'path' | 'layout'>): SkillResourceFile[] {
  if (summary.layout !== 'bundle') return []
  let root: string
  try { root = realpathSync(dirname(summary.path)) } catch { return [] }
  const resources: SkillResourceFile[] = []
  let count = 0, textBytes = 0
  for (const { path, full, bytes } of bundleFiles(root, false)) {
    if (count++ >= MAX_READ_RESOURCES) break
    if (bytes > 1024 * 1024) continue
    try {
      const data = readFileSync(full)
      const binary = data.includes(0)
      const text = !binary && data.length <= MAX_RESOURCE_TEXT_BYTES && textBytes + data.length <= MAX_TOTAL_RESOURCE_TEXT_BYTES
      if (text) textBytes += data.length
      resources.push({ path, hash: sha256Hex(data), bytes: data.length,
        ...(binary ? { binary: true } : {}), ...(text ? { content: data.toString('utf8') } : {}) })
    } catch { }
  }
  return resources
}

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

function topLevelBucket(relPath: string): string {
  const slash = relPath.indexOf('/')
  return slash === -1 ? relPath : `${relPath.slice(0, slash)}/`
}

function backupOverflowError(reason: 'bytes' | 'files', path: string, totals: Map<string, { bytes: number; count: number }>): Error {
  const largest = [...totals.entries()].sort((a, b) => reason === 'bytes' ? b[1].bytes - a[1].bytes : b[1].count - a[1].count)[0]?.[0]
  const limit = reason === 'bytes' ? 'over 16 MiB' : `over ${MAX_BUNDLE_SNAPSHOT_FILES} files`
  const detail = largest === undefined ? `${limit} at ${path}` : `${limit} at ${path}; largest: ${largest}`
  return new Error(`Skill supporting-file backup exceeds 16 MiB or 1024 files (${detail}); no files were changed`)
}

export function snapshotBundleFiles(bundleDir: string): SkillBundleSnapshot {
  const files: SkillBundleSnapshot['files'] = Object.create(null)
  const totals = new Map<string, { bytes: number; count: number }>()
  let bytes = 0, count = 0
  for (const file of bundleFiles(realpathSync(bundleDir), true)) {
    bytes += file.bytes
    count++
    const bucket = topLevelBucket(file.path)
    const entry = totals.get(bucket) ?? { bytes: 0, count: 0 }
    entry.bytes += file.bytes
    entry.count++
    totals.set(bucket, entry)
    if (bytes > MAX_BUNDLE_SNAPSHOT_BYTES) throw backupOverflowError('bytes', file.path, totals)
    if (count > MAX_BUNDLE_SNAPSHOT_FILES) throw backupOverflowError('files', file.path, totals)
    const data = readFileSync(file.full)
    if (data.length !== file.bytes) throw new Error('supporting file changed during backup: ' + file.path)
    files[file.path] = { base64: data.toString('base64'), mode: file.mode }
  }
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
  const totals = new Map<string, { bytes: number; count: number }>()
  let bytes = 0, count = 0
  for (const [path, file] of Object.entries(files)) {
    const size = Buffer.from(file.base64, 'base64').length
    bytes += size
    count++
    const bucket = topLevelBucket(path)
    const entry = totals.get(bucket) ?? { bytes: 0, count: 0 }
    entry.bytes += size
    entry.count++
    totals.set(bucket, entry)
    if (bytes > MAX_BUNDLE_SNAPSHOT_BYTES) throw backupOverflowError('bytes', path, totals)
    if (count > MAX_BUNDLE_SNAPSHOT_FILES) throw backupOverflowError('files', path, totals)
  }
  return { version: 1, complete: true, files }
}

export function restoreBundleFiles(bundleDir: string, target: SkillBundleSnapshot, current: SkillBundleSnapshot): { rollback(): void; snapshot: SkillBundleSnapshot } {
  const currentFiles = Object.entries(current.files).filter(([path]) => !isDependencyPath(path))
  const targetFiles = Object.entries(target.files).filter(([path]) => !isDependencyPath(path))
  const files: SkillBundleSnapshot['files'] = Object.create(null)
  if (!target.complete) for (const [path, file] of currentFiles) files[path] = file
  for (const [path, file] of targetFiles) files[path] = { ...file, mode: file.mode ?? current.files[path]?.mode ?? 0o600 }
  const snapshot = boundedSnapshot(files)
  const changes: BundleFileMutation[] = targetFiles.map(([path, file]) => ({
    path, action: 'upsert', content: Buffer.from(file.base64, 'base64'), ...(file.mode === undefined ? {} : { mode: file.mode }),
  }))
  if (target.complete) for (const [path] of currentFiles) {
    if (!Object.hasOwn(target.files, path)) changes.push({ path, action: 'delete' })
  }
  return { ...applyBundleFileChanges(bundleDir, changes), snapshot }
}

export function snapshotResourcePreview(snapshot: SkillBundleSnapshot): Array<{ path: string; content: string }> {
  let bytes = 0
  return Object.keys(snapshot.files).filter(path => !isDependencyPath(path)).sort((a, b) => a.localeCompare(b)).slice(0, MAX_READ_RESOURCES).flatMap(path => {
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

export function extractConcreteBundleReferences(markdown: string): string[] {
  const found = new Set<string>()
  const consider = (raw: string) => {
    const stripped = raw.split('#')[0]!.split('?')[0]!.trim().replace(/^\.\//u, '').replaceAll('\\', '/')
    if (!/^(?:references|scripts|assets)\//u.test(stripped)) return
    if (TEMPLATE_HINT.test(stripped) || !CONCRETE_EXT.test(stripped)) return
    try {
      found.add(normalizeBundleRelativePath(stripped))
    } catch {
    }
  }
  for (const match of markdown.matchAll(REFERENCE_LINK)) consider(match[1]!)
  for (const match of markdown.matchAll(REFERENCE_CODE)) consider(match[1]!)
  return [...found]
}

export function brokenBundleReferences(markdown: string, existingPaths: ReadonlySet<string>): string[] {
  return extractConcreteBundleReferences(markdown).filter(path => !existingPaths.has(path))
}

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
  const baseFileHashes: Record<string, string | null> = Object.create(null)

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
