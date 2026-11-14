import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { readArchive } from './archive.ts'
import type { LocalizedText, MarketAudit, MarketEntry, MarketRegistryFile, MarketSource } from './contracts.ts'
import { isSkillName, splitFrontmatter } from './frontmatter.ts'
import { githubUrl, parseGithub } from './source-kind.ts'
import official from '../market/official.json' with { type: 'json' }

export const OFFICIAL_REGISTRY_ID = 'official'
/** The official registry's newest copy; the package carries a snapshot for offline use. */
export const OFFICIAL_REGISTRY_URL = 'https://raw.githubusercontent.com/omdsh-dev/dsh-mnemon/main/plugins/dsh-mnemon-source-skills/market/official.json'
/** The open skills index searched as the user types. */
export const SKILLS_SH_ID = 'skills-sh'
export const SKILLS_SH_URL = 'https://skills.sh'
/** A registry copy older than this is refreshed when the page opens. */
export const REGISTRY_REFRESH_MS = 6 * 60 * 60 * 1000
/** The schema of the Agent Skills discovery index this market reads. */
export const DISCOVERY_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json'

const MAX_REGISTRY_BYTES = 2 * 1024 * 1024
const MAX_ENTRIES = 1_000
const MAX_FILES = 300
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_SKILL_BYTES_TOTAL = 12 * 1024 * 1024
/** A repository lists at most this many skills, each read once for its name and description. */
const MAX_REPOSITORY_SKILLS = 300
const SEARCH_LIMIT = 30
const TIMEOUT_MS = 20_000
/** A repository's file tree is reused this long, between a preview and its install. */
const TREE_TTL_MS = 10 * 60 * 1000

export interface FetchResponse {
  ok: boolean
  status: number
  headers?: { get(name: string): string | null } | undefined
  body?: ReadableStream<Uint8Array> | null | undefined
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}
export type Fetcher = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<FetchResponse>

export const defaultFetcher: Fetcher = (url, init) => fetch(url, init as RequestInit) as Promise<FetchResponse>

export interface SkillFile {
  path: string
  data: Buffer
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function localizedText(value: unknown, maximum: number): LocalizedText | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim().slice(0, maximum)
  const fields = object(value)
  if (fields === undefined) return undefined
  const en = typeof fields.en === 'string' ? fields.en.trim().slice(0, maximum) : undefined
  const zh = typeof fields['zh-CN'] === 'string' ? fields['zh-CN'].trim().slice(0, maximum) : typeof fields.zh === 'string' ? fields.zh.trim().slice(0, maximum) : undefined
  if (!en && !zh) return undefined
  return { ...(en ? { en } : {}), ...(zh ? { 'zh-CN': zh } : {}) }
}

/** The text for a language, falling back to the other one. */
export function localized(value: LocalizedText | undefined, language: string): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  return (language.startsWith('zh') ? value['zh-CN'] ?? value.en : value.en ?? value['zh-CN']) ?? ''
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const REF = /^[A-Za-z0-9_./-]{1,200}$/u

function safeRelative(path: string): string | undefined {
  const normalized = path.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')
  if (normalized.split('/').some(part => part === '..' || part === '')) return normalized === '' ? '' : undefined
  return normalized
}

function source(value: unknown): MarketSource | undefined {
  const fields = object(value)
  if (fields === undefined) return undefined
  if (fields.type === 'github' && typeof fields.repo === 'string' && REPO.test(fields.repo) && typeof fields.path === 'string') {
    const path = safeRelative(fields.path)
    const ref = typeof fields.ref === 'string' && REF.test(fields.ref) ? fields.ref : undefined
    return path === undefined ? undefined : { type: 'github', repo: fields.repo, path, ...(ref === undefined ? {} : { ref }) }
  }
  if (fields.type === 'url' && typeof fields.url === 'string' && /^https?:\/\//u.test(fields.url)) return { type: 'url', url: fields.url }
  if (fields.type === 'path' && typeof fields.path === 'string' && fields.path.trim() !== '') return { type: 'path', path: fields.path.trim() }
  return undefined
}

/** Validate a registry file; entries that cannot be installed are left out, not fatal. */
export function parseRegistry(value: unknown): { registry: MarketRegistryFile; skipped: number } {
  const fields = object(value)
  if (fields === undefined || fields.version !== 1 || !Array.isArray(fields.skills)) throw new Error('a skill registry is a JSON object with "version": 1 and a "skills" array')
  const seen = new Set<string>()
  const skills: MarketEntry[] = []
  let skipped = 0
  for (const raw of fields.skills.slice(0, MAX_ENTRIES)) {
    const entry = object(raw)
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    const description = localizedText(entry?.description, 600)
    const from = source(entry?.source)
    if (entry === undefined || !isSkillName(name) || description === undefined || from === undefined || seen.has(name)) { skipped++; continue }
    seen.add(name)
    const title = localizedText(entry.title, 120)
    const text = (key: string, maximum: number) => typeof entry[key] === 'string' && (entry[key] as string).trim() !== '' ? { [key]: (entry[key] as string).trim().slice(0, maximum) } : {}
    skills.push({
      name, description, source: from,
      ...(title === undefined ? {} : { title }),
      ...text('category', 60), ...text('author', 120), ...text('license', 60), ...text('version', 40),
      ...(typeof entry.homepage === 'string' && /^https?:\/\//u.test(entry.homepage) ? { homepage: entry.homepage } : {}),
      ...(Array.isArray(entry.tags) ? { tags: entry.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8).map(tag => tag.slice(0, 40)) } : {}),
    })
  }
  const name = localizedText(fields.name, 120) ?? 'Skills'
  const description = localizedText(fields.description, 600)
  const categories = Array.isArray(fields.categories) ? fields.categories.flatMap(item => {
    const category = object(item)
    const label = localizedText(category?.label, 60)
    return typeof category?.id === 'string' && label !== undefined ? [{ id: category.id.slice(0, 60), label }] : []
  }) : []
  return {
    registry: {
      version: 1, name, skills,
      ...(typeof fields.id === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/u.test(fields.id) ? { id: fields.id } : {}),
      ...(description === undefined ? {} : { description }),
      ...(typeof fields.homepage === 'string' && /^https?:\/\//u.test(fields.homepage) ? { homepage: fields.homepage } : {}),
      ...(categories.length === 0 ? {} : { categories }),
    },
    skipped,
  }
}

/** The registry the package ships, so the market works offline and before any refresh. */
export function bundledOfficialRegistry(): MarketRegistryFile {
  return parseRegistry(official).registry
}

function signalWithTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()
  return { accept: 'application/vnd.github+json', 'user-agent': 'dsh-mnemon', ...(token ? { authorization: `Bearer ${token}` } : {}) }
}

async function request(fetcher: Fetcher, url: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<FetchResponse> {
  try {
    return await fetcher(url, { signal: signalWithTimeout(signal), ...(headers === undefined ? {} : { headers }) })
  } catch (error) {
    if (signal?.aborted === true) throw error
    throw new Error(`${new URL(url).host} could not be reached: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function checkDeclaredLength(response: FetchResponse, url: string, limit: number): void {
  const declared = response.headers?.get('content-length')?.trim()
  if (declared !== undefined && /^\d+$/u.test(declared) && Number(declared) > limit) {
    throw new Error(`${url} is larger than ${limit} bytes`)
  }
}

async function readStreamBytes(body: ReadableStream<Uint8Array>, url: string, limit: number): Promise<Buffer> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined || value.byteLength === 0) continue
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${url} is larger than ${limit} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

async function fetchText(
  fetcher: Fetcher,
  url: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
  limit = MAX_REGISTRY_BYTES,
): Promise<string> {
  const response = await request(fetcher, url, signal, headers)
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  checkDeclaredLength(response, url, limit)
  if (typeof response.body?.getReader === 'function') {
    return (await readStreamBytes(response.body, url, limit)).toString('utf8')
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > limit) throw new Error(`${url} is larger than ${limit} bytes`)
  return text
}

async function fetchBytes(fetcher: Fetcher, url: string, limit: number, signal?: AbortSignal, label = url): Promise<Buffer> {
  const response = await request(fetcher, url, signal)
  if (!response.ok) throw new Error(`${label} answered HTTP ${response.status}`)
  checkDeclaredLength(response, url, limit)
  if (typeof response.body?.getReader === 'function') {
    return readStreamBytes(response.body, url, limit)
  }
  const data = Buffer.from(await response.arrayBuffer())
  if (data.byteLength > limit) throw new Error(`${url} is larger than ${limit} bytes`)
  return data
}

function parseJson(text: string, what: string): unknown {
  try { return JSON.parse(text) } catch (error) { throw new Error(`${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`) }
}

/** Read a JSON file from an http(s) URL or an absolute file path. */
export async function loadJson(location: string, fetcher: Fetcher, signal?: AbortSignal): Promise<unknown> {
  let text: string
  if (/^https?:\/\//u.test(location)) text = await fetchText(fetcher, location, signal)
  else {
    const path = location.startsWith('file://') ? fileURLToPath(location) : location
    if (!isAbsolute(path)) throw new Error('a registry location is an http(s) URL or an absolute file path')
    if (statSync(path).size > MAX_REGISTRY_BYTES) throw new Error(`${path} is larger than ${MAX_REGISTRY_BYTES} bytes`)
    text = readFileSync(path, 'utf8')
  }
  return parseJson(text, 'the registry')
}

/** Read a registry from an http(s) URL or an absolute file path. */
export async function loadRegistry(location: string, fetcher: Fetcher, signal?: AbortSignal): Promise<MarketRegistryFile> {
  return parseRegistry(await loadJson(location, fetcher, signal)).registry
}

/** A stable id for a registry the user adds: its own id when it declares one, else a digest of where it lives. */
export function registryId(location: string, declared: string | undefined, taken: ReadonlySet<string>): string {
  if (declared !== undefined && declared !== OFFICIAL_REGISTRY_ID && declared !== SKILLS_SH_ID && !taken.has(declared)) return declared
  return 'registry-' + createHash('sha256').update(location).digest('hex').slice(0, 10)
}

function rawUrl(repo: string, ref: string, path: string): string {
  return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref).replace(/%2F/gu, '/')}/${path.split('/').map(encodeURIComponent).join('/')}`
}

interface GithubTreeEntry { path: string; type: string; size?: number }
interface GithubTree { tree: GithubTreeEntry[]; truncated: boolean; at: number }

/** Trees per fetcher, so a preview and the install after it list a repository once. */
const trees = new WeakMap<Fetcher, Map<string, GithubTree>>()

/** A repository's whole file tree at a ref, from one GitHub API call. */
async function repositoryTree(fetcher: Fetcher, repo: string, ref: string, signal?: AbortSignal): Promise<GithubTree> {
  let cache = trees.get(fetcher)
  if (cache === undefined) trees.set(fetcher, cache = new Map())
  const key = `${repo}@${ref}`
  const cached = cache.get(key)
  if (cached !== undefined && Date.now() - cached.at < TREE_TTL_MS) return cached
  const response = await request(fetcher, `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, signal, githubHeaders())
  if (response.status === 403 || response.status === 429) throw new Error(`GitHub declined to list ${repo} for now (it allows 60 unauthenticated requests an hour); try again later, or set GITHUB_TOKEN`)
  if (response.status === 404) throw new Error(`GitHub has no repository ${repo} at ${ref}, or it is private`)
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for ${repo}`)
  const fields = object(parseJson(await response.text(), `GitHub's tree of ${repo}`))
  if (!Array.isArray(fields?.tree)) throw new Error(`${repo} returned no file tree for ${ref}`)
  const tree: GithubTree = {
    tree: (fields.tree as GithubTreeEntry[]).filter(entry => typeof entry?.path === 'string' && typeof entry.type === 'string'),
    truncated: fields.truncated === true,
    at: Date.now(),
  }
  if (cache.size >= 50) cache.delete(cache.keys().next().value!)
  cache.set(key, tree)
  return tree
}

async function githubTree(fetcher: Fetcher, repo: string, ref: string, prefix: string, signal?: AbortSignal): Promise<GithubTreeEntry[]> {
  const tree = await repositoryTree(fetcher, repo, ref, signal)
  const base = prefix === '' ? '' : prefix + '/'
  const files = tree.tree.filter(entry => entry.type === 'blob' && entry.path.startsWith(base))
  if (files.length === 0 && tree.truncated) throw new Error(`${repo} is too large to list; use a registry entry with a direct url`)
  return files
}

/** Folders whose `SKILL.md` files are not skills to offer: dependencies, build output, test fixtures. */
const SKIPPED_FOLDERS = new Set(['node_modules', '.git', 'dist', 'build', 'fixtures', '__fixtures__', 'test', 'tests', '__tests__', 'vendor'])

/** The `SKILL.md` files of a tree under a folder, nearest first. */
function skillDocuments(tree: readonly GithubTreeEntry[], prefix: string): string[] {
  const base = prefix === '' ? '' : prefix + '/'
  return tree
    .filter(entry => entry.type === 'blob' && entry.path.startsWith(base) && (entry.path === base + 'SKILL.md' || entry.path.endsWith('/SKILL.md')))
    .map(entry => entry.path)
    .filter(path => { const parts = path.split('/'); return parts.length <= 8 && !parts.slice(0, -1).some(part => SKIPPED_FOLDERS.has(part)) })
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
}

function folderOf(path: string): string {
  return path === 'SKILL.md' ? '' : path.slice(0, -'/SKILL.md'.length)
}

/** The fields of a `SKILL.md` a market shows, or undefined when DSH could not load it under its name. */
export function skillMeta(raw: string): { name: string; description: string; license?: string } | undefined {
  try {
    const split = splitFrontmatter(raw)
    const fields = object(split === undefined ? undefined : parse(split.frontmatter))
    const name = typeof fields?.name === 'string' ? fields.name.trim() : ''
    const description = typeof fields?.description === 'string' ? fields.description.trim() : ''
    if (!isSkillName(name) || description === '') return undefined
    const license = typeof fields?.license === 'string' && fields.license.trim() !== '' ? fields.license.trim().slice(0, 60) : undefined
    return { name, description: description.slice(0, 1024), ...(license === undefined ? {} : { license }) }
  } catch { return undefined }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => { while (next < items.length) { const index = next++; results[index] = await run(items[index]!) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Every skill a GitHub repository (or one folder of it) holds: one API call
 * for its tree, then each `SKILL.md` read raw for its name and description.
 * A repository that is a plugin marketplace lends its name to the list.
 */
export async function loadRepository(location: string, fetcher: Fetcher, signal?: AbortSignal): Promise<MarketRegistryFile> {
  const github = parseGithub(location)
  if (github === undefined) throw new Error('not a GitHub repository: ' + location)
  const ref = github.ref ?? 'HEAD'
  const tree = await repositoryTree(fetcher, github.repo, ref, signal)
  const documents = skillDocuments(tree.tree, github.path)
  if (documents.length === 0) throw new Error(tree.truncated ? `${github.repo} is too large to list whole; add the folder its skills are in` : `${github.repo} has no SKILL.md`)
  const read = await mapLimit(documents.slice(0, MAX_REPOSITORY_SKILLS), 8, async path => {
    try { return { path, meta: skillMeta(await fetchText(fetcher, rawUrl(github.repo, ref, path), signal)) } } catch { return { path, meta: undefined } }
  })
  const owner = github.repo.split('/')[0]!
  const seen = new Set<string>()
  const skills: MarketEntry[] = []
  for (const { path, meta } of read) {
    if (meta === undefined || seen.has(meta.name)) continue
    seen.add(meta.name)
    const folder = folderOf(path)
    skills.push({
      name: meta.name, description: meta.description.slice(0, 600), author: owner,
      source: { type: 'github', repo: github.repo, path: folder, ref },
      homepage: githubUrl({ repo: github.repo, ref, path: folder }),
      ...(meta.license === undefined ? {} : { license: meta.license }),
    })
  }
  if (skills.length === 0) throw new Error(`no SKILL.md in ${github.repo} would load in DSH`)
  let name: LocalizedText = github.path === '' ? github.repo : `${github.repo}/${github.path}`
  let description: LocalizedText | undefined
  if (github.path === '' && tree.tree.some(entry => entry.path === '.claude-plugin/marketplace.json')) {
    try {
      const marketplace = object(parseJson(await fetchText(fetcher, rawUrl(github.repo, ref, '.claude-plugin/marketplace.json'), signal), 'the marketplace'))
      if (typeof marketplace?.name === 'string' && marketplace.name.trim() !== '') name = `${marketplace.name.trim().slice(0, 80)} · ${github.repo}`
      description = localizedText(marketplace?.description ?? object(marketplace?.metadata)?.description, 600)
    } catch { /* The skills are listed either way. */ }
  }
  return { version: 1, name, skills, homepage: githubUrl(github), ...(description === undefined ? {} : { description }) }
}

/**
 * Where a site's Agent Skills index may live, nearest first: under the
 * path given, then at the site's root, the current well-known name before
 * the one it replaced. A URL that names an index is read as it is.
 */
export function discoveryCandidates(location: string): string[] {
  const url = new URL(location)
  if (url.pathname.endsWith('/index.json')) return [url.toString()]
  const scope = url.pathname.replace(/\/+$/u, '')
  const found: string[] = []
  for (const folder of ['.well-known/agent-skills', '.well-known/skills']) {
    if (scope !== '') found.push(`${url.origin}${scope}/${folder}/index.json`)
    found.push(`${url.origin}/${folder}/index.json`)
  }
  return [...new Set(found)]
}

/**
 * An Agent Skills discovery index: schema 0.2.0 (one artifact per skill,
 * a `SKILL.md` or an archive, with its SHA-256 digest), or the earlier form
 * that lists each skill's files. Entries that break the rules are dropped.
 */
export function parseDiscovery(value: unknown, indexUrl: string): MarketRegistryFile {
  const fields = object(value)
  if (fields === undefined || !Array.isArray(fields.skills)) throw new Error('an Agent Skills index is a JSON object with a "skills" array')
  const schema = fields.$schema
  if (schema !== undefined && schema !== DISCOVERY_SCHEMA) throw new Error(`unsupported Agent Skills index schema: ${String(schema).slice(0, 120)}`)
  const index = new URL(indexUrl)
  const site = index.pathname.replace(/\/\.well-known\/(?:agent-skills|skills)\/index\.json$/u, '').replace(/\/+$/u, '')
  const owner = index.host.replace(/^www\./u, '')
  const seen = new Set<string>()
  const skills: MarketEntry[] = []
  for (const raw of fields.skills.slice(0, MAX_ENTRIES)) {
    const entry = object(raw)
    const name = typeof entry?.name === 'string' ? entry.name : ''
    const description = typeof entry?.description === 'string' ? entry.description.trim() : ''
    if (entry === undefined || !isSkillName(name) || description === '' || seen.has(name)) continue
    let from: MarketSource | undefined
    if (schema !== undefined) {
      const format = entry.type === 'skill-md' || entry.type === 'archive' ? entry.type : undefined
      const digest = typeof entry.digest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(entry.digest) ? entry.digest : undefined
      let url: URL | undefined
      try { url = typeof entry.url === 'string' ? new URL(entry.url, index) : undefined } catch { url = undefined }
      if (format !== undefined && digest !== undefined && url !== undefined && /^https?:$/u.test(url.protocol)) from = { type: 'artifact', url: url.toString(), format, digest }
    } else if (Array.isArray(entry.files)) {
      const files = entry.files.filter((file): file is string => typeof file === 'string').map(file => safeRelative(file)).filter((file): file is string => file !== undefined && file !== '')
      if (files.includes('SKILL.md') && files.length <= MAX_FILES) from = { type: 'files', base: new URL(`${name}/`, index).toString(), files }
    }
    if (from === undefined) continue
    seen.add(name)
    skills.push({ name, description: description.slice(0, 600), source: from, author: owner })
  }
  return { version: 1, name: index.host + site, homepage: index.origin + (site === '' ? '/' : site), skills }
}

/** A site's Agent Skills index, from the first place it is published. */
export async function loadDiscovery(location: string, fetcher: Fetcher, signal?: AbortSignal): Promise<MarketRegistryFile> {
  let found: { index: string; value: unknown } | undefined
  let reached = false
  for (const index of discoveryCandidates(location)) {
    let response: FetchResponse
    try { response = await request(fetcher, index, signal) } catch (error) { if (signal?.aborted === true) throw error; continue }
    reached = true
    if (!response.ok) continue
    let value: unknown
    try { value = JSON.parse(await response.text()) } catch { continue }
    found = { index, value }
    break
  }
  if (found === undefined) throw new Error(reached ? `${new URL(location).host} publishes no Agent Skills index at /.well-known/agent-skills/index.json` : `${new URL(location).host} could not be reached`)
  return parseDiscovery(found.value, found.index)
}

/** Whether a JSON file is a discovery index rather than a catalog, read by its shape. */
export function isDiscoveryIndex(value: unknown): boolean {
  const fields = object(value)
  if (fields === undefined || !Array.isArray(fields.skills)) return false
  if (typeof fields.$schema === 'string') return true
  const first = object(fields.skills[0])
  return fields.version === undefined && first !== undefined && Array.isArray(first.files)
}

/** Whether a JSON file is a Claude Code plugin marketplace. */
export function isPluginMarketplace(value: unknown): boolean {
  const fields = object(value)
  return fields !== undefined && Array.isArray(fields.plugins) && typeof fields.name === 'string'
}

/** The GitHub repository a raw or blob URL of a marketplace file lives in. */
export function marketplaceRepository(url: string): string | undefined {
  const parsed = new URL(url)
  const parts = parsed.pathname.split('/').filter(Boolean)
  if (parsed.hostname === 'raw.githubusercontent.com' && parts.length >= 3) return githubUrl({ repo: `${parts[0]}/${parts[1]}`, ref: parts[2]!, path: '' })
  const github = parseGithub(url)
  return github === undefined ? undefined : githubUrl({ repo: github.repo, ...(github.ref === undefined ? {} : { ref: github.ref }), path: '' })
}

function checkBudget(files: ReadonlyArray<{ bytes: number }>): void {
  if (files.length > MAX_FILES) throw new Error(`the skill has more than ${MAX_FILES} files`)
  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  if (total > MAX_SKILL_BYTES_TOTAL) throw new Error(`the skill is larger than ${MAX_SKILL_BYTES_TOTAL} bytes`)
  if (files.some(file => file.bytes > MAX_FILE_BYTES)) throw new Error(`a file of the skill is larger than ${MAX_FILE_BYTES} bytes`)
}

function localRoot(entry: MarketEntry & { source: { type: 'path' } }, registryLocation: string): string {
  if (isAbsolute(entry.source.path)) return entry.source.path
  if (/^https?:\/\//u.test(registryLocation)) throw new Error('a relative path source needs a registry that is a local file')
  return resolve(dirname(registryLocation.startsWith('file://') ? fileURLToPath(registryLocation) : registryLocation), entry.source.path)
}

function listLocal(root: string): Array<{ path: string; bytes: number }> {
  const info = statSync(root)
  if (info.isFile()) return [{ path: 'SKILL.md', bytes: info.size }]
  const found: Array<{ path: string; bytes: number }> = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.well-known') continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) found.push({ path: relative(root, full).split(sep).join('/'), bytes: statSync(full).size })
      if (found.length > MAX_FILES) throw new Error(`the skill has more than ${MAX_FILES} files`)
    }
  }
  visit(root)
  return found
}

/** A discovery artifact's files, after its bytes match the digest its index published. */
async function artifactFiles(entry: MarketEntry & { source: { type: 'artifact' } }, fetcher: Fetcher, signal?: AbortSignal): Promise<SkillFile[]> {
  const data = await fetchBytes(fetcher, entry.source.url, MAX_SKILL_BYTES_TOTAL, signal)
  if ('sha256:' + createHash('sha256').update(data).digest('hex') !== entry.source.digest) throw new Error(`${entry.source.url} does not match the digest its index published`)
  if (entry.source.format === 'skill-md') return [{ path: 'SKILL.md', data }]
  return readArchive(data, { files: MAX_FILES, bytes: MAX_SKILL_BYTES_TOTAL })
}

function unresolved(): never {
  throw new Error('an indexed skill is resolved to its repository or site before it is read')
}

/** The file list of a market entry, without downloading it when its source can say. */
export async function listSkillFiles(entry: MarketEntry, registryLocation: string, fetcher: Fetcher, signal?: AbortSignal): Promise<Array<{ path: string; bytes: number }>> {
  switch (entry.source.type) {
    case 'url': return [{ path: 'SKILL.md', bytes: 0 }]
    case 'path': return listLocal(localRoot(entry as MarketEntry & { source: { type: 'path' } }, registryLocation))
    case 'files': return entry.source.files.map(path => ({ path, bytes: 0 }))
    case 'artifact': return (await artifactFiles(entry as MarketEntry & { source: { type: 'artifact' } }, fetcher, signal)).map(file => ({ path: file.path, bytes: file.data.byteLength }))
    case 'indexed': return unresolved()
    case 'github': {
      const { repo, path } = entry.source
      const prefix = path === '' ? '' : path + '/'
      return (await githubTree(fetcher, repo, entry.source.ref ?? 'HEAD', path, signal)).map(file => ({ path: file.path.slice(prefix.length), bytes: file.size ?? 0 }))
    }
  }
}

/** The SKILL.md of a market entry, for a preview before installing. */
export async function fetchSkillDocument(entry: MarketEntry, registryLocation: string, fetcher: Fetcher, signal?: AbortSignal): Promise<string> {
  switch (entry.source.type) {
    case 'url': return fetchText(fetcher, entry.source.url, signal, undefined, MAX_FILE_BYTES)
    case 'path': {
      const root = localRoot(entry as MarketEntry & { source: { type: 'path' } }, registryLocation)
      const file = statSync(root).isFile() ? root : join(root, 'SKILL.md')
      if (statSync(file).size > MAX_FILE_BYTES) throw new Error(`${file} is larger than ${MAX_FILE_BYTES} bytes`)
      return readFileSync(file, 'utf8')
    }
    case 'files': return fetchText(fetcher, new URL('SKILL.md', entry.source.base).toString(), signal, undefined, MAX_FILE_BYTES)
    case 'artifact': return (await artifactFiles(entry as MarketEntry & { source: { type: 'artifact' } }, fetcher, signal)).find(file => file.path === 'SKILL.md')!.data.toString('utf8')
    case 'indexed': return unresolved()
    case 'github': return fetchText(fetcher, rawUrl(entry.source.repo, entry.source.ref ?? 'HEAD', entry.source.path === '' ? 'SKILL.md' : `${entry.source.path}/SKILL.md`), signal, undefined, MAX_FILE_BYTES)
  }
}

/** Download every file of a market entry, bounded, with paths kept inside the skill folder. */
export async function fetchSkillFiles(entry: MarketEntry, registryLocation: string, fetcher: Fetcher, signal?: AbortSignal): Promise<SkillFile[]> {
  if (entry.source.type === 'url') return [{ path: 'SKILL.md', data: Buffer.from(await fetchSkillDocument(entry, registryLocation, fetcher, signal), 'utf8') }]
  if (entry.source.type === 'indexed') return unresolved()
  if (entry.source.type === 'artifact') {
    const files = await artifactFiles(entry as MarketEntry & { source: { type: 'artifact' } }, fetcher, signal)
    checkBudget(files.map(file => ({ bytes: file.data.byteLength })))
    return files
  }
  const listed = await listSkillFiles(entry, registryLocation, fetcher, signal)
  checkBudget(listed)
  const files: SkillFile[] = []
  for (const file of listed) {
    const path = safeRelative(file.path)
    if (path === undefined || path === '') throw new Error('a file of the skill escapes its folder: ' + file.path)
    let data: Buffer
    if (entry.source.type === 'path') {
      const root = localRoot(entry as MarketEntry & { source: { type: 'path' } }, registryLocation)
      data = readFileSync(statSync(root).isFile() ? root : join(root, ...path.split('/')))
    } else if (entry.source.type === 'files') {
      data = await fetchBytes(fetcher, new URL(path, entry.source.base).toString(), MAX_FILE_BYTES, signal)
    } else {
      const { repo, ref = 'HEAD' } = entry.source
      data = await fetchBytes(fetcher, rawUrl(repo, ref, entry.source.path === '' ? path : `${entry.source.path}/${path}`), MAX_FILE_BYTES, signal, `${repo}/${path}`)
    }
    if (data.byteLength > MAX_FILE_BYTES) throw new Error(`${path} is larger than ${MAX_FILE_BYTES} bytes`)
    files.push({ path, data })
  }
  checkBudget(files.map(file => ({ bytes: file.data.byteLength })))
  if (!files.some(file => file.path === 'SKILL.md')) throw new Error('the skill has no SKILL.md at its top level')
  return files
}

// ---- skills.sh -------------------------------------------------------------------

/** A skill the open index found: its id, the repository or site it lives in, and how often it is installed. */
export interface IndexedSkill {
  id: string
  origin: string
  skill: string
  name: string
  installs: number
}

const INDEX_ID = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?\/[A-Za-z0-9_.-]+$/u

/** The parts of an index id: `owner/repo/skill`, or `site/skill` for a site's own index. */
export function indexedParts(id: string): { origin: string; skill: string } | undefined {
  if (!INDEX_ID.test(id)) return undefined
  const at = id.lastIndexOf('/')
  return { origin: id.slice(0, at), skill: id.slice(at + 1) }
}

/** Search skills.sh, the index the open `skills` CLI searches, newest installs first. */
export async function searchSkillsSh(query: string, fetcher: Fetcher, signal?: AbortSignal): Promise<IndexedSkill[]> {
  const response = await request(fetcher, `${SKILLS_SH_URL}/api/search?${new URLSearchParams({ q: query, limit: String(SEARCH_LIMIT) }).toString()}`, signal)
  if (response.status === 429) throw new Error('skills.sh is busy; try again in a moment')
  if (!response.ok) throw new Error(`skills.sh answered HTTP ${response.status}`)
  const fields = object(parseJson(await response.text(), 'the skills.sh answer'))
  const found: IndexedSkill[] = []
  for (const raw of Array.isArray(fields?.skills) ? fields.skills.slice(0, SEARCH_LIMIT) : []) {
    const entry = object(raw)
    const id = typeof entry?.id === 'string' ? entry.id : ''
    const parts = indexedParts(id)
    if (parts === undefined) continue
    const declared = typeof entry?.name === 'string' ? entry.name.trim() : ''
    const name = isSkillName(declared) ? declared : isSkillName(parts.skill) ? parts.skill : undefined
    if (name === undefined) continue
    found.push({ id, origin: parts.origin, skill: parts.skill, name, installs: typeof entry?.installs === 'number' && Number.isFinite(entry.installs) ? Math.max(0, Math.round(entry.installs)) : 0 })
  }
  return found.sort((a, b) => b.installs - a.installs)
}

/** What security reviewers said about a skill on skills.sh; none when it was not reviewed yet. */
export async function skillsShAudits(id: string, fetcher: Fetcher, signal?: AbortSignal): Promise<MarketAudit[]> {
  try {
    const response = await request(fetcher, `${SKILLS_SH_URL}/api/v1/skills/audit/${id.split('/').map(encodeURIComponent).join('/')}`, signal)
    if (!response.ok) return []
    const fields = object(JSON.parse(await response.text()))
    return (Array.isArray(fields?.audits) ? fields.audits : []).slice(0, 6).flatMap(raw => {
      const audit = object(raw)
      const status = audit?.status === 'pass' || audit?.status === 'warn' || audit?.status === 'fail' ? audit.status : undefined
      const provider = typeof audit?.provider === 'string' ? audit.provider.slice(0, 80) : undefined
      if (status === undefined || provider === undefined) return []
      return [{
        provider, status,
        ...(typeof audit?.summary === 'string' && audit.summary.trim() !== '' ? { summary: audit.summary.trim().slice(0, 600) } : {}),
        ...(typeof audit?.riskLevel === 'string' ? { risk: audit.riskLevel.slice(0, 40) } : {}),
      } satisfies MarketAudit]
    })
  } catch { return [] }
}

/** The text files skills.sh keeps of a skill: enough to read it, not always every file to install. */
export async function skillsShSnapshot(id: string, fetcher: Fetcher, signal?: AbortSignal): Promise<SkillFile[]> {
  const parts = indexedParts(id)
  if (parts === undefined) throw new Error('not a skills.sh id: ' + id)
  const response = await request(fetcher, `${SKILLS_SH_URL}/api/download/${id.split('/').map(encodeURIComponent).join('/')}`, signal)
  if (!response.ok) throw new Error(`skills.sh has no copy of ${id} (HTTP ${response.status})`)
  const fields = object(parseJson(await response.text(), 'the skills.sh copy'))
  const files = (Array.isArray(fields?.files) ? fields.files : []).flatMap(raw => {
    const file = object(raw)
    const path = typeof file?.path === 'string' ? safeRelative(file.path) : undefined
    return path === undefined || path === '' || typeof file?.contents !== 'string' ? [] : [{ path, data: Buffer.from(file.contents, 'utf8') }]
  })
  checkBudget(files.map(file => ({ bytes: file.data.byteLength })))
  if (!files.some(file => file.path === 'SKILL.md')) throw new Error(`skills.sh's copy of ${id} has no SKILL.md`)
  return files
}

/**
 * Where an indexed skill's files live: the folder of its `SKILL.md` in its
 * GitHub repository, found in the repository's tree by folder name and then
 * by the name in its frontmatter; or its entry in its site's own index.
 */
export async function resolveIndexed(skill: Pick<IndexedSkill, 'origin' | 'skill' | 'name'>, fetcher: Fetcher, signal?: AbortSignal): Promise<MarketEntry> {
  const github = parseGithub(skill.origin)
  if (github === undefined) {
    const site = await loadDiscovery(`https://${skill.origin}`, fetcher, signal)
    const entry = site.skills.find(candidate => candidate.name === skill.name || candidate.name === skill.skill)
    if (entry === undefined) throw new Error(`${skill.origin} no longer publishes ${skill.name}`)
    return entry
  }
  const ref = 'HEAD'
  const tree = await repositoryTree(fetcher, github.repo, ref, signal)
  const documents = skillDocuments(tree.tree, '')
  const named = (path: string) => folderOf(path).split('/').at(-1)
  let path = documents.find(candidate => named(candidate) === skill.skill) ?? documents.find(candidate => named(candidate) === skill.name)
  if (path === undefined) {
    for (const candidate of documents.slice(0, 40)) {
      const meta = await fetchText(fetcher, rawUrl(github.repo, ref, candidate), signal).then(skillMeta, () => undefined)
      if (meta?.name === skill.name) { path = candidate; break }
    }
  }
  if (path === undefined) throw new Error(`${github.repo} no longer has a skill named ${skill.name}`)
  const folder = folderOf(path)
  return { name: skill.name, description: '', author: github.repo.split('/')[0]!, source: { type: 'github', repo: github.repo, path: folder, ref }, homepage: githubUrl({ repo: github.repo, ref, path: folder }) }
}
