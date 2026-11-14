/**
 * How GitHub sign-in reaches GitHub.
 *
 * The plugin asks for the ambient `fetch`: that is the seam a launcher installs
 * a proxy policy on, so an explicit dispatcher here would override a policy
 * rather than honour it. On a network where GitHub is reachable only through a
 * proxy the launcher never heard about — one set in Windows' own settings, for
 * instance — the ambient request cannot connect at all and the page could only
 * report `fetch failed`.
 *
 * This module keeps the ambient request as the first choice and, only after it
 * fails to connect, retries the same request once through a proxy discovered
 * from the environment or, on Windows, from the system proxy settings, over a
 * CONNECT tunnel built from Node's own `http`, `tls` and `https` modules. No
 * dependency is added, no global dispatcher is replaced, and a launcher policy
 * that did install one keeps working untouched.
 */
import { execFileSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { Agent, request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'

/** A proxy to reach, and where the plugin learned about it. */
export interface MnemonGitHubProxy {
  /** The proxy URL, such as `http://127.0.0.1:7890`. */
  url: string
  /** The settings that named it, so a failure can name them back. */
  source: 'environment' | 'system'
}

/** A proxy plus the hosts that must not use it. */
export interface MnemonGitHubProxyRoute {
  proxy: MnemonGitHubProxy
  /** The bypass list that came with the proxy, when it carried one. */
  bypass?: string
}

/** The request shape both the ambient `fetch` and the tunnel satisfy. */
export type MnemonGitHubFetch = typeof fetch

export const MNEMON_GITHUB_TUNNEL_TIMEOUT_MS = 15_000
export const MNEMON_GITHUB_REGISTRY_TIMEOUT_MS = 5_000

/**
 * The environment names a proxy may hide in, in the order undici reads them:
 * lowercase wins over uppercase, and `all_proxy` is the last resort.
 */
const PROXY_ENV_NAMES = [['https_proxy', 'HTTPS_PROXY'], ['http_proxy', 'HTTP_PROXY'], ['all_proxy', 'ALL_PROXY']] as const
const BYPASS_ENV_NAMES = ['no_proxy', 'NO_PROXY'] as const

const WINDOWS_INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const WINDOWS_PROXY_ENTRY = /^\s+(ProxyEnable|ProxyServer|ProxyOverride)\s+REG_(?:DWORD|SZ|EXPAND_SZ)\s+(\S.*)$/u

/**
 * The ways a request dies before it is an answer. undici wraps the real reason
 * in `cause`, so a message and every cause below it are inspected.
 */
const TRANSPORT_MARKERS = [
  'fetch failed', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'UND_ERR_', 'socket hang up', 'other side closed', 'network socket disconnected',
] as const

/** Whether an error means the request never reached a server. */
export function isTransportFailure(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    if (current instanceof Error) {
      if (current.name === 'AbortError' || current.name === 'TimeoutError') return false
      const text = current.message + ' ' + String((current as { code?: unknown }).code ?? '')
      if (TRANSPORT_MARKERS.some(marker => text.includes(marker))) return true
      current = current.cause
      continue
    }
    if (typeof current === 'string') return TRANSPORT_MARKERS.some(marker => current.includes(marker))
    return false
  }
  return false
}

/** Whether the caller itself stopped the request, which is never retried. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/** Whether a host is this machine, which no proxy is ever asked about. */
export function isLoopbackHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/gu, '')
  return name === 'localhost' || name === '::1' || name.startsWith('127.')
}

/** Read one proxy setting, accepting both spellings and refusing blanks. */
function proxyUrl(raw: string): string | undefined {
  const value = raw.trim()
  if (value === '') return undefined
  try {
    const url = new URL(value.includes('://') ? value : 'http://' + value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.href
  } catch {
    return undefined
  }
}

function firstSetting(environment: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = environment[name]?.trim()
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

/** The proxy this process was launched with, if any. */
export function proxyFromEnvironment(environment: NodeJS.ProcessEnv = process.env): MnemonGitHubProxyRoute | undefined {
  for (const names of PROXY_ENV_NAMES) {
    const raw = firstSetting(environment, names)
    if (raw === undefined) continue
    const url = proxyUrl(raw)
    if (url === undefined) continue
    const bypass = firstSetting(environment, BYPASS_ENV_NAMES)
    return { proxy: { url, source: 'environment' }, ...(bypass === undefined ? {} : { bypass }) }
  }
  return undefined
}

/**
 * Read the shape Windows writes: one `host:port` for every protocol, or one
 * entry per protocol as `http=host:port;https=host:port`.
 */
export function parseWindowsProxy(enable: string | undefined, server: string | undefined): MnemonGitHubProxy | undefined {
  if (server === undefined || server.trim() === '') return undefined
  const enabled = enable === undefined || /^(?:0x)?0*1$/iu.test(enable.trim())
  if (!enabled) return undefined
  const entries = new Map<string, string>()
  for (const part of server.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) {
      entries.set('*', part.trim())
      continue
    }
    entries.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim())
  }
  const chosen = entries.get('https') ?? entries.get('http') ?? entries.get('*')
  if (chosen === undefined) return undefined
  const url = proxyUrl(chosen)
  return url === undefined ? undefined : { url, source: 'system' }
}

/** Whether a bypass list (`NO_PROXY` or `ProxyOverride`) covers a host. */
export function proxyBypassesHost(bypass: string | undefined, host: string): boolean {
  if (bypass === undefined) return false
  const name = host.trim().toLowerCase().replace(/^\[|\]$/gu, '')
  if (name === '') return false
  for (const raw of bypass.split(/[;,\s]+/u)) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    if (entry === '<local>' && !name.includes('.')) return true
    const escaped = entry.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*')
    if (new RegExp('^' + escaped + '$', 'u').test(name)) return true
  }
  return false
}

/** Run `reg.exe` once; any failure means "this machine says nothing". */
function readRegistry(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout: MNEMON_GITHUB_REGISTRY_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/** The proxy Windows itself would use, read from the current user's settings. */
export function readWindowsProxySettings(
  run: (command: string, args: string[]) => string = readRegistry,
): MnemonGitHubProxyRoute | undefined {
  let output: string
  try {
    output = run('reg.exe', ['query', WINDOWS_INTERNET_SETTINGS])
  } catch {
    return undefined
  }
  const values = new Map<string, string>()
  for (const line of output.split(/\r?\n/u)) {
    const match = WINDOWS_PROXY_ENTRY.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2].trim())
  }
  const proxy = parseWindowsProxy(values.get('ProxyEnable'), values.get('ProxyServer'))
  if (proxy === undefined) return undefined
  const override = values.get('ProxyOverride')
  return { proxy, ...(override === undefined || override === '' ? {} : { bypass: override }) }
}

/**
 * The proxy to fall back to: the environment first, because a launcher that
 * exported one meant it, then this machine's own system settings.
 */
export function discoverGitHubProxy(options: {
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  windowsSettings?: () => MnemonGitHubProxyRoute | undefined
} = {}): MnemonGitHubProxyRoute | undefined {
  const fromEnvironment = proxyFromEnvironment(options.environment ?? process.env)
  if (fromEnvironment !== undefined) return fromEnvironment
  if ((options.platform ?? process.platform) !== 'win32') return undefined
  try {
    return (options.windowsSettings ?? readWindowsProxySettings)()
  } catch {
    return undefined
  }
}

/** Open one CONNECT tunnel through the proxy and finish its TLS handshake. */
function connectThroughProxy(
  proxy: URL,
  host: string,
  port: number,
  signal?: AbortSignal,
  timeoutMs = MNEMON_GITHUB_TUNNEL_TIMEOUT_MS,
): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'aborted')))
      return
    }
    const authority = host + ':' + String(port)
    const authorization = proxy.username === ''
      ? {}
      : { 'proxy-authorization': 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') }
    let rawSocket: Duplex | undefined
    let tlsSocket: TLSSocket | undefined
    let handshakeTimer: NodeJS.Timeout | undefined
    let settled = false
    const clearHandshake = (): void => {
      if (handshakeTimer !== undefined) {
        clearTimeout(handshakeTimer)
        handshakeTimer = undefined
      }
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      clearHandshake()
      signal?.removeEventListener('abort', onAbort)
      tlsSocket?.destroy()
      rawSocket?.destroy()
      connect.destroy()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const onAbort = (): void => {
      fail(signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason ?? 'aborted')))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const connect = httpRequest({
      host: proxy.hostname,
      port: proxy.port === '' ? 80 : Number(proxy.port),
      method: 'CONNECT',
      path: authority,
      headers: { host: authority, ...authorization },
      agent: false,
      timeout: timeoutMs,
    })
    connect.once('connect', (response, socket) => {
      rawSocket = socket
      if (settled) {
        socket.destroy()
        return
      }
      if (response.statusCode !== 200) {
        fail(new Error('the proxy refused the tunnel with HTTP ' + String(response.statusCode)))
        return
      }
      const secured = tlsConnect({ socket, servername: host })
      tlsSocket = secured
      handshakeTimer = setTimeout(() => {
        fail(new Error('the TLS handshake through the proxy did not finish within ' + String(timeoutMs) + 'ms'))
      }, timeoutMs)
      handshakeTimer.unref?.()
      secured.once('secureConnect', () => {
        if (settled) {
          secured.destroy()
          socket.destroy()
          return
        }
        settled = true
        clearHandshake()
        signal?.removeEventListener('abort', onAbort)
        resolve(secured)
      })
      secured.once('error', fail)
    })
    connect.once('timeout', () => {
      fail(new Error('the proxy did not answer within ' + String(timeoutMs) + 'ms'))
    })
    connect.once('error', fail)
    connect.end()
  })
}

/** An agent whose every connection is a tunnel through one proxy. */
class TunnelAgent extends Agent {
  constructor(
    private readonly proxy: URL,
    private readonly signal?: AbortSignal,
    private readonly timeoutMs = MNEMON_GITHUB_TUNNEL_TIMEOUT_MS,
  ) {
    super({ keepAlive: false })
  }

  override createConnection(options: unknown, callback?: (error: Error | null, socket: Duplex) => void): Duplex | null | undefined {
    const fields = (options ?? {}) as { host?: unknown; port?: unknown }
    const host = typeof fields.host === 'string' ? fields.host : ''
    const port = Number(fields.port ?? 443)
    if (host === '') {
      callback?.(new Error('the tunnel needs a destination host'), undefined as unknown as Duplex)
      return undefined
    }
    connectThroughProxy(this.proxy, host, Number.isFinite(port) ? port : 443, this.signal, this.timeoutMs).then(
      socket => {
        if (this.signal?.aborted) {
          socket.destroy()
          const reason = this.signal.reason
          callback?.(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted')), undefined as unknown as Duplex)
          return
        }
        callback?.(null, socket)
      },
      (error: unknown) => { callback?.(error instanceof Error ? error : new Error(String(error)), undefined as unknown as Duplex) },
    )
    return undefined
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {}
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  if (typeof (headers as Headers).entries === 'function') return Object.fromEntries((headers as Headers).entries())
  return { ...(headers as Record<string, string>) }
}

/**
 * What a tunnelled request read back, as a `fetch` answer: the status, the text and its
 * content type, which is all this channel uses. The type says how to read a body that
 * is not JSON, such as the form GitHub's sign-in answers with when no JSON was asked for.
 */
export function tunnelAnswer(status: number, type: string | undefined, text: string): Response {
  const body = status === 204 || status === 205 || status === 304 ? null : text
  return new Response(body, { status, ...(type === undefined ? {} : { headers: { 'content-type': type } }) })
}

/** The request one tunnel performs, as a `fetch`-shaped answer. */
function tunnelRequest(target: URL, url: string, init: RequestInit, timeoutMs = MNEMON_GITHUB_TUNNEL_TIMEOUT_MS): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const signal = init.signal ?? undefined
    const agent = new TunnelAgent(target, signal, timeoutMs)
    const request = httpsRequest(url, {
      agent,
      method: init.method ?? 'GET',
      headers: headerRecord(init.headers),
      ...(signal === undefined ? {} : { signal }),
    })
    request.on('socket', socket => {
      if (request.destroyed || signal?.aborted) socket.destroy()
    })
    request.once('error', reject)
    request.once('response', response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.once('error', reject)
      response.once('end', () => {
        const type = response.headers['content-type']
        resolve(tunnelAnswer(response.statusCode ?? 502, type, Buffer.concat(chunks).toString('utf8')))
      })
    })
    if (typeof init.body === 'string') request.write(init.body)
    request.end()
  })
}

/** A `fetch` that reaches every host through one proxy. */
export function createTunnelFetch(proxy: MnemonGitHubProxy, timeoutMs = MNEMON_GITHUB_TUNNEL_TIMEOUT_MS): MnemonGitHubFetch {
  let target: URL
  try {
    target = new URL(proxy.url)
  } catch {
    throw new Error('the proxy address could not be read: ' + proxy.url)
  }
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => tunnelRequest(target, urlOf(input), init, timeoutMs)) as MnemonGitHubFetch
}

/** One line naming what went wrong, with the reason undici hid in `cause`. */
export function describeTransportError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const parts = [error.message]
  const cause: unknown = error.cause
  if (cause instanceof Error && cause.message !== '' && cause.message !== error.message) parts.push(cause.message)
  else if (typeof cause === 'string' && cause !== '' && cause !== error.message) parts.push(cause)
  const code = (cause as { code?: unknown } | undefined)?.code ?? (error as { code?: unknown }).code
  const text = parts.join(': ')
  return typeof code === 'string' && code !== '' && !text.includes(code) ? text + ' (' + code + ')' : text
}

function unreachable(host: string, error: unknown, detail: string): Error {
  return new Error('could not reach ' + host + ': ' + describeTransportError(error) + detail)
}

export interface MnemonGitHubTransportOptions {
  /** The request that goes first; the ambient `fetch` by default. */
  ambient?: MnemonGitHubFetch
  /** Where a proxy is discovered from; the environment and Windows by default. */
  discover?: () => MnemonGitHubProxyRoute | undefined
  /** How one proxy is reached; a CONNECT tunnel by default. */
  tunnel?: (proxy: MnemonGitHubProxy) => MnemonGitHubFetch
}

/**
 * The request this channel sends: the ambient `fetch` first, and one retry
 * through a discovered proxy when that cannot connect. A proxy that worked is
 * remembered, and a proxy that stops working is forgotten, so a machine that
 * moves between networks keeps reaching GitHub without a restart.
 */
export function createGitHubTransport(options: MnemonGitHubTransportOptions = {}): MnemonGitHubFetch {
  const ambient = options.ambient ?? fetch
  const discover = options.discover ?? ((): MnemonGitHubProxyRoute | undefined => discoverGitHubProxy())
  const tunnel = options.tunnel ?? createTunnelFetch
  let proxied: MnemonGitHubFetch | undefined

  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (proxied !== undefined) {
      try {
        return await proxied(input, init)
      } catch (error) {
        if (!isTransportFailure(error)) throw error
        proxied = undefined
      }
    }
    try {
      return await ambient(input, init)
    } catch (error) {
      if (!isTransportFailure(error)) throw error
      const host = ((): string | undefined => {
        try {
          return new URL(urlOf(input)).hostname
        } catch {
          return undefined
        }
      })()
      if (host === undefined || isLoopbackHost(host)) throw error
      const route = discover()
      if (route === undefined) {
        throw unreachable(host, error, '; this Host has no proxy for GitHub, so set HTTPS_PROXY to a proxy that can reach it')
      }
      if (route.bypass !== undefined && proxyBypassesHost(route.bypass, host)) {
        throw unreachable(host, error, '; the proxy ' + route.proxy.url + ' is configured to bypass ' + host)
      }
      const attempt = tunnel(route.proxy)
      try {
        const response = await attempt(input, init)
        proxied = attempt
        return response
      } catch (tunnelError) {
        // A caller that aborted still gets its abort; anything else is the
        // fallback failing, which is worth naming together with the proxy.
        if (isAbortError(tunnelError)) throw tunnelError
        throw unreachable(host, error, '; the ' + route.proxy.source + ' proxy ' + route.proxy.url + ' could not reach it either: ' + describeTransportError(tunnelError))
      }
    }
  }) as MnemonGitHubFetch
}
