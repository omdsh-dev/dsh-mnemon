import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const GIT_BRANCH_TIMEOUT_MS = 2_000
const MAX_HEAD_CACHE_ENTRIES = 256
const DETACHED_HEAD_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu

interface CachedHeadState {
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  ino: bigint
  branch: string | undefined
}

const headCache = new Map<string, CachedHeadState>()

function cacheHead(headPath: string, entry: CachedHeadState): string | undefined {
  if (!headCache.has(headPath) && headCache.size >= MAX_HEAD_CACHE_ENTRIES) {
    const oldest = headCache.keys().next().value
    if (oldest !== undefined) headCache.delete(oldest)
  }
  headCache.set(headPath, entry)
  return entry.branch
}

function readGitHeadFast(root: string): { hit: true; branch: string | undefined } | { hit: false } {
  let rootStat
  try {
    rootStat = statSync(root)
  } catch {
    return { hit: false }
  }
  if (!rootStat.isDirectory()) return { hit: false }
  const rootDev = rootStat.dev
  let current = resolve(root)
  for (;;) {
    let dotGitStat
    try {
      dotGitStat = lstatSync(join(current, '.git'))
    } catch {
      dotGitStat = undefined
    }
    if (dotGitStat !== undefined) {
      if (!dotGitStat.isDirectory()) return { hit: false }
      const headPath = join(current, '.git', 'HEAD')
      let headStat
      try {
        headStat = statSync(headPath, { bigint: true })
      } catch {
        return { hit: false }
      }
      const cached = headCache.get(headPath)
      if (
        cached !== undefined
        && cached.size === headStat.size
        && cached.mtimeNs === headStat.mtimeNs
        && cached.ctimeNs === headStat.ctimeNs
        && cached.ino === headStat.ino
      ) {
        return { hit: true, branch: cached.branch }
      }
      let raw: string
      try {
        raw = readFileSync(headPath, 'utf8').trim()
      } catch {
        return { hit: false }
      }
      if (raw.startsWith('ref: refs/heads/')) {
        const name = raw.slice('ref: refs/heads/'.length).trim()
        const branch = cacheHead(headPath, {
          size: headStat.size,
          mtimeNs: headStat.mtimeNs,
          ctimeNs: headStat.ctimeNs,
          ino: headStat.ino,
          branch: name === '' ? undefined : name,
        })
        return { hit: true, branch }
      }
      if (DETACHED_HEAD_SHA_PATTERN.test(raw)) {
        cacheHead(headPath, {
          size: headStat.size,
          mtimeNs: headStat.mtimeNs,
          ctimeNs: headStat.ctimeNs,
          ino: headStat.ino,
          branch: undefined,
        })
        return { hit: true, branch: undefined }
      }
      return { hit: false }
    }
    const parent = dirname(current)
    if (parent === current) return { hit: false }
    let parentStat
    try {
      parentStat = statSync(parent)
    } catch {
      return { hit: false }
    }
    if (parentStat.dev !== rootDev) return { hit: false }
    current = parent
  }
}

export function gitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || name.toUpperCase().startsWith('GIT_')) continue
    sanitized[name] = value
  }
  return sanitized
}

export function resolveGitBranch(cwd?: string): string | undefined {
  const root = cwd?.trim()
  if (root === undefined || root === '') return undefined
  const fast = readGitHeadFast(root)
  if (fast.hit) return fast.branch
  try {
    const output = execFileSync('git', ['-C', root, 'branch', '--show-current'], {
      encoding: 'utf8',
      timeout: GIT_BRANCH_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: gitEnvironment(),
    })
    const branch = output.trim()
    return branch === '' ? undefined : branch
  } catch {
    return undefined
  }
}
