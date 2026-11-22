#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_ASSETS_REPO = 'mnemon-dev/assets'
export const DEFAULT_ASSETS_BRANCH = 'main'
export const DEFAULT_NAMESPACE = 'dsh-mnemon'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm'])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_VIDEO_BYTES = 25 * 1024 * 1024

const SAFE_TOKEN = /^[a-z0-9][a-z0-9._-]*$/iu
const SAFE_REPO = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/iu
const SAFE_BRANCH = /^[a-z0-9][a-z0-9._/-]*$/iu

function usage() {
  return [
    'Usage: node scripts/upload-pr-evidence.mjs --slug <slug> [options] <file...>',
    '',
    'Maintainer/automation helper that uploads redacted PR visual evidence to',
    `${DEFAULT_ASSETS_REPO} and prints 40-character commit-SHA Markdown links.`,
    '',
    'Options:',
    '  --slug <slug>          Required PR or branch folder name (e.g. pr-722-locale)',
    `  --repo <owner/name>    Target GitHub assets repository (default: ${DEFAULT_ASSETS_REPO})`,
    `  --namespace <name>     Top-level project directory (default: ${DEFAULT_NAMESPACE})`,
    `  --branch <name>        Target branch (default: ${DEFAULT_ASSETS_BRANCH})`,
    '  --remote <url-or-path> Explicit Git remote URL or local bare repository path',
    '  --dry-run              Validate files and print planned paths without pushing',
    '  -h, --help             Show this help message',
  ].join('\n')
}

export function parseUploadArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  let slug
  let repo = DEFAULT_ASSETS_REPO
  let namespace = DEFAULT_NAMESPACE
  let branch = DEFAULT_ASSETS_BRANCH
  let remote
  let dryRun = false
  let help = false
  const files = []

  const takeValue = (index, flag) => {
    const value = args[index + 1]
    if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`)
    return value
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      files.push(...args.slice(i + 1))
      break
    }
    if (arg === '-h' || arg === '--help') { help = true; continue }
    if (arg === '--dry-run') { dryRun = true; continue }
    if (arg === '--slug') { slug = takeValue(i++, arg); continue }
    if (arg.startsWith('--slug=')) { slug = arg.slice('--slug='.length); continue }
    if (arg === '--repo') { repo = takeValue(i++, arg); continue }
    if (arg.startsWith('--repo=')) { repo = arg.slice('--repo='.length); continue }
    if (arg === '--namespace') { namespace = takeValue(i++, arg); continue }
    if (arg.startsWith('--namespace=')) { namespace = arg.slice('--namespace='.length); continue }
    if (arg === '--branch') { branch = takeValue(i++, arg); continue }
    if (arg.startsWith('--branch=')) { branch = arg.slice('--branch='.length); continue }
    if (arg === '--remote') { remote = takeValue(i++, arg); continue }
    if (arg.startsWith('--remote=')) { remote = arg.slice('--remote='.length); continue }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    files.push(arg)
  }

  if (help) return { help: true }
  if (!slug || !SAFE_TOKEN.test(slug) || slug.includes('..')) {
    throw new Error('--slug must be a single ASCII identifier (letters, digits, ., _, -)')
  }
  if (!SAFE_REPO.test(repo)) throw new Error(`Invalid --repo value: ${repo}`)
  if (!SAFE_TOKEN.test(namespace) || namespace.includes('..')) {
    throw new Error(`Invalid --namespace value: ${namespace}`)
  }
  if (!SAFE_BRANCH.test(branch) || branch.includes('..')) {
    throw new Error(`Invalid --branch value: ${branch}`)
  }
  if (files.length === 0) throw new Error('At least one media file path is required')

  return { help: false, slug, repo, namespace, branch, remote, dryRun, files }
}

export function validateEvidenceFiles(paths, { namespace, slug }) {
  const seen = new Set()
  return paths.map(rawPath => {
    const sourcePath = resolve(rawPath)
    let stats
    try {
      stats = statSync(sourcePath)
    } catch {
      throw new Error(`Evidence file not found: ${rawPath}`)
    }
    if (!stats.isFile()) throw new Error(`Evidence path is not a regular file: ${rawPath}`)

    const name = basename(sourcePath)
    if (!SAFE_TOKEN.test(name) || name.includes('..')) {
      throw new Error(`Unsafe evidence filename: ${name}`)
    }
    const key = name.toLowerCase()
    if (seen.has(key)) throw new Error(`Duplicate evidence filename: ${name}`)
    seen.add(key)

    const ext = extname(name).toLowerCase()
    const isImage = IMAGE_EXTENSIONS.has(ext)
    const isVideo = VIDEO_EXTENSIONS.has(ext)
    if (!isImage && !isVideo) {
      throw new Error(`Unsupported media extension for ${name}: ${ext || '(none)'}`)
    }
    const limit = isImage ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES
    if (stats.size === 0) throw new Error(`Evidence file is empty: ${name}`)
    if (stats.size > limit) {
      throw new Error(`Evidence file ${name} exceeds limit (${stats.size} > ${limit} bytes)`)
    }

    return {
      sourcePath,
      name,
      kind: isImage ? 'image' : 'video',
      bytes: stats.size,
      repoPath: `${namespace}/pr/${slug}/${name}`,
    }
  })
}

export function formatEvidenceMarkdown({ repo, sha, entries }) {
  return entries.map(entry => {
    const alt = entry.name.slice(0, -extname(entry.name).length).replace(/[-_]+/gu, ' ')
    const url = `https://raw.githubusercontent.com/${repo}/${sha}/${entry.repoPath}`
    return entry.kind === 'image' ? `![${alt}](${url})` : `[${alt}](${url})`
  }).join('\n')
}

function cloneAssetRepo({ repo, branch, remote, targetDir, env }) {
  if (remote) {
    execFileSync('git', ['clone', '--depth=1', '--single-branch', '--branch', branch, remote, targetDir], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return
  }
  try {
    execFileSync('gh', ['repo', 'clone', repo, targetDir, '--', '--depth=1', '--single-branch', '--branch', branch], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    execFileSync('git', ['clone', '--depth=1', '--single-branch', '--branch', branch, `https://github.com/${repo}.git`, targetDir], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
}

function hasStagedChanges(cwd, env) {
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd, env, stdio: 'ignore' })
    return false
  } catch (error) {
    if (error?.status === 1) return true
    throw error
  }
}

export function uploadPrEvidence({
  slug,
  repo = DEFAULT_ASSETS_REPO,
  namespace = DEFAULT_NAMESPACE,
  branch = DEFAULT_ASSETS_BRANCH,
  remote,
  dryRun = false,
  files,
  env = process.env,
}) {
  const entries = validateEvidenceFiles(files, { namespace, slug })
  if (dryRun) {
    const markdown = formatEvidenceMarkdown({ repo, sha: '<40-char-commit-sha>', entries })
    return { repo, branch, sha: undefined, committed: false, dryRun: true, entries, markdown }
  }

  const workDir = mkdtempSync(join(tmpdir(), 'mnemon-pr-evidence-'))
  try {
    cloneAssetRepo({ repo, branch, remote, targetDir: workDir, env })
    const destinationDir = join(workDir, namespace, 'pr', slug)
    mkdirSync(destinationDir, { recursive: true })
    for (const entry of entries) {
      copyFileSync(entry.sourcePath, join(destinationDir, entry.name))
    }

    execFileSync('git', ['add', '--', ...entries.map(entry => entry.repoPath)], { cwd: workDir, env, stdio: ['ignore', 'pipe', 'pipe'] })

    let committed = false
    if (hasStagedChanges(workDir, env)) {
      execFileSync('git', ['commit', '-m', `chore(${namespace}): add PR evidence for ${slug}`], {
        cwd: workDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      execFileSync('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: workDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
      committed = true
    }

    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workDir, env, encoding: 'utf8' }).trim()
    const markdown = formatEvidenceMarkdown({ repo, sha, entries })
    return { repo, branch, sha, committed, dryRun: false, entries, markdown }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

function main() {
  let options
  try {
    options = parseUploadArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    console.error('')
    console.error(usage())
    process.exitCode = 1
    return
  }

  if (options.help) {
    console.log(usage())
    return
  }

  try {
    const result = uploadPrEvidence(options)
    if (result.dryRun) {
      console.log(`Dry run for ${result.repo} (${result.branch}):`)
      for (const entry of result.entries) {
        console.log(`- ${entry.repoPath} (${entry.bytes} bytes)`)
      }
      console.log('')
      console.log(result.markdown)
      return
    }
    const status = result.committed ? 'Uploaded' : 'Already up to date'
    console.log(`${status} in ${result.repo}@${result.sha}:`)
    console.log('')
    console.log(result.markdown)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
