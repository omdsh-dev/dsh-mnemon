export type MarketSourceKind = 'catalog' | 'well-known' | 'github' | 'search'

export interface DetectedSource {
  kind: 'catalog' | 'well-known' | 'github' | 'json'
  location: string
  label: string
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u
const NAME = /^[A-Za-z0-9_.-]+$/u
const REF = /^[A-Za-z0-9_./-]{1,200}$/u

export interface GithubLocation {
  repo: string
  ref?: string
  path: string
}

export function githubUrl(location: GithubLocation): string {
  const base = `https://github.com/${location.repo}`
  if (location.ref === undefined && location.path === '') return base
  return `${base}/tree/${location.ref ?? 'HEAD'}${location.path === '' ? '' : '/' + location.path}`
}

export function parseGithub(input: string): GithubLocation | undefined {
  const text = input.trim().replace(/\.git$/u, '').replace(/\/+$/u, '')
  const short = /^([^/\s]+)\/([^/\s]+)$/u.exec(text)
  if (short !== null && !/^https?:/iu.test(text)) return OWNER.test(short[1]!) && NAME.test(short[2]!) && !/\.json$/iu.test(short[2]!) ? { repo: `${short[1]}/${short[2]}`, path: '' } : undefined
  let url: URL
  try { url = new URL(text) } catch { return undefined }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return undefined
  const [owner, repo, mode, ref, ...rest] = url.pathname.split('/').filter(Boolean)
  if (owner === undefined || repo === undefined || !OWNER.test(owner) || !NAME.test(repo)) return undefined
  if (mode === undefined) return { repo: `${owner}/${repo}`, path: '' }
  if ((mode !== 'tree' && mode !== 'blob') || ref === undefined || !REF.test(ref)) return { repo: `${owner}/${repo}`, path: '' }
  const parts = mode === 'blob' ? rest.slice(0, -1) : rest
  if (parts.some(part => part === '..' || part === '.')) return undefined
  return { repo: `${owner}/${repo}`, ref, path: parts.join('/') }
}

function isAbsolutePath(text: string): boolean {
  return text.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(text) || text.startsWith('file://')
}

export function detectSource(input: string): DetectedSource | undefined {
  const text = input.trim()
  if (text === '') return undefined
  if (isAbsolutePath(text)) {
    return /\.json$/iu.test(text) ? { kind: 'catalog', location: text, label: text.split(/[\\/]/u).at(-1)! } : undefined
  }
  const github = parseGithub(text)
  if (github !== undefined) return { kind: 'github', location: githubUrl(github), label: github.path === '' ? github.repo : `${github.repo}/${github.path}` }
  let url: URL
  try { url = new URL(/^https?:\/\//iu.test(text) ? text : `https://${text}`) } catch { return undefined }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (!url.hostname.includes('.')) return undefined
  if (url.hostname === 'skills.sh' || url.hostname === 'www.skills.sh') {
    const [owner, repo] = url.pathname.split('/').filter(Boolean)
    if (owner !== undefined && repo !== undefined && OWNER.test(owner) && NAME.test(repo)) return { kind: 'github', location: `https://github.com/${owner}/${repo}`, label: `${owner}/${repo}` }
    return undefined
  }
  const location = url.toString().replace(/\/$/u, '')
  if (/\.json$/iu.test(url.pathname)) return { kind: 'json', location, label: url.pathname.split('/').at(-1)! }
  return { kind: 'well-known', location, label: url.host + url.pathname.replace(/\/$/u, '') }
}
