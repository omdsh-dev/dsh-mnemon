import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, parse, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { MnemonStorageMigration } from './protocol.ts'

/**
 * Moving a storage root is the one Mnemon operation that touches every file the
 * user owns, so it is written to be boring: never overwrite a non-empty target,
 * never delete the source before the destination has been read back, and always
 * report what moved.
 */

/** Directories the Host itself owns inside a storage root. Sources own the rest. */
const KNOWN_AREAS: readonly string[] = ['runtime', 'documents', 'data', 'state']

export interface MnemonMigrationPlan {
  from: string
  to: string
  /** What the source holds, before anything moves. */
  source: { files: number; bytes: number }
  /** Whether the target already holds Mnemon data, which refuses the move. */
  targetOccupied: boolean
  /** Whether the two roots are distinct enough for a rename to be possible. */
  sameDevice: boolean
  blocked?: string
}

function safeRoot(value: string): string {
  const resolved = resolve(value)
  if (resolved === parse(resolved).root) throw new Error('the Mnemon data directory must not be a filesystem root')
  return resolved
}

function walk(directory: string): { files: number; bytes: number; paths: string[] } {
  let files = 0
  let bytes = 0
  const paths: string[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) { visit(path); continue }
      if (!entry.isFile()) continue
      files += 1
      bytes += statSync(path).size
      paths.push(path)
    }
  }
  if (existsSync(directory)) visit(directory)
  return { files, bytes, paths }
}

/**
 * A target is only usable when it is empty or absent: merging two Mnemon roots
 * would silently pick a winner per file, and the user cannot review that.
 */
function occupied(target: string): boolean {
  if (!existsSync(target)) return false
  if (readdirSync(target).length > 0) return true
  return false
}

export function planMigration(from: string, to: string): MnemonMigrationPlan {
  const source = safeRoot(from)
  const target = safeRoot(to)
  const contents = walk(source)
  if (source === target) return { from: source, to: target, source: { files: contents.files, bytes: contents.bytes }, targetOccupied: false, sameDevice: true, blocked: 'the data directory is already this directory' }
  if (target.startsWith(source + sep) || source.startsWith(target + sep)) {
    return { from: source, to: target, source: { files: contents.files, bytes: contents.bytes }, targetOccupied: occupied(target), sameDevice: true, blocked: 'one directory is inside the other' }
  }
  const targetOccupied = occupied(target)
  return {
    from: source, to: target,
    source: { files: contents.files, bytes: contents.bytes },
    targetOccupied,
    sameDevice: parse(source).root === parse(target).root,
    ...(targetOccupied ? { blocked: 'the target directory already holds data' } : {}),
  }
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Copy a whole tree, then verify every file against the source before the source is removed. */
function copyTree(from: string, to: string): { files: number; bytes: number } {
  const contents = walk(from)
  mkdirSync(to, { recursive: true, mode: 0o700 })
  for (const path of contents.paths) {
    const relative = path.slice(from.length + 1)
    const destination = join(to, relative)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    copyFileSync(path, destination)
  }
  for (const path of contents.paths) {
    const destination = join(to, path.slice(from.length + 1))
    if (!existsSync(destination) || digest(path) !== digest(destination)) throw new Error('the copied Mnemon data directory did not verify: ' + relative(path, from))
  }
  return { files: contents.files, bytes: contents.bytes }
}

function relative(path: string, root: string): string {
  return path.slice(root.length + 1)
}

function fsyncDirectory(directory: string): void {
  const handle = openSync(directory, 'r')
  try {
    fsyncSync(handle)
  } catch (error) {
    // Windows refuses to flush a directory handle. The copy is verified file by
    // file before this point, so a refused flush only costs durability on a
    // platform that offers no way to buy it.
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EACCES') throw error
  } finally {
    closeSync(handle)
  }
}

/**
 * Moves a storage root. A rename on the same filesystem is atomic and keeps the
 * permissions of the files; across filesystems the tree is copied and verified
 * first, and the source is only removed after that verification passed.
 */
export async function migrateStorageRoot(from: string, to: string, options: { remove?: boolean } = {}): Promise<MnemonStorageMigration> {
  const plan = planMigration(from, to)
  if (plan.blocked !== undefined) throw new Error('cannot move the Mnemon data directory: ' + plan.blocked)
  const remove = options.remove !== false
  mkdirSync(dirname(plan.to), { recursive: true, mode: 0o700 })
  if (plan.sameDevice && !existsSync(plan.to)) {
    try {
      renameSync(plan.from, plan.to)
      return { from: plan.from, to: plan.to, source: 'rename', files: plan.source.files, bytes: plan.source.bytes, removed: true }
    } catch (error) {
      // A rename can still fail across a mount point that shares a root; fall back to a copy.
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    }
  }
  const copied = copyTree(plan.from, plan.to)
  fsyncDirectory(plan.to)
  if (remove) rmSync(plan.from, { recursive: true, force: true })
  return { from: plan.from, to: plan.to, source: 'copy', files: copied.files, bytes: copied.bytes, removed: remove }
}

/** The Host-owned areas of a storage root, for the settings page to describe. */
export function storageAreas(root: string): string[] {
  return KNOWN_AREAS.filter(area => existsSync(join(root, area)))
}
