import { createGitHubTransport, describeTransportError, type MnemonGitHubFetch } from './github-transport.ts'
import { githubRepositoryNameValid, type MnemonSyncGitHubPoll, type MnemonSyncGitHubRepository, type MnemonSyncGitHubRepositoryList, type MnemonSyncGitHubStatus } from './protocol.ts'
import { MnemonSyncError } from './sync-error.ts'

export const MNEMON_GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const MNEMON_GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const MNEMON_GITHUB_API_BASE = 'https://api.github.com'
export const MNEMON_GITHUB_DEFAULT_CLIENT_ID = 'Ov23liq4i7n8UsylGRfb'
export const MNEMON_GITHUB_SCOPE = 'repo'
export const MNEMON_SYNC_GITHUB_CREDENTIAL_KEY = 'dsh-mnemon/github'
export const MNEMON_GITHUB_REQUEST_TIMEOUT_MS = 30_000
export const MNEMON_GITHUB_DEFAULT_INTERVAL_MS = 5_000
export const MNEMON_GITHUB_SLOW_DOWN_MS = 5_000
export const MNEMON_GITHUB_MAX_INTERVAL_MS = 60_000
export const MNEMON_GITHUB_FLOW_LIMIT_MS = 3_600_000
export const MNEMON_GITHUB_REPOSITORY_PAGE = 100
export const MNEMON_GITHUB_REPOSITORY_PAGES = 5
export const MNEMON_GITHUB_USER_AGENT = 'dsh-mnemon-sync'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

export interface MnemonGitHubGrant {
  version: 1
  accessToken: string
  login?: string
  scopes?: string[]
  savedAt: string
}

export interface MnemonGitHubCredentialPort {
  available(): boolean
  describe(): Promise<{ configured: boolean; writable: boolean }>
  read(): Promise<MnemonGitHubGrant | undefined>
  write(grant: MnemonGitHubGrant): Promise<void>
  clear(): Promise<void>
}

interface DeviceFlow {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresAt: number
  intervalMs: number
  nextPollAt: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function codeOf(body: unknown): string | undefined {
  const fields = record(body)
  return text(fields?.error) ?? text(fields?.message)
}

function count(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d{1,9}$/u.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : undefined
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u

function shapeOf(answer: { status: number; type?: string | undefined; body: unknown }): string {
  const keys = Object.keys(record(answer.body) ?? {})
  const names = keys.filter(key => FIELD_NAME.test(key)).slice(0, 8)
  const listed = keys.length > names.length ? [...names, String(keys.length - names.length) + ' other'] : names
  return 'HTTP ' + String(answer.status) + ', content-type ' + (answer.type ?? 'none') + ', fields: ' + (listed.length === 0 ? 'none' : listed.join(', '))
}

function failure(action: string, status: number, body: unknown): Error {
  const code = codeOf(body)
  const message = code === undefined ? action + ' failed with HTTP ' + String(status) : action + ' failed: ' + code
  return status === 401 ? new MnemonSyncError('github-unauthorized', message) : new Error(message)
}

export function githubGrantFromRecord(record_: unknown): MnemonGitHubGrant | undefined {
  const fields = record(record_)
  if (fields?.kind !== 'grant') return undefined
  const payload = record(fields.payload)
  if (payload?.version !== 1) return undefined
  const accessToken = text(payload.accessToken)
  if (accessToken === undefined) return undefined
  const scopes = Array.isArray(payload.scopes) ? payload.scopes.filter((scope): scope is string => typeof scope === 'string') : undefined
  return {
    version: 1,
    accessToken,
    ...(text(payload.login) === undefined ? {} : { login: text(payload.login)! }),
    ...(scopes === undefined || scopes.length === 0 ? {} : { scopes }),
    savedAt: text(payload.savedAt) ?? new Date(0).toISOString(),
  }
}

function repositoryOf(value: unknown): MnemonSyncGitHubRepository | undefined {
  const fields = record(value)
  const fullName = text(fields?.full_name)
  const url = text(fields?.clone_url)
  const name = text(fields?.name)
  if (fullName === undefined || url === undefined || name === undefined) return undefined
  const owner = record(fields?.owner)
  const permissions = record(fields?.permissions)
  return {
    name,
    fullName,
    url,
    private: fields?.private === true,
    defaultBranch: text(fields?.default_branch) ?? 'main',
    owner: text(owner?.login) ?? fullName.split('/')[0] ?? '',
    push: permissions?.push !== false,
  }
}

export class MnemonGitHubAuth {
  private flow: DeviceFlow | undefined

  constructor(
    private readonly port: MnemonGitHubCredentialPort | undefined,
    private readonly clientId: string = MNEMON_GITHUB_DEFAULT_CLIENT_ID,
    private readonly now: () => number = () => Date.now(),
    private readonly request: MnemonGitHubFetch = createGitHubTransport(),
  ) {}

  available(): boolean {
    return this.port !== undefined && this.port.available()
  }

  private store(): MnemonGitHubCredentialPort | undefined {
    const port = this.port
    return port !== undefined && port.available() ? port : undefined
  }

  async token(): Promise<string | undefined> {
    return (await this.grant())?.accessToken
  }

  async grant(): Promise<MnemonGitHubGrant | undefined> {
    const port = this.store()
    if (port === undefined) return undefined
    try {
      return await port.read()
    } catch {
      return undefined
    }
  }

  private async writable(): Promise<boolean> {
    const port = this.store()
    if (port === undefined) return false
    try {
      return (await port.describe()).writable
    } catch {
      return false
    }
  }

  async status(): Promise<MnemonSyncGitHubStatus> {
    if (!this.available()) return { available: false, signedIn: false, writable: false }
    const grant = await this.grant()
    const writable = await this.writable()
    const flow = this.liveFlow()
    return {
      available: true,
      signedIn: grant !== undefined,
      writable,
      ...(grant?.login === undefined ? {} : { login: grant.login }),
      ...(grant?.scopes === undefined ? {} : { scopes: grant.scopes }),
      ...(flow === undefined ? {} : {
        flow: {
          userCode: flow.userCode,
          verificationUri: flow.verificationUri,
          expiresAt: new Date(flow.expiresAt).toISOString(),
          intervalMs: flow.intervalMs,
        },
      }),
    }
  }

  private liveFlow(): DeviceFlow | undefined {
    const flow = this.flow
    if (flow === undefined) return undefined
    if (this.now() >= flow.expiresAt) {
      this.flow = undefined
      return undefined
    }
    return flow
  }

  async start(signal?: AbortSignal): Promise<MnemonSyncGitHubStatus> {
    if (!this.available()) throw new Error('this DSH Host provides no credentials store, so GitHub sign-in is unavailable')
    const current = this.liveFlow()
    if (current !== undefined) return this.status()
    if ((await this.grant()) !== undefined) return this.status()
    let answer: { status: number; type?: string; body: unknown }
    try {
      answer = await this.json(MNEMON_GITHUB_DEVICE_CODE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.clientId, scope: MNEMON_GITHUB_SCOPE }).toString(),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      throw new Error('the GitHub device code request could not reach GitHub: ' + describeTransportError(error))
    }
    if (answer.status !== 200) throw failure('the GitHub device code request', answer.status, answer.body)
    const fields = record(answer.body)
    const deviceCode = text(fields?.device_code)
    const userCode = text(fields?.user_code)
    const verificationUri = text(fields?.verification_uri)
    if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
      throw new Error('the GitHub device code answer was incomplete (' + shapeOf(answer) + ')')
    }
    const expiresIn = count(fields?.expires_in) ?? 900
    const intervalMs = Math.min(Math.max((count(fields?.interval) ?? MNEMON_GITHUB_DEFAULT_INTERVAL_MS / 1000) * 1000, 1000), MNEMON_GITHUB_MAX_INTERVAL_MS)
    this.flow = {
      deviceCode,
      userCode,
      verificationUri,
      expiresAt: this.now() + Math.min(expiresIn * 1000, MNEMON_GITHUB_FLOW_LIMIT_MS),
      intervalMs,
      nextPollAt: this.now() + intervalMs,
    }
    return this.status()
  }

  async poll(signal?: AbortSignal): Promise<MnemonSyncGitHubPoll> {
    if (!this.available()) throw new Error('this DSH Host provides no credentials store, so GitHub sign-in is unavailable')
    const flow = this.liveFlow()
    if (flow === undefined) return { status: 'expired' }
    if (this.now() < flow.nextPollAt) return { status: 'pending', intervalMs: flow.intervalMs }
    let answer: { status: number; body: unknown }
    try {
      answer = await this.json(MNEMON_GITHUB_ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId, device_code: flow.deviceCode, grant_type: DEVICE_GRANT,
        }).toString(),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      flow.nextPollAt = this.now() + flow.intervalMs
      return { status: 'pending', intervalMs: flow.intervalMs, message: describeTransportError(error) }
    }
    const fields = record(answer.body)
    const code = text(fields?.error)
    if (code === undefined) {
      const accessToken = text(fields?.access_token)
      if (accessToken === undefined || answer.status !== 200) {
        this.flow = undefined
        return { status: 'error', message: codeOf(answer.body) ?? 'HTTP ' + String(answer.status) }
      }
      const scopes = text(fields?.scope)?.split(/[\s,]+/u).filter(scope => scope !== '')
      const login = await this.account(accessToken, signal)
      const port = this.store()
      if (port === undefined) throw new Error('this DSH Host provides no credentials store, so GitHub sign-in is unavailable')
      await port.write({
        version: 1, accessToken,
        ...(login === undefined ? {} : { login }),
        ...(scopes === undefined || scopes.length === 0 ? {} : { scopes }),
        savedAt: new Date(this.now()).toISOString(),
      })
      this.flow = undefined
      return { status: 'success', ...(login === undefined ? {} : { login }) }
    }
    if (code === 'authorization_pending') {
      flow.nextPollAt = this.now() + flow.intervalMs
      return { status: 'pending', intervalMs: flow.intervalMs }
    }
    if (code === 'slow_down') {
      flow.intervalMs = Math.min(flow.intervalMs + MNEMON_GITHUB_SLOW_DOWN_MS, MNEMON_GITHUB_MAX_INTERVAL_MS)
      flow.nextPollAt = this.now() + flow.intervalMs
      return { status: 'pending', intervalMs: flow.intervalMs }
    }
    this.flow = undefined
    if (code === 'expired_token') return { status: 'expired' }
    if (code === 'access_denied') return { status: 'denied' }
    return { status: 'error', message: code }
  }

  async cancel(): Promise<MnemonSyncGitHubStatus> {
    this.flow = undefined
    return this.status()
  }

  async signOut(): Promise<MnemonSyncGitHubStatus> {
    this.flow = undefined
    const port = this.store()
    if (port !== undefined) await port.clear()
    return this.status()
  }

  private async account(token: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const { status, body } = await this.json(MNEMON_GITHUB_API_BASE + '/user', { headers: this.authorization(token), ...(signal === undefined ? {} : { signal }) })
      if (status !== 200) return undefined
      return text(record(body)?.login)
    } catch {
      return undefined
    }
  }

  private authorization(token: string): Record<string, string> {
    return {
      authorization: 'Bearer ' + token,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    }
  }

  private async requireToken(): Promise<string> {
    const grant = await this.grant()
    if (grant === undefined) throw new Error('sign in to GitHub before choosing a repository')
    return grant.accessToken
  }

  async repositories(signal?: AbortSignal): Promise<MnemonSyncGitHubRepositoryList> {
    const token = await this.requireToken()
    const repositories: MnemonSyncGitHubRepository[] = []
    for (let page = 1; page <= MNEMON_GITHUB_REPOSITORY_PAGES; page += 1) {
      const url = MNEMON_GITHUB_API_BASE + '/user/repos?per_page=' + String(MNEMON_GITHUB_REPOSITORY_PAGE) + '&page=' + String(page) + '&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member'
      const { status, body } = await this.ask(url, { headers: this.authorization(token), ...(signal === undefined ? {} : { signal }) }, 'listing GitHub repositories')
      if (status !== 200) throw failure('listing GitHub repositories', status, body)
      if (!Array.isArray(body)) throw new Error('the GitHub repository answer was not a list')
      for (const entry of body) {
        const repository = repositoryOf(entry)
        if (repository !== undefined && !repositories.some(known => known.fullName === repository.fullName)) repositories.push(repository)
      }
      if (body.length < MNEMON_GITHUB_REPOSITORY_PAGE) break
    }
    const login = (await this.account(token, signal)) ?? ''
    return { login, repositories }
  }

  async create(name: unknown, isPrivate: unknown, signal?: AbortSignal): Promise<MnemonSyncGitHubRepository> {
    const token = await this.requireToken()
    const value = typeof name === 'string' ? name.trim() : ''
    if (!githubRepositoryNameValid(value)) throw new Error('a GitHub repository name holds letters, digits, dots, dashes and underscores')
    const { status, body } = await this.ask(MNEMON_GITHUB_API_BASE + '/user/repos', {
      method: 'POST',
      headers: { ...this.authorization(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name: value, private: isPrivate === true, auto_init: true }),
      ...(signal === undefined ? {} : { signal }),
    }, 'creating the GitHub repository')
    if (status !== 201) throw failure('creating the GitHub repository', status, body)
    const repository = repositoryOf(body)
    if (repository === undefined) throw new Error('the created GitHub repository could not be read back')
    return repository
  }

  private async ask(url: string, options: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  }, action: string): Promise<{ status: number; body: unknown }> {
    try {
      return await this.json(url, options)
    } catch (error) {
      throw new Error(action + ' could not reach GitHub: ' + describeTransportError(error))
    }
  }

  private async json(url: string, options: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  }): Promise<{ status: number; type?: string; body: unknown }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => { controller.abort() }, MNEMON_GITHUB_REQUEST_TIMEOUT_MS)
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal])
    try {
      const response = await this.request(url, {
        method: options.method ?? 'GET',
        headers: { accept: 'application/json', 'user-agent': MNEMON_GITHUB_USER_AGENT, ...options.headers },
        ...(options.body === undefined ? {} : { body: options.body }),
        signal,
      })
      const raw = await response.text()
      const type = response.headers.get('content-type') ?? undefined
      let body: unknown
      try {
        body = raw === '' ? undefined : JSON.parse(raw)
      } catch {
        body = /^application\/x-www-form-urlencoded\b/iu.test(type ?? '') ? Object.fromEntries(new URLSearchParams(raw)) : undefined
      }
      return { status: response.status, ...(type === undefined ? {} : { type }), body }
    } finally {
      clearTimeout(timeout)
    }
  }
}
