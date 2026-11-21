export const MNEMON_MACHINE_LABEL_MAX = 120

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u
const HTTPS = /^https:\/\/[^\s/]+(?::\d+)?\/[^\s]+$/u
const SSH = /^ssh:\/\/[^\s/]+(?::\d+)?\/[^\s]+$/u
const SCP = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/u
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u
const HTTPS_USER = /^https:\/\/([^/]*)@/u
const USER_TEXT = /^(?:[A-Za-z0-9._~!$&'()*+,;=-]|%[0-9A-Fa-f]{2})+$/u
const NOT_A_NAME = /[:@\s\p{Cc}]/u
const TOKEN_SHAPE = /^(?:gh[opsru]_|github_pat_|glpat-|gldt-|glcbt-|hf_|ATBB|ATCTT|ATATT)|^[0-9A-Fa-f]{32,}$|^[A-Za-z0-9]{52,}$/u
const USER_NAME_MAX = 100
const EMAIL = /^[^\s<>@]+@[^\s<>@]+$/u
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u
const CONTROL = /[\p{Cc}\u2028\u2029]/u
const GITHUB_REPOSITORY = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u

export function syncBranchValid(name: string): boolean {
  return name !== '' && name.length <= 200 && BRANCH.test(name) && !name.includes('..') && !name.includes('//')
    && !name.includes('@{') && !name.includes('\\') && !name.startsWith('/') && !name.endsWith('/')
    && !name.endsWith('.') && !name.endsWith('.lock') && name !== '@'
}

export function syncDirectoryParts(value: string): string[] | undefined {
  const raw = value.trim().replaceAll('\\', '/')
  if (raw === '' || raw.length > 400 || /^[A-Za-z]:/u.test(raw)) return undefined
  const parts = raw.split('/').filter(part => part !== '')
  return parts.length === 0 || parts.some(part => part === '.' || part === '..' || part.includes(':')) ? undefined : parts
}

export type MnemonSyncRepositoryProblem = 'format' | 'credentials'

export function syncRepositoryProblem(url: string, localPath: (path: string) => boolean): MnemonSyncRepositoryProblem | undefined {
  if (url === '' || url.length > 2000 || /\s/u.test(url)) return 'format'
  if (SCHEME.test(url)) {
    if (!HTTPS.test(url) && !SSH.test(url)) return 'format'
    const user = HTTPS_USER.exec(url)?.[1]
    return user === undefined || syncUserName(user) ? undefined : 'credentials'
  }
  return SCP.test(url) || localPath(url) ? undefined : 'format'
}

function syncUserName(written: string): boolean {
  if (!USER_TEXT.test(written)) return false
  let name: string
  try {
    name = decodeURIComponent(written)
  } catch {
    return false
  }
  return name.length <= USER_NAME_MAX && !NOT_A_NAME.test(name) && !TOKEN_SHAPE.test(name)
}

export function portableAbsolutePath(path: string): boolean {
  return path.startsWith('/') || WINDOWS_DRIVE.test(path) || path.startsWith('\\\\')
}

export function syncEmailValid(email: string): boolean {
  return email.length <= 320 && EMAIL.test(email)
}

export function machineLabelValid(label: string): boolean {
  return label !== '' && label.length <= MNEMON_MACHINE_LABEL_MAX && !CONTROL.test(label)
}

export function githubRepositoryNameValid(name: string): boolean {
  return GITHUB_REPOSITORY.test(name)
}
